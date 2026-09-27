import OpenAI from "openai";

const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

export async function selectClips(transcriptText, userPrompt, totalDurationSeconds) {
  const systemPrompt = "Jsi editor videa. Dostanes prepis videa s casovymi znackami (v sekundach) a instrukci od uzivatele.\n" +
    "Tvuj ukol: vybrat useky videa, ktere se maji pouzit ve financim sestrihu, podle instrukce uzivatele.\n\n" +
    "Video ma celkovou delku " + totalDurationSeconds.toFixed(0) + " sekund.\n\n" +
    "Odpovez VYHRADNE JSON polem, zadny text okolo, zadne markdown bloky. Format:\n" +
    "[{ \"start\": 12.3, \"end\": 18.7, \"reason\": \"kratke zduvodneni\" }]\n\n" +
    "Pravidla:\n" +
    "- Casy musi byt v rozsahu 0 az " + totalDurationSeconds.toFixed(0) + ".\n" +
    "- Useky rad chronologicky (podle start).\n" +
    "- Useky se nesmi prekryvat.\n" +
    "- Vyber jen tolik useku, kolik odpovida pozadovane delce/typu vystupu z promptu uzivatele.";

  const completion = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
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
