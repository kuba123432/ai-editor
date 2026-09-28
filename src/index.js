import "dotenv/config";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import { extractAudio, transcribeAudio } from "./transcribe.js";
import { selectClips } from "./selectClips.js";
import { buildEditedVideo, addWatermark, burnAssSubtitles } from "./cutVideo.js";
import { writeAssFile } from "./subtitles.js";

const argv = yargs(hideBin(process.argv))
  .option("input", { alias: "i", type: "string", demandOption: true, describe: "Cesta ke vstupnimu videu" })
  .option("prompt", { alias: "p", type: "string", demandOption: true, describe: "Co chces, aby AI z videa udelala" })
  .option("output", { alias: "o", type: "string", default: "output.mp4", describe: "Cesta k vyslednemu videu" })
  .option("watermark", { type: "boolean", default: true, describe: "Pridat watermark" })
  .option("subtitles", { type: "boolean", default: true, describe: "Pridat vypalene titulky (AI je da jen tam, kde davaji smysl)" })
  .option("zoom", { type: "boolean", default: true, describe: "Pridat jemny zoom efekt na kazdy vybrany klip" })
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

  console.log("1/6 Zjistuju delku videa...");
  const durationSeconds = await getDurationSeconds(argv.input);
  console.log("    Delka: " + durationSeconds.toFixed(1) + "s");

  console.log("2/6 Vytahuju zvuk z videa...");
  await extractAudio(argv.input, audioPath);

  console.log("3/6 Prepisuju rec na text (Whisper)...");
  const { segments, words } = await transcribeAudio(audioPath);
  console.log("    Nalezeno " + segments.length + " useku reci, " + words.length + " slov.");

  console.log("4/6 Vybiram nejlepsi momenty podle promptu (Groq)...");
  const clips = await selectClips(segments, words, argv.prompt, durationSeconds);
  console.log("    AI vybrala " + clips.length + " useku:");
  clips.forEach((c, i) => {
    console.log(
      "    " + (i + 1) + ". [" + (c.role || "-") + "] " +
      c.start.toFixed(1) + "s-" + c.end.toFixed(1) + "s" +
      (c.subtitles ? " (titulky)" : "") + " \"" + c.text + "\""
    );
  });

  console.log("5/6 Striham a skladam finalni video" + (argv.zoom ? " (se zoomem, muze trvat dele)" : "") + "...");
  const cutOutput = path.join(tmpDir, "cut.mp4");
  await buildEditedVideo(argv.input, clips, cutOutput, tmpDir, { zoom: argv.zoom });

  let currentOutput = cutOutput;

  if (argv.subtitles && clips.some((c) => c.subtitles)) {
    console.log("    Pridavam titulky k napinavym momentum...");
    const assPath = path.join(tmpDir, "subtitles.ass");
    writeAssFile(words, clips, assPath);
    const withSubs = path.join(tmpDir, "with_subs.mp4");
    await burnAssSubtitles(currentOutput, assPath, withSubs);
    currentOutput = withSubs;
  } else if (argv.subtitles) {
    console.log("    AI nepovazovala zadny usek za dost napinavy na titulky, preskakuji.");
  }

  console.log("6/6 Pridavam watermark...");
  if (argv.watermark) {
    await addWatermark(currentOutput, argv.output);
  } else {
    fs.copyFileSync(currentOutput, argv.output);
  }

  if (process.argv.includes("--vertical")) {
    console.log("    Prevadim na 9:16 (Reels)...");
    const { makeVertical } = await import("./cutVideo.js");
    const flatPath = path.join(tmpDir, "flat.mp4");
    fs.copyFileSync(argv.output, flatPath);
    await makeVertical(flatPath, argv.output);
  }

  console.log("\nHotovo! Vysledek: " + argv.output);
}

main().catch((err) => {
  console.error("\nChyba:", err.message);
  process.exit(1);
});
