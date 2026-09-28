import fs from "fs";

function formatAssTime(seconds) {
  if (seconds < 0) seconds = 0;
  const totalCentiseconds = Math.round(seconds * 100);
  const cs = totalCentiseconds % 100;
  const totalSeconds = Math.floor(totalCentiseconds / 100);
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);
  const pad = (n, len) => String(n).padStart(len, "0");
  return h + ":" + pad(m, 2) + ":" + pad(s, 2) + "." + pad(cs, 2);
}

// Barvy v ASS jsou ve formatu BGR.
const COLOR_TEXT = "&HFFFFFF&"; // bila
const COLOR_ACTIVE = "&H00E6FF&"; // zluta (prave rikane slovo)

const ASS_HEADER =
  "[Script Info]\n" +
  "ScriptType: v4.00+\n" +
  "PlayResX: 1280\n" +
  "PlayResY: 720\n" +
  "ScaledBorderAndShadow: yes\n" +
  "WrapStyle: 2\n\n" +
  "[V4+ Styles]\n" +
  "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n" +
  "Style: Default,Arial,72,&H00FFFFFF,&H00FFFFFF,&H00000000,&H90000000,-1,0,0,0,100,100,1,0,1,5,2,2,60,60,110,1\n\n" +
  "[Events]\n" +
  "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n";

function escapeAss(text) {
  return text.replace(/\\/g, "").replace(/[{}]/g, "");
}

export function buildAssKaraoke(words, clips, opts) {
  opts = opts || {};
  // 1) slova prepocitame na casovou osu vysledneho videa, jen z useku s titulky
  const remapped = [];
  let clipOffset = 0;

  clips.forEach((clip, clipIndex) => {
    const clipStart = clip.start;
    const clipEnd = clip.end;
    const clipOutEnd = clipOffset + (clipEnd - clipStart);

    if (clip.subtitles !== false) {
      for (const w of words) {
        const wStart = Math.max(w.start, clipStart);
        const wEnd = Math.min(w.end, clipEnd);
        const visible = wEnd - wStart;
        const full = w.end - w.start;
        // slovo, ktere je useknute na okraji useku, nezobrazujeme
        if (w.word.length > 0 && visible > 0 && visible >= full * 0.6) {
          remapped.push({
            word: w.word,
            start: clipOffset + (wStart - clipStart),
            end: clipOffset + (wEnd - clipStart),
            clipIndex: clipIndex,
            clipOutEnd: clipOutEnd,
          });
        }
      }
    }

    clipOffset = clipOutEnd;
  });

  // 2) rozdelime na kratke radky (max 3 slova, konec vety = novy radek)
  const MAX_WORDS_PER_LINE = 3;
  const MAX_CHARS_PER_LINE = opts.vertical ? 14 : 18;
  const MAX_GAP_SECONDS = 0.6;
  const lines = [];
  let current = [];

  for (const w of remapped) {
    if (current.length > 0) {
      const prev = current[current.length - 1];
      const gap = w.start - prev.end;
      const chars = current.reduce((n, x) => n + x.word.length + 1, 0) + w.word.length;
      const endsSentence = /[.!?…]["')\]]*$/.test(prev.word);
      const endsSoft = /[,;:]["')\]]*$/.test(prev.word) && current.length >= 2;
      if (
        current.length >= MAX_WORDS_PER_LINE ||
        chars > MAX_CHARS_PER_LINE ||
        gap > MAX_GAP_SECONDS ||
        w.clipIndex !== prev.clipIndex ||
        endsSentence ||
        endsSoft
      ) {
        lines.push(current);
        current = [];
      }
    }
    current.push(w);
  }
  if (current.length > 0) lines.push(current);

  // 3) kazdy radek = jeden Dialogue, aktivni slovo se podbarvi
  let events = "";
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const lineStart = line[0].start;
    const clipOutEnd = line[0].clipOutEnd;
    const nextLine = lines[li + 1];

    let lineEnd = Math.max(line[line.length - 1].end + 0.15, lineStart + 0.6);
    lineEnd = Math.min(lineEnd, clipOutEnd);
    if (nextLine && nextLine[0].clipIndex === line[0].clipIndex) {
      lineEnd = Math.min(lineEnd, nextLine[0].start);
    }
    if (lineEnd <= lineStart) continue;

    let text = "{\\fad(70,60)\\fscx85\\fscy85\\t(0,140,\\fscx100\\fscy100)}";

    for (let i = 0; i < line.length; i++) {
      const w = line[i];
      const nextStart = i < line.length - 1 ? line[i + 1].start : lineEnd;
      const onMs = Math.max(0, Math.round((w.start - lineStart) * 1000));
      const offMs = Math.max(onMs + 1, Math.round((nextStart - lineStart) * 1000));
      text +=
        "{\\1c" + COLOR_TEXT +
        "\\t(" + onMs + "," + (onMs + 1) + ",\\1c" + COLOR_ACTIVE + ")" +
        "\\t(" + offMs + "," + (offMs + 1) + ",\\1c" + COLOR_TEXT + ")}" +
        escapeAss(w.word.toUpperCase()) +
        (i < line.length - 1 ? " " : "");
    }

    events +=
      "Dialogue: 0," +
      formatAssTime(lineStart) + "," +
      formatAssTime(lineEnd) +
      ",Default,,0,0,0," + "," + text + "\n";
  }

  let header = ASS_HEADER;
  if (opts.vertical) {
    header = header
      .replace("PlayResX: 1280", "PlayResX: 1080")
      .replace("PlayResY: 720", "PlayResY: 1920")
      .replace("Arial,72,", "Arial,88,")
      .replace(",1,5,2,2,60,60,110,1", ",1,6,2,2,60,60,430,1");
  }
  return header + events;
}

export function writeAssFile(words, clips, assPath, opts) {
  const ass = buildAssKaraoke(words, clips, opts);
  fs.writeFileSync(assPath, ass, "utf-8");
  return assPath;
}
