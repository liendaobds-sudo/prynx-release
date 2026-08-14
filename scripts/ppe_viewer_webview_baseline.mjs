import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

import playwright from '../desktop/node_modules/playwright/index.js';

const { chromium } = playwright;
const RAW_PDF_PATH = process.env.PRYNX_VIEWER_BASELINE_PDF || '';
const PDF_PATH = resolve(RAW_PDF_PATH);
const CDP_URL = process.env.PRYNX_VIEWER_BASELINE_CDP || 'http://127.0.0.1:9223';
const RUNS = Number(process.env.PRYNX_VIEWER_BASELINE_RUNS || 60);
const SMOKE_MODE = process.env.PRYNX_VIEWER_BASELINE_SMOKE === '1';
const RAW_OUTPUT = process.env.PRYNX_VIEWER_BASELINE_OUTPUT
  || '.tmp/ppe_viewer_baseline/webview-baseline.json';
const OUTPUT = resolve(RAW_OUTPUT);
const REQUIRE_STANDEE_HASH = process.env.PRYNX_VIEWER_BASELINE_REQUIRE_STANDEE_HASH !== '0';
const POLL_MS = 16;
const TIMEOUT_MS = 60_000;
const SAMPLE_EDGE = 256;
const REQUIRED_STABLE_FRAMES = 2;
const MAX_SCREENSHOT_INTERVAL_MS = 60;
const VIEWPORT_COVERAGE_GATE = 0.98;
const SHARP_DENSITY_GATE = 0.98;
const TILE_GEOMETRY_TOLERANCE_PX = 4;
const WARM_ZOOM_FLOOR = 2;
const WARM_ZOOM_UP_FACTOR = 1.5;
const WARM_ZOOM_DOWN_FACTOR = 0.67;
const MEASUREMENT_SCOPE = 'main-page-thumbnail-closed';
const STANDEE_SHA256 = 'd3afdaa6c3940f0431fe26ea3cbeedb8e59fe85c2a802db49a95be856868f61c';
const PPE_PIPELINE_ID = 'ppe-fogra39-relative-view-knockout-png-v5-native-worker';
const TRACED_IPC_COMMANDS = new Set([
  'render_ppe_page',
  'render_pdf_page',
  'shadow_render_ppe_page',
  'get_pdf_viewer_bootstrap',
  'get_pdf_metadata',
]);
const ipcTraceByPage = new WeakMap();
const PERF_LOG_PATH = process.env.PRYNX_VIEWER_BASELINE_PERF_LOG
  || `${process.env.USERPROFILE || ''}\\Desktop\\PrynX_RenderPerf.log`;
const EXPECTED_RUNTIME_ENV = {
  PRYNX_VIEWER_ENGINE_MODE: 'ppe-only',
  PRYNX_VIEWER_SHADOW_RENDER: 'off-or-unset',
};

if (!process.env.PRYNX_VIEWER_BASELINE_PDF
  && process.env.PRYNX_VIEWER_BASELINE_SELF_TEST !== '1') {
  throw new Error('Thiếu PRYNX_VIEWER_BASELINE_PDF.');
}
if (!Number.isSafeInteger(RUNS)
  || RUNS % 2 !== 0
  || (SMOKE_MODE ? RUNS !== 2 : RUNS < 60)) {
  throw new Error(SMOKE_MODE
    ? 'Smoke cleanup cần đúng 2 lượt (1 cặp cold/warm).'
    : 'Baseline chính thức cần PRYNX_VIEWER_BASELINE_RUNS là số chẵn >= 60.');
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

function normalizedFsTarget(path) {
  const absolute = resolve(path);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

async function pathsReferToSameFile(first, second) {
  if (normalizedFsTarget(first) === normalizedFsTarget(second)) return true;
  try {
    const [firstStat, secondStat] = await Promise.all([stat(first), stat(second)]);
    return firstStat.dev === secondStat.dev
      && firstStat.ino !== 0
      && firstStat.ino === secondStat.ino;
  } catch {
    return false;
  }
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    try {
      await rename(temporary, path);
    } catch (error) {
      if (process.platform !== 'win32' || !['EEXIST', 'EPERM'].includes(error?.code)) throw error;
      const backup = `${path}.${process.pid}.${Date.now()}.bak`;
      let movedPrevious = false;
      try {
        await rename(path, backup);
        movedPrevious = true;
      } catch (moveError) {
        if (moveError?.code !== 'ENOENT') throw moveError;
      }
      try {
        await rename(temporary, path);
      } catch (replaceError) {
        if (movedPrevious) {
          try {
            await rename(backup, path);
          } catch {
            // Report cũ vẫn nằm ở file .bak; giữ nguyên để không mất bằng chứng.
          }
        }
        throw replaceError;
      }
      if (movedPrevious) await rm(backup, { force: true }).catch(() => undefined);
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

function redactReportValue(value) {
  if (typeof value === 'string') return sanitizeReportText(value);
  if (Array.isArray(value)) return value.map(redactReportValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactReportValue(item)]));
  }
  return value;
}

async function writeReportAtomic(path, value) {
  return writeJsonAtomic(path, redactReportValue(value));
}

async function sha256File(path) {
  const digest = createHash('sha256');
  digest.update(await readFile(path));
  return digest.digest('hex');
}

async function perfLogOffset() {
  try {
    return (await stat(PERF_LOG_PATH)).size;
  } catch {
    return null;
  }
}

async function readNewPerfLog(offset) {
  if (offset === null) return '';
  try {
    const bytes = await readFile(PERF_LOG_PATH);
    if (bytes.length < offset) {
      throw new Error('PrynX_RenderPerf.log bị truncate/rotate giữa lượt đo.');
    }
    return bytes.subarray(offset).toString('utf8');
  } catch (error) {
    throw new Error(`Không đọc được phần log native mới của lượt đo: ${error}`);
  }
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

function summarize(values) {
  return {
    count: values.length,
    min: values.length ? Math.min(...values) : null,
    p50: percentile(values, 0.50),
    p95: percentile(values, 0.95),
    max: values.length ? Math.max(...values) : null,
  };
}

function nativePerfEvidence(perfLog) {
  const ppeResultCount = (perfLog.match(/PPE_NATIVE_RESULT/g) || []).length;
  const displayResultCount = (perfLog.match(/RENDER_WORKER_RESULT/g) || []).length;
  return {
    available: perfLog.length > 0,
    ppeResultCount,
    displayResultCount,
    scope: 'global-log-supplemental-not-request-correlated',
  };
}

function pipelineEvidenceFromIpcTrace(traceSnapshot) {
  const calls = traceSnapshot?.calls || [];
  const viewerConfig = traceSnapshot?.viewerConfig;
  const ppeCalls = calls.filter((call) => call.command === 'render_ppe_page');
  const displayCalls = calls.filter((call) => call.command === 'render_pdf_page');
  const shadowCalls = calls.filter((call) => call.command === 'shadow_render_ppe_page');
  const observedConfigCalls = calls.filter((call) => (
    call.command === 'get_pdf_viewer_bootstrap' || call.command === 'get_pdf_metadata'
  ));
  const configCalls = observedConfigCalls.filter((call) => (
    normalizeWindowsPath(call.filePath || '') === normalizeWindowsPath(PDF_PATH)
  ));
  const foreignConfigCalls = observedConfigCalls.filter((call) => (
    normalizeWindowsPath(call.filePath || '') !== normalizeWindowsPath(PDF_PATH)
  ));
  const ppeFulfilled = ppeCalls.filter((call) => call.status === 'fulfilled');
  const ppeRejected = ppeCalls.filter((call) => call.status === 'rejected');
  const ppePending = ppeCalls.filter((call) => call.status === 'pending');
  const ppeStaleSequence = ppeCalls.filter((call) => call.resetSequence !== traceSnapshot?.resetSequence);
  const displayStaleSequence = displayCalls.filter((call) => call.resetSequence !== traceSnapshot?.resetSequence);
  const shadowStaleSequence = shadowCalls.filter((call) => call.resetSequence !== traceSnapshot?.resetSequence);
  const configRejected = configCalls.filter((call) => call.status === 'rejected');
  const configPending = configCalls.filter((call) => call.status === 'pending');
  const configInvalid = configCalls.filter((call) => (
    (call.status === 'fulfilled' && call.configPayloadValid !== true)
    || call.payloadParsed !== true
  ));
  const configUnexpected = configCalls.filter((call) => (
    call.status === 'fulfilled'
    && call.configPayloadValid === true
    && (call.viewerEngineMode !== 'ppe-only' || call.viewerShadowEnabled !== false)
  ));
  const tracedRenderCalls = [...ppeCalls, ...displayCalls, ...shadowCalls];
  const uniqueRequestIds = new Set(
    tracedRenderCalls.map((call) => call.requestId)
      .filter((value) => typeof value === 'string' && value),
  );
  const allPpeCallsIdentified = ppeCalls.every((call) => (
    call.payloadParsed === true
    && typeof call.requestId === 'string'
    && call.requestId.length > 0
    && call.pipelineIdentity === PPE_PIPELINE_ID
  ));
  const engineConfigSourcePathMatched = viewerConfig?.sourcePathMatched === true;
  const engineConfigCurrent = engineConfigSourcePathMatched
    && viewerConfig?.validatedResetSequence === traceSnapshot?.resetSequence;
  const engineConfigCapturedInRun = viewerConfig?.capturedResetSequence === traceSnapshot?.resetSequence;
  const latestPpeCompletedAt = ppeFulfilled.reduce(
    (latest, call) => Math.max(latest, Number(call.completedAt) || 0),
    0,
  );
  const sanitizeRequestId = (requestId) => (typeof requestId === 'string' && requestId
    ? createHash('sha256').update(requestId).digest('hex').slice(0, 16)
    : null);
  return {
    ppeCallCount: ppeCalls.length,
    ppeFulfilledCount: ppeFulfilled.length,
    ppeRejectedCount: ppeRejected.length,
    ppePendingCount: ppePending.length,
    ppeStaleSequenceCount: ppeStaleSequence.length,
    displayCallCount: displayCalls.length,
    shadowCallCount: shadowCalls.length,
    engineConfigCallCount: configCalls.length,
    engineConfigObservedCallCount: observedConfigCalls.length,
    engineConfigForeignCallCount: foreignConfigCalls.length,
    engineConfigRejectedCount: configRejected.length,
    engineConfigPendingCount: configPending.length,
    engineConfigInvalidCount: configInvalid.length,
    engineConfigUnexpectedCount: configUnexpected.length,
    requestIds: ppeCalls.map((call) => sanitizeRequestId(call.requestId)).filter(Boolean),
    pipelineIdentities: [...new Set(ppeCalls.map((call) => call.pipelineIdentity).filter(Boolean))],
    allPpeCallsIdentified,
    requestIdsUnique: uniqueRequestIds.size === tracedRenderCalls.length,
    viewerEngineMode: viewerConfig?.viewerEngineMode ?? null,
    viewerShadowEnabled: viewerConfig?.viewerShadowEnabled ?? null,
    engineConfigSource: viewerConfig?.source ?? null,
    engineConfigSourcePathMatched,
    engineConfigCapturedInRun,
    engineConfigValidatedForRun: engineConfigCurrent,
    fulfilledDurationsMs: ppeFulfilled
      .filter((call) => Number.isFinite(call.completedAt))
      .map((call) => Math.round(call.completedAt - call.startedAt)),
    sourcePathsMatched: ppeCalls.every((call) => (
      normalizeWindowsPath(call.filePath || '') === normalizeWindowsPath(PDF_PATH)
    )),
    payloadsParsed: ppeCalls.every((call) => call.payloadParsed === true),
    latestPpeCompletedAt,
    verifiedPpeOnly: ppeFulfilled.length > 0
      && ppeRejected.length === 0
      && ppePending.length === 0
      && ppeStaleSequence.length === 0
      && displayStaleSequence.length === 0
      && shadowStaleSequence.length === 0
      && displayCalls.length === 0
      && shadowCalls.length === 0
      && configRejected.length === 0
      && configPending.length === 0
      && configInvalid.length === 0
      && configUnexpected.length === 0
      && allPpeCallsIdentified
      && uniqueRequestIds.size === tracedRenderCalls.length
      && ppeCalls.every((call) => (
        normalizeWindowsPath(call.filePath || '') === normalizeWindowsPath(PDF_PATH)
      ))
      && viewerConfig?.viewerEngineMode === 'ppe-only'
      && viewerConfig?.viewerShadowEnabled === false
      && engineConfigCurrent,
    scope: 'target-webview-cdp-network-ipc-trace',
  };
}

function transitionPassesPixelGate(run) {
  return run?.fcvfMs !== null
    && Number.isFinite(run?.fcvfMs)
    && run.final?.dom?.sharpCoverageRatio >= VIEWPORT_COVERAGE_GATE
    && run.final?.compositor?.hasContent === true
    && run.final?.frameEvidence?.candidateCount > 0
    && run.final?.frameEvidence?.postTriggerGeometry?.valid === true
    && run.final?.frameEvidence?.postTriggerGeometry?.sharpValid === true
    && run.stableFrames >= REQUIRED_STABLE_FRAMES;
}

function documentCacheResetState(documentClosed) {
  if (documentClosed === true) return 'removed';
  if (documentClosed === false) return 'already-empty';
  throw new Error(`close_pdf_document trả kiểu không hợp lệ: ${typeof documentClosed}`);
}

function measuredTabIdsFromFiber(rootFiber, normalizedPath) {
  const matched = new Set();
  const stack = [rootFiber];
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
      if (statePath !== normalizedPath || !('viewerNumPages' in (state || {}))) continue;
      let ancestor = node;
      while (ancestor) {
        const tabId = ancestor.memoizedProps?.tabId ?? ancestor.pendingProps?.tabId;
        if (typeof tabId === 'string' && tabId) {
          matched.add(tabId);
          break;
        }
        ancestor = ancestor.return;
      }
    }
    stack.push(node.child, node.sibling);
  }
  return [...matched];
}

