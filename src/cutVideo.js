// src/cutVideo.js
// Střih klipů + Ken Burns zoom + titulky + watermark.
//
// Hlavní změna proti staré verzi (oprava rozjetého zvuku a zamrzlého konce):
//  1) každý klip se renderuje zvlášť se STEJNÝMI parametry (30 fps, stejné rozlišení, stejné audio)
//  2) délka videa v klipu je celý počet snímků a audio se na tu samou délku přesně
//     doplní/ořízne (apad + atrim), takže video a audio mají u každého klipu stejnou délku
//  3) klipy se spojí bez ztráty (PCM audio v mezisouboru), AAC se kóduje až jednou na konci
//  4) titulky a watermark se přidávají až ve finálním průchodu na celé časové ose
//  5) po renderu se změří délky a při rozdílu se vypíše varování

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FPS = 30;
const SAMPLE_RATE = 44100;

// ---------- pomocné funkce ----------

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} skončil s chybou ${code}:\n${err.split('\n').slice(-15).join('\n')}`));
    });
  });
}

async function probe(file) {
  const out = await run('ffprobe', [
    '-v', 'error',
    '-print_format', 'json',
    '-show_streams',
    '-show_format',
    file,
  ]);
  const info = JSON.parse(out);
  const v = info.streams.find((s) => s.codec_type === 'video');
  const a = info.streams.find((s) => s.codec_type === 'audio');
  return {
    width: v ? v.width : 0,
    height: v ? v.height : 0,
    hasAudio: !!a,
    videoDuration: v && v.duration ? parseFloat(v.duration) : parseFloat(info.format.duration),
    audioDuration: a && a.duration ? parseFloat(a.duration) : 0,
    duration: parseFloat(info.format.duration),
  };
}

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

// cesta k souboru s titulky do filtru ffmpeg (escapování : \ ')
const filterPath = (p) => p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");

// ---------- render jednoho klipu ----------

async function renderClip({ input, start, end, index, tmpDir, width, height, hasAudio, zoom }) {
  const rawDur = end - start;
  if (!(rawDur > 0)) throw new Error(`Klip ${index + 1} má neplatný čas (start ${start}, end ${end}).`);

  // celý počet snímků => video má přesnou délku
  const frames = Math.max(1, Math.round(rawDur * FPS));
  const dur = frames / FPS;
  const outFile = path.join(tmpDir, `clip_${String(index).padStart(3, '0')}.mov`);

  // Ken Burns: zoom od 1.0 do 1+zoom přes celý klip. Střídá se přiblížení a oddálení.
  // Obraz se před zoompanem zvětší 2x, aby zoom nedělal jitter (zaokrouhlování pozice).
  const zoomIn = index % 2 === 0;
  const zExpr = zoomIn
    ? `1+${zoom}*on/${frames}`
    : `1+${zoom}-${zoom}*on/${frames}`;

  const videoFilter =
    `[0:v]fps=${FPS},scale=${width * 2}:${height * 2}:flags=lanczos,setsar=1,` +
    `zoompan=z='${zExpr}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${width}x${height}:fps=${FPS},` +
    `setpts=PTS-STARTPTS,format=yuv420p[v]`;

  // audio: sjednotit formát, pak přesně na délku videa (doplnit tichem nebo oříznout)
  const audioFilter = hasAudio
    ? `[0:a]aresample=${SAMPLE_RATE},aformat=sample_fmts=s16:channel_layouts=stereo,` +
      `asetpts=PTS-STARTPTS,apad=whole_dur=${dur},atrim=end=${dur},asetpts=PTS-STARTPTS[a]`
    : `anullsrc=r=${SAMPLE_RATE}:cl=stereo,atrim=end=${dur},asetpts=PTS-STARTPTS[a]`;

  const args = [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-ss', String(start), '-t', String(rawDur + 0.5), // malá rezerva, přesnou délku řeší filtry
    '-i', input,
    '-filter_complex', `${videoFilter};${audioFilter}`,
    '-map', '[v]', '-map', '[a]',
    '-frames:v', String(frames),
    '-fps_mode', 'cfr', '-r', String(FPS),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'pcm_s16le', '-ar', String(SAMPLE_RATE), '-ac', '2',
    outFile,
  ];
  await run('ffmpeg', args);

  const info = await probe(outFile);
  const diff = Math.abs(info.videoDuration - info.audioDuration);
  if (diff > 0.05) {
    console.warn(
      `⚠️  Klip ${index + 1}: video ${info.videoDuration.toFixed(3)} s, audio ${info.audioDuration.toFixed(3)} s (rozdíl ${diff.toFixed(3)} s)`
    );
  }
  return { file: outFile, duration: info.videoDuration };
}

