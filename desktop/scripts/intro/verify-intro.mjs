/**
 * Visual QA for PRYNX intro source + rendered MP4.
 * Run: node scripts/intro/verify-intro.mjs
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const root = path.join(__dirname);
const source = path.join(root, 'source', 'index.html');
const outDir = path.join(root, 'out');
const verifyDir = path.join(outDir, 'verify');
const mp4 = path.join(outDir, 'prynx-intro.mp4');

function findFfmpeg() {
  try {
    const p = require('ffmpeg-static');
    if (p && fs.existsSync(p)) return p;
  } catch { /* */ }
  return null;
}

async function analyzeImage(page, filePath) {
  const buf = fs.readFileSync(filePath);
  const dataUrl = `data:image/png;base64,${buf.toString('base64')}`;
  await page.setContent(
    `<!doctype html><canvas id="c"></canvas><img id="i" src="${dataUrl}">`,
  );
  await page.waitForFunction(() => document.getElementById('i').complete);
  return page.evaluate(() => {
    const img = document.getElementById('i');
    const c = document.getElementById('c');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
    let dark = 0;
    let mid = 0;
    let light = 0;
    for (let i = 0; i < data.length; i += 32) {
      const l = (data[i] + data[i + 1] + data[i + 2]) / 3;
      if (l < 80) dark++;
      else if (l < 200) mid++;
      else light++;
    }
    const tot = dark + mid + light || 1;
    const cx = Math.floor(width / 2);
    const cy = Math.floor(height / 2);
    const sample = ctx.getImageData(Math.max(0, cx - 60), Math.max(0, cy - 40), 120, 80).data;
    let sum = 0;
    let sc = 0;
    for (let i = 0; i < sample.length; i += 4) {
      sum += (sample[i] + sample[i + 1] + sample[i + 2]) / 3;
      sc++;
    }
    return {
      w: width,
      h: height,
      darkPct: +(100 * dark / tot).toFixed(2),
      midPct: +(100 * mid / tot).toFixed(2),
      lightPct: +(100 * light / tot).toFixed(2),
      centerMean: +(sum / sc).toFixed(1),
    };
  });
}

function fail(msg) {
  console.error('FAIL:', msg);
  process.exitCode = 1;
}

