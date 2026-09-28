import OpenAI from "openai";

const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

const MAX_PAUSE = 0.8;
const SOFT_MAX_UNIT = 7;
const HARD_MAX_UNIT = 11;
const PAD_BEFORE = 0.12;
const PAD_AFTER = 0.3;
const DURATION_TOLERANCE = 5;

const SHORTLIST_THRESHOLD = 120; // nad tolik vet se pouzije dvoukolovy vyber
const SHORTLIST_CHUNK_SIZE = 90; // kolik vet posilame v jedne davce
const SHORTLIST_PER_CHUNK = 8; // kolik nejlepsich vet vytahnout z kazde davky
const SHORTLIST_DELAY_MS = 65000; // pauza mezi davkami kvuli limitu tokenu/min

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractTargetDuration(userPrompt) {
  const match = userPrompt.match(/(\d+)\s*(sekund|vterin|sec|s\b)/i);
  if (match) return parseInt(match[1], 10);
  return 30;
}

export function buildUnits(words, segments) {
  if (!words || words.length === 0) {
    return (segments || []).map((s) => ({
      start: s.start,
      end: s.end,
      text: s.text,
      first: null,
      last: null,
    }));
  }

  const units = [];
  let firstIdx = 0;

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const isLast = i === words.length - 1;
    const gapToNext = isLast ? Infinity : words[i + 1].start - w.end;
    const duration = w.end - words[firstIdx].start;

    const endsSentence = /[.!?…]["')\]]*$/.test(w.word);
    const endsSoft = /[,;:]["')\]]*$/.test(w.word);

    const cut =
      isLast ||
      endsSentence ||
      gapToNext > MAX_PAUSE ||
      (endsSoft && duration >= SOFT_MAX_UNIT) ||
      duration >= HARD_MAX_UNIT;

    if (cut) {
      units.push({
        start: words[firstIdx].start,
        end: w.end,
        text: words
          .slice(firstIdx, i + 1)
          .map((x) => x.word)
          .join(" "),
        first: firstIdx,
        last: i,
      });
      firstIdx = i + 1;
    }
  }

  return units;
}

function formatUnitsForPrompt(units) {
  return units
    .map(
      (u, i) =>
        "#" + (i + 1) + " [" + u.start.toFixed(1) + "s-" + u.end.toFixed(1) + "s, " +
        (u.end - u.start).toFixed(1) + "s] " + u.text
    )
    .join("\n");
}

function parseJsonArray(rawText) {
  const start = rawText.indexOf("[");
  const end = rawText.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("V odpovedi neni JSON pole.");
  }
  return JSON.parse(rawText.slice(start, end + 1));
}

export function picksToClips(picks, units, words, totalDurationSeconds) {
  const used = new Set();
  const clips = [];

  for (const p of picks) {
    let from = Math.round(Number(p.from)) - 1;
    let to = Math.round(Number(p.to)) - 1;
    if (Number.isNaN(from) || Number.isNaN(to)) continue;
    if (from > to) [from, to] = [to, from];
    from = Math.max(0, from);
    to = Math.min(units.length - 1, to);

    while (from <= to && used.has(from)) from++;
    while (to >= from && used.has(to)) to--;
    if (from > to) continue;

    let clash = false;
    for (let k = from; k <= to; k++) if (used.has(k)) clash = true;
    if (clash) continue;

    for (let k = from; k <= to; k++) used.add(k);

    const first = units[from];
    const last = units[to];
    let start = first.start;
    let end = last.end;

    if (first.first !== null) {
      const prevEnd = first.first > 0 ? words[first.first - 1].end : 0;
      start -= Math.min(PAD_BEFORE, Math.max(0, (first.start - prevEnd) / 2));
      const nextStart =
        last.last < words.length - 1 ? words[last.last + 1].start : totalDurationSeconds;
      end += Math.min(PAD_AFTER, Math.max(0, (nextStart - last.end) / 2));
    }

    start = Math.max(0, start);
    end = Math.min(totalDurationSeconds, end);
    if (end - start < 0.5) continue;

    clips.push({
      start: start,
      end: end,
      role: String(p.role || ""),
      subtitles: p.subtitles === true,
      reason: String(p.reason || ""),
      text: units
        .slice(from, to + 1)
        .map((u) => u.text)
        .join(" "),
    });
  }

  if (clips.length > 0) clips[0].subtitles = false;

  return clips;
}

