import { spawn } from "child_process";
import fs from "fs";
import path from "path";

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", args);
    let stderr = "";
    ffmpeg.stderr.on("data", (d) => (stderr += d.toString()));
    ffmpeg.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error("ffmpeg selhal (kod " + code + "):\n" + stderr.slice(-1000)));
    });
    ffmpeg.on("error", (err) => reject(new Error("Nepodarilo se spustit ffmpeg: " + err.message)));
  });
}

async function cutSingleClip(inputPath, start, end, outputPath) {
  const duration = end - start;
  await runFfmpeg([
    "-y",
    "-ss", String(start),
    "-i", inputPath,
    "-t", String(duration),
    "-c:v", "libx264",
    "-c:a", "aac",
    "-avoid_negative_ts", "make_zero",
    outputPath,
  ]);
}

async function concatClips(clipPaths, outputPath, tmpDir) {
  const listPath = path.join(tmpDir, "concat_list.txt");
  const listContent = clipPaths.map((p) => "file '" + path.resolve(p) + "'").join("\n");
  fs.writeFileSync(listPath, listContent);

  await runFfmpeg([
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", listPath,
    "-c", "copy",
    outputPath,
  ]);
}

export async function addWatermark(inputPath, outputPath, text) {
  if (!text) text = "made with ai-editor";
  await runFfmpeg([
    "-y",
    "-i", inputPath,
    "-vf", "drawtext=text='" + text + "':fontcolor=white@0.7:fontsize=20:x=w-tw-20:y=h-th-20",
    "-codec:a", "copy",
    outputPath,
  ]);
}

export async function buildEditedVideo(inputVideoPath, clips, outputPath, tmpDir) {
  fs.mkdirSync(tmpDir, { recursive: true });

  const clipPaths = [];
  for (let i = 0; i < clips.length; i++) {
    const start = clips[i].start;
    const end = clips[i].end;
    const clipPath = path.join(tmpDir, "clip_" + i + ".mp4");
    await cutSingleClip(inputVideoPath, start, end, clipPath);
    clipPaths.push(clipPath);
  }

  if (clipPaths.length === 1) {
    fs.copyFileSync(clipPaths[0], outputPath);
  } else {
    await concatClips(clipPaths, outputPath, tmpDir);
  }
}
