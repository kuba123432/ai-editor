// src/checkstart.mjs - druhy krok: overi, ze klip zacina vetou, ktera dava smysl sama o sobe
const KEY = process.env.GROQ_API_KEY;
const BASE = process.env.GROQ_BASE || "https://api.groq.com/openai/v1";
const LLM = process.env.LLM_MODEL || "openai/gpt-oss-20b";

async function ask(system, user) {
  for (let i = 1; i <= 4; i++) {
    const body = {
      model: LLM,
      temperature: 0,
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

const SYS = `Kontroluješ začátek krátkého videoklipu. Divák uvidí jen klip, ne nic před ním.
Dostaneš 2 věty PŘED klipem (jen pro kontext) a prvních 4 vět klipu, očíslovaných 0 až 3.
Urči, která z vět 0 až 3 je nejdřívější, od které lze klip začít tak, aby byl začátek srozumitelný sám o sobě.
Věta NENÍ vhodný začátek, když odpovídá na otázku, kterou divák neslyšel (např. "Záleží...", "Ano", "Ne", "Právě"), navazuje na dřívější myšlenku (a, ale, takže, protože, to, tam, on...), nebo je jen pozdrav či poděkování.
Odpověz POUZE JSON: {"first":N}, N je 0 až 3, nebo -1, když žádná z nich nevyhovuje.`;

// vrati nove id prvni vety, puvodni a (kdyz je vse OK nebo kontrola selze), nebo null (klip zahodit)
export async function checkStart(S, a, b, minLen) {
  try {
    const ctx = S.slice(Math.max(0, a - 2), a).map((x) => x.text).join(" ") || "(nic)";
    const first = S.slice(a, Math.min(b + 1, a + 4)).map((x, i) => `${i}: ${x.text}`).join("\n");
    const c = await ask(SYS, `PŘED KLIPEM: ${ctx}\n\nKLIP:\n${first}`);
    const n = Math.round(Number(JSON.parse(c.slice(c.indexOf("{"), c.lastIndexOf("}") + 1)).first));
    if (n === -1) return null;
    if (!Number.isFinite(n) || n < 0 || n > 3 || a + n > b) return a;
    if (S[b].e - S[a + n].s < minLen) return null;
    return a + n;
  } catch {
    return a;
  }
}
