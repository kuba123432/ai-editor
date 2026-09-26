import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic();

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

  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2000,
    system: systemPrompt,
    messages: [
      {
        role: "user",
        content: "Instrukce uzivatele: \"" + userPrompt + "\"\n\nPrepis videa:\n" + transcriptText,
      },
    ],
  });

  const rawText = message.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  let clips;
  try {
    const cleaned = rawText.replace(/^```json\s*|```$/g, "").trim();
    clips = JSON.parse(cleaned);
  } catch (err) {
    throw new Error("Claude nevratil validni JSON. Syrova odpoved:\n" + rawText + "\n\nChyba parsovani: " + err.message);
  }

  if (!Array.isArray(clips) || clips.length === 0) {
    throw new Error("Claude nevybral zadne useky. Zkus upravit prompt.");
  }

  return clips;
}
