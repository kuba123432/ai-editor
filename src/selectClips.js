import OpenAI from "openai";
 
const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});
 
function extractTargetDuration(userPrompt) {
  const match = userPrompt.match(/(\d+)\s*(sekund|vterin|sec|s\b)/i);
  if (match) return parseInt(match[1], 10);
  return 30;
}
 
export async function selectClips(transcriptText, userPrompt, totalDurationSeconds) {
  const targetDuration = extractTargetDuration(userPrompt);
 
  const systemPrompt =
    "Jsi zkuseny stribovy editor kratkych videi (Reels/TikTok/Shorts). Dostanes prepis videa s casovymi znackami (v sekundach) a instrukci od uzivatele.\n\n" +
    "Tvuj ukol NENI jen vybrat 'nejlepsi' izolovane momenty. Tvuj ukol je poskladat z useku puvodniho videa KRATKY PRIBEH s obloukem:\n" +
    "1. HOOK (prvni 1-3s) - nejpoutavejsi/nejprekvapivejsi vyrok nebo moment, ktery divaka okamzite zaujme a donuti ho nescrollovat dal.\n" +
    "2. KONTEXT / BUDOVANI - useky, ktere vysvetli o cem je rec nebo vystupnuji napeti/zajimavost smerem k vyvrcholeni.\n" +
    "3. VYVRCHOLENI / PAYOFF - zaver, ktery dava smysl, uzaviraj mysllenku, nebo je nejsilnejsi/nejvtipnejsi/nejprekvapivejsi cast.\n\n" +
    "Useky NEMUSI byt ve vyslednem poradi chronologicky podle puvodniho videa - poradi objektu ve vystupnim poli JE poradi, ve kterem se useky sestrihaji za sebe. " +
    "Poskladej je v poradi, ktere nejlepe vypravi pribeh (klidne hook z konce videa, kontext ze zacatku, atd.), pokud to davá vyssi smysl nez chronologicke razeni.\n\n" +
    "Video ma celkovou delku " + totalDurationSeconds.toFixed(0) + " sekund.\n" +
    "Cilova celkova delka vysledneho sestrihu je priblizne " + targetDuration + " sekund (tolerance +/- 3s). " +
    "Neber tolik useku, aby soucet jejich delek tuhle cilovou delku vyrazne prekrocil.\n\n" +
    "Odpovez VYHRADNE JSON polem, zadny text okolo, zadne markdown bloky. Format:\n" +
    "[{ \"start\": 12.3, \"end\": 18.7, \"role\": \"hook|kontext|payoff\", \"reason\": \"kratke zduvodneni proc a proc na tomto miste v pribehu\" }]\n\n" +
    "Pravidla:\n" +
    "- Casy musi byt v rozsahu 0 az " + totalDurationSeconds.toFixed(0) + ".\n" +
    "- Useky se nesmi prekryvat (i po pripadnem prerazeni).\n" +
    "- Kazdy usek by mel byt srozumitelny sam o sobe (nezacinat/nekoncit uprostred slova nebo vety, pokud se tomu da vyhnout).\n" +
    "- Poradi useku v poli odpovida poradi ve finalnim sestrihu - vyber ho tak, aby pribeh davai smysl.\n" +
    "- Vyber jen tolik useku, kolik je potreba pro souvisly pribeh s hookem, kontextem a payoffem (typicky 3-6 useku).";
 
  const completion = await groq.chat.completions.create({
    model: "openai/gpt-oss-120b",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: "Instrukce uzivatele: \"" + userPrompt + "\"\n\nPrepis videa:\n" + transcriptText },
    ],
  });
 
  const rawText = (completion.choices[0].message.content || "").trim();
 
  let clips;
  try {
    const cleaned = rawText.replace(/^```json\s*|```$/g, "").trim();
    clips = JSON.parse(cleaned);
  } catch (err) {
    throw new Error("Model nevratil validni JSON. Syrova odpoved:\n" + rawText + "\n\nChyba parsovani: " + err.message);
  }
 
  if (!Array.isArray(clips) || clips.length === 0) {
    throw new Error("Model nevybral zadne useky. Zkus upravit prompt.");
  }
 
  return clips;
}