function tauriIpcCommand(rawUrl) {
  try {
    const url = new URL(rawUrl);
    let encoded = null;
    if (url.hostname.toLowerCase() === 'ipc.localhost') {
      encoded = url.pathname.replace(/^\/+/, '').replace(/\/+$/, '');
    } else if (url.protocol === 'ipc:') {
      encoded = (url.pathname || url.hostname).replace(/^\/+/, '').replace(/\/+$/, '');
    }
    return encoded ? decodeURIComponent(encoded) : null;
  } catch {
    return null;
  }
}

function tauriIpcPayload(request) {
  const raw = request.postData();
  if (!raw) return { __tracePayloadParsed: false };
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object'
      ? { ...value, __tracePayloadParsed: true }
      : { __tracePayloadParsed: false };
  } catch {
    return { __tracePayloadParsed: false };
  }
}

function recordIpcTraceCall(trace, command, args = {}) {
  const requestContext = args?.requestContext || {};
  const call = {
    command,
    payloadParsed: args?.__tracePayloadParsed !== false,
    requestId: typeof requestContext.requestId === 'string' ? requestContext.requestId : null,
    filePath: typeof args?.filePath === 'string' ? args.filePath : null,
    ownerId: typeof requestContext.ownerId === 'string' ? requestContext.ownerId : null,
    groupKey: typeof requestContext.groupKey === 'string' ? requestContext.groupKey : null,
    generation: Number.isFinite(requestContext.generation)
      ? Number(requestContext.generation)
      : null,
    clip: [args?.clipX, args?.clipY, args?.clipW, args?.clipH].some((value) => Number.isFinite(value))
      ? {
          x: Number.isFinite(args.clipX) ? Number(args.clipX) : null,
          y: Number.isFinite(args.clipY) ? Number(args.clipY) : null,
          width: Number.isFinite(args.clipW) ? Number(args.clipW) : null,
          height: Number.isFinite(args.clipH) ? Number(args.clipH) : null,
        }
      : null,
    purpose: typeof requestContext.purpose === 'string' ? requestContext.purpose : null,
    priority: Number.isFinite(requestContext.priority) ? Number(requestContext.priority) : null,
    page: Number.isFinite(args?.page) ? Number(args.page) : null,
    dpi: Number.isFinite(args?.dpi) ? Number(args.dpi) : null,
    rotation: Number.isFinite(args?.rotation) ? Number(args.rotation) : null,
    pipelineIdentity: typeof requestContext.pipelineIdentity === 'string'
      ? requestContext.pipelineIdentity
      : null,
    startedAt: performance.now(),
    completedAt: null,
    status: 'pending',
    resetSequence: trace.resetSequence,
    tauriResponse: null,
  };
  trace.calls.push(call);
  return call;
}

function settleIpcTraceCall(trace, call, status, value = null) {
  call.completedAt = performance.now();
  call.status = status;
  const isConfig = call.command === 'get_pdf_viewer_bootstrap' || call.command === 'get_pdf_metadata';
  if (isConfig && status === 'fulfilled') {
    call.configSourcePathMatched = (
      normalizeWindowsPath(call.filePath || '') === normalizeWindowsPath(PDF_PATH)
    );
    call.viewerEngineMode = typeof value?.viewerEngineMode === 'string'
      ? value.viewerEngineMode
      : null;
    call.viewerShadowEnabled = typeof value?.viewerShadowEnabled === 'boolean'
      ? value.viewerShadowEnabled
      : null;
    call.configPayloadValid = (
      (value?.viewerEngineMode === 'current'
        || value?.viewerEngineMode === 'hybrid'
        || value?.viewerEngineMode === 'ppe-only')
      && typeof value?.viewerShadowEnabled === 'boolean'
    );
  }
  if (isConfig && status === 'fulfilled'
    && call.configPayloadValid && call.configSourcePathMatched) {
    trace.viewerConfig = {
      viewerEngineMode: value.viewerEngineMode,
      viewerShadowEnabled: value.viewerShadowEnabled === true,
      source: call.command,
      sourcePathMatched: true,
      capturedResetSequence: call.resetSequence,
      validatedResetSequence: call.resetSequence,
    };
  }
}

function createIpcTraceState(resetSequence = 0) {
  return {
    calls: [],
    requests: new WeakMap(),
    pending: new Set(),
    resetSequence,
    viewerConfig: null,
    onRequest: null,
    onResponse: null,
    onRequestFailed: null,
  };
}

async function installIpcTrace(page) {
  if (ipcTraceByPage.has(page)) throw new Error('IPC trace đã được cài cho WebView này.');
  const trace = createIpcTraceState();
  trace.onRequest = (request) => {
    const command = tauriIpcCommand(request.url());
    if (!command || !TRACED_IPC_COMMANDS.has(command)) return;
    const call = recordIpcTraceCall(trace, command, tauriIpcPayload(request));
    trace.requests.set(request, call);
  };
  trace.onResponse = (response) => {
    const call = trace.requests.get(response.request());
    if (!call) return;
    const responseTask = (async () => {
      try {
        const transportError = await response.finished();
        const headers = response.headers();
        call.tauriResponse = headers['tauri-response'] || null;
        const status = !transportError && call.tauriResponse === 'ok' ? 'fulfilled' : 'rejected';
        let value = null;
        if (status === 'fulfilled'
          && (call.command === 'get_pdf_viewer_bootstrap' || call.command === 'get_pdf_metadata')) {
          value = await response.json();
        }
        settleIpcTraceCall(trace, call, status, value);
      } catch (error) {
        settleIpcTraceCall(trace, call, 'rejected');
        call.traceError = String(error);
      }
    })();
    trace.pending.add(responseTask);
    void responseTask.finally(() => trace.pending.delete(responseTask));
  };
  trace.onRequestFailed = (request) => {
    const call = trace.requests.get(request);
    if (!call) return;
    settleIpcTraceCall(trace, call, 'rejected');
    call.traceError = request.failure()?.errorText || 'IPC request failed';
  };
  page.on('request', trace.onRequest);
  page.on('response', trace.onResponse);
  page.on('requestfailed', trace.onRequestFailed);
  ipcTraceByPage.set(page, trace);
  return { installed: true, source: 'target-webview-cdp-network' };
}

async function waitForIpcTraceIdle(trace, timeoutMs = 5_000) {
  const deadline = performance.now() + Math.max(0, timeoutMs);
  while (trace.calls.some((call) => call.status === 'pending') || trace.pending.size > 0) {
    if (performance.now() >= deadline) {
      throw new Error('IPC trace còn request pending quá hạn; từ chối trộn hai transition.');
    }
    const pendingSnapshot = [...trace.pending];
    if (pendingSnapshot.length > 0) {
      await Promise.race([
        Promise.allSettled(pendingSnapshot),
        sleep(POLL_MS),
      ]);
    } else {
      await sleep(POLL_MS);
    }
  }
}

async function resetIpcTrace(page) {
  const trace = ipcTraceByPage.get(page);
  if (!trace) throw new Error('IPC trace chưa được cài.');
  await waitForIpcTraceIdle(trace);
  trace.resetSequence += 1;
  trace.calls = [];
  trace.requests = new WeakMap();
  if (trace.viewerConfig) trace.viewerConfig.validatedResetSequence = trace.resetSequence;
}

async function readIpcTrace(page) {
  const trace = ipcTraceByPage.get(page);
  if (!trace) throw new Error('IPC trace chưa được cài.');
  await waitForIpcTraceIdle(trace);
  return {
    resetSequence: trace.resetSequence,
    viewerConfig: trace.viewerConfig ? { ...trace.viewerConfig } : null,
    calls: trace.calls.map((call) => ({ ...call })),
  };
}

function engineConfigCapturedInCurrentTrace(page) {
  const trace = ipcTraceByPage.get(page);
  if (!trace) throw new Error('IPC trace chưa được cài.');
  return trace.viewerConfig?.capturedResetSequence === trace.resetSequence;
}

async function uninstallIpcTrace(page) {
  const trace = ipcTraceByPage.get(page);
  if (!trace) return;
  await waitForIpcTraceIdle(trace);
  page.off('request', trace.onRequest);
  page.off('response', trace.onResponse);
  page.off('requestfailed', trace.onRequestFailed);
  ipcTraceByPage.delete(page);
}

function disconnectAttachedBrowser(browser) {
  // connectOverCDP gắn vào WebView đang chạy; Browser.close có thể gửi Browser.close
  // tới process đích. Chỉ ngắt transport phía harness để không tắt PrynX của người dùng.
  const connection = browser?._connection;
  if (!connection?.close) {
    throw new Error('Playwright không cung cấp đường ngắt CDP an toàn; không gọi Browser.close.');
  }
  const closing = connection.close();
  return closing && typeof closing.then === 'function' ? closing : Promise.resolve();
}

function isFatalWebViewError(error) {
  const message = String(error || '');
  return /Target page, context or browser has been closed|Browser has been closed|WebSocket.*closed/i
    .test(message);
}

function sanitizeReportText(value) {
  let sanitized = String(value ?? '');
  const rawVariants = [PDF_PATH, PDF_PATH.replaceAll('\\', '/')].filter(Boolean);
  const variants = [
    ...rawVariants,
    ...rawVariants.flatMap((path) => [encodeURI(path), encodeURIComponent(path)]),
  ]
    .filter(Boolean)
    .filter((path, index, all) => all.indexOf(path) === index)
    .sort((left, right) => right.length - left.length);
  for (const variant of variants) {
    let offset = 0;
    while (offset < sanitized.length) {
      const index = sanitized.toLowerCase().indexOf(variant.toLowerCase(), offset);
      if (index < 0) break;
      sanitized = `${sanitized.slice(0, index)}<PDF_PATH>${sanitized.slice(index + variant.length)}`;
      offset = index + '<PDF_PATH>'.length;
    }
  }
  return sanitized;
}

function reportIdentity(identity) {
  if (!identity) return null;
  return {
    fileName: identity.fileName ?? null,
    phase: identity.phase ?? null,
    numPages: Number(identity.numPages) || 0,
    sourceKeyStored: false,
  };
}

function reportDom(dom) {
  if (!dom) return dom;
  return {
    ...dom,
    tiles: (dom.tiles || []).map(({ sourceToken: _sourceToken, ...tile }) => tile),
  };
}

async function fileIdentity(path) {
  const value = await stat(path);
  return { sizeBytes: value.size, mtimeMs: value.mtimeMs, ctimeMs: value.ctimeMs };
}

async function assertFileIdentity(path, expected) {
  const current = await fileIdentity(path);
  if (current.sizeBytes !== expected.sizeBytes
    || current.mtimeMs !== expected.mtimeMs
    || current.ctimeMs !== expected.ctimeMs) {
    throw new Error('File PDF đo đã thay đổi trong lúc chạy baseline; từ chối trộn revision.');
  }
}

function normalizeWindowsPath(path) {
  return String(path || '')
    .replaceAll('/', '\\')
    .replace(/^\\\\\?\\UNC\\/i, '\\\\')
    .replace(/^\\\\\?\\/i, '')
    .toLowerCase();
}

function mergedCoverageRatio(rectangles, bounds) {
  const clipped = rectangles
    .map((rect) => ({
      left: Math.max(bounds.left, rect.left),
      top: Math.max(bounds.top, rect.top),
      right: Math.min(bounds.right, rect.right),
      bottom: Math.min(bounds.bottom, rect.bottom),
    }))
    .filter((rect) => rect.right > rect.left && rect.bottom > rect.top);
  const xs = [...new Set([bounds.left, bounds.right, ...clipped.flatMap((rect) => [rect.left, rect.right])])]
    .sort((a, b) => a - b);
  let covered = 0;
  for (let index = 0; index + 1 < xs.length; index += 1) {
    const left = xs[index];
    const right = xs[index + 1];
    const spans = clipped
      .filter((rect) => rect.left < right && rect.right > left)
      .map((rect) => [rect.top, rect.bottom])
      .sort((a, b) => a[0] - b[0]);
    let spanTop = null;
    let spanBottom = null;
    let height = 0;
    for (const [top, bottom] of spans) {
      if (spanTop === null || top > spanBottom) {
        if (spanTop !== null) height += spanBottom - spanTop;
        spanTop = top;
        spanBottom = bottom;
      } else {
        spanBottom = Math.max(spanBottom, bottom);
      }
    }
    if (spanTop !== null) height += spanBottom - spanTop;
    covered += (right - left) * height;
  }
  const area = Math.max(0, bounds.right - bounds.left) * Math.max(0, bounds.bottom - bounds.top);
  return area > 0 ? Math.min(1, covered / area) : 0;
}

