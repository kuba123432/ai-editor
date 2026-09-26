import "dotenv/config";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import { extractAudio, transcribeAudio, formatTranscriptForPrompt } from "./transcribe.js";
import { selectClips } from "./selectClips.js";
import { buildEditedVideo, addWatermark } from "./cutVideo.js";

const argv = yargs(hideBin(process.argv))
  .option("input", { alias: "i", type: "string", demandOption: true, describe: "Cesta ke vstupnimu videu" })
  .option("prompt", { alias: "p", type: "string", demandOption: true, describe: "Co chces, aby AI z videa udelala" })
  .option("output", { alias: "o", type: "string", default: "output.mp4", describe: "Cesta k vyslednemu videu" })
  .option("watermark", { type: "boolean", default: true, describe: "Pridat watermark" })
  .help()
  .parse();

function getDurationSeconds(videoPath) {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      videoPath,
    ]);
    let out = "";
    ffprobe.stdout.on("data", (d) => (out += d.toString()));
    ffprobe.on("close", (code) => {
      if (code === 0) resolve(parseFloat(out.trim()));
      else reject(new Error("ffprobe selhal"));
    });
    ffprobe.on("error", (err) => reject(new Error("Nepodarilo se spustit ffprobe: " + err.message)));
  });
}

async function main() {
  if (!fs.existsSync(argv.input)) {
    console.error("Vstupni soubor neexistuje: " + argv.input);
    process.exit(1);
  }

  const tmpDir = path.join(process.cwd(), ".tmp_ai_editor");
  fs.mkdirSync(tmpDir, { recursive: true });
  const audioPath = path.join(tmpDir, "audio.mp3");

  console.log("1/5 Zjistuju delku videa...");
  const durationSeconds = await getDurationSeconds(argv.input);
  console.log("    Delka: " + durationSeconds.toFixed(1) + "s");

  console.log("2/5 Vytahuju zvuk z videa...");
  await extractAudio(argv.input, audioPath);

  console.log("3/5 Prepisuju rec na text (Whisper)...");
  const segments = await transcribeAudio(audioPath);
  const transcriptText = formatTranscriptForPrompt(segments);
  console.log("    Nalezeno " + segments.length + " useku reci.");

  console.log("4/5 Vybiram nejlepsi momenty podle promptu (Claude)...");
  const clips = await selectClips(transcriptText, argv.prompt, durationSeconds);
  console.log("    AI vybrala " + clips.length + " useku.");

  console.log("5/5 Strihaм a skladam finalni video...");
  const rawOutput = argv.watermark ? path.join(tmpDir, "no_watermark.mp4") : argv.output;
  await buildEditedVideo(argv.input, clips, rawOutput, tmpDir);

  if (argv.watermark) {
    await addWatermark(rawOutput, argv.output);
  }

  console.log("\nHotovo! Vysledek: " + argv.output);
}

main().catch((err) => {
  console.error("\nChyba:", err.message);
  process.exit(1);
});
