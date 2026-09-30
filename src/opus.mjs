// src/opus.mjs - styl OpusClip: z dlouheho videa udela nekolik SAMOSTATNYCH vertikalnich klipu
// (souvisly vyrez, hook nahore, karaoke titulky, skore viralnosti). Potrebuje jen ffmpeg + GROQ_API_KEY.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { checkStart } from "./checkstart.mjs";
import { makeTitle } from "./titles.mjs";

const { values: A } = parseArgs({
  options: {
    input: { type: "string", short: "i" },
    out: { type: "string", short: "o", default: "clips" },
    count: { type: "string", short: "n", default: "5" },
    min: { type: "string", default: "20" },
    max: { type: "string", default: "60" },
    lang: { type: "string", default: process.env.WHISPER_LANG || "cs" },
    fit: { type: "string", default: "crop" }, // crop | blur | none
    x: { type: "string", default: "0.5" }, // pozice cropu zleva doprava, 0 az 1
    hint: { type: "string", default: "" }, // napoveda pro Whisper: jmena, terminy
    upper: { type: "boolean", default: false },
    "no-captions": { type: "boolean", default: false },
    "no-hook": { type: "boolean", default: false },
  },
});

const KEY = process.env.GROQ_API_KEY;
const BASE = process.env.GROQ_BASE || "https://api.groq.com/openai/v1";
const WHISPER = process.env.WHISPER_MODEL || "whisper-large-v3";
const LLM = process.env.LLM_MODEL || "openai/gpt-oss-20b";
const num = (v, d) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : d);
const COUNT = Math.max(1, Math.round(num(A.count, 5)));
const MIN = num(A.min, 20);
const MAX = num(A.max, 60);
const X = Math.min(1, Math.max(0, num(A.x, 0.5)));

const log = (...m) => console.log(...m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mmss = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 28, ...opts });
  if (r.status !== 0) {
    throw new Error(`${cmd} selhal:\n${(r.stderr || String(r.error || "")).split("\n").slice(-15).join("\n")}`);
  }
  return r.stdout;
}

function probe(file) {
  const j = JSON.parse(run("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", file]));
  const v = j.streams.find((s) => s.codec_type === "video");
  if (!v) throw new Error("Soubor nema video stopu.");
  let w = v.width, h = v.height;
  const rot = Math.abs(Number(v.tags?.rotate ?? v.side_data_list?.find((d) => d.rotation != null)?.rotation ?? 0));
  if (rot === 90 || rot === 270) [w, h] = [h, w];
  return { duration: parseFloat(j.format.duration), w, h };
}

async function api(url, makeInit, tries = 6) {
  for (let i = 1; i <= tries; i++) {
    const res = await fetch(url, makeInit());
    if (res.ok) return res.json();
    const txt = await res.text();
    if ((res.status === 429 || res.status >= 500) && i < tries) {
      const wait = (parseFloat(res.headers.get("retry-after")) || 15 * i) + 1;
      log(`  API ${res.status}, cekam ${Math.round(wait)} s...`);
      await sleep(wait * 1000);
      continue;
    }
    throw new Error(`Groq ${res.status}: ${txt.slice(0, 400)}`);
  }
}

// ---------- 1) prepis (po 20 minutach, takze delka videa neni problem) ----------
async function transcribe(input, duration, dir) {
  const cache = path.join(dir, "transcript.json");
  if (fs.existsSync(cache)) {
    log("Pouzivam ulozeny prepis (smaz transcript.json, kdyz chces novy).");
    return JSON.parse(fs.readFileSync(cache, "utf8"));
  }
  const CH = 1200;
  const words = [], segEnds = [], bad = [];
  const total = Math.ceil(duration / CH);
  for (let off = 0, n = 1; off < duration - 1; off += CH, n++) {
    const f = path.join(dir, "_chunk.mp3");
    run("ffmpeg", ["-y", "-v", "error", "-ss", String(off), "-t", String(CH), "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", f]);
    log(`Prepis ${n}/${total} (Whisper ${WHISPER}, jazyk ${A.lang || "auto"})...`);
    const blob = new Blob([fs.readFileSync(f)], { type: "audio/mpeg" });
    const r = await api(`${BASE}/audio/transcriptions`, () => {
      const fd = new FormData();
      fd.append("file", blob, "audio.mp3");
      fd.append("model", WHISPER);
      fd.append("response_format", "verbose_json");
      fd.append("timestamp_granularities[]", "word");
      fd.append("timestamp_granularities[]", "segment");
      fd.append("temperature", "0");
      if (A.lang && A.lang !== "auto") fd.append("language", A.lang);
      if (A.hint) fd.append("prompt", A.hint);
      return { method: "POST", headers: { Authorization: `Bearer ${KEY}` }, body: fd };
    });
    fs.unlinkSync(f);
    for (const s of r.segments || []) {
      segEnds.push(s.end + off);
      if (s.no_speech_prob > 0.7 && s.avg_logprob < -0.8) bad.push([s.start + off, s.end + off]); // halucinace v tichu
    }
    for (const w of r.words || []) {
      const s = w.start + off, e = w.end + off, t = String(w.word || "").trim();
      if (!t || bad.some(([a, b]) => (s + e) / 2 >= a && (s + e) / 2 <= b)) continue;
      words.push({ w: t, s, e });
    }
  }
  const res = { words, segEnds };
  fs.writeFileSync(cache, JSON.stringify(res));
  return res;
}

