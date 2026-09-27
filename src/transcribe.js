import { spawn } from "child_process";
import fs from "fs";
import OpenAI from "openai";

const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

export function extractAudio(inputVideoPath, outputAudioPath) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", [
      "-y", "-i", inputVideoPath, "-vn",
      "-acodec", "libmp3lame", "-q:a", "4",
      outputAudioPath,
    ]);
    ffmpeg.stderr.on("data", () => {});
    ffmpeg.on("close", (code) => {
      if (code === 0) resolve(outputAudioPath);
      else reject(new Error("ffmpeg extractAudio selhal s kodem " + code));
    });
    ffmpeg.on("error", (err) => {
      reject(new Error("Nepodarilo se spustit ffmpeg: " + err.message));
    });
  });
}

export async function transcribeAudio(audioPath) {
  const fileSizeMb = fs.statSync(audioPath).size / (1024 * 1024);
  if (fileSizeMb > 24) {
    throw new Error("Zvukovy soubor ma " + fileSizeMb.toFixed(1) + " MB. Limit je 25 MB.");
  }

  const transcription = await groq.audio.transcriptions.create({
    file: fs.createReadStream(audioPath),
    model: "whisper-large-v3-turbo",
    response_format: "verbose_json",
  });

  return transcription.segments.map((s) => ({
    start: s.start,
    end: s.end,
    text: s.text.trim(),
  }));
}

export function formatTranscriptForPrompt(segments) {
  return segments
    .map((s) => "[" + s.start.toFixed(1) + "s - " + s.end.toFixed(1) + "s] " + s.text)
    .join("\n");
}