function sharpCoverageRatio(tiles, bounds) {
  return mergedCoverageRatio(
    tiles
      .filter((tile) => tile.quality >= SHARP_DENSITY_GATE)
      .map((tile) => ({
        left: tile.x,
        top: tile.y,
        right: tile.x + tile.width,
        bottom: tile.y + tile.height,
      })),
    bounds,
  );
}

function validObservedRect(dom) {
  const rect = dom?.visibleRect || dom?.pageRect;
  if (!rect) return null;
  const values = [rect.x, rect.y, rect.width, rect.height];
  if (!values.every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) return null;
  return rect;
}

function normalizedInteractiveClip(call) {
  if (!call?.clip) return null;
  const { x, y, width, height } = call.clip;
  if (![x, y, width, height].every(Number.isFinite)
    || x < 0 || y < 0 || width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

function normalizeQuarterTurn(value) {
  const rotation = ((Math.round(Number(value)) % 360) + 360) % 360;
  return [0, 90, 180, 270].includes(rotation) ? rotation : null;
}

function ppeCandidateGeometryEvidence(call, dom, preTriggerSourceTokens = new Set()) {
  const observedRect = validObservedRect(dom);
  if (!observedRect) {
    return { valid: false, kind: 'invalid-observed-viewport', coverageRatio: 0 };
  }
  const requestRotation = normalizeQuarterTurn(call?.rotation);
  if (requestRotation === null) {
    return { valid: false, kind: 'invalid-rotation', coverageRatio: 0 };
  }
  const clip = normalizedInteractiveClip(call);
  if (call?.clip && !clip) {
    return { valid: false, kind: 'invalid-clip', coverageRatio: 0, requestRotation };
  }
  const dpi = Number(call.dpi);
  if (!Number.isFinite(dpi) || dpi <= 0) {
    return { valid: false, kind: 'invalid-dpi', coverageRatio: 0, requestRotation };
  }
  const viewportBounds = {
    left: observedRect.x,
    top: observedRect.y,
    right: observedRect.x + observedRect.width,
    bottom: observedRect.y + observedRect.height,
  };
  const close = (left, right, tolerance = 0.51) => (
    Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= tolerance
  );
  const matchedTiles = (dom?.tiles || []).filter((tile) => {
    const tileClip = tile.requestClip;
    const clipMatched = clip
      ? tileClip
        && close(tileClip.x, clip.x)
        && close(tileClip.y, clip.y)
        && close(tileClip.width, clip.width)
        && close(tileClip.height, clip.height)
      : tileClip === null;
    if (!clipMatched
      || tile.requestPage !== call.page
      || !close(tile.requestZoom * 96, dpi, 0.11)
      || tile.requestRotation !== requestRotation
      || tile.accurateOnly !== true) return false;
    return !clip || (
      close(tile.naturalWidth, clip.width, TILE_GEOMETRY_TOLERANCE_PX)
      && close(tile.naturalHeight, clip.height, TILE_GEOMETRY_TOLERANCE_PX)
    );
  });
  const coverageRatio = mergedCoverageRatio(
    matchedTiles.map((tile) => ({
      left: tile.x,
      top: tile.y,
      right: tile.x + tile.width,
      bottom: tile.y + tile.height,
    })),
    viewportBounds,
  );
  return {
    valid: matchedTiles.length > 0,
    viewportCovered: coverageRatio >= VIEWPORT_COVERAGE_GATE,
    kind: clip ? 'clip' : 'full-page',
    coverageRatio,
    matchedTileCount: matchedTiles.length,
    requestRotation,
    matchedTileRects: matchedTiles.map((tile) => ({
      x: tile.x,
      y: tile.y,
      width: tile.width,
      height: tile.height,
      quality: tile.quality,
      sourceIsPostTrigger: typeof tile.sourceToken === 'string'
        && tile.sourceToken.length > 0
        && !preTriggerSourceTokens.has(tile.sourceToken),
    })),
    viewportBounds,
  };
}

function aggregatePpeCandidateGeometry(candidates, dom) {
  const observedRect = validObservedRect(dom);
  if (!observedRect) {
    return { valid: false, coverageRatio: 0, requestIds: [], tileRects: [] };
  }
  const viewportBounds = {
    left: observedRect.x,
    top: observedRect.y,
    right: observedRect.x + observedRect.width,
    bottom: observedRect.y + observedRect.height,
  };
  const tileRects = [];
  const seen = new Set();
  for (const candidate of candidates) {
    for (const rect of candidate.geometryEvidence?.matchedTileRects || []) {
      if (rect.sourceIsPostTrigger !== true) continue;
      const key = [candidate.requestId, rect.x, rect.y, rect.width, rect.height]
        .map(String).join(':');
      if (seen.has(key)) continue;
      seen.add(key);
      tileRects.push(rect);
    }
  }
  const coverageRatio = mergedCoverageRatio(tileRects.map((rect) => ({
    left: rect.x,
    top: rect.y,
    right: rect.x + rect.width,
    bottom: rect.y + rect.height,
  })), viewportBounds);
  const sharpCoverageRatio = mergedCoverageRatio(
    tileRects
      .filter((rect) => Number(rect.quality) >= SHARP_DENSITY_GATE)
      .map((rect) => ({
        left: rect.x,
        top: rect.y,
        right: rect.x + rect.width,
        bottom: rect.y + rect.height,
      })),
    viewportBounds,
  );
  return {
    valid: candidates.length > 0 && coverageRatio >= VIEWPORT_COVERAGE_GATE,
    sharpValid: candidates.length > 0 && sharpCoverageRatio >= VIEWPORT_COVERAGE_GATE,
    coverageRatio,
    sharpCoverageRatio,
    requestIds: candidates.map((candidate) => (
      createHash('sha256').update(candidate.requestId).digest('hex').slice(0, 16)
    )),
    tileRects,
    viewportBounds,
  };
}

async function prepareSession(page) {
  await page.bringToFront();
  const state = await page.evaluate(async () => {
    window.focus();
    await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
    return {
      hasRoot: Boolean(document.getElementById('root')),
      isTauri: Boolean(window.__TAURI_INTERNALS__),
    };
  });
  if (!state.hasRoot || !state.isTauri) {
    throw new Error('WebView PrynX chưa sẵn sàng; harness không thay đổi auth/license để đi tắt.');
  }
}

async function dispatchPath(page) {
  return page.evaluate(async (path) => {
    const nativeFiles = await import('/src/lib/nativeFileAccess.ts');
    const prepared = await nativeFiles.createPathBackedFile(path);
    return {
      accepted: nativeFiles.dispatchSupportedSystemFiles([prepared.file]),
      size: prepared.stat?.size ?? null,
      note: 'dispatcher schedules a 50ms batch flush before tab creation',
    };
  }, PDF_PATH);
}

async function activeMeasuredTabId(page) {
  return page.evaluate((expectedPath) => {
    const activeRoot = document.querySelector('[data-prynx-tab-active="true"]');
    const root = document.getElementById('root');
    const rootKey = root && Object.keys(root).find((name) => name.startsWith('__reactContainer$'));
    if (!activeRoot || !root || !rootKey) return null;
    const matched = new Set();
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
        if (statePath !== expectedPath || !('viewerNumPages' in (state || {}))) continue;
        let ancestor = node;
        let tabId = null;
        let belongsToActiveRoot = false;
        while (ancestor) {
          if (ancestor.stateNode === activeRoot) belongsToActiveRoot = true;
          const candidate = ancestor.memoizedProps?.tabId ?? ancestor.pendingProps?.tabId;
          if (!tabId && typeof candidate === 'string' && candidate) tabId = candidate;
          ancestor = ancestor.return;
        }
        if (belongsToActiveRoot && tabId) matched.add(tabId);
      }
      stack.push(node.child, node.sibling);
    }
    return matched.size === 1 ? [...matched][0] : null;
  }, normalizeWindowsPath(PDF_PATH));
}

async function verifyThumbnailPanelClosed(page) {
  return page.evaluate((expectedPath) => {
    const root = document.getElementById('root');
    const reactKey = root && Object.keys(root).find((name) => name.startsWith('__reactContainer$'));
    if (!root || !reactKey) return { verified: false, reason: 'react-root-not-found' };
    const stack = [root[reactKey]];
    const seenFibers = new Set();
    const seenStores = new Set();
    const matches = [];
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node || seenFibers.has(node)) continue;
      seenFibers.add(node);
      for (const value of [node.memoizedProps?.value, node.pendingProps?.value]) {
        if (!value?.getState || seenStores.has(value)) continue;
        seenStores.add(value);
        const state = value.getState();
        const statePath = String(state?.file?.path || '').replaceAll('/', '\\').toLowerCase();
        if (statePath === expectedPath && 'viewerThumbMenuOpen' in state) {
          matches.push(state.viewerThumbMenuOpen);
        }
      }
      stack.push(node.child, node.sibling);
    }
    if (matches.length !== 1) {
      return { verified: false, reason: 'viewer-store-ambiguous', matchingStoreCount: matches.length };
    }
    return {
      verified: matches[0] === false,
      reason: matches[0] === false ? null : 'thumbnail-panel-open',
      matchingStoreCount: 1,
    };
  }, normalizeWindowsPath(PDF_PATH));
}

async function measuredFileTabIds(page) {
  return page.evaluate((normalizedPath) => {
    const root = document.getElementById('root');
    const rootKey = root && Object.keys(root).find((name) => name.startsWith('__reactContainer$'));
    if (!root || !rootKey) throw new Error('Không tìm thấy React root để định danh tab cần đóng.');
    const matched = new Set();
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
        if (statePath !== normalizedPath || !('viewerNumPages' in (state || {}))) continue;
        let ancestor = node;
        while (ancestor) {
          const tabId = ancestor.memoizedProps?.tabId ?? ancestor.pendingProps?.tabId;
          if (typeof tabId === 'string' && tabId) {
            matched.add(tabId);
            break;
          }
          ancestor = ancestor.return;
        }
      }
      stack.push(node.child, node.sibling);
    }
    return [...matched];
  }, normalizeWindowsPath(PDF_PATH));
}

async function closeMeasuredFileTabs(page, expectedTabId) {
  const tabIds = await measuredFileTabIds(page);
  if (tabIds.length !== 1 || tabIds[0] !== expectedTabId) {
    throw new Error(
      `Tab theo path không khớp tab do harness mở: path=${tabIds.join(',')}, `
      + `expected=${expectedTabId}.`,
    );
  }
  for (const tabId of tabIds) {
    const tab = page.locator(`[data-tab-id="${tabId}"]`);
    await tab.locator('button[title="Close Tab"]').click();
    await tab.waitFor({ state: 'detached', timeout: 5_000 });
  }
  return { closedCount: tabIds.length, tabIds };
}

async function waitForMeasuredViewerGone(page) {
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    const identity = await measuredViewerCacheIdentity(page);
    if (identity.namespaceKind === 'path-fallback') return true;
    await sleep(POLL_MS);
  }
  return false;
}

async function measuredViewerCacheIdentity(page) {
  return page.evaluate(({ path, normalizedPath }) => {
    const root = document.getElementById('root');
    const reactKey = root && Object.keys(root).find((name) => name.startsWith('__reactContainer$'));
    if (!root || !reactKey) return { namespace: path, namespaceKind: 'path-fallback' };
    const stack = [root[reactKey]];
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
        if (statePath === normalizedPath) {
          const namespace = state.pdfUrl || state.file.path;
          return { namespace, namespaceKind: state.pdfUrl ? 'pdf-url' : 'path' };
        }
      }
      stack.push(node.child, node.sibling);
    }
    return { namespace: path, namespaceKind: 'path-fallback' };
  }, { path: PDF_PATH, normalizedPath: normalizeWindowsPath(PDF_PATH) });
}

function warmZoomTarget(beforeZoom) {
  if (!Number.isFinite(beforeZoom) || beforeZoom <= 0) {
    throw new Error(`Zoom Viewer trước warm không hợp lệ: ${beforeZoom}`);
  }
  // Standee ở fit có thể nằm dưới sàn 24 DPI; 1,5× vẫn cùng bucket và không tạo
  // request mới. Đích tối thiểu 200% bảo đảm thoát sàn trên toàn miền raw-DPI hợp lệ.
  return beforeZoom <= 2
    ? Math.max(WARM_ZOOM_FLOOR, beforeZoom * WARM_ZOOM_UP_FACTOR)
    : beforeZoom * WARM_ZOOM_DOWN_FACTOR;
}