// ---------- 2) vety ----------
function buildSentences(words, segEnds) {
  const S = [];
  let cur = [];
  const flush = () => {
    if (!cur.length) return;
    S.push({ s: cur[0].s, e: cur[cur.length - 1].e, words: cur, text: cur.map((x) => x.w).join(" ") });
    cur = [];
  };
  words.forEach((w, i) => {
    cur.push(w);
    const nx = words[i + 1];
    const segBreak = nx && segEnds.some((t) => t > w.e + 0.35 && t < nx.s + 0.35);
    if (!nx || /[.?!…]$/.test(w.w) || nx.s - w.e > 0.8 || cur.length >= 40 || segBreak) flush();
  });
  return S;
}

// ---------- 3) vyber klipu (AI vybira rozsah VET, takze klip je vzdy souvisly a konci na konci vety) ----------
const SYS = (k) => `Jsi stříhač virálních krátkých videí (TikTok/Reels/Shorts), jako OpusClip. Dostaneš přepis videa, věty jsou ve formátu id|začátek_v_sekundách|text.
Vyber přesně ${k} nejlepších samostatných klipů. Pravidla:
- klip je souvislý rozsah vět od start_id do end_id (včetně), nic se nevynechává ani nepřeskakuje
- délka ${MIN}–${MAX} sekund (délku odhadni z časů vět)
- začíná silným hookem: odvážné tvrzení, otázka, překvapivý fakt nebo začátek příběhu; nikdy uprostřed myšlenky ani slovy typu "a tak", "jo", "no"
- končí dokončenou myšlenkou nebo pointou
- musí být srozumitelný bez zbytku videa
- uvnitř klipu nesmí být dlouhá pauza nebo ticho; pokud je mezi větami pauza nad cca 2,5 s, tento rozsah nevybírej
- první věta klipu musí sama působit jako začátek; nezačínej navazovací větou typu a tak, takže, protože, ale, no, jo
- title musí odpovídat tématu první věty klipu, ne až pozdější části
- klipy se nesmí překrývat
- score 0–100 = potenciál zaujmout (síla hooku, emoce, hodnota, dokončenost). Buď přísný, většina klipů má 40–80.
- title: chytlavý titulek česky, max 60 znaků, bez emoji a uvozovek
- reason: jedna krátká věta česky, proč klip funguje
Odpověz POUZE JSON: {"clips":[{"start_id":0,"end_id":0,"score":0,"title":"","reason":""}]}. Vždy vrať přesně ${k} klipů, i když nejsou dokonalé, a slabším dej nízké score. Prázdný seznam nevracej.`;

