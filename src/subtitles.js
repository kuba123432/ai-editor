import fs from "fs";

function formatSrtTime(seconds) {
  if (seconds < 0) seconds = 0;
  const ms = Math.round((seconds % 1) * 1000);
  const totalSeconds = Math.floor(seconds);
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);
  const pad = (n, len) => String(n).padStart(len, "0");
  return pad(h, 2) + ":" + pad(m, 2) + ":" + pad(s, 2) + "," + pad(ms, 3);
}

export function buildSrtForClips(segments, clips) {
  const entries = [];
  let clipOffset = 0;

  for (const clip of clips) {
    const clipStart = clip.start;
    const clipEnd = clip.end;
    const clipDuration = clipEnd - clipStart;

    for (const seg of segments) {
      const segStart = Math.max(seg.start, clipStart);
      const segEnd = Math.min(seg.end, clipEnd);

      if (segEnd > segStart) {
        const newStart = clipOffset + (segStart - clipStart);
        const newEnd = clipOffset + (segEnd - clipStart);
        entries.push({ start: newStart, end: newEnd, text: seg.text.trim() });
      }
    }

    clipOffset += clipDuration;
  }

  let srt = "";
  entries.forEach((entry, i) => {
    srt += (i + 1) + "\n";
    srt += formatSrtTime(entry.start) + " --> " + formatSrtTime(entry.end) + "\n";
    srt += entry.text + "\n\n";
  });

  return srt;
}

export function writeSrtFile(segments, clips, srtPath) {
  const srt = buildSrtForClips(segments, clips);
  fs.writeFileSync(srtPath, srt, "utf-8");
  return srtPath;
}
