import { createHash } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import playwright from '../desktop/node_modules/playwright/index.js';

const { chromium } = playwright;
const RAW_PDF_PATH = process.env.PRYNX_THUMB_STRESS_PDF || '';
const PDF_PATH = resolve(RAW_PDF_PATH);
const CDP_URL = process.env.PRYNX_THUMB_STRESS_CDP || 'http://127.0.0.1:9223';
const RAW_OUTPUT = process.env.PRYNX_THUMB_STRESS_OUTPUT
  || '.tmp/ppe_viewer_baseline/thumbnail-stress.json';
const OUTPUT = resolve(RAW_OUTPUT);
const EXPECTED_PAGES = Number(process.env.PRYNX_THUMB_STRESS_PAGES || 1000);
const WAIT_MS = 120_000;
const SETTLE_MS = 1_500;
const MAX_MOUNTED_ITEMS = 200;

if (!RAW_PDF_PATH) throw new Error('Thiếu PRYNX_THUMB_STRESS_PDF.');
if (!Number.isSafeInteger(EXPECTED_PAGES) || EXPECTED_PAGES < 100) {
  throw new Error('PRYNX_THUMB_STRESS_PAGES phải là số nguyên >= 100.');
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

function normalizeWindowsPath(path) {
  return String(path || '').replaceAll('/', '\\').toLowerCase();
}

async function sha256File(path) {
  const digest = createHash('sha256');
  const bytes = await (await import('node:fs/promises')).readFile(path);
  digest.update(bytes);
  return digest.digest('hex');
}

async function writeReport(value) {
  await mkdir(dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function findTargetPage(browser) {
  const pages = browser.contexts().flatMap((context) => context.pages());
  const candidates = [];
  for (const page of pages) {
    if (await page.locator('#root').count()
      && await page.evaluate(() => Boolean(window.__TAURI_INTERNALS__))) {
      candidates.push(page);
    }
  }
  if (candidates.length !== 1) {
    throw new Error(`Cần đúng 1 WebView PrynX qua CDP; hiện thấy ${candidates.length}.`);
  }
  return candidates[0];
}

async function dispatchPath(page) {
  return page.evaluate(async (path) => {
    const nativeFiles = await import('/src/lib/nativeFileAccess.ts');
    const prepared = await nativeFiles.createPathBackedFile(path);
    return {
      accepted: nativeFiles.dispatchSupportedSystemFiles([prepared.file]),
      size: prepared.stat?.size ?? null,
    };
  }, PDF_PATH);
}

async function workspaceState(page) {
  return page.evaluate((expectedPath) => {
    const root = document.getElementById('root');
    const rootKey = root && Object.keys(root).find((name) => name.startsWith('__reactContainer$'));
    if (!root || !rootKey) return null;
    const stack = [root[rootKey]];
    const seenFibers = new Set();
    const seenStores = new Set();
    const normalized = String(expectedPath || '').replaceAll('/', '\\').toLowerCase();
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node || seenFibers.has(node)) continue;
      seenFibers.add(node);
      for (const value of [node.memoizedProps?.value, node.pendingProps?.value]) {
        if (!value?.getState || seenStores.has(value)) continue;
        seenStores.add(value);
        const state = value.getState();
        const statePath = String(state?.file?.path || '').replaceAll('/', '\\').toLowerCase();
        if (statePath !== normalized || !('viewerNumPages' in (state || {}))) continue;
        return {
          numPages: Number(state.viewerNumPages) || 0,
          thumbnailOpen: state.viewerThumbMenuOpen === true,
          hasThumbSetter: typeof state.setViewerThumbMenuOpen === 'function',
        };
      }
      stack.push(node.child, node.sibling);
    }
    return null;
  }, normalizeWindowsPath(PDF_PATH));
}

async function waitForWorkspace(page) {
  const deadline = Date.now() + WAIT_MS;
  let last = null;
  while (Date.now() < deadline) {
    last = await workspaceState(page);
    if (last?.numPages === EXPECTED_PAGES) return last;
    await sleep(250);
  }
  throw new Error(`Không thấy workspace ${EXPECTED_PAGES} trang sau ${WAIT_MS} ms: ${JSON.stringify(last)}.`);
}

async function openThumbnailPanel(page) {
  return page.evaluate((expectedPath) => {
    const root = document.getElementById('root');
    const rootKey = root && Object.keys(root).find((name) => name.startsWith('__reactContainer$'));
    if (!root || !rootKey) throw new Error('Không tìm thấy React root.');
    const normalized = String(expectedPath || '').replaceAll('/', '\\').toLowerCase();
    const stack = [root[rootKey]];
    const seenFibers = new Set();
    const seenStores = new Set();
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node || seenFibers.has(node)) continue;
      seenFibers.add(node);
      for (const value of [node.memoizedProps?.value, node.pendingProps?.value]) {
        if (!value?.getState || seenStores.has(value)) continue;
        seenStores.add(value);
        const state = value.getState();
        const statePath = String(state?.file?.path || '').replaceAll('/', '\\').toLowerCase();
        if (statePath !== normalized || typeof state.setViewerThumbMenuOpen !== 'function') continue;
        state.setViewerThumbMenuOpen(true);
        return { opened: true, previous: state.viewerThumbMenuOpen === true };
      }
      stack.push(node.child, node.sibling);
    }
    return { opened: false };
  }, normalizeWindowsPath(PDF_PATH));
}