async function triggerWarmZoom(page) {
  return page.evaluate(async ({ expectedPath, zoomFloor, zoomUpFactor, zoomDownFactor }) => {
    const activeRoot = document.querySelector('[data-prynx-tab-active="true"]');
    const root = document.getElementById('root');
    const reactKey = root && Object.keys(root).find((name) => name.startsWith('__reactContainer$'));
    if (!root || !reactKey) throw new Error('Không tìm thấy React root của Viewer.');
    const stack = [root[reactKey]];
    const seenFibers = new Set();
    const seenStores = new Set();
    const matches = [];
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node || seenFibers.has(node)) continue;
      seenFibers.add(node);
      for (const value of [node.memoizedProps?.value, node.pendingProps?.value]) {
        if (!value?.getState || !value?.setState || seenStores.has(value)) continue;
        seenStores.add(value);
        const state = value.getState();
        const statePath = String(state?.file?.path || '').replaceAll('/', '\\').toLowerCase();
        if (statePath !== expectedPath || !('viewerNumPages' in state)) continue;
        matches.push({ value, state });
      }
      stack.push(node.child, node.sibling);
    }
    if (matches.length !== 1) {
      throw new Error(`Workspace store warm zoom không duy nhất: ${matches.length}.`);
    }
    const [{ value, state }] = matches;
    const activePage = Number(state.viewerActivePage) || 1;
    const container = activeRoot?.querySelector(`#pdf-page-container-${activePage}`);
    const pageSurface = container?.querySelector('[class*="group/pdf-frame"]') || container;
    const beforeRect = pageSurface?.getBoundingClientRect();
    if (!beforeRect || beforeRect.width <= 1 || beforeRect.height <= 1) {
      throw new Error('Không tìm thấy surface Viewer active trước warm zoom.');
    }
    const beforeZoom = Number(state.viewerZoom);
    if (!Number.isFinite(beforeZoom) || beforeZoom <= 0) {
      throw new Error(`Zoom Viewer trước warm không hợp lệ: ${beforeZoom}`);
    }
    const targetZoom = beforeZoom <= 2
      ? Math.max(zoomFloor, beforeZoom * zoomUpFactor)
      : beforeZoom * zoomDownFactor;
    value.setState({ viewerFitMode: 'custom', viewerZoom: targetZoom });
    return {
      accepted: true,
      kind: 'warm-zoom',
      beforeZoom,
      targetZoom,
      beforePageRect: {
        x: beforeRect.x,
        y: beforeRect.y,
        width: beforeRect.width,
        height: beforeRect.height,
      },
      requireGeometryChange: true,
      previousSurfaceRetained: true,
    };
  }, {
    expectedPath: normalizeWindowsPath(PDF_PATH),
    zoomFloor: WARM_ZOOM_FLOOR,
    zoomUpFactor: WARM_ZOOM_UP_FACTOR,
    zoomDownFactor: WARM_ZOOM_DOWN_FACTOR,
  });
}

async function clearMeasuredViewerCaches(page, measuredIdentity) {
  return page.evaluate(async ({ path, namespace }) => {
    const cache = await import('/src/lib/tileUrlCache.ts');
    // PERF (audit 2026-08-13 §V.1–V.3): namespace thật ưu tiên pdfUrl giống
    // usePdfLoader/LivePageFrame; identity được chụp trước khi tab bị đóng.
    cache.clearTileUrlCacheForFile(namespace);
    let namespaceHasCachedTile = false;
    const root = document.getElementById('root');
    const rootKey = root && Object.keys(root).find((name) => name.startsWith('__reactContainer$'));
    if (root && rootKey) {
      const stack = [root[rootKey]];
      const seenFibers = new Set();
      while (stack.length > 0 && !namespaceHasCachedTile) {
        const node = stack.pop();
        if (!node || seenFibers.has(node)) continue;
        seenFibers.add(node);
        const props = [node.memoizedProps, node.pendingProps];
        for (const value of props) {
          if (typeof value?.fileKey !== 'string') continue;
          if (cache.tileUrlCacheNamespaceForFileKey(value.fileKey) !== namespace) continue;
          const pageNum = Number(value.pageNum);
          const zoom = Number(value.zoom);
          const rotation = Number(value.rot ?? 0);
          if (!Number.isFinite(pageNum) || !Number.isFinite(zoom)) continue;
          const key = `${value.fileKey}_${pageNum}_${zoom}_${rotation}_${value.clipX}_${value.clipY}_${value.clipW}_${value.clipH}`;
          if (cache.getCachedTileUrl(key)) {
            namespaceHasCachedTile = true;
            cache.clearTileUrlCacheForFile(namespace);
            break;
          }
        }
        stack.push(node.child, node.sibling);
      }
    }
    try {
      // PERF (audit 2026-08-14 §V.4): page.evaluate chạy như script runtime, không qua
      // biến đổi module của Vite; bare specifier @tauri-apps không thể được WebView phân giải.
      const invoke = window.__PRYNX_INVOKE__
        || window.__TAURI__?.core?.invoke
        || window.__TAURI_INTERNALS__?.invoke;
      if (typeof invoke !== 'function') {
        throw new Error('Không tìm thấy cầu nối IPC Tauri trong WebView đang đo.');
      }
      // Không truyền owner giả: owner thật đã release khi tab đóng; lệnh này buộc cold
      // document cache của session đo và không thể vô tình giữ lease không tồn tại.
      const documentClosed = await invoke('close_pdf_document', { filePath: path, ownerId: null });
      return {
        namespaceCleared: Boolean(namespace),
        namespaceHasCachedTile,
        documentClosed,
        error: null,
      };
    } catch (error) {
      return {
        namespaceCleared: Boolean(namespace),
        namespaceHasCachedTile,
        documentClosed: null,
        error: String(error),
      };
    }
  }, { path: PDF_PATH, namespace: measuredIdentity.namespace });
}

async function domState(page) {
  return page.evaluate(({ expectedPath, sharpDensityGate, viewportCoverageGate }) => {
    const normalizeRotation = (value) => {
      const rotation = ((Math.round(Number(value)) % 360) + 360) % 360;
      return [0, 90, 180, 270].includes(rotation) ? rotation : null;
    };
    const activeRoot = document.querySelector('[data-prynx-tab-active="true"]');
    const root = document.getElementById('root');
    const key = root && Object.keys(root).find((name) => name.startsWith('__reactContainer$'));
    let activeIdentityMatches = false;
    const matchingStates = [];
    if (activeRoot && root && key) {
      const stack = [root[key]];
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
          if (statePath !== expectedPath || !('viewerNumPages' in (state || {}))) continue;
          let ancestor = node;
          let tabId = null;
          let belongsToActiveRoot = false;
          while (ancestor) {
            if (ancestor.stateNode === activeRoot) belongsToActiveRoot = true;
            const candidate = ancestor.memoizedProps?.tabId ?? ancestor.pendingProps?.tabId;
            if (!tabId && typeof candidate === 'string' && candidate) tabId = candidate;
            ancestor = ancestor.return;
          }
          if (belongsToActiveRoot) {
            const activePage = Number(state.viewerActivePage) || 1;
            const pageOrder = Array.isArray(state.viewerPageOrder) ? state.viewerPageOrder : [];
            const sourcePage = Number(pageOrder[activePage - 1]) || activePage;
            const pageInstanceIds = Array.isArray(state.viewerPageInstanceIds)
              ? state.viewerPageInstanceIds
              : [];
            const pageRotations = Array.isArray(state.viewerPageRotations)
              ? state.viewerPageRotations
              : [];
            const rotation = Number(pageRotations[activePage - 1]) || 0;
            matchingStates.push({ tabId, activePage, sourcePage, rotation });
          }
        }
        stack.push(node.child, node.sibling);
      }
    }
    activeIdentityMatches = matchingStates.length === 1 && Boolean(matchingStates[0]?.tabId);
    const activePage = Number(matchingStates[0]?.activePage) || 1;
    const container = activeRoot?.querySelector(`#pdf-page-container-${activePage}`);
    if (!container || !activeIdentityMatches) {
      return { shell: false, pageRect: null, tiles: [], coverageRatio: 0, sharp: false, page: null };
    }
    const surface = container.querySelector('[class*="group/pdf-frame"]') || container;
    const pageRect = surface.getBoundingClientRect();
    const devicePixelRatio = Math.max(1, Number(window.devicePixelRatio) || 1);
    const tiles = [...container.querySelectorAll('.tile-container img')]
      .filter((image) => {
        const rect = image.getBoundingClientRect();
        const style = getComputedStyle(image);
        const tile = image.closest('.tile-container');
        const tileStyle = tile ? getComputedStyle(tile) : null;
        return image.complete && image.naturalWidth > 0 && image.naturalHeight > 0
          && rect.width > 0 && rect.height > 0
          && rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight
          && style.visibility !== 'hidden' && style.display !== 'none'
          && Number(style.opacity || 1) > 0
          && tileStyle?.visibility !== 'hidden' && tileStyle?.display !== 'none'
          && Number(tileStyle?.opacity || 1) > 0;
      })
      .map((image) => {
        const rect = image.getBoundingClientRect();
        const fiberKey = Object.keys(image).find((name) => name.startsWith('__reactFiber$'));
        let fiber = fiberKey ? image[fiberKey] : null;
        let liveTileProps = null;
        while (fiber) {
          const props = fiber.memoizedProps || fiber.pendingProps;
          if (Number.isFinite(props?.pageNum)
            && Number.isFinite(props?.zoom)
            && typeof props?.fileKey === 'string') {
            liveTileProps = props;
            break;
          }
          fiber = fiber.return;
        }
        const hasClip = Number.isFinite(liveTileProps?.clipX)
          && Number.isFinite(liveTileProps?.clipY)
          && Number.isFinite(liveTileProps?.clipW) && liveTileProps.clipW > 0
          && Number.isFinite(liveTileProps?.clipH) && liveTileProps.clipH > 0;
        return {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          naturalWidth: image.naturalWidth,
          naturalHeight: image.naturalHeight,
          // Mật độ 1 nghĩa là đủ một pixel nguồn cho mỗi device pixel compositor.
          quality: Math.min(
            image.naturalWidth / (rect.width * devicePixelRatio),
            image.naturalHeight / (rect.height * devicePixelRatio),
          ),
          sourceToken: image.currentSrc || image.src || null,
          requestPage: Number.isFinite(liveTileProps?.pageNum) ? Number(liveTileProps.pageNum) : null,
          requestZoom: Number.isFinite(liveTileProps?.zoom) ? Number(liveTileProps.zoom) : null,
          requestRotation: normalizeRotation(liveTileProps?.rot),
          requestClip: hasClip
            ? {
                x: Number.isFinite(liveTileProps?.clipX) ? Number(liveTileProps.clipX) : null,
                y: Number.isFinite(liveTileProps?.clipY) ? Number(liveTileProps.clipY) : null,
                width: Number.isFinite(liveTileProps?.clipW) ? Number(liveTileProps.clipW) : null,
                height: Number.isFinite(liveTileProps?.clipH) ? Number(liveTileProps.clipH) : null,
              }
            : null,
          accurateOnly: liveTileProps?.accurateOnly === true,
        };
      });
    const visibleLeft = Math.max(0, pageRect.left);
    const visibleTop = Math.max(0, pageRect.top);
    const visibleRight = Math.min(innerWidth, pageRect.right);
    const visibleBottom = Math.min(innerHeight, pageRect.bottom);
    const scrollViewport = container.closest('.acro-scroll');
    const scrollRect = scrollViewport?.getBoundingClientRect();
    const boundedVisibleLeft = scrollRect ? Math.max(visibleLeft, scrollRect.left) : visibleLeft;
    const boundedVisibleTop = scrollRect ? Math.max(visibleTop, scrollRect.top) : visibleTop;
    const boundedVisibleRight = scrollRect ? Math.min(visibleRight, scrollRect.right) : visibleRight;
    const boundedVisibleBottom = scrollRect ? Math.min(visibleBottom, scrollRect.bottom) : visibleBottom;
    const visibleArea = Math.max(0, boundedVisibleRight - boundedVisibleLeft)
      * Math.max(0, boundedVisibleBottom - boundedVisibleTop);
    const clipped = tiles
      .map((tile) => ({
        left: Math.max(boundedVisibleLeft, tile.x),
        top: Math.max(boundedVisibleTop, tile.y),
        right: Math.min(boundedVisibleRight, tile.x + tile.width),
        bottom: Math.min(boundedVisibleBottom, tile.y + tile.height),
      }))
      .filter((rect) => rect.right > rect.left && rect.bottom > rect.top);
    const xs = [...new Set([boundedVisibleLeft, boundedVisibleRight, ...clipped.flatMap((rect) => [rect.left, rect.right])])]
      .sort((a, b) => a - b);
    let coveredArea = 0;
    for (let index = 0; index + 1 < xs.length; index += 1) {
      const left = xs[index];
      const right = xs[index + 1];
      const spans = clipped
        .filter((rect) => rect.left < right && rect.right > left)
        .map((rect) => [rect.top, rect.bottom])
        .sort((a, b) => a[0] - b[0]);
      let top = null;
      let bottom = null;
      let height = 0;
      for (const [nextTop, nextBottom] of spans) {
        if (top === null || nextTop > bottom) {
          if (top !== null) height += bottom - top;
          top = nextTop;
          bottom = nextBottom;
        } else {
          bottom = Math.max(bottom, nextBottom);
        }
      }
      if (top !== null) height += bottom - top;
      coveredArea += (right - left) * height;
    }
    const bounds = {
      left: boundedVisibleLeft,
      top: boundedVisibleTop,
      right: boundedVisibleRight,
      bottom: boundedVisibleBottom,
    };
    const coverageRatio = visibleArea > 0 ? Math.min(1, coveredArea / visibleArea) : 0;
    const sharpTiles = tiles.filter((tile) => tile.quality >= sharpDensityGate);
    const sharpClipped = sharpTiles
      .map((tile) => ({
        left: Math.max(visibleLeft, tile.x),
        top: Math.max(visibleTop, tile.y),
        right: Math.min(visibleRight, tile.x + tile.width),
        bottom: Math.min(visibleBottom, tile.y + tile.height),
      }))
      .filter((rect) => rect.right > rect.left && rect.bottom > rect.top);
    const sharpXs = [...new Set([bounds.left, bounds.right, ...sharpClipped.flatMap((rect) => [rect.left, rect.right])])]
      .sort((a, b) => a - b);
    let sharpArea = 0;
    for (let index = 0; index + 1 < sharpXs.length; index += 1) {
      const left = sharpXs[index];
      const right = sharpXs[index + 1];
      const spans = sharpClipped
        .filter((rect) => rect.left < right && rect.right > left)
        .map((rect) => [rect.top, rect.bottom])
        .sort((a, b) => a[0] - b[0]);
      let top = null;
      let bottom = null;
      let height = 0;
      for (const [nextTop, nextBottom] of spans) {
        if (top === null || nextTop > bottom) {
          if (top !== null) height += bottom - top;
          top = nextTop;
          bottom = nextBottom;
        } else {
          bottom = Math.max(bottom, nextBottom);
        }
      }
      if (top !== null) height += bottom - top;
      sharpArea += (right - left) * height;
    }
    const sharpRatio = visibleArea > 0 ? Math.min(1, sharpArea / visibleArea) : 0;
    return {
      shell: pageRect.width > 1 && pageRect.height > 1,
      pageRect: { x: pageRect.x, y: pageRect.y, width: pageRect.width, height: pageRect.height },
      visibleRect: {
        x: boundedVisibleLeft,
        y: boundedVisibleTop,
        width: Math.max(0, boundedVisibleRight - boundedVisibleLeft),
        height: Math.max(0, boundedVisibleBottom - boundedVisibleTop),
      },
      tiles,
      coverageRatio,
      sharpCoverageRatio: sharpRatio,
      sharp: sharpRatio >= viewportCoverageGate,
      devicePixelRatio,
      page: Number(matchingStates[0]?.sourcePage) || 1,
      rotation: normalizeRotation(matchingStates[0]?.rotation),
    };
  }, {
    expectedPath: normalizeWindowsPath(PDF_PATH),
    sharpDensityGate: SHARP_DENSITY_GATE,
    viewportCoverageGate: VIEWPORT_COVERAGE_GATE,
  });
}