function totalLength(clips) {
  return clips.reduce((sum, c) => sum + (c.end - c.start), 0);
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

// Prvni kolo pro dlouha videa: z kazde davky vet vytahne jen tu nejzajimavejsi hrstku,
// aby se do druheho (finalniho) kola poslalo mnohem min textu a vlezlo se to do limitu tokenu/min.
async function shortlistUnits(units, userPrompt) {
  const chunks = chunkArray(units, SHORTLIST_CHUNK_SIZE);
  const candidates = [];
  const seen = new Set();

  for (let c = 0; c < chunks.length; c++) {
    const offset = c * SHORTLIST_CHUNK_SIZE;
    const chunk = chunks[c];

    const chunkText = chunk
      .map(
        (u, i) =>
          "#" + (offset + i + 1) + " [" + u.start.toFixed(1) + "s-" + u.end.toFixed(1) + "s] " + u.text
      )
      .join("\n");

    const systemPrompt =
      "Dostanes cast prepisu dlouheho videa (ocislovane vety) a instrukci uzivatele. " +
      "Vyber az " + SHORTLIST_PER_CHUNK + " nejzajimavejsich, nejpoutavejsich nebo nejprekvapivejsich vet z teto casti, " +
      "ktere by mohly byt soucasti kratkeho virelniho videa. " +
      "Odpovez VYHRADNE JSON polem cisel vet, napr. [12, 45, 78]. Zadny dalsi text, zadne markdown bloky.";

    const messages = [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: "Instrukce uzivatele: \"" + userPrompt + "\"\n\nCast prepisu:\n" + chunkText,
      },
    ];

    try {
      const completion = await groq.chat.completions.create({
        model: "openai/gpt-oss-20b",
        messages: messages,
        max_tokens: 4096,
        reasoning_effort: "low",
      });
      const rawText = (completion.choices[0].message.content || "").trim();
      const picks = parseJsonArray(rawText);

      for (const n of picks) {
        const idx = Math.round(Number(n)) - 1;
        if (Number.isNaN(idx) || idx < 0 || idx >= units.length) continue;
        if (seen.has(idx)) continue;
        seen.add(idx);
        candidates.push({ idx: idx, unit: units[idx] });
      }
    } catch (err) {
      console.log("    (davka " + (c + 1) + "/" + chunks.length + " selhala, preskakuji: " + err.message + ")");
    }

    console.log("    Davka " + (c + 1) + "/" + chunks.length + " hotova, zatim " + candidates.length + " kandidatu.");

    if (c < chunks.length - 1) {
      console.log("    Cekam kvuli limitu Groq (tokeny/min)...");
      await sleep(SHORTLIST_DELAY_MS);
    }
  }

  candidates.sort((a, b) => a.idx - b.idx);
  return candidates.map((c) => c.unit);
}