async function pickClips(S, duration) {
  const WIN = 480, STEP = 420;
  const nWin = Math.max(1, Math.ceil((duration - WIN) / STEP) + 1);
  const ask = nWin === 1 ? COUNT + 3 : Math.min(4, COUNT);
  const len = (a, b) => S[b].e - S[a].s;
  const fit = (a, b) => {
    while (b > a && len(a, b) > MAX) b--;
    while (b < S.length - 1 && len(a, b) < MIN && len(a, b + 1) <= MAX) b++;
    return len(a, b) >= MIN * 0.7 && len(a, b) <= MAX + 5 ? [a, b] : null;
  };
  const cand = [];
  for (let k = 0; k < nWin; k++) {
    const t0 = k * STEP, t1 = t0 + WIN;
    const ids = [];
    S.forEach((x, i) => { if (x.s >= t0 && x.s < t1) ids.push(i); });
    if (ids.length < 5) continue;
    log(`AI vybira klipy: okno ${k + 1}/${nWin} (${mmss(t0)}-${mmss(Math.min(t1, duration))})...`);
    const body = {
      model: LLM,
      temperature: 0.3,
      max_tokens: 4096,
      messages: [
        { role: "system", content: SYS(ask) },
        { role: "user", content: ids.map((i) => `${i}|${Math.round(S[i].s)}|${S[i].text}`).join("\n") },
      ],
    };
    if (LLM.includes("gpt-oss")) body.reasoning_effort = "low";
    const r = await api(`${BASE}/chat/completions`, () => ({
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }));
    let out;
    try {
      const c = r.choices[0].message.content;
      if (process.env.DEBUG) console.log("AI:", c);
      out = JSON.parse(c.slice(c.indexOf("{"), c.lastIndexOf("}") + 1)).clips;
      if (!Array.isArray(out)) throw new Error("no clips");
    } catch {
      log("  odpoved AI nesla precist, preskakuji okno");
      continue;
    }
    for (const c of out) {
      let a = Math.round(+c.start_id), b = Math.round(+c.end_id);
      if (!(a >= ids[0] && b <= ids[ids.length - 1] && a <= b)) continue;
      let ab = fit(a, b);
      if (ab) { let bs = ab[0], bb = ab[1], bl = 0, st = ab[0]; for (let j = ab[0]; j <= ab[1]; j++) { if (j === ab[1] || S[j + 1].s - S[j].e > 2.5) { const l = S[j].e - S[st].s; if (l > bl) { bl = l; bs = st; bb = j; } st = j + 1; } } if (bs !== ab[0] || bb !== ab[1]) { if (bl < MIN) { log(`  zahazuji ids ${a}-${b}: pauza nad 2,5 s`); continue; } log(`  orezavam ids ${a}-${b} na ${bs}-${bb}: pauza nad 2,5 s`); ab = [bs, bb]; } }
      if (!ab) { log("  zahazuji ids " + a + "-" + b + ": delka mimo limity"); continue; }
      [a, b] = ab; { const ns = await checkStart(S, a, b, MIN * 0.7); if (ns === null) { log("  zahazuji ids " + a + "-" + b + ": slaby zacatek"); continue; } a = ns; }
      cand.push({
        a, b,
        start: Math.max(0, S[a].s - 0.15),
        end: Math.min(duration, S[b].e + 0.35),
        score: Math.max(0, Math.min(100, Math.round(+c.score || 0))),
        title: String(c.title || "").replace(/["„“]/g, "").slice(0, 70),
        reason: String(c.reason || ""),
      });
    }
  }
  cand.sort((x, y) => y.score - x.score);
  const picked = [];
  for (const c of cand) {
    if (picked.length >= COUNT) break;
    if (picked.some((p) => c.start < p.end && c.end > p.start)) continue; // prekryv: vyhraje vyssi skore
    picked.push(c);
  }
  return picked;
}

// ---------- 4) titulky (ASS): karaoke po 3 slovech, aktivni slovo zvyraznene + hook nahore ----------
const cs = (t) => {
  const c = Math.round(Math.max(0, t) * 100);
  return `${Math.floor(c / 360000)}:${String(Math.floor(c / 6000) % 60).padStart(2, "0")}:${String(Math.floor(c / 100) % 60).padStart(2, "0")}.${String(c % 100).padStart(2, "0")}`;
};

function makeAss(clip, S, W, H) {
  const vert = A.fit !== "none";
  const fs1 = Math.round(Math.min(W, H) * 0.06);
  const fs2 = Math.round(Math.min(W, H) * 0.055);
  const mv = Math.round(H * (vert ? 0.27 : 0.1));
  const mvHook = Math.round(H * 0.13);
  const head = `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,DejaVu Sans,${fs1},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,${Math.round(fs1 / 9)},2,2,60,60,${mv},1
Style: Hook,DejaVu Sans,${fs2},&H00FFFFFF,&H00FFFFFF,&H30000000,&H30000000,1,0,0,0,100,100,0,0,3,${Math.round(fs2 / 4)},0,8,70,70,${mvHook},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const ev = [];
  const clean = (w) => {
    const t = w.replace(/[{}\\]/g, "").replace(/[.,;:…]+$/, "");
    return A.upper ? t.toUpperCase() : t;
  };
  if (!A["no-hook"] && clip.title) {
    ev.push(`Dialogue: 1,${cs(0)},${cs(Math.min(3.2, clip.end - clip.start))},Hook,,0,0,0,,${clip.title.replace(/[{}\\]/g, "")}`);
  }
  if (!A["no-captions"]) {
    const ws = [];
    for (let i = clip.a; i <= clip.b; i++) ws.push(...S[i].words);
    const groups = [];
    let g = [];
    ws.forEach((w, i) => {
      g.push(w);
      const nx = ws[i + 1];
      if (g.length >= 3 || !nx || nx.s - w.e > 0.4 || /[.?!]$/.test(w.w)) { groups.push(g); g = []; }
    });
    groups.forEach((grp, gi) => {
      const nextStart = groups[gi + 1] ? groups[gi + 1][0].s : Infinity;
      grp.forEach((w, wi) => {
        const st = w.s - clip.start;
        const en = Math.max((grp[wi + 1] ? grp[wi + 1].s : Math.min(w.e + 0.2, nextStart)) - clip.start, st + 0.08);
        const text = grp
          .map((x, xi) => (xi === wi ? `{\\c&H00E5FF&}${clean(x.w)}{\\c&HFFFFFF&}` : clean(x.w)))
          .join(" ");
        ev.push(`Dialogue: 0,${cs(st)},${cs(en)},Cap,,0,0,0,,${text}`);
      });
    });
  }
  return head + ev.join("\n") + "\n";
}

// ---------- 5) render ----------
function render(clip, S, info, dir, name) {
  const vertOut = A.fit !== "none";
  const W = vertOut ? 1080 : info.w - (info.w % 2);
  const H = vertOut ? 1920 : info.h - (info.h % 2);
  const assFile = name.replace(/\.mp4$/, ".ass");
  fs.writeFileSync(path.join(dir, assFile), makeAss(clip, S, W, H));
  const subs = A["no-captions"] && A["no-hook"] ? "" : `,ass=${assFile}`;
  const landscape = info.w > info.h;
  let g;
  if (!vertOut) g = `[0:v]scale=${W}:${H},setsar=1${subs}[v]`;
  else if (!landscape) g = `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1${subs}[v]`;
  else if (A.fit === "blur") {
    g = `[0:v]split=2[bg][fg];[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=30:6[b];[fg]scale=1080:-2[f];[b][f]overlay=(W-w)/2:(H-h)/2,setsar=1${subs}[v]`;
  } else g = `[0:v]crop=w=ih*9/16:h=ih:x=(iw-ow)*${X}:y=0,scale=1080:1920,setsar=1${subs}[v]`;
  run("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-ss", clip.start.toFixed(2), "-t", (clip.end - clip.start).toFixed(2), "-i", path.resolve(A.input),
    "-filter_complex", g, "-map", "[v]", "-map", "0:a?",
    "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", name,
  ], { cwd: dir });
}

const slug = (t) =>
  t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "klip";

// ---------- main ----------
if (!A.input || !fs.existsSync(A.input)) {
  log(`Pouziti: npm run opus -- -i video.mp4 [-n 5] [--min 20] [--max 60] [--fit crop|blur|none] [--x 0.5]
                             [--lang cs] [--hint "jmena, terminy"] [--upper] [--no-captions] [--no-hook] [-o slozka]`);
  process.exit(1);
}
if (!KEY) { log("Chybi GROQ_API_KEY."); process.exit(1); }
if (!["crop", "blur", "none"].includes(A.fit)) { log("--fit musi byt crop, blur nebo none."); process.exit(1); }

try {
  const input = path.resolve(A.input);
  const dir = path.resolve(A.out);
  fs.mkdirSync(dir, { recursive: true });
  const info = probe(input);
  log(`Video: ${info.w}x${info.h}, ${mmss(info.duration)}${info.w > info.h ? " (na sirku)" : " (na vysku)"}`);

  const tr = await transcribe(input, info.duration, dir);
  for (const w of tr.words) w.w = w.w.replace(/^Zaban(ovi)?/, (m, x) => (x ? "Zemanovi" : "Zeman"));
  const S = buildSentences(tr.words, tr.segEnds);
  log(`Prepis: ${tr.words.length} slov, ${S.length} vet`);
  if (S.length < 3) throw new Error("Prepis je skoro prazdny (zadna rec?).");

  const clips = await pickClips(S, info.duration);
  if (!clips.length) throw new Error("AI nenasla zadny pouzitelny klip. Zkus jiny zdroj nebo --min 10.");

  for (const c of clips) { const t = await makeTitle(S, c.a, c.b); if (t) c.title = t; }
  const report = [];
  clips.forEach((c, i) => {
    const name = `${String(i + 1).padStart(2, "0")}_score${c.score}_${slug(c.title)}.mp4`;
    log(`Renderuji ${i + 1}/${clips.length}: ${name}`);
    render(c, S, info, dir, name);
    report.push({ file: name, start: +c.start.toFixed(2), end: +c.end.toFixed(2), score: c.score, title: c.title, reason: c.reason });
  });
  fs.writeFileSync(path.join(dir, "clips.json"), JSON.stringify(report, null, 2));

  log("\nHotovo. Klipy jsou ve slozce: " + dir + "\n");
  report.forEach((r, i) => {
    log(`${String(i + 1).padStart(2)}. ${String(r.score).padStart(3)}/100  ${mmss(r.start)}-${mmss(r.end)} (${Math.round(r.end - r.start)} s)  ${r.title}`);
    if (r.reason) log(`      ${r.reason}`);
  });
} catch (e) {
  console.error("\nChyba: " + e.message);
  process.exit(1);
}