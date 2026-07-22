/**
 * Render PRYNX splash intro → video (Playwright + FFmpeg).
 *
 * Usage:
 *   npm run render:intro
 *   npm run render:intro -- --width 1920 --height 1080 --hold 3000 --fps 30
 *
 * Requires: playwright + chromium (devDeps). FFmpeg via system PATH or ffmpeg-static.
 *
 * Source of truth: scripts/intro/source/index.html
 * Outputs (default): desktop/scripts/intro/out/prynx-intro.webm
 *                    desktop/scripts/intro/out/prynx-intro.mp4
 */

import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function parseArgs(argv) {
  const out = {
    width: 1920,
    height: 1080,
    hold: 5000, // ms hold — 3D reveal ~4.4s + short settle
    exit: 650,
    fps: 30,
    scale: 1,
    brandOnly: false, // skip page/run scene
    frames: false,
    outDir: path.join(__dirname, 'out'),
    name: 'prynx-intro',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--width') out.width = Number(next());
    else if (a === '--height') out.height = Number(next());
    else if (a === '--hold') out.hold = Number(next());
    else if (a === '--exit') out.exit = Number(next());
    else if (a === '--fps') out.fps = Number(next());
    else if (a === '--scale') out.scale = Number(next());
    else if (a === '--brand-only') out.brandOnly = true;
    else if (a === '--frames') out.frames = true;
    else if (a === '--out') out.outDir = path.resolve(next());
    else if (a === '--name') out.name = next();
    else if (a === '--help' || a === '-h') {
      console.log(`render-intro.mjs options:
  --width N      viewport width (default 1920)
  --height N     viewport height (default 1080)
  --hold MS      hold before exit (default 5200)
  --exit MS      exit duration (default 700)
  --fps N        target fps (default 30)
  --scale N      deviceScaleFactor (default 1; use 2 for sharper)
  --brand-only   skip page→run→done scene, logo only
  --frames       also write PNG sequence under out/frames/
  --out DIR      output directory
  --name NAME    base filename (default prynx-intro)

Source: scripts/intro/source/index.html`);
      process.exit(0);
    }
  }
  return out;
}