async function displayedPdfIdentity(page) {
  return page.evaluate(({ expectedName, expectedPath }) => {
    const activeRoot = document.querySelector('[data-prynx-tab-active="true"]');
    if (!activeRoot) return null;
    const root = document.getElementById('root');
    const key = root && Object.keys(root).find((name) => name.startsWith('__reactContainer$'));
    if (root && key) {
      const stack = [root[key]];
      const seenFibers = new Set();
      const seenStores = new Set();
      const matchingStates = [];
      while (stack.length > 0) {
        const node = stack.pop();
        if (!node || seenFibers.has(node)) continue;
        seenFibers.add(node);
        for (const value of [node.memoizedProps?.value, node.pendingProps?.value]) {
          if (!value?.getState || seenStores.has(value)) continue;
          seenStores.add(value);
          const state = value.getState();
          if (state?.originalFileName === expectedName
            && String(state?.file?.path || '').replaceAll('/', '\\').toLowerCase()
              === String(expectedPath || '').replaceAll('/', '\\').toLowerCase()
            && 'viewerNumPages' in state) {
            let ancestor = node;
            let belongsToActiveRoot = false;
            while (ancestor) {
              if (ancestor.stateNode === activeRoot) {
                belongsToActiveRoot = true;
                break;
              }
              ancestor = ancestor.return;
            }
            if (!belongsToActiveRoot) continue;
            matchingStates.push({
              fileName: state.originalFileName,
              sourceKey: [
                state.pdfUrl || '',
                state.file?.path || '',
                state.file?.name || '',
                state.file?.size || 0,
                state.file?.lastModified || 0,
              ].join('|'),
              phase: state.phase || null,
              numPages: Number(state.viewerNumPages) || 0,
            });
          }
        }
        stack.push(node.child, node.sibling);
      }
      if (matchingStates.length !== 1) return null;
      return matchingStates[0];
    }
    return null;
  }, { expectedName: basename(PDF_PATH), expectedPath: PDF_PATH });
}

function fulfilledPpeCandidatesForDom(
  trace,
  dom,
  expectedSourceKey,
  expectedPath = PDF_PATH,
  preTriggerSourceTokens = new Set(),
) {
  if (!trace || !dom?.tiles?.length || !expectedSourceKey) return [];
  const normalizedExpectedPath = normalizeWindowsPath(expectedPath);
  const sourceParts = String(expectedSourceKey).split('|');
  const sourcePath = normalizeWindowsPath(sourceParts[1] || '');
  if (sourcePath !== normalizedExpectedPath) return [];
  return trace.calls.flatMap((call) => {
    if (call.command !== 'render_ppe_page' || call.status !== 'fulfilled') return [];
    if (Number.isFinite(trace.resetSequence) && call.resetSequence !== trace.resetSequence) return [];
    if (call.page !== dom.page) return [];
    if (!Number.isFinite(call.dpi) || call.dpi <= 0) return [];
    if (normalizeWindowsPath(call.filePath || '') !== normalizedExpectedPath) return [];
    if (typeof call.ownerId !== 'string' || !call.ownerId) return [];
    if (typeof call.groupKey !== 'string' || !call.groupKey) return [];
    if (typeof call.generation !== 'number' || !Number.isFinite(call.generation)) return [];
    if (call.purpose === 'background' || (Number.isFinite(call.priority) && call.priority >= 100)) {
      return [];
    }
    const geometryEvidence = ppeCandidateGeometryEvidence(call, dom, preTriggerSourceTokens);
    return geometryEvidence.valid ? [{ ...call, geometryEvidence }] : [];
  });
}

function latestFulfilledPpeRequestIds(trace) {
  return new Set((trace?.calls || [])
    .filter((call) => call.command === 'render_ppe_page' && call.status === 'fulfilled')
    .map((call) => call.requestId)
    .filter(Boolean));
}

function postTriggerPpeCandidates(candidates, triggerStartedAt, requestIdsBeforeTrigger = new Set()) {
  return candidates.filter((call) => (
    !requestIdsBeforeTrigger.has(call.requestId)
    && Number.isFinite(call.startedAt)
    && call.startedAt >= triggerStartedAt
  ));
}