export async function selectClips(segments, words, userPrompt, totalDurationSeconds) {
  const targetDuration = extractTargetDuration(userPrompt);
  const allUnits = buildUnits(words, segments);

  if (allUnits.length === 0) {
    throw new Error("V ramci videa nebyla nalezena zadna rec, neni z ceho vybirat.");
  }

  let units = allUnits;

  if (allUnits.length > SHORTLIST_THRESHOLD) {
    console.log("    Video ma " + allUnits.length + " vet, nejdriv delam predvyber po davkach...");
    units = await shortlistUnits(allUnits, userPrompt);
    if (units.length < 3) {
      console.log("    Predvyber vratil malo kandidatu, pouzivam cely prepis.");
      units = allUnits;
    } else {
      console.log("    Predvyber hotovy: " + units.length + " kandidatnich vet.");
    }
  }

  const systemPrompt =
    "Jsi zkuseny editor kratkych videi (Reels/TikTok/Shorts). Dostanes prepis videa rozdeleny na ocislovane VETY (kazda ma cislo, cas a delku) a instrukci od uzivatele.\n\n" +
    "Tvuj ukol NENI jen vybrat 'nejlepsi' izolovane momenty. Tvuj ukol je poskladat z vet KRATKY SOUVISLY PRIBEH s obloukem:\n" +
    "1. HOOK (prvni 1-3s) - nejpoutavejsi/nejprekvapivejsi veta, ktera divaka okamzite zaujme a donuti ho nescrollovat dal.\n" +
    "2. KONTEXT / BUDOVANI - useky, ktere vysvetli o cem je rec nebo stupnuji napeti/zajimavost smerem k vyvrcholeni.\n" +
    "3. VYVRCHOLENI / PAYOFF - zaver, ktery dava smysl, uzaviraj myslenku, nebo je nejsilnejsi/nejvtipnejsi/nejprekvapivejsi cast.\n\n" +
    "Useky musi na sebe LOGICKY NAVAZOVAT - kazdy dalsi ma vyplyvat z predchoziho (otazka -> odpoved, priciny -> nasledek). Neskakej mezi nesouvisejicimi tematy.\n\n" +
    "Vybiras CELE VETY podle jejich cisel (from a to, vcetne). Nikdy nerezes uprostred vety. Jeden usek jsou 1 az 3 po sobe jdouci vety.\n" +
    "Poradi useku v poli JE poradi ve finalnim sestrihu. Nemusi byt chronologicke - klidne dej hook z konce videa, pokud to zlepsi pribeh.\n\n" +
    "TITULKY: pole \"subtitles\" rika, jestli se u useku maji zobrazit vypalene titulky. Nastav true JEN u useku s napinavou, dramatickou nebo silnou pointou, kde titulky zesili efekt. " +
    "Vetsina useku ma mit false (typicky true u 1-2 useku z celeho sestrihu). Prvni usek (hook) ma VZDY subtitles: false.\n\n" +
    "Video ma celkovou delku " + totalDurationSeconds.toFixed(0) + " sekund.\n" +
    "Cilova celkova delka vysledneho sestrihu je priblizne " + targetDuration + " sekund (tolerance +/- 3s). Soucet delek vybranych vet se ma tomuto cili priblizit.\n\n" +
    "Odpovez VYHRADNE JSON polem, zadny text okolo, zadne markdown bloky. Format:\n" +
    "[{ \"from\": 4, \"to\": 5, \"role\": \"hook|kontext|payoff\", \"subtitles\": false, \"reason\": \"kratke zduvodneni\" }]\n\n" +
    "Pravidla:\n" +
    "- Cisla vet musi existovat v prepisu. Kazda veta smi byt pouzita nejvyse v jednom useku (useky se nesmi prekryvat).\n" +
    "- Vyber jen tolik useku, kolik je potreba pro souvisly pribeh s hookem, kontextem a payoffem (typicky 3-6 useku).";

  const baseMessages = [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: "Instrukce uzivatele: \"" + userPrompt + "\"\n\nPrepis videa po vetach:\n" + formatUnitsForPrompt(units),
    },
  ];

  let messages = baseMessages;
  let best = null;
  let lastError = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const completion = await groq.chat.completions.create({
      model: "openai/gpt-oss-20b",
      messages: messages,
      max_tokens: 2048,
      reasoning_effort: "low",
    });
    const rawText = (completion.choices[0].message.content || "").trim();

    let problem = null;
    let clips = [];

    try {
      const picks = parseJsonArray(rawText);
      if (!Array.isArray(picks)) throw new Error("Odpoved neni pole.");
      clips = picksToClips(picks, units, words, totalDurationSeconds);
      if (clips.length === 0) problem = "Nevybral jsi zadne platne useky. Pouzij cisla vet z prepisu.";
    } catch (err) {
      lastError = new Error("Model nevratil validni JSON. Syrova odpoved:\n" + rawText + "\n\nChyba parsovani: " + err.message);
      problem = "Tvoje odpoved nebyla validni JSON pole (" + err.message + "). Odpovez znovu VYHRADNE JSON polem.";
    }

    if (!problem) {
      const total = totalLength(clips);
      const diff = Math.abs(total - targetDuration);
      if (best === null || diff < best.diff) best = { clips: clips, diff: diff };
      if (diff <= DURATION_TOLERANCE) return clips;
      problem =
        "Soucet delek tvych useku je " + total.toFixed(1) + " s, ale cil je " + targetDuration +
        " s (tolerance +/- 3s). Uprav vyber (pridej nebo ubrat vety/useky) a odpovez znovu VYHRADNE JSON polem.";
    }

    messages = baseMessages.concat([
      { role: "assistant", content: rawText },
      { role: "user", content: problem },
    ]);
  }

  if (best !== null) return best.clips;
  throw lastError || new Error("Model nevybral zadne useky. Zkus upravit prompt.");
}