function findFfmpeg() {
  // 1) System PATH
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg'], {
    encoding: 'utf8',
  });
  if (r.status === 0 && r.stdout.trim()) {
    return r.stdout.trim().split(/\r?\n/)[0];
  }
  // 2) Bundled ffmpeg-static (no system install needed)
  try {
    const staticPath = require('ffmpeg-static');
    if (staticPath && fs.existsSync(staticPath)) return staticPath;
  } catch {
    /* not installed */
  }
  return null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const htmlPath = path.join(__dirname, 'source', 'index.html');
  if (!fs.existsSync(htmlPath)) {
    console.error('Missing intro source at', htmlPath);
    process.exit(1);
  }

  fs.mkdirSync(opts.outDir, { recursive: true });
  const framesDir = path.join(opts.outDir, 'frames');
  if (opts.frames) {
    fs.rmSync(framesDir, { recursive: true, force: true });
    fs.mkdirSync(framesDir, { recursive: true });
  }

  const qs = new URLSearchParams();
  if (opts.brandOnly) qs.set('brandOnly', '1');
  const q = qs.toString();
  const url = pathToFileURL(htmlPath).href + (q ? `?${q}` : '');
  const totalMs = opts.hold + opts.exit;
  const ffmpeg = findFfmpeg();

  console.log(`PRYNX intro render
  source: ${htmlPath}
  size:   ${opts.width}x${opts.height} @ scale ${opts.scale}
  timing: hold ${opts.hold}ms + exit ${opts.exit}ms = ${totalMs}ms
  fps:    ${opts.fps}${opts.frames ? ' (PNG frames on)' : ''}
  out:    ${opts.outDir}
  ffmpeg: ${ffmpeg || '(not found — WebM only)'}
`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: opts.width, height: opts.height },
    deviceScaleFactor: opts.scale,
    recordVideo: {
      dir: opts.outDir,
      size: { width: opts.width, height: opts.height },
    },
  });

  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__PRYNX_INTRO_READY__ === true, null, {
    timeout: 8000,
  });

  const t0 = Date.now();
  let frameIdx = 0;
  const frameInterval = 1000 / opts.fps;

  // Capture loop: real-time screenshots (optional) while animation plays
  const capturePromise = (async () => {
    if (!opts.frames) {
      await sleep(opts.hold);
      await page.evaluate(() => window.__PRYNX_PLAY_EXIT__());
      await sleep(opts.exit);
      return;
    }

    while (Date.now() - t0 < totalMs) {
      const elapsed = Date.now() - t0;
      if (elapsed >= opts.hold) {
        // trigger exit once
        await page.evaluate(() => {
          if (!window.__PRYNX_EXIT_FIRED__) {
            window.__PRYNX_EXIT_FIRED__ = true;
            window.__PRYNX_PLAY_EXIT__();
          }
        });
      }

      const name = `frame-${String(frameIdx).padStart(5, '0')}.png`;
      await page.screenshot({
        path: path.join(framesDir, name),
        type: 'png',
        animations: 'allow',
      });
      frameIdx++;

      const nextAt = t0 + frameIdx * frameInterval;
      const wait = nextAt - Date.now();
      if (wait > 0) await sleep(wait);
    }
  })();

  if (!opts.frames) {
    await capturePromise;
  } else {
    await capturePromise;
  }

  // Close page to finalize Playwright video
  const video = page.video();
  await page.close();
  const rawVideoPath = video ? await video.path() : null;
  await context.close();
  await browser.close();

  let webmPath = path.join(opts.outDir, `${opts.name}.webm`);
  if (rawVideoPath && fs.existsSync(rawVideoPath)) {
    // Playwright names the file randomly — rename/copy to stable name
    fs.copyFileSync(rawVideoPath, webmPath);
    if (path.resolve(rawVideoPath) !== path.resolve(webmPath)) {
      try {
        fs.unlinkSync(rawVideoPath);
      } catch {
        /* keep raw if locked */
      }
    }
    console.log('✓ WebM:', webmPath);
  } else {
    webmPath = null;
    console.warn('Playwright video path missing — use --frames + ffmpeg instead.');
  }

  // Prefer high-quality MP4 from PNG sequence when available
  const mp4Path = path.join(opts.outDir, `${opts.name}.mp4`);
  if (ffmpeg && opts.frames && frameIdx > 0) {
    const pattern = path.join(framesDir, 'frame-%05d.png');
    const r = spawnSync(
      ffmpeg,
      [
        '-y',
        '-framerate',
        String(opts.fps),
        '-i',
        pattern,
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-crf',
        '18',
        '-preset',
        'slow',
        '-movflags',
        '+faststart',
        mp4Path,
      ],
      { encoding: 'utf8' },
    );
    if (r.status === 0 && fs.existsSync(mp4Path)) {
      console.log('✓ MP4 (from frames):', mp4Path);
    } else {
      console.error('ffmpeg frame encode failed:', r.stderr?.slice(-500));
    }
  } else if (ffmpeg && webmPath) {
    const r = spawnSync(
      ffmpeg,
      [
        '-y',
        '-i',
        webmPath,
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-crf',
        '18',
        '-preset',
        'slow',
        '-movflags',
        '+faststart',
        mp4Path,
      ],
      { encoding: 'utf8' },
    );
    if (r.status === 0 && fs.existsSync(mp4Path)) {
      console.log('✓ MP4 (from webm):', mp4Path);
    } else {
      console.error('ffmpeg webm→mp4 failed:', r.stderr?.slice(-500));
    }
  } else if (!ffmpeg) {
    console.error(
      'No FFmpeg found. Install devDep: npm i -D ffmpeg-static  (or put ffmpeg on PATH).',
    );
    process.exitCode = 1;
  }

  if (opts.frames) {
    console.log(`✓ Frames: ${frameIdx} PNGs in ${framesDir}`);
  }

  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