async function compositorState(page, state) {
  const observedRect = state.visibleRect || state.pageRect;
  if (!observedRect) return {
    captured: false, hasContent: false, signature: null, contentBounds: null,
  };
  const encoded = (await page.screenshot({ type: 'png' })).toString('base64');
  return page.evaluate(async ({ encodedPng, pageRect, sampleEdge }) => {
    const screenshot = new Image();
    await new Promise((resolveImage, rejectImage) => {
      screenshot.onload = resolveImage;
      screenshot.onerror = rejectImage;
      screenshot.src = `data:image/png;base64,${encodedPng}`;
    });
    const inset = 3;
    const left = Math.max(0, pageRect.x + inset);
    const top = Math.max(0, pageRect.y + inset);
    const right = Math.min(innerWidth, pageRect.x + pageRect.width - inset);
    const bottom = Math.min(innerHeight, pageRect.y + pageRect.height - inset);
    const width = right - left;
    const height = bottom - top;
    if (width <= 1 || height <= 1) return { captured: false, hasContent: false, signature: null };
    const scale = Math.min(1, sampleEdge / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(
      screenshot,
      left * screenshot.naturalWidth / innerWidth,
      top * screenshot.naturalHeight / innerHeight,
      width * screenshot.naturalWidth / innerWidth,
      height * screenshot.naturalHeight / innerHeight,
      0,
      0,
      canvas.width,
      canvas.height,
    );
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let minLuma = 255;
    let maxLuma = 0;
    let nonWhite = 0;
    let chromatic = 0;
    let contentMinX = canvas.width;
    let contentMinY = canvas.height;
    let contentMaxX = -1;
    let contentMaxY = -1;
    let hash = 2166136261;
    for (let index = 0; index < pixels.length; index += 4) {
      const r = pixels[index];
      const g = pixels[index + 1];
      const b = pixels[index + 2];
      const luma = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
      minLuma = Math.min(minLuma, luma);
      maxLuma = Math.max(maxLuma, luma);
      const contentPixel = r < 248 || g < 248 || b < 248;
      if (contentPixel) {
        nonWhite += 1;
        const pixelIndex = index / 4;
        const x = pixelIndex % canvas.width;
        const y = Math.floor(pixelIndex / canvas.width);
        contentMinX = Math.min(contentMinX, x);
        contentMinY = Math.min(contentMinY, y);
        contentMaxX = Math.max(contentMaxX, x);
        contentMaxY = Math.max(contentMaxY, y);
      }
      if (Math.max(r, g, b) - Math.min(r, g, b) >= 12) chromatic += 1;
      hash = Math.imul(hash ^ r, 16777619);
      hash = Math.imul(hash ^ g, 16777619);
      hash = Math.imul(hash ^ b, 16777619);
    }
    const count = canvas.width * canvas.height;
    return {
      captured: true,
      hasContent: (maxLuma - minLuma >= 8 && nonWhite / count >= 0.005)
        || chromatic / count >= 0.002,
      signature: (hash >>> 0).toString(16).padStart(8, '0'),
      nonWhiteRatio: nonWhite / count,
      chromaticRatio: chromatic / count,
      lumaRange: maxLuma - minLuma,
      contentBounds: contentMaxX >= contentMinX && contentMaxY >= contentMinY
        ? {
            leftRatio: contentMinX / canvas.width,
            topRatio: contentMinY / canvas.height,
            rightRatio: (contentMaxX + 1) / canvas.width,
            bottomRatio: (contentMaxY + 1) / canvas.height,
          }
        : null,
    };
  }, { encodedPng: encoded, pageRect: observedRect, sampleEdge: SAMPLE_EDGE });
}

async function measureTransition(page, label, trigger, measureShell, requireConfigInRun) {
  await resetIpcTrace(page);
  const ppeRequestIdsBeforeTrigger = latestFulfilledPpeRequestIds(ipcTraceByPage.get(page));
  const preTriggerDom = await domState(page);
  const preTriggerSourceTokens = new Set(
    (preTriggerDom.tiles || []).map((tile) => tile.sourceToken).filter(Boolean),
  );
  const logOffset = await perfLogOffset();
  const started = performance.now();
  const triggerStarted = performance.now();
  const triggerResult = await trigger();
  const triggerOverheadMs = performance.now() - triggerStarted;
  let shellMs = null;
  let fspMs = null;
  let fcvfMs = null;
  let blankStartedAt = null;
  let blankTotalMs = 0;
  let blankMaxMs = 0;
  let stableFrames = 0;
  let previousSignature = null;
  let last = null;
  let expectedSourceKey = null;
  let screenshotCount = 0;
  let screenshotTotalMs = 0;
  let nextScreenshotAt = 0;
  const deadline = performance.now() + TIMEOUT_MS;
  while (performance.now() < deadline) {
    const identity = await displayedPdfIdentity(page);
    if (!expectedSourceKey && identity?.sourceKey) {
      expectedSourceKey = identity.sourceKey;
    }
    const identityMatches = Boolean(identity)
      && identity.numPages > 0
      && Boolean(identity.sourceKey)
      && (!expectedSourceKey || identity.sourceKey === expectedSourceKey);
    const dom = identityMatches
      ? await domState(page)
      : { shell: false, pageRect: null, tiles: [], coverageRatio: 0, sharp: false };
    if (measureShell && dom.shell && shellMs === null) {
      shellMs = Math.round(performance.now() - started);
    }
    let compositor = { captured: false, hasContent: false, signature: null };
    let capturedNewScreenshot = false;
    if (dom.tiles.length && performance.now() >= nextScreenshotAt) {
      const screenshotStarted = performance.now();
      compositor = await compositorState(page, dom);
      screenshotTotalMs += performance.now() - screenshotStarted;
      screenshotCount += 1;
      capturedNewScreenshot = compositor.captured;
      nextScreenshotAt = performance.now() + MAX_SCREENSHOT_INTERVAL_MS;
    } else if (last?.compositor) {
      compositor = { ...last.compositor, captured: false };
    }
    const observedAt = performance.now();
    if (requireConfigInRun && !engineConfigCapturedInCurrentTrace(page)) {
      last = {
        identity: reportIdentity(identity), dom: reportDom(dom), compositor, frameEvidence: null,
      };
      await sleep(POLL_MS);
      continue;
    }
    const liveTrace = ipcTraceByPage.get(page);
    const framePpeCandidates = fulfilledPpeCandidatesForDom(
      liveTrace,
      dom,
      expectedSourceKey,
      PDF_PATH,
      preTriggerSourceTokens,
    );
    const postGeometryCandidates = postTriggerPpeCandidates(
      framePpeCandidates,
      triggerStarted,
      ppeRequestIdsBeforeTrigger,
    );
    const postTriggerGeometry = aggregatePpeCandidateGeometry(postGeometryCandidates, dom);
    const latestFramePpeCompletedAt = postGeometryCandidates.reduce(
      (latest, call) => Math.max(latest, Number(call.completedAt) || 0),
      0,
    );
    const frameEvidence = {
      correlation: 'post-trigger-path-page-interactive-geometry-candidate-no-compositor-request-id',
      candidateCount: framePpeCandidates.length,
      candidateRequestIds: framePpeCandidates.map((call) => (
        createHash('sha256').update(call.requestId).digest('hex').slice(0, 16)
      )),
      candidateGeometry: framePpeCandidates.map((call) => ({
        requestId: createHash('sha256').update(call.requestId).digest('hex').slice(0, 16),
        ...call.geometryEvidence,
      })),
      postGeometryCandidateCount: postGeometryCandidates.length,
      postGeometryCandidateRequestIds: postGeometryCandidates.map((call) => (
        createHash('sha256').update(call.requestId).digest('hex').slice(0, 16)
      )),
      postTriggerGeometry,
      latestCompletedAt: latestFramePpeCompletedAt || null,
    };
    const completedPpeForFrame = latestFramePpeCompletedAt > started
      && postTriggerGeometry.valid
      && capturedNewScreenshot
      && latestFramePpeCompletedAt <= observedAt;
    const visibleSurface = dom.coverageRatio >= VIEWPORT_COVERAGE_GATE && compositor.hasContent;
    const visualFrame = visibleSurface && completedPpeForFrame;
    const beforeRect = triggerResult.beforePageRect;
    const geometryReady = !triggerResult.requireGeometryChange || Boolean(dom.pageRect && beforeRect)
      && (
        Math.abs(dom.pageRect.width - beforeRect.width) >= Math.max(2, beforeRect.width * 0.05)
        || Math.abs(dom.pageRect.height - beforeRect.height) >= Math.max(2, beforeRect.height * 0.05)
      );
    const hasFrame = visualFrame && geometryReady;
    // Blank-gap chỉ đếm lúc compositor thật sự không có frame. Surface cũ còn hiện
    // trong lúc đổi zoom là hành vi tốt, không được ghi oan thành màn trắng.
    if (dom.shell && !visibleSurface && blankStartedAt === null) blankStartedAt = observedAt;
    if (visibleSurface && blankStartedAt !== null) {
      const gap = observedAt - blankStartedAt;
      blankTotalMs += gap;
      blankMaxMs = Math.max(blankMaxMs, gap);
      blankStartedAt = null;
    }
    if (hasFrame && fspMs === null) fspMs = Math.round(observedAt - started);
    if (capturedNewScreenshot && hasFrame && dom.sharp && postTriggerGeometry.sharpValid) {
      stableFrames = compositor.signature === previousSignature ? stableFrames + 1 : 1;
      previousSignature = compositor.signature;
      if (stableFrames >= REQUIRED_STABLE_FRAMES) {
        fcvfMs = Math.round(performance.now() - started);
        last = { dom, compositor, frameEvidence };
        break;
      }
    } else if (capturedNewScreenshot) {
      stableFrames = 0;
      previousSignature = null;
    }
    last = { identity: reportIdentity(identity), dom: reportDom(dom), compositor, frameEvidence };
    await sleep(POLL_MS);
  }
  if (fcvfMs === null) {
    const now = performance.now();
    const perfLog = await readNewPerfLog(logOffset);
    const ipcCalls = await readIpcTrace(page);
    return {
      label,
      trigger: triggerResult,
      shellMs,
      fspMs,
      fcvfMs: null,
      blankGapTotalMs: Math.round(blankTotalMs),
      blankGapMaxMs: Math.round(blankMaxMs),
      blankGapOpen: blankStartedAt !== null,
      blankGapCurrentMs: blankStartedAt === null ? 0 : Math.round(now - blankStartedAt),
      timeoutStage: fspMs === null ? 'fsp' : 'fcvf',
      stableFrames,
      sourceKeyCaptured: Boolean(expectedSourceKey),
      harnessObservation: {
        screenshotCount,
        screenshotTotalMs: Math.round(screenshotTotalMs),
        triggerOverheadMs: Math.round(triggerOverheadMs),
      },
      frameRequestCorrelation: 'post-trigger-path-page-interactive-geometry-candidate-no-compositor-request-id',
      pipelineEvidence: pipelineEvidenceFromIpcTrace(ipcCalls),
      nativePerfEvidence: nativePerfEvidence(perfLog),
      final: last ? { ...last, frameEvidence: null } : null,
    };
  }
  const perfLog = await readNewPerfLog(logOffset);
  const ipcCalls = await readIpcTrace(page);
  return {
    label,
    trigger: triggerResult,
    shellMs,
    fspMs,
    fcvfMs,
    blankGapTotalMs: Math.round(blankTotalMs),
    blankGapMaxMs: Math.round(blankMaxMs),
    blankGapOpen: false,
    blankGapCurrentMs: 0,
    timeoutStage: null,
    stableFrames,
    sourceKeyCaptured: Boolean(expectedSourceKey),
    harnessObservation: {
      screenshotCount,
      screenshotTotalMs: Math.round(screenshotTotalMs),
      triggerOverheadMs: Math.round(triggerOverheadMs),
    },
    frameRequestCorrelation: 'post-trigger-path-page-interactive-geometry-candidate-no-compositor-request-id',
    pipelineEvidence: pipelineEvidenceFromIpcTrace(ipcCalls),
    nativePerfEvidence: nativePerfEvidence(perfLog),
    final: last,
  };
}

async function measureOpen(page) {
  const run = await measureTransition(page, 'cold-open', async () => {
    const result = await dispatchPath(page);
    if (result.accepted !== 1) {
      throw new Error(`Dispatcher không nhận đúng một file PDF: ${result.accepted}.`);
    }
    return result;
  }, true, true);
  const measuredTabId = await activeMeasuredTabId(page);
  if (!measuredTabId) throw new Error('Không xác định duy nhất tab active sau cold-open.');
  return { ...run, measuredTabId };
}

async function measureWarmZoom(page) {
  return measureTransition(page, 'warm-zoom', () => triggerWarmZoom(page), false, false);
}

if (process.env.PRYNX_VIEWER_BASELINE_SELF_TEST === '1') {
  if (!await pathsReferToSameFile(
    resolve('self-test', 'standee.pdf'),
    resolve('self-test', 'standee.pdf'),
  )) {
    throw new Error('same-file self-test fail');
  }
  const coverage = mergedCoverageRatio(
    [
      { left: 0, top: 0, right: 60, bottom: 100 },
      { left: 40, top: 0, right: 100, bottom: 100 },
    ],
    { left: 0, top: 0, right: 100, bottom: 100 },
  );
  if (Math.abs(coverage - 1) > 1e-9) throw new Error(`coverage self-test fail: ${coverage}`);
  const sharp = sharpCoverageRatio(
    [
      { x: 0, y: 0, width: 50, height: 100, quality: 1 },
      { x: 50, y: 0, width: 50, height: 100, quality: 0.5 },
    ],
    { left: 0, top: 0, right: 100, bottom: 100 },
  );
  if (Math.abs(sharp - 0.5) > 1e-9) throw new Error(`sharp coverage self-test fail: ${sharp}`);
  const deviceSharp = sharpCoverageRatio(
    [
      { x: 0, y: 0, width: 50, height: 100, quality: 0.979 },
      { x: 50, y: 0, width: 50, height: 100, quality: 0.98 },
    ],
    { left: 0, top: 0, right: 100, bottom: 100 },
  );
  if (Math.abs(deviceSharp - 0.5) > 1e-9) {
    throw new Error(`device-pixel sharp density self-test fail: ${deviceSharp}`);
  }
  if (Math.abs(warmZoomTarget(0.1) - 2) > 1e-9
    || Math.abs(warmZoomTarget(1) - 2) > 1e-9
    || Math.abs(warmZoomTarget(3) - 2.01) > 1e-9) {
    throw new Error('warm zoom target self-test fail');
  }
  const passingTransition = {
    fcvfMs: 10,
    stableFrames: 2,
    final: {
      dom: { sharpCoverageRatio: 0.98 },
      compositor: { hasContent: true },
      frameEvidence: {
        candidateCount: 1,
        postTriggerGeometry: { valid: true, sharpValid: true },
      },
    },
  };
  if (!transitionPassesPixelGate(passingTransition)
    || transitionPassesPixelGate({ ...passingTransition, fcvfMs: null })
    || transitionPassesPixelGate({
      ...passingTransition,
      final: { ...passingTransition.final, compositor: { hasContent: false } },
    })) {
    throw new Error('transition fail-closed pixel gate self-test fail');
  }
  const trace = (calls, mode = 'ppe-only', shadow = false) => ({
    resetSequence: 7,
    viewerConfig: {
      viewerEngineMode: mode,
      viewerShadowEnabled: shadow,
      source: 'get_pdf_viewer_bootstrap',
      sourcePathMatched: true,
      capturedResetSequence: 7,
      validatedResetSequence: 7,
    },
    calls,
  });
  const staleConfigTrace = trace([], 'ppe-only');
  staleConfigTrace.resetSequence = 8;
  if (pipelineEvidenceFromIpcTrace(staleConfigTrace).verifiedPpeOnly) {
    throw new Error('pipeline evidence self-test fail: stale config sequence');
  }
  const fulfilled = {
    command: 'render_ppe_page',
    payloadParsed: true,
    requestId: 'ppe-1',
    pipelineIdentity: PPE_PIPELINE_ID,
    filePath: PDF_PATH,
    page: 1,
    dpi: 96,
    rotation: 0,
    ownerId: 'tab-1:document-1',
    groupKey: 'page:1:viewport',
    generation: 1,
    purpose: 'accurate',
    priority: 0,
    status: 'fulfilled',
    resetSequence: 7,
    startedAt: 101,
    completedAt: 102,
  };
  if (!pipelineEvidenceFromIpcTrace(trace([fulfilled])).verifiedPpeOnly) {
    throw new Error('pipeline evidence self-test fail: PPE-only');
  }
  const fullPageDom = {
    tiles: [{
      x: 0, y: 0, width: 100, height: 100, naturalWidth: 100, naturalHeight: 100,
      requestPage: 1, requestZoom: 1, requestRotation: 0, requestClip: null,
      accurateOnly: true, sourceToken: 'blob:full-new',
    }],
    pageRect: { x: 0, y: 0, width: 100, height: 100 },
    visibleRect: { x: 0, y: 0, width: 100, height: 100 },
    page: 1,
  };
  if (fulfilledPpeCandidatesForDom(
    { resetSequence: 7, calls: [fulfilled] },
    fullPageDom,
    `blob:standee|${PDF_PATH}`,
    PDF_PATH,
    new Set(['blob:full-old']),
  ).length !== 1) throw new Error('frame PPE candidate self-test fail');
  if (postTriggerPpeCandidates([{ ...fulfilled, startedAt: 99 }], 100).length !== 0
    || postTriggerPpeCandidates([fulfilled], 100).length !== 1
    || postTriggerPpeCandidates([fulfilled], 100, new Set([fulfilled.requestId])).length !== 0) {
    throw new Error('frame PPE post-trigger request-time self-test fail');
  }
  const clipped = {
    ...fulfilled,
    requestId: 'ppe-clip',
    dpi: 192,
    clip: { x: 100, y: 200, width: 400, height: 300 },
  };
  const clippedDom = {
    tiles: [{
      x: 10, y: 20, width: 200, height: 150, naturalWidth: 400, naturalHeight: 300,
      requestPage: 1, requestZoom: 2, requestRotation: 0,
      requestClip: { x: 100, y: 200, width: 400, height: 300 }, accurateOnly: true,
      sourceToken: 'blob:clip-new',
    }],
    pageRect: { x: 0, y: 0, width: 500, height: 800 },
    visibleRect: { x: 10, y: 20, width: 200, height: 150 },
    page: 1,
  };
  if (fulfilledPpeCandidatesForDom(
    { resetSequence: 7, calls: [clipped] }, clippedDom, `blob:standee|${PDF_PATH}`, PDF_PATH,
    new Set(['blob:clip-old']),
  ).length !== 1) throw new Error('frame PPE clipped coverage self-test fail');
  const staleSurfaceCandidates = fulfilledPpeCandidatesForDom(
    { resetSequence: 7, calls: [clipped] },
    { ...clippedDom, tiles: clippedDom.tiles.map((tile) => ({ ...tile, sourceToken: 'blob:clip-old' })) },
    `blob:standee|${PDF_PATH}`,
    PDF_PATH,
    new Set(['blob:clip-old']),
  );
  if (aggregatePpeCandidateGeometry(staleSurfaceCandidates, clippedDom).valid) {
    throw new Error('frame PPE stale surface self-test fail');
  }
  const blurryDom = {
    ...clippedDom,
    tiles: clippedDom.tiles.map((tile) => ({
      ...tile,
      naturalWidth: 200,
      naturalHeight: 150,
      sourceToken: 'blob:clip-blurry',
    })),
  };
  const blurryCandidates = fulfilledPpeCandidatesForDom(
    { resetSequence: 7, calls: [clipped] }, blurryDom,
    `blob:standee|${PDF_PATH}`, PDF_PATH, new Set(['blob:clip-old']),
  );
  if (aggregatePpeCandidateGeometry(blurryCandidates, blurryDom).sharpValid) {
    throw new Error('frame PPE blurry surface self-test fail');
  }
  const wrongViewportCandidates = fulfilledPpeCandidatesForDom(
    { resetSequence: 7, calls: [clipped] },
    { ...clippedDom, visibleRect: { x: 250, y: 20, width: 200, height: 150 } },
    `blob:standee|${PDF_PATH}`,
    PDF_PATH,
    new Set(['blob:clip-old']),
  );
  if (aggregatePpeCandidateGeometry(
    wrongViewportCandidates,
    { ...clippedDom, visibleRect: { x: 250, y: 20, width: 200, height: 150 } },
  ).valid) throw new Error('frame PPE wrong-viewport clip self-test fail');
  const leftHalf = {
    ...clipped,
    requestId: 'ppe-left',
    clip: { x: 0, y: 0, width: 200, height: 300 },
  };
  const rightHalf = {
    ...clipped,
    requestId: 'ppe-right',
    clip: { x: 200, y: 0, width: 200, height: 300 },
  };
  const tiledDom = {
    ...clippedDom,
    tiles: [
      {
        x: 10, y: 20, width: 100, height: 150, naturalWidth: 200, naturalHeight: 300,
        requestPage: 1, requestZoom: 2, requestRotation: 0,
        requestClip: { x: 0, y: 0, width: 200, height: 300 }, accurateOnly: true,
        sourceToken: 'blob:left-new',
      },
      {
        x: 110, y: 20, width: 100, height: 150, naturalWidth: 200, naturalHeight: 300,
        requestPage: 1, requestZoom: 2, requestRotation: 0,
        requestClip: { x: 200, y: 0, width: 200, height: 300 }, accurateOnly: true,
        sourceToken: 'blob:right-new',
      },
    ],
  };
  const tiledCandidates = fulfilledPpeCandidatesForDom(
    { resetSequence: 7, calls: [leftHalf, rightHalf] }, tiledDom,
    `blob:standee|${PDF_PATH}`, PDF_PATH, new Set(['blob:left-old', 'blob:right-old']),
  );
  if (tiledCandidates.length !== 2
    || !aggregatePpeCandidateGeometry(tiledCandidates, tiledDom).valid) {
    throw new Error('frame PPE tiled viewport union self-test fail');
  }
  const inheritedConfigTrace = trace([fulfilled]);
  inheritedConfigTrace.viewerConfig.capturedResetSequence = 6;
  if (!pipelineEvidenceFromIpcTrace(inheritedConfigTrace).verifiedPpeOnly
    || pipelineEvidenceFromIpcTrace(inheritedConfigTrace).engineConfigCapturedInRun) {
    throw new Error('pipeline evidence self-test fail: inherited warm config');
  }
  if (pipelineEvidenceFromIpcTrace(trace([
    fulfilled,
    { command: 'render_pdf_page', requestId: 'display-1', status: 'fulfilled' },
  ])).verifiedPpeOnly) throw new Error('pipeline evidence self-test fail: display contamination');
  if (pipelineEvidenceFromIpcTrace(trace([
    fulfilled,
    {
      command: 'render_ppe_page',
      requestId: 'ppe-2',
      pipelineIdentity: PPE_PIPELINE_ID,
      status: 'rejected',
    },
  ])).verifiedPpeOnly) throw new Error('pipeline evidence self-test fail: mixed PPE rejection');
  if (pipelineEvidenceFromIpcTrace(trace([
    fulfilled,
    {
      command: 'render_ppe_page',
      requestId: 'ppe-2',
      pipelineIdentity: PPE_PIPELINE_ID,
      status: 'pending',
    },
  ])).verifiedPpeOnly) throw new Error('pipeline evidence self-test fail: pending PPE');
  if (pipelineEvidenceFromIpcTrace(trace([
    fulfilled,
    { command: 'get_pdf_metadata', filePath: PDF_PATH, payloadParsed: true, status: 'rejected' },
  ])).verifiedPpeOnly) throw new Error('pipeline evidence self-test fail: rejected config');
  if (pipelineEvidenceFromIpcTrace(trace([
    fulfilled,
    {
      command: 'get_pdf_metadata', filePath: PDF_PATH, payloadParsed: true,
      status: 'fulfilled', configPayloadValid: false,
    },
  ])).verifiedPpeOnly) throw new Error('pipeline evidence self-test fail: invalid config');
  const conflictingConfigTrace = createIpcTraceState(12);
  const staleModeConfigCall = recordIpcTraceCall(
    conflictingConfigTrace,
    'get_pdf_viewer_bootstrap',
    { filePath: PDF_PATH },
  );
  settleIpcTraceCall(conflictingConfigTrace, staleModeConfigCall, 'fulfilled', {
    viewerEngineMode: 'current',
    viewerShadowEnabled: false,
  });
  const expectedModeConfigCall = recordIpcTraceCall(
    conflictingConfigTrace,
    'get_pdf_metadata',
    { filePath: PDF_PATH },
  );
  settleIpcTraceCall(conflictingConfigTrace, expectedModeConfigCall, 'fulfilled', {
    viewerEngineMode: 'ppe-only',
    viewerShadowEnabled: false,
  });
  conflictingConfigTrace.calls.push({ ...fulfilled, resetSequence: 12 });
  const conflictingConfigEvidence = pipelineEvidenceFromIpcTrace(conflictingConfigTrace);
  if (conflictingConfigEvidence.verifiedPpeOnly
    || conflictingConfigEvidence.engineConfigUnexpectedCount !== 1) {
    throw new Error('pipeline evidence self-test fail: conflicting config responses');
  }
  if (pipelineEvidenceFromIpcTrace(trace([
    { ...fulfilled, requestId: null },
  ])).verifiedPpeOnly) throw new Error('pipeline evidence self-test fail: missing identity');
  if (pipelineEvidenceFromIpcTrace(trace([
    { ...fulfilled, resetSequence: 6 },
  ])).verifiedPpeOnly) throw new Error('pipeline evidence self-test fail: stale request sequence');
  if (pipelineEvidenceFromIpcTrace(trace([fulfilled], 'hybrid')).verifiedPpeOnly) {
    throw new Error('pipeline evidence self-test fail: hybrid mode');
  }
  if (pipelineEvidenceFromIpcTrace(trace([fulfilled], 'ppe-only', true)).verifiedPpeOnly) {
    throw new Error('pipeline evidence self-test fail: shadow enabled');
  }
  if (pipelineEvidenceFromIpcTrace(trace([
    { command: 'shadow_render_ppe_page', requestId: 'shadow-1', status: 'fulfilled' },
  ])).verifiedPpeOnly) throw new Error('pipeline evidence self-test fail: shadow only');
  if (documentCacheResetState(true) !== 'removed'
    || documentCacheResetState(false) !== 'already-empty') {
    throw new Error('document cache reset self-test fail');
  }
  const tabStore = {
    getState: () => ({ file: { path: 'D:\\jobs\\standee.pdf' }, viewerNumPages: 1 }),
  };
  const tabOwner = { memoizedProps: { tabId: 'tab-standee' }, pendingProps: null, return: null };
  const measuredFiber = {
    memoizedProps: { value: tabStore }, pendingProps: null,
    child: null, sibling: null, return: tabOwner,
  };
  if (measuredTabIdsFromFiber(measuredFiber, 'd:\\jobs\\standee.pdf')[0] !== 'tab-standee'
    || measuredTabIdsFromFiber(measuredFiber, 'd:\\jobs\\other.pdf').length !== 0) {
    throw new Error('measured tab identity self-test fail');
  }
  if (tauriIpcCommand('ipc://render_ppe_page') !== 'render_ppe_page'
    || tauriIpcCommand('http://ipc.localhost/render_pdf_page') !== 'render_pdf_page'
    || tauriIpcCommand('https://example.com/render_ppe_page') !== null) {
    throw new Error('IPC URL parser self-test fail');
  }
  const invalidPayload = tauriIpcPayload({ postData: () => '{' });
  if (invalidPayload.__tracePayloadParsed !== false) {
    throw new Error('IPC payload parser self-test fail');
  }
  const lifecycle = createIpcTraceState(4);
  const lifecycleCall = recordIpcTraceCall(lifecycle, 'render_ppe_page', {
    filePath: PDF_PATH,
    page: 1,
    dpi: 96,
    requestContext: { requestId: 'ppe-life', pipelineIdentity: PPE_PIPELINE_ID },
  });
  if (pipelineEvidenceFromIpcTrace({
    resetSequence: 4,
    viewerConfig: trace([], 'ppe-only').viewerConfig,
    calls: lifecycle.calls,
  }).verifiedPpeOnly) throw new Error('IPC lifecycle self-test fail: pending');
  let pendingTimeoutRejected = false;
  try {
    await waitForIpcTraceIdle(lifecycle, 0);
  } catch {
    pendingTimeoutRejected = true;
  }
  if (!pendingTimeoutRejected) throw new Error('IPC lifecycle self-test fail: pending timeout');
  settleIpcTraceCall(lifecycle, lifecycleCall, 'fulfilled');
  await waitForIpcTraceIdle(lifecycle, 0);
  const lifecycleEvidence = pipelineEvidenceFromIpcTrace({
    resetSequence: 4,
    viewerConfig: { ...trace([], 'ppe-only').viewerConfig, validatedResetSequence: 4 },
    calls: lifecycle.calls,
  });
  if (!lifecycleEvidence.verifiedPpeOnly || lifecycleEvidence.ppeFulfilledCount !== 1) {
    throw new Error('IPC lifecycle self-test fail: fulfilled');
  }
  let disconnected = false;
  await disconnectAttachedBrowser({ _connection: { close: () => { disconnected = true; } } });
  if (!disconnected) throw new Error('CDP disconnect self-test fail');
  const temporaryReport = resolve(
    '.tmp',
    `ppe-viewer-webview-self-test-${process.pid}-${Date.now()}.json`,
  );
  await writeJsonAtomic(temporaryReport, { complete: false, runs: [1] });
  const atomicReport = JSON.parse(await readFile(temporaryReport, 'utf8'));
  await rm(temporaryReport, { force: true });
  if (atomicReport.complete !== false || atomicReport.runs.length !== 1) {
    throw new Error('atomic report self-test fail');
  }
  const invalidConfigTrace = createIpcTraceState(9);
  const invalidConfigCall = recordIpcTraceCall(invalidConfigTrace, 'get_pdf_metadata', {});
  settleIpcTraceCall(invalidConfigTrace, invalidConfigCall, 'fulfilled', {
    viewerEngineMode: 'ppe-only',
  });
  if (invalidConfigCall.configPayloadValid !== false || invalidConfigTrace.viewerConfig !== null) {
    throw new Error('config payload validation self-test fail');
  }
  const foreignConfigTrace = createIpcTraceState(10);
  const foreignConfigCall = recordIpcTraceCall(foreignConfigTrace, 'get_pdf_metadata', {
    filePath: 'D:\\jobs\\background.pdf',
  });
  settleIpcTraceCall(foreignConfigTrace, foreignConfigCall, 'fulfilled', {
    viewerEngineMode: 'ppe-only',
    viewerShadowEnabled: false,
  });
  if (foreignConfigCall.configSourcePathMatched !== false
    || foreignConfigTrace.viewerConfig !== null) {
    throw new Error('config source-path self-test fail');
  }
  const sensitivePath = process.platform === 'win32'
    ? PDF_PATH.toUpperCase()
    : PDF_PATH;
  if (sanitizeReportText(`mở lỗi ${sensitivePath}`).includes(sensitivePath)) {
    throw new Error('report path redaction self-test fail');
  }
  const encodedSensitivePath = encodeURIComponent(sensitivePath);
  if (sanitizeReportText(`http://localfile.localhost/${encodedSensitivePath}`)
    .toLowerCase().includes(encodedSensitivePath.toLowerCase())) {
    throw new Error('report encoded-path redaction self-test fail');
  }
  if (reportIdentity({ fileName: 'standee.pdf', sourceKey: `blob:x|${PDF_PATH}`, numPages: 1 })
    .sourceKeyStored !== false) {
    throw new Error('report identity redaction self-test fail');
  }
  const redactedReport = redactReportValue({ nested: { error: `lỗi ${sensitivePath}` } });
  if (redactedReport.nested.error.includes(sensitivePath)) {
    throw new Error('recursive report redaction self-test fail');
  }
  console.log(JSON.stringify({ ok: true, schemaVersion: 2 }));
  process.exit(0);
}

  const report = {
  schemaVersion: 2,
  scope: 'end-to-end-webview-main-page-thumbnail-closed',
  timingUnit: 'ms',
  artifact: {
    name: basename(PDF_PATH),
    sizeBytes: null,
    sha256: null,
    pathStored: false,
    matchesAuditedStandee: false,
  },
  config: {
    runs: RUNS,
    pairs: RUNS / 2,
    baselineKind: SMOKE_MODE ? 'cleanup-smoke' : 'official',
    transitions: ['cold-open', 'warm-zoom'],
    pollMs: POLL_MS,
    timeoutMs: TIMEOUT_MS,
    stableFrames: REQUIRED_STABLE_FRAMES,
    stableFrameRule: 'distinct-screenshot-captures',
    screenshotIntervalMs: MAX_SCREENSHOT_INTERVAL_MS,
    measurementScope: MEASUREMENT_SCOPE,
    thumbnailPolicy: 'new-viewer-default-closed-and-verified-per-run',
    expectedRuntimeEnv: EXPECTED_RUNTIME_ENV,
    requireStandeeHash: REQUIRE_STANDEE_HASH,
  },
  sessionEvidence: {
    pipelineScope: 'target-webview-cdp-network-ipc-trace',
    engineModeGate: 'ppe-only',
    shadowGate: false,
    nativePerfLogScope: 'global-file-bounded-by-offset-supplemental',
    thumbnailBaselineStatus: 'separate-runtime-gate-required',
    frameRequestCorrelation: 'post-trigger-path-page-interactive-geometry-candidate-no-compositor-request-id',
  },
  limitations: [
    'FSP/FCVF chỉ tương quan PPE fulfilled phát sinh sau trigger với LiveTile theo path/trang/DPI/xoay/clip và độ phủ viewport; compositor chưa phát request ID của surface.',
    'Report này chỉ đo trang chính khi thumbnail đóng; không phải baseline thumbnail.',
    'PrynX_RenderPerf.log là log toàn cục và chỉ dùng bổ sung, không chứng minh pipeline của frame.',
  ],
  runs: [],
  consoleErrors: [],
  badHttp: [],
  processMemory: {
    status: 'not-measured-by-cdp-harness',
    scope: 'whole-application-tree-required-separately',
  },
  complete: false,
  failure: null,
};

if (await pathsReferToSameFile(RAW_PDF_PATH, RAW_OUTPUT)) {
  report.failure = {
    message: 'Output baseline WebView không được trùng file PDF đầu vào.',
    completedRuns: 0,
  };
  report.complete = false;
  await writeReportAtomic(`${OUTPUT}.failure.json`, report);
  throw new Error(report.failure.message);
}

let browser = null;
let tracedPage = null;
let pendingError = null;
try {
  const artifactStat = await stat(PDF_PATH);
  const initialArtifactIdentity = {
    sizeBytes: artifactStat.size,
    mtimeMs: artifactStat.mtimeMs,
    ctimeMs: artifactStat.ctimeMs,
  };
  const artifactHash = await sha256File(PDF_PATH);
  report.artifact.sizeBytes = artifactStat.size;
  report.artifact.sha256 = artifactHash;
  report.artifact.matchesAuditedStandee = artifactHash === STANDEE_SHA256;
  if (REQUIRE_STANDEE_HASH && !report.artifact.matchesAuditedStandee) {
    throw new Error(`SHA-256 không khớp Standee audit: ${artifactHash}`);
  }
  await assertFileIdentity(PDF_PATH, initialArtifactIdentity);
  browser = await chromium.connectOverCDP(CDP_URL);
  const pages = browser.contexts().flatMap((context) => context.pages());
  const candidates = [];
  for (const candidate of pages) {
    if (await candidate.locator('#root').count()
      && await candidate.evaluate(() => Boolean(window.__TAURI_INTERNALS__))) {
      candidates.push(candidate);
    }
  }
  if (candidates.length !== 1) {
    throw new Error(`Cần đúng 1 WebView PrynX qua CDP; hiện thấy ${candidates.length}.`);
  }
  const [page] = candidates;
  tracedPage = page;
  page.on('console', (message) => {
    if (message.type() === 'error') report.consoleErrors.push(sanitizeReportText(message.text()));
  });
  page.on('pageerror', (error) => report.consoleErrors.push(sanitizeReportText(error)));
  page.on('response', (response) => {
    if (response.status() >= 400) {
      report.badHttp.push({ status: response.status(), url: sanitizeReportText(response.url()) });
    }
  });

  await prepareSession(page);
  await installIpcTrace(page);
  const initialMeasuredTabIds = await measuredFileTabIds(page);
  report.sessionEvidence.initialMeasuredTabCount = initialMeasuredTabIds.length;
  if (initialMeasuredTabIds.length !== 0) {
    throw new Error(
      'Standee đang mở trong PrynX. Hãy đóng tab đó trước khi chạy baseline để harness không '
      + 'tự đóng tài liệu của người dùng.',
    );
  }
  let previousMeasuredIdentity = { namespace: PDF_PATH, namespaceKind: 'path-first-run' };
  for (let index = 0; index < RUNS; index += 1) {
    const reportIndex = report.runs.length;
    await assertFileIdentity(PDF_PATH, initialArtifactIdentity);
    const label = index % 2 === 0 ? 'cold-open' : 'warm-zoom';
    // PERF (audit 2026-08-13 §V.1–V.3): cold đóng document/cache do PrynX sở hữu,
    // nhưng không đụng cache hệ điều hành; warm zoom giữ nguyên tab/document session,
    // giữ surface cũ tự nhiên tới khi render mới ở zoom đích sẵn sàng.
    const coldReset = label === 'cold-open'
      ? await clearMeasuredViewerCaches(page, previousMeasuredIdentity)
      : null;
    if (label === 'cold-open' && coldReset.error) {
      report.runs.push({
        index: index + 1, label, valid: false, coldReset,
        validationError: sanitizeReportText(coldReset.error),
      });
      throw new Error(`Không dọn được document cache trước cold run: ${coldReset.error}`);
    }
    if (label === 'cold-open' && coldReset.namespaceHasCachedTile) {
      report.runs.push({
        index: index + 1, label, valid: false, coldReset,
        validationError: 'Tile cache của file đo vẫn còn entry sau khi dọn cold state.',
      });
      throw new Error('Tile cache của file đo vẫn còn entry sau khi dọn cold state.');
    }
    if (label === 'cold-open') {
      coldReset.documentCacheState = documentCacheResetState(coldReset.documentClosed);
    }
    let run;
    let thumbnailEvidence;
    let measuredIdentity;
    try {
      run = label === 'cold-open'
        ? await measureOpen(page)
        : await measureWarmZoom(page);
      thumbnailEvidence = await verifyThumbnailPanelClosed(page);
      measuredIdentity = await measuredViewerCacheIdentity(page);
    } catch (transitionError) {
      report.runs.push({
        index: index + 1,
        label,
        valid: false,
        coldReset,
        validationError: sanitizeReportText(transitionError),
      });
      throw transitionError;
    }
    report.runs.push({
      index: index + 1,
      cacheIdentityKind: measuredIdentity.namespaceKind,
      coldReset,
      thumbnailEvidence,
      ...run,
    });
    try {
      if (!thumbnailEvidence.verified) {
        throw new Error(
          `Lượt ${index + 1} không giữ được phạm vi trang chính với thumbnail đóng: `
          + `${thumbnailEvidence.reason}.`,
        );
      }
      if (!run.sourceKeyCaptured) {
        throw new Error(`Lượt ${index + 1} không khóa được identity file đang hiển thị.`);
      }
      if (!run.pipelineEvidence?.verifiedPpeOnly) {
        throw new Error(
          `Lượt ${index + 1} không có bằng chứng PPE-only sạch: `
          + `mode=${run.pipelineEvidence?.viewerEngineMode}, `
          + `ppe_ok=${run.pipelineEvidence?.ppeFulfilledCount}, `
          + `ppe_rejected=${run.pipelineEvidence?.ppeRejectedCount}, `
          + `ppe_pending=${run.pipelineEvidence?.ppePendingCount}, `
          + `config_rejected=${run.pipelineEvidence?.engineConfigRejectedCount}, `
          + `config_pending=${run.pipelineEvidence?.engineConfigPendingCount}, `
          + `config_invalid=${run.pipelineEvidence?.engineConfigInvalidCount}, `
          + `config_unexpected=${run.pipelineEvidence?.engineConfigUnexpectedCount}, `
          + `display=${run.pipelineEvidence?.displayCallCount}, `
          + `shadow=${run.pipelineEvidence?.shadowCallCount}.`,
        );
      }
      if (label === 'cold-open' && !run.pipelineEvidence.engineConfigCapturedInRun) {
        throw new Error(
          `Lượt ${index + 1} không bắt được bootstrap/metadata cấu hình engine trong chính cold run.`,
        );
      }
      if (!transitionPassesPixelGate(run)) {
        throw new Error(
          `Lượt ${index + 1} không đạt pixel gate: `
          + `timeout=${run.timeoutStage || 'none'}, `
          + `sharp_coverage=${run.final?.dom?.sharpCoverageRatio ?? null}, `
          + `stable_frames=${run.stableFrames ?? 0}.`,
        );
      }
    } catch (validationError) {
      report.runs[reportIndex].valid = false;
      report.runs[reportIndex].validationError = sanitizeReportText(validationError);
      throw validationError;
    }
    report.runs[reportIndex].valid = true;
    // PERF (audit 2026-08-13 §V.1–V.3): checkpoint nằm ngoài cửa sổ timing;
    // nếu session dài bị ngắt, các lượt hợp lệ đã đo vẫn còn với complete=false.
    await writeReportAtomic(OUTPUT, report);
    previousMeasuredIdentity = measuredIdentity;
    if (label === 'warm-zoom') {
      try {
        const coldRun = report.runs[reportIndex - 1];
        const closed = await closeMeasuredFileTabs(page, coldRun?.measuredTabId);
        if (closed.closedCount !== 1) {
          throw new Error(
            `Sau warm run phải đóng đúng 1 tab theo path đã đo; thực tế ${closed.closedCount}.`,
          );
        }
        if (!(await waitForMeasuredViewerGone(page))) {
          throw new Error(`Tab lượt ${index + 1} chưa cleanup Workspace store trước cold run kế.`);
        }
        report.runs[reportIndex].tabClosedAfterPair = true;
        await writeReportAtomic(OUTPUT, report);
      } catch (cleanupPairError) {
        report.runs[reportIndex].valid = false;
        report.runs[reportIndex].validationError = sanitizeReportText(cleanupPairError);
        throw cleanupPairError;
      }
    }
  }
  await assertFileIdentity(PDF_PATH, initialArtifactIdentity);
  if (await sha256File(PDF_PATH) !== artifactHash) {
    throw new Error('Nội dung PDF đo đã thay đổi trước khi chốt baseline.');
  }
  const cold = report.runs.filter((run) => run.label === 'cold-open');
  const warm = report.runs.filter((run) => run.label === 'warm-zoom');
  const metric = (rows, name) => summarize(rows.map((row) => row[name]).filter(Number.isFinite));
  report.summary = {
    cold: {
      shellMs: metric(cold, 'shellMs'),
      fspMs: metric(cold, 'fspMs'),
      fcvfMs: metric(cold, 'fcvfMs'),
      blankGapMaxMs: metric(cold, 'blankGapMaxMs'),
    },
    warmZoom: {
      fspMs: metric(warm, 'fspMs'),
      fcvfMs: metric(warm, 'fcvfMs'),
      blankGapMaxMs: metric(warm, 'blankGapMaxMs'),
    },
    passedPixelGate: report.runs.every((run) => (
      run.valid === true
      && run.sourceKeyCaptured === true
      && transitionPassesPixelGate(run)
      && run.pipelineEvidence?.verifiedPpeOnly
      && (run.label !== 'cold-open' || run.pipelineEvidence?.engineConfigCapturedInRun)
      && run.thumbnailEvidence?.verified
    )),
  };
  report.complete = report.runs.length === RUNS && report.summary.passedPixelGate;
  if (!report.complete) {
    throw new Error('Baseline WebView chưa đạt đủ pixel gate cho toàn bộ lượt đo.');
  }
} catch (error) {
  pendingError = error;
  report.failure = {
    message: sanitizeReportText(error),
    completedRuns: report.runs.length,
    validRuns: report.runs.filter((run) => run.valid === true).length,
  };
  report.runs = report.runs.map((run) => ({
    ...run,
    validationError: run.validationError ? sanitizeReportText(run.validationError) : undefined,
  }));
} finally {
  let cleanupError = null;
  if (tracedPage && !tracedPage.isClosed()) {
    try {
      await uninstallIpcTrace(tracedPage);
    } catch (error) {
      cleanupError = sanitizeReportText(`Không gỡ được listener IPC trace: ${error}`);
    }
  } else if (tracedPage) {
    cleanupError = 'WebView mục tiêu đã đóng trước khi gỡ listener IPC trace.';
  }
  if (browser) {
    try {
      await disconnectAttachedBrowser(browser);
    } catch (error) {
      cleanupError = cleanupError || sanitizeReportText(`Không ngắt được transport CDP: ${error}`);
    }
  }
  if (cleanupError) {
    report.cleanupError = cleanupError;
    report.complete = false;
    if (!pendingError) {
      pendingError = new Error(cleanupError);
      report.failure = {
        message: cleanupError,
        completedRuns: report.runs.length,
        validRuns: report.runs.filter((run) => run.valid === true).length,
      };
    }
  }
  if (pendingError && isFatalWebViewError(pendingError)) report.complete = false;
  try {
    await writeReportAtomic(OUTPUT, report);
  } catch (error) {
    if (!pendingError) pendingError = error;
    else pendingError = new AggregateError(
      [pendingError, error],
      `Baseline thất bại và không ghi được report: ${error}`,
    );
  }
}

if (pendingError) {
  // PERF (audit 2026-08-14 §VIEW.LARGE.3): connectOverCDP có thể để lại handle nội bộ
  // của Playwright dù transport phía harness đã ngắt. Report đã được await/ghi atomic ở
  // trên; thoát riêng tiến trình đo để không treo phiên và tuyệt đối không gửi Browser.close
  // sang WebView PrynX đang chạy.
  console.error(pendingError instanceof Error
    ? pendingError.stack || pendingError.message
    : String(pendingError));
  process.exit(1);
}

console.log(JSON.stringify({ output: OUTPUT, summary: report.summary }, null, 2));
process.exit(0);
