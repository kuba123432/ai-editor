const UPSCALE = 4; // zvětšení před zoompanem (dej 3, když render padá na paměť)
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
 
function getVideoResolution(inputPath) {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height",
      "-of", "csv=s=x:p=0",
      inputPath,
    ]);
    let out = "";
    ffprobe.stdout.on("data", (d) => (out += d.toString()));
    ffprobe.on("close", (code) => {
      if (code === 0) {
        const parts = out.trim().split("x");
        resolve({ width: parseInt(parts[0], 10), height: parseInt(parts[1], 10) });
      } else reject(new Error("ffprobe (rozliseni) selhal"));
    });
    ffprobe.on("error", (err) => reject(new Error("Nepodarilo se spustit ffprobe: " + err.message)));
  });
}
 
async function cutSingleClip(inputPath, start, end, outputPath, zoomOptions) {
  const duration = end - start;
  const args = ["-y", "-ss", String(start), "-i", inputPath, "-t", String(duration)];
 
  if (zoomOptions) {
    const { width, height, fps, maxZoom } = zoomOptions;
    const totalFrames = Math.max(1, Math.round(duration * fps));
    const increment = (maxZoom - 1) / totalFrames;
    const zoomExpr = "min(zoom+" + increment.toFixed(6) + "," + maxZoom + ")";
    const vf =
      "scale=" + (width * UPSCALE) + ":-2" +
      ",zoompan=z='" + zoomExpr + "':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=" +
      width + "x" + height + ":fps=" + fps;
    args.push("-vf", vf);
  }
 
  args.push("-c:v", "libx264", "-c:a", "aac", "-avoid_negative_ts", "make_zero", outputPath);
 
  await runFfmpeg(args);
}
 
async function concatClips(clipPaths, outputPath, tmpDir) {
  const listPath = path.join(tmpDir, "concat_list.txt");
  const listContent = clipPaths.map((p) => "file '" + path.resolve(p) + "'").join("\n");
  fs.writeFileSync(listPath, listContent);
 
  await runFfmpeg([
    "-y", "-f", "concat", "-safe", "0", "-i", listPath,
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-c:a", "aac",
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
 
export async function burnAssSubtitles(inputPath, assPath, outputPath) {
  await runFfmpeg([
    "-y",
    "-i", inputPath,
    "-vf", "subtitles=" + assPath,
    "-c:a", "copy",
    outputPath,
  ]);
}
 
export async function buildEditedVideo(inputVideoPath, clips, outputPath, tmpDir, options) {
  options = options || {};
  fs.mkdirSync(tmpDir, { recursive: true });
 
  let zoomOptions = null;
  if (options.zoom) {
    const res = await getVideoResolution(inputVideoPath);
    zoomOptions = { width: res.width, height: res.height, fps: 30, maxZoom: 1.12 };
  }
 
  const clipPaths = [];
  for (let i = 0; i < clips.length; i++) {
    const start = clips[i].start;
    const end = clips[i].end;
    const clipPath = path.join(tmpDir, "clip_" + i + ".mp4");
    await cutSingleClip(inputVideoPath, start, end, clipPath, zoomOptions);
    clipPaths.push(clipPath);
  }
 
  if (clipPaths.length === 1) {
    fs.copyFileSync(clipPaths[0], outputPath);
  } else {
    await concatClips(clipPaths, outputPath, tmpDir);
  }
}


export async function makeVertical(inputPath, outputPath) {
  const filter =
    "[0:v]split=2[bg][fg];" +
    "[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=30:3[bgb];" +
    "[fg]scale=1080:-2:flags=lanczos[fgs];" +
    "[bgb][fgs]overlay=(W-w)/2:(H-h)/2,setsar=1[v]";
  await runFfmpeg([
    "-y",
    "-i", inputPath,
    "-filter_complex", filter,
    "-map", "[v]",
    "-map", "0:a?",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-c:a", "copy",
    outputPath,
  ]);
}
