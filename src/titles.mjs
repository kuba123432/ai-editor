// src/titles.mjs - hook titulek z PRVNICH vet hotoveho klipu (nemuze vychazet z pozdejsi casti)
const KEY = process.env.GROQ_API_KEY;
const BASE = process.env.GROQ_BASE || "https://api.groq.com/openai/v1";
const LLM = process.env.LLM_MODEL || "openai/gpt-oss-20b";

async function ask(system, user) {
  for (let i = 1; i <= 4; i++) {
    const body = {
      model: LLM,
      temperature: 0.3,
      max_tokens: 1500,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    };
    if (LLM.includes("gpt-oss")) body.reasoning_effort = "low";
    const res = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return (await res.json()).choices[0].message.content;
    if (res.status === 429 && i < 4) {
      const wait = (parseFloat(res.headers.get("retry-after")) || 10 * i) + 1;
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    throw new Error("Groq " + res.status);
  }
}

const SYS = `Dostaneš začátek krátkého videa (TikTok/Reels/Shorts). Napiš jeden hook titulek česky, který diváka zastaví při scrollování.
Pravidla:
- max 60 znaků
- vychází POUZE z dodaného textu, nic si nevymýšlej a nepřidávej fakta ani jména, která v textu nejsou
- titulek musí odpovídat tomu, co se říká hned na začátku
- může být tvrzení nebo otázka, ne název tématu
- bez emoji, bez uvozovek
Odpověz POUZE samotným titulkem, nic jiného.`;

function clean(t) {
  let s = String(t || "")
    .split("\n")[0]
    .replace(/["„“”'`]/g, "")
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > 60) {
    s = s.slice(0, 60);
    const i = s.lastIndexOf(" ");
    if (i > 30) s = s.slice(0, i);
  }
  return s;
}

// vrati novy titulek, nebo null (kdyz AI selze) -> volajici necha puvodni title
export async function makeTitle(S, a, b) {
  try {
    const text = S.slice(a, Math.min(b + 1, a + 3)).map((x) => x.text).join(" ").slice(0, 500);
    const t = clean(await ask(SYS, text));
    return t.length >= 5 ? t : null;
  } catch {
    return null;
  }
}