// ---------- hlavní funkce ----------

/**
 * @param {string} inputPath   zdrojové video
 * @param {Array<{start:number,end:number}>} clips  klipy v sekundách (start, end)
 * @param {string} outputPath  výsledné mp4
 * @param {object} [opts]
 * @param {string} [opts.subtitles]  cesta k .ass souboru (časy podle výsledného videa)
 * @param {boolean|string} [opts.watermark=true]  true = "made with ai-editor", nebo vlastní text, false = bez
 * @param {number} [opts.zoom=0.12]  síla Ken Burns zoomu (0 = vypnuto)
 * @returns {Promise<{outputPath:string, videoDuration:number, audioDuration:number, clipDurations:number[]}>}
 */
export async function cutVideo(inputPath, clips, outputPath, opts = {}) {
  if (!fs.existsSync(inputPath)) throw new Error(`Zdrojový soubor neexistuje: ${inputPath}`);
  if (!Array.isArray(clips) || clips.length === 0) throw new Error('Nejsou žádné klipy ke střihu.');

  const { subtitles = null, watermark = true, zoom = 0.12 } = opts;

  const src = await probe(inputPath);
  const width = even(src.width);
  const height = even(src.height);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-editor-'));

  try {
    // 1) render klipů
    const rendered = [];
    for (let i = 0; i < clips.length; i++) {
      const c = clips[i];
      const cStart = Math.max(0, Number(c.start));
      const cEnd = Math.min(Number(c.end), src.duration); // klip nesmí přesáhnout konec zdroje
      console.log(`Střih klipu ${i + 1}/${clips.length} (${cStart}s – ${cEnd}s)`);
      rendered.push(
        await renderClip({
          input: inputPath,
          start: cStart,
          end: cEnd,
          index: i,
          tmpDir,
          width,
          height,
          hasAudio: src.hasAudio,
          zoom,
        })
      );
    }

    // 2) spojení klipů (všechny mají stejné parametry, takže bez překódování)
    const listFile = path.join(tmpDir, 'list.txt');
    fs.writeFileSync(
      listFile,
      rendered.map((r) => `file '${r.file.replace(/'/g, "'\\''")}'`).join('\n')
    );
    const joined = path.join(tmpDir, 'joined.mov');
    await run('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'concat', '-safe', '0', '-i', listFile,
      '-c', 'copy', joined,
    ]);

    // 3) finální průchod: titulky + watermark + AAC
    const vf = [];
    if (subtitles) {
      if (!fs.existsSync(subtitles)) throw new Error(`Soubor s titulky neexistuje: ${subtitles}`);
      vf.push(`ass='${filterPath(path.resolve(subtitles))}'`);
    }
    if (watermark) {
      const text = (typeof watermark === 'string' ? watermark : 'made with ai-editor').replace(/[:'\\]/g, '');
      const fs_ = Math.max(14, Math.round(height / 40));
      vf.push(
        `drawtext=text='${text}':x=w-tw-${Math.round(fs_ * 0.8)}:y=h-th-${Math.round(fs_ * 0.8)}:` +
          `fontsize=${fs_}:fontcolor=white@0.6:shadowcolor=black@0.5:shadowx=1:shadowy=1`
      );
    }

    const videoCodec = vf.length
      ? ['-vf', vf.join(','), '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p']
      : ['-c:v', 'copy'];
    const finalArgs = [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', joined,
      ...videoCodec,
      '-c:a', 'aac', '-b:a', '160k', '-ar', String(SAMPLE_RATE),
      '-movflags', '+faststart',
      outputPath,
    ];
    await run('ffmpeg', finalArgs);

    // 4) kontrola
    const out = await probe(outputPath);
    const diff = Math.abs(out.videoDuration - out.audioDuration);
    if (diff > 0.1) {
      console.warn(
        `⚠️  CHYBA: audio a video nemají stejnou délku (video ${out.videoDuration.toFixed(2)} s, audio ${out.audioDuration.toFixed(2)} s)`
      );
    } else {
      console.log(
        `✅ Hotovo: ${out.videoDuration.toFixed(1)} s, audio a video sedí (rozdíl ${diff.toFixed(3)} s) → ${outputPath}`
      );
    }

    return {
      outputPath,
      videoDuration: out.videoDuration,
      audioDuration: out.audioDuration,
      clipDurations: rendered.map((r) => r.duration),
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export default cutVideo;
