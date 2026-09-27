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

const ASS_HEADER =
  "[Script Info]\n" +
  "ScriptType: v4.00+\n" +
  "PlayResX: 1280\n" +
  "PlayResY: 720\n" +
  "ScaledBorderAndShadow: yes\n" +
  "WrapStyle: 2\n\n" +
  "[V4+ Styles]\n" +
  "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n" +
  "Style: Default,Arial,64,&H0000FFFF,&H00FFFFFF,&H00000000,&H96000000,-1,0,0,0,100,100,0,0,1,3,1,2,40,40,80,1\n\n" +
  "[Events]\n" +
  "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n";

export function buildAssKaraoke(words, clips) {
  const remapped = [];
  let clipOffset = 0;

  for (const clip of clips) {
    const clipStart = clip.start;
    const clipEnd = clip.end;

    for (const w of words) {
      const wStart = Math.max(w.start, clipStart);
      const wEnd = Math.min(w.end, clipEnd);
      if (wEnd > wStart && w.word.length > 0) {
        remapped.push({
          word: w.word,
          start: clipOffset + (wStart - clipStart),
          end: clipOffset + (wEnd - clipStart),
        });
      }
    }

    clipOffset += clipEnd - clipStart;
  }

  const MAX_WORDS_PER_LINE = 4;
  const MAX_GAP_SECONDS = 0.6;
  const lines = [];
  let current = [];

  for (const w of remapped) {
    if (current.length > 0) {
      const prev = current[current.length - 1];
      const gap = w.start - prev.end;
      if (current.length >= MAX_WORDS_PER_LINE || gap > MAX_GAP_SECONDS) {
        lines.push(current);
        current = [];
      }
    }
    current.push(w);
  }
  if (current.length > 0) lines.push(current);

  let events = "";
  for (const line of lines) {
    const lineStart = line[0].start;
    const lineEnd = line[line.length - 1].end;
    let text = "";

    for (let i = 0; i < line.length; i++) {
      const w = line[i];
      const nextStart = i < line.length - 1 ? line[i + 1].start : lineEnd;
      const kCentiseconds = Math.max(1, Math.round((nextStart - w.start) * 100));
      text += "{\\k" + kCentiseconds + "}" + w.word + " ";
    }

    events +=
      "Dialogue: 0," +
      formatAssTime(lineStart) +
      "," +
      formatAssTime(lineEnd) +
      ",Default,,0,0,0,," +
      text.trim() +
      "\n";
  }

  return ASS_HEADER + events;
}

export function writeAssFile(words, clips, assPath) {
  const ass = buildAssKaraoke(words, clips);
  fs.writeFileSync(assPath, ass, "utf-8");
  return assPath;
}