async function inspectDom(page) {
  return page.evaluate(() => {
    const scroll = document.querySelector('[data-virtuoso-scroller="true"]')
      || document.querySelector('.acro-thumb-scroll');
    const items = [...document.querySelectorAll('[data-thumb-index]')]
      .map((node) => Number(node.getAttribute('data-thumb-index')))
      .filter(Number.isFinite);
    const images = document.querySelectorAll('.acro-thumb-item img').length;
    const loadedImages = [...document.querySelectorAll('.acro-thumb-item img')]
      .filter((node) => node.complete && node.naturalWidth > 0).length;
    const memory = performance.memory
      ? {
          usedJSHeapSize: performance.memory.usedJSHeapSize,
          totalJSHeapSize: performance.memory.totalJSHeapSize,
          jsHeapSizeLimit: performance.memory.jsHeapSizeLimit,
        }
      : null;
    return {
      itemCount: items.length,
      minIndex: items.length ? Math.min(...items) : null,
      maxIndex: items.length ? Math.max(...items) : null,
      imageCount: images,
      loadedImageCount: loadedImages,
      scrollTop: scroll?.scrollTop ?? null,
      scrollHeight: scroll?.scrollHeight ?? null,
      clientHeight: scroll?.clientHeight ?? null,
      memory,
    };
  });
}

async function scrollToEnd(page) {
  await page.evaluate(() => {
    const scroll = document.querySelector('[data-virtuoso-scroller="true"]')
      || document.querySelector('.acro-thumb-scroll');
    if (!scroll) throw new Error('Không tìm thấy .acro-thumb-scroll.');
    scroll.scrollTop = scroll.scrollHeight;
    scroll.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await sleep(SETTLE_MS);
}

const report = {
  schemaVersion: 1,
  scope: 'installed-webview-thumbnail-virtualizer-stress',
  artifact: { name: '', sizeBytes: null, sha256: null, pathStored: false },
  expectedPages: EXPECTED_PAGES,
  maxMountedItems: MAX_MOUNTED_ITEMS,
  initial: null,
  afterScrollEnd: null,
  workspace: null,
  thumbnailPanel: null,
  virtualized: false,
  complete: false,
  failure: null,
};

let browser = null;
try {
  const artifact = await stat(PDF_PATH);
  report.artifact = {
    name: PDF_PATH.split('\\').at(-1) || PDF_PATH,
    sizeBytes: artifact.size,
    sha256: await sha256File(PDF_PATH),
    pathStored: false,
  };
  browser = await chromium.connectOverCDP(CDP_URL);
  const page = await findTargetPage(browser);
  const dispatched = await dispatchPath(page);
  if (dispatched.accepted !== 1) throw new Error(`Dispatcher nhận ${dispatched.accepted} file.`);
  report.workspace = await waitForWorkspace(page);
  report.thumbnailPanel = await openThumbnailPanel(page);
  if (!report.thumbnailPanel.opened) throw new Error('Không mở được thumbnail panel qua workspace store.');
  await page.waitForSelector('.acro-thumb-scroll', { timeout: 10_000 });
  await sleep(SETTLE_MS);
  report.initial = await inspectDom(page);
  await scrollToEnd(page);
  report.afterScrollEnd = await inspectDom(page);
  report.workspaceAfterOpen = await workspaceState(page);
  report.virtualized = report.initial.itemCount > 0
    && report.afterScrollEnd.itemCount > 0
    && report.initial.itemCount < MAX_MOUNTED_ITEMS
    && report.afterScrollEnd.itemCount < MAX_MOUNTED_ITEMS
    && report.initial.itemCount < EXPECTED_PAGES
    && report.afterScrollEnd.itemCount < EXPECTED_PAGES
    && report.afterScrollEnd.maxIndex >= EXPECTED_PAGES - 1;
  if (!report.virtualized) {
    throw new Error(
      `Virtualizer gate fail: initial=${report.initial.itemCount}, `
      + `end=${report.afterScrollEnd.itemCount}, `
      + `maxIndex=${report.afterScrollEnd.maxIndex}.`,
    );
  }
  report.complete = true;
} catch (error) {
  report.failure = String(error);
} finally {
  // connectOverCDP gắn vào WebView đang chạy; chỉ ngắt transport, không đóng PrynX.
  if (browser?._connection?.close) {
    const closing = browser._connection.close();
    if (closing && typeof closing.then === 'function') await closing.catch(() => undefined);
  }
  await writeReport(report);
}

if (!report.complete) {
  throw new Error(report.failure || 'Thumbnail stress chưa đạt.');
}
console.log(JSON.stringify({
  ok: true,
  pages: report.expectedPages,
  initialItems: report.initial.itemCount,
  endItems: report.afterScrollEnd.itemCount,
  endMaxIndex: report.afterScrollEnd.maxIndex,
}));
process.exit(0);