async function main() {
  fs.mkdirSync(verifyDir, { recursive: true });
  const issues = [];

  if (!fs.existsSync(source)) {
    fail(`missing source ${source}`);
    return;
  }
  if (!fs.existsSync(path.join(root, 'source', 'vendor', 'gsap.min.js'))) {
    issues.push('vendor/gsap.min.js missing');
  }

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
  });
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });

  const url = pathToFileURL(source).href;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });

  try {
    await page.waitForFunction(() => window.__PRYNX_INTRO_READY__ === true, null, {
      timeout: 8000,
    });
  } catch {
    issues.push('__PRYNX_INTRO_READY__ never set');
  }

  const meta = await page.evaluate(() => ({
    gsap: typeof gsap !== 'undefined',
    pieces: document.querySelectorAll('.logo-piece').length,
    letters: document.querySelectorAll('.flip-letter').length,
    exitFn: typeof window.__PRYNX_PLAY_EXIT__ === 'function',
    slogan: document.querySelector('#slogan')?.textContent?.trim() || '',
  }));

  console.log('meta', meta);
  if (!meta.gsap) issues.push('GSAP not loaded');
  if (meta.pieces !== 4) issues.push(`expected 4 logo pieces, got ${meta.pieces}`);
  if (meta.letters !== 5) issues.push(`expected 5 letters, got ${meta.letters}`);
  if (!meta.exitFn) issues.push('__PRYNX_PLAY_EXIT__ missing');
  if (!/print made easy/i.test(meta.slogan)) issues.push(`bad slogan: ${meta.slogan}`);

  // Wait until full hold frame (~4.2s from ready)
  await page.waitForTimeout(4300);

  const holdState = await page.evaluate(() => {
    const pick = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        opacity: parseFloat(s.opacity),
        w: Math.round(r.width),
        h: Math.round(r.height),
        y: Math.round(r.y),
      };
    };
    return {
      camera: pick('#camera'),
      piece1: pick('#piece1'),
      flipP: pick('#flipP'),
      flipX: pick('#flipX'),
      slogan: pick('#slogan'),
    };
  });
  console.log('holdState', holdState);

  if (!holdState.camera || holdState.camera.opacity < 0.99) {
    issues.push('camera not fully visible at hold');
  }
  if (!holdState.piece1 || holdState.piece1.opacity < 0.99) {
    issues.push('logo pieces not visible at hold');
  }
  if (!holdState.flipP || holdState.flipP.opacity < 0.99 || holdState.flipP.h < 20) {
    issues.push(`letter P not visible properly: ${JSON.stringify(holdState.flipP)}`);
  }
  if (!holdState.flipX || holdState.flipX.opacity < 0.99 || holdState.flipX.h < 20) {
    issues.push(`letter X not visible properly: ${JSON.stringify(holdState.flipX)}`);
  }
  if (!holdState.slogan || holdState.slogan.opacity < 0.99) {
    issues.push('slogan not visible at hold');
  }

  // Bug check: GSAP sometimes leaves translateZ residual on letters
  const letterZ = await page.evaluate(() => {
    const el = document.querySelector('#flipP');
    const t = getComputedStyle(el).transform;
    // matrix3d m[14] is tz
    if (t.startsWith('matrix3d')) {
      const nums = t.slice(9, -1).split(',').map(Number);
      return nums[14];
    }
    return 0;
  });
  console.log('flipP translateZ residual:', letterZ);
  if (Math.abs(letterZ) > 1) {
    issues.push(`flip letters have residual translateZ=${letterZ} (looks like floating 3D glitch)`);
  }

  const holdShot = path.join(verifyDir, 'qa_hold.png');
  await page.screenshot({ path: holdShot, type: 'png' });
  await page.locator('.logo-group').screenshot({ path: path.join(verifyDir, 'qa_logo.png') });

  const holdStats = await analyzeImage(page, holdShot);
  console.log('hold pixel stats', holdStats);
  if (holdStats.darkPct < 0.3) {
    issues.push(`hold frame almost no dark ink (darkPct=${holdStats.darkPct}) — logo/text may be missing`);
  }

  // Exit hook
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__PRYNX_INTRO_READY__ === true);
  await page.waitForTimeout(1000);
  await page.evaluate(() => window.__PRYNX_PLAY_EXIT__());
  await page.waitForTimeout(700);
  const exitOp = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.intro-container')).opacity));
  console.log('exit container opacity', exitOp);
  if (exitOp > 0.15) issues.push(`exit did not fade enough (opacity=${exitOp})`);

  if (consoleErrors.length) {
    issues.push(`console errors: ${consoleErrors.join(' | ')}`);
  }

  // MP4 checks
  if (!fs.existsSync(mp4)) {
    issues.push('prynx-intro.mp4 missing — run npm run render:intro');
  } else {
    const ff = findFfmpeg();
    if (ff) {
      const probe = spawnSync(ff, ['-i', mp4], { encoding: 'utf8' });
      const info = (probe.stderr || '') + (probe.stdout || '');
      const durM = info.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
      const resM = info.match(/(\d{3,5})x(\d{3,5})/);
      let durationSec = 0;
      if (durM) {
        durationSec = (+durM[1]) * 3600 + (+durM[2]) * 60 + parseFloat(durM[3]);
      }
      console.log('mp4 durationSec', durationSec, 'res', resM && `${resM[1]}x${resM[2]}`);
      if (durationSec < 4) issues.push(`MP4 too short: ${durationSec}s`);
      if (durationSec > 12) issues.push(`MP4 unexpectedly long: ${durationSec}s`);
      if (!resM || resM[1] !== '1920' || resM[2] !== '1080') {
        issues.push(`MP4 resolution not 1920x1080: ${resM && `${resM[1]}x${resM[2]}`}`);
      }

      // Extract mid frame and analyze
      const midFrame = path.join(verifyDir, 'mp4_mid.png');
      spawnSync(ff, ['-y', '-ss', '3.5', '-i', mp4, '-frames:v', '1', midFrame], {
        encoding: 'utf8',
      });
      if (fs.existsSync(midFrame)) {
        const midStats = await analyzeImage(page, midFrame);
        console.log('mp4 mid-frame stats', midStats);
        if (midStats.darkPct < 0.2) {
          issues.push(`MP4 mid-frame looks empty (darkPct=${midStats.darkPct})`);
        }
      } else {
        issues.push('failed to extract MP4 mid frame');
      }
    }
  }

  await browser.close();

  console.log('\n======== QA RESULT ========');
  if (issues.length === 0) {
    console.log('PASS — intro source + hold frame + exit look healthy.');
  } else {
    console.log(`FAIL — ${issues.length} issue(s):`);
    for (const i of issues) console.log(' -', i);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
