// PERF (audit 2026-09-25 §R25.GPU.09/11/12/13): lease và đơn vị IPC rõ ràng.
import { useEffect, useLayoutEffect, useRef, useState, useCallback, type RefObject } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { viewerTraceLog } from '../../lib/previewPerfLog';
import { nativePopupExclusions, type NativeInteractionEvent, type NativeInteractionUpdate } from './nativeViewportInteraction';

export interface NativeCameraSnapshot {
  zoom: number; pan_x: number; pan_y: number;
  viewport_width: number; viewport_height: number; dpr: number;
}
export function parseNativeCamera(value: unknown): NativeCameraSnapshot {
  if (!value || typeof value !== 'object') throw new Error('Snapshot camera không hợp lệ');
  const v = value as Record<string, unknown>;
  for (const key of ['zoom', 'pan_x', 'pan_y', 'viewport_width', 'viewport_height', 'dpr']) {
    if (typeof v[key] !== 'number' || !Number.isFinite(v[key])) throw new Error(`Camera thiếu trường ${key}`);
  }
  const c = value as NativeCameraSnapshot;
  if (c.zoom <= 0 || c.dpr <= 0 || c.viewport_width <= 0 || c.viewport_height <= 0) throw new Error('Kích thước camera không hợp lệ');
  // UIUX (audit 2026-09-27 §V27.CAMERA): metadata IPC không thuộc hình học;
  // ACK và event cùng camera phải dedup được dù envelope của chúng khác nhau.
  return { zoom: c.zoom, pan_x: c.pan_x, pan_y: c.pan_y, viewport_width: c.viewport_width,
    viewport_height: c.viewport_height, dpr: c.dpr };
}
function parseCameraVersion(value: unknown): number | null {
  if (value === undefined) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('Phiên bản camera không hợp lệ');
  }
  return value;
}
export type InvalidationLevel = 'L0' | 'L1' | 'L2' | 'L3';
export interface UseNativeGpuViewportOptions {
  enabled?: boolean;
  visible?: boolean;
  document?: { filePath: string; page: number; token: string };
  onCameraChange?: (camera: NativeCameraSnapshot, userInitiatedZoom: boolean) => void;
  onError?: (err: Error) => void;
  interactive?: boolean;
  onInteraction?: (event: NativeInteractionEvent) => void;
}
export interface UseNativeGpuViewportReturn {
  containerRef: RefObject<HTMLDivElement | null>;
  isReady: boolean;
  isSceneReady: boolean;
  isPresented: boolean;
  isVisible: boolean;
  camera: NativeCameraSnapshot | null;
  setZoom: (zoom: number, cursorX?: number, cursorY?: number) => Promise<NativeCameraSnapshot | null>;
  fitPage: (maxZoom?: number) => Promise<NativeCameraSnapshot | null>;
  refreshCamera: () => Promise<NativeCameraSnapshot | null>;
  triggerInvalidation: (level: InvalidationLevel) => Promise<boolean>;
  closeViewport: () => Promise<void>;
  setInteraction: (update: NativeInteractionUpdate) => Promise<boolean>;
}
type Lease = { viewId: string; generation: number; closed: boolean; ready: boolean };
interface SurfaceSize { width: number; height: number; dpr: number }
interface NativeSurfaceProof extends SurfaceSize { epoch: number }
// PERF (audit 2026-09-30 §LOG.DEBUG): Không console.debug object trong hot-loop camera/interaction/status GPU.
// Bật cờ __PRYNX_GPU_DEBUG__ = true trên window khi cần debug sâu sự kiện viewport.
const isGpuDebugVerbose = (): boolean =>
  typeof window !== 'undefined'
  && (window as unknown as { __PRYNX_GPU_DEBUG__?: boolean }).__PRYNX_GPU_DEBUG__ === true;

export function matchesNativeSurfaceProof(value: unknown, expected: SurfaceSize | null, minimumEpoch: number): value is NativeSurfaceProof {
  if (!expected || !value || typeof value !== 'object') {
    if (import.meta.env.DEV && isGpuDebugVerbose()) console.debug('[GPU_PROOF_REJECT] missing expected or value', { expected, value });
    return false;
  }
  const proof = value as Partial<NativeSurfaceProof>;
  const epochOk = Number.isSafeInteger(proof.epoch) && (proof.epoch ?? 0) >= Math.max(1, minimumEpoch);
  const sizeOk = proof.width === expected.width && proof.height === expected.height;
  const dprOk = typeof proof.dpr === 'number' && Number.isFinite(proof.dpr) && Math.abs(proof.dpr - expected.dpr) < .001;
  if (!epochOk || !sizeOk || !dprOk) {
    if (import.meta.env.DEV && isGpuDebugVerbose()) console.debug('[GPU_PROOF_MISMATCH]', { epochOk, sizeOk, dprOk, proof, expected, minimumEpoch });
    return false;
  }
  return true;
}
const args = (lease: Lease) => ({ viewId: lease.viewId, generation: lease.generation });
// PERF (audit 2026-09-25 §R25.GPU.26): nối first-present native với trạng thái DOM.
const trace = (stage: string, lease: Lease, extra: Record<string, unknown> = {}) => {
  void viewerTraceLog('native-viewport-lifecycle', { stage, ...args(lease), ...extra });
};
const isTauri = () => Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);

// UIUX (audit 2026-09-26 §R34.05): trong lúc đổi trang, IPC camera của scene
// trước có thể về sau khi native đã nhận revision mới. Đây là race được chấp
// nhận và phải bỏ qua; không được biến nó thành lỗi renderer rồi unmount HWND.
function isExpectedSceneTransitionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /Zoom thuộc trang cũ|Fit thuộc trang cũ|Tương tác thuộc trang cũ|Revision scene đã hết hiệu lực|Scene thuộc trang (đã đóng|đã thay thế)|Frame đã bị thay thế|Phiên viewport đã hết hiệu lực|Viewport đã đóng|Viewport không tồn tại/i.test(message);
}

export function useNativeGpuViewport(options: UseNativeGpuViewportOptions = {}): UseNativeGpuViewportReturn {
  const { enabled = true } = options;
  const callbacks = useRef(options);
  useLayoutEffect(() => { callbacks.current = options; });
  const containerRef = useRef<HTMLDivElement | null>(null);
  const owner = useRef<string | null>(null);
  if (owner.current === null) owner.current = crypto.randomUUID();
  const generation = useRef(0);
  const active = useRef<Lease | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [isSceneReady, setIsSceneReady] = useState(false);
  const [isPresented, setIsPresented] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  const presentedRevision = useRef(0);
  const sceneRevision = useRef(0);
  const interactionRevision = useRef(0);
  const interactionQueue = useRef<Promise<unknown>>(Promise.resolve());
  const [camera, setCamera] = useState<NativeCameraSnapshot | null>(null);
  const acceptedCamera = useRef<NativeCameraSnapshot | null>(null);
  const acceptedCameraVersion = useRef<number | null>(null);
  const acceptedUserZoomVersion = useRef<number | null>(null);
  const report = useCallback((e: unknown) => {
    if (isExpectedSceneTransitionError(e)) {
      void viewerTraceLog('native-viewport-transition-error-ignored', {
        message: e instanceof Error ? e.message : String(e),
        revision: sceneRevision.current,
      });
      return;
    }
    callbacks.current.onError?.(e instanceof Error ? e : new Error(String(e)));
  }, []);
  const accept = useCallback((lease: Lease, value: unknown, userInitiatedZoom = false, eventVersion?: number) => {
    if (active.current !== lease || lease.closed) return null;
    const snapshot = parseNativeCamera(value);
    const version = parseCameraVersion(eventVersion === undefined
      ? (value as Record<string, unknown>).cameraVersion : eventVersion);
    const previousVersion = acceptedCameraVersion.current;
    // UIUX (audit 2026-09-27 §V27.CAMERA): revision trang chưa đủ để chặn
    // Fit ACK tới trễ sau wheel. Sau khi đã có version, payload cũ không có
    // version cũng không được kéo camera lùi trong cùng scene/lease.
    if (previousVersion !== null && (version === null || version < previousVersion)) return null;
    // PERF (audit 2026-09-27 §V27.E): WM_PAINT/IPC ACK cùng camera không làm
    // React dựng lại cả cây trang phía dưới native HWND.
    const previous=acceptedCamera.current;
    // RPC có thể serialize f32 dạng ngắn, còn event JSON mở rộng thành f64.
    // So cùng giá trị f32 gốc, không dùng epsilon để che một camera khác.
    const sameGeometry = previous && snapshot.viewport_width === previous.viewport_width
      && snapshot.viewport_height === previous.viewport_height
      && Math.fround(snapshot.zoom) === Math.fround(previous.zoom)
      && Math.fround(snapshot.pan_x) === Math.fround(previous.pan_x)
      && Math.fround(snapshot.pan_y) === Math.fround(previous.pan_y)
      && Math.fround(snapshot.dpr) === Math.fround(previous.dpr);
    if (previous && version !== null && version === previousVersion && !sameGeometry) return null;
    if (version !== null) acceptedCameraVersion.current = version;
    if (sameGeometry) {
      // ACK có thể tới trước event cùng version. Giữ camera state nhưng vẫn
      // chuyển quyền zoom tay đúng một lần; không để ACK làm mất ý định user.
      if (userInitiatedZoom && version !== null && acceptedUserZoomVersion.current !== version) {
        acceptedUserZoomVersion.current = version;
        callbacks.current.onCameraChange?.(previous, true);
      }
      return previous;
    }
    acceptedCamera.current=snapshot;
    if (userInitiatedZoom && version !== null) acceptedUserZoomVersion.current = version;
    setCamera(snapshot); callbacks.current.onCameraChange?.(snapshot, userInitiatedZoom); return snapshot;
  }, []);
  const retire = useCallback(async (lease: Lease) => {
    lease.closed = true; lease.ready = false;
    // Đóng cả phiên đang opening: native giữ tombstone để từ chối open đến muộn.
    await invoke('close_native_gpu_viewport', args(lease));
  }, []);
  const closeViewport = useCallback(async () => {
    const lease = active.current; active.current = null;
    setIsReady(false); setIsVisible(false); setCamera(null);
    setIsSceneReady(false); setIsPresented(false); presentedRevision.current = 0; sceneRevision.current++;
    if (lease) { try { await retire(lease); } catch (e) { report(e); } }
  }, [report, retire]);

  useEffect(() => {
    if (!enabled || !isTauri() || !containerRef.current) {
      setIsReady(false); setIsVisible(false); setCamera(null);
      return;
    }
    const lease: Lease = { viewId: owner.current!, generation: ++generation.current, closed: false, ready: false };
    active.current = lease;
    acceptedCamera.current=null;
    acceptedCameraVersion.current=null;
    acceptedUserZoomVersion.current=null;
    trace('mount', lease);
    setIsReady(false); setIsVisible(false); setCamera(null);
    let raf = 0; let busy = false; let opened = false; let previous = ''; let shown = false; let exclusions = '';
    // PERF (audit 2026-09-26 §R34.09): sidebar/ruler/layout transition có thể
    // đổi bounds qua nhiều frame. Resize surface Vulkan ở từng frame làm mất
    // frame đang hiển thị và tạo chuỗi surface-lost → view trắng. Chỉ debounce
    // resize sau khi HWND đã mở; lần mở đầu vẫn đi ngay để không kéo dài cold
    // start, còn visibility bị chặn nếu bounds đã đổi trước ACK.
    let pendingBoundsKey = '';
    let pendingBoundsAt = 0;
    let expectedSurface: SurfaceSize | null = null;
    let minimumSurfaceEpoch = 0;
    let lastSurfaceEpoch = 0;
    let geometryDirty = true;
    let measuredState = '';
    const transitions = new Map<EventTarget, Set<string>>();
    const dirty = () => { geometryDirty = true; };
    const transition = (event: Event) => {
      const target=event.target;
      if (!(target instanceof Element) || !containerRef.current) return;
      if (!target.contains(containerRef.current) && !containerRef.current.contains(target)
        && !target.closest('[role="menu"], .text-selection-toolbar, .acrobat-comment-card')) return;
      const name='propertyName' in event ? String(event.propertyName) : 'animationName' in event ? String(event.animationName) : '';
      const active=transitions.get(target) ?? new Set<string>();
      if (event.type.endsWith('start') || event.type.endsWith('run')) active.add(name); else active.delete(name);
      if (active.size) transitions.set(target,active); else transitions.delete(target);
      dirty();
    };
    const mutations=new MutationObserver(dirty);
    mutations.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['style','class','open','hidden','aria-modal']});
    const sizes=typeof ResizeObserver==='undefined' ? null : new ResizeObserver(dirty);
    sizes?.observe(containerRef.current);
    window.addEventListener('resize',dirty);
    document.addEventListener('scroll',dirty,true);
    const transitionEvents=['transitionrun','transitionend','transitioncancel','animationstart','animationend','animationcancel'];
    transitionEvents.forEach(name=>document.addEventListener(name,transition,true));
    const unlisteners: Array<() => void> = [];
    void listen<{ viewId: string; generation: number; revision: number; camera: unknown; cameraVersion?: number; userInitiatedZoom?: boolean }>('ppe-native-camera', event => {
      // PERF (audit 2026-09-30 §LOG.DEBUG): Không console.debug camera event per-tick chuột trừ khi bật __PRYNX_GPU_DEBUG__
      if (import.meta.env.DEV && isGpuDebugVerbose()) {
        console.debug('[GPU_CAMERA_EVENT]', {
          rev: event.payload.revision,
          currRev: sceneRevision.current,
          cameraVersion: event.payload.cameraVersion,
          userInitiatedZoom: event.payload.userInitiatedZoom,
          camera: event.payload.camera
        });
      }
      if (event.payload.viewId === lease.viewId && event.payload.generation === lease.generation && !lease.closed
        && event.payload.revision === sceneRevision.current) {
        try { accept(lease, event.payload.camera, event.payload.userInitiatedZoom === true, event.payload.cameraVersion); } catch (e) { report(e); }
      }
    }).then(stop => { if (lease.closed) stop(); else unlisteners.push(stop); }).catch(report);
    void listen<{ viewId: string; generation: number; revision: number; event: NativeInteractionEvent }>('ppe-native-interaction', event => {
      const value = event.payload;
      if (import.meta.env.DEV && isGpuDebugVerbose()) {
        console.debug('[GPU_INTERACTION_EVENT]', value.event);
      }
      if (active.current !== lease || lease.closed || value.viewId !== lease.viewId || value.generation !== lease.generation
        || value.revision !== sceneRevision.current || callbacks.current.visible === false) return;
      callbacks.current.onInteraction?.(value.event);
    }).then(stop => { if (lease.closed) stop(); else unlisteners.push(stop); }).catch(report);
    void listen<{ viewId: string; generation: number; revision: number; error: string | null; contentReady?: boolean; surface?: NativeSurfaceProof }>('ppe-native-status', event => {
      const value = event.payload;
      if (import.meta.env.DEV && isGpuDebugVerbose()) {
        console.debug('[GPU_STATUS_EVENT]', {
          rev: value.revision,
          expectedRev: sceneRevision.current,
          contentReady: value.contentReady,
          surface: value.surface,
          expectedSurface,
          minimumSurfaceEpoch
        });
      }
      trace('status', lease, { revision: value.revision, current_revision: sceneRevision.current,
        owner_matches: value.viewId === lease.viewId, generation_matches: value.generation === lease.generation,
        closed: lease.closed, error: value.error });
      if (value.viewId !== lease.viewId || value.generation !== lease.generation || lease.closed
        || value.revision !== sceneRevision.current) {
        if (import.meta.env.DEV && isGpuDebugVerbose() && value.revision !== sceneRevision.current) {
          console.debug('[GPU_STATUS_DROPPED_STALE_REV]', { eventRev: value.revision, currentRev: sceneRevision.current });
        }
        return;
      }
      if (value.error) { report(new Error(value.error)); return; }
      // COLOR (audit 2026-09-27 §V27.C3): proof của surface cũ không được
      // giành quyền sau resize; thiếu boolean/proof không phải ACK hợp lệ.
      if (value.surface && value.surface.epoch < lastSurfaceEpoch) {
        if (import.meta.env.DEV && isGpuDebugVerbose()) {
          console.debug('[GPU_STATUS_DROPPED_OLD_EPOCH]', { epoch: value.surface.epoch, lastSurfaceEpoch });
        }
        return;
      }
      if (value.contentReady === true && matchesNativeSurfaceProof(value.surface, expectedSurface, minimumSurfaceEpoch)) {
        lastSurfaceEpoch = value.surface.epoch;
        presentedRevision.current = value.revision;
        setIsPresented(true);
      } else {
        if (import.meta.env.DEV && isGpuDebugVerbose()) {
          console.debug('[GPU_STATUS_NOT_READY]', {
            contentReady: value.contentReady,
            proofMatch: matchesNativeSurfaceProof(value.surface, expectedSurface, minimumSurfaceEpoch)
          });
        }
        presentedRevision.current = 0;
        setIsPresented(false);
      }
    }).then(stop => { if (lease.closed) stop(); else unlisteners.push(stop); trace('status-listening', lease); }).catch(report);
    const measure = () => {
      if (lease.closed) return;
      raf = requestAnimationFrame(measure);
      if (busy || !containerRef.current) return;
      const readiness=`${callbacks.current.visible !== false}:${callbacks.current.interactive === true}:${presentedRevision.current}:${sceneRevision.current}:${interactionRevision.current}:${window.devicePixelRatio}`;
      if (!geometryDirty && transitions.size===0 && measuredState===readiness && pendingBoundsKey===previous) return;
      geometryDirty=false;measuredState=readiness;
      const rect = containerRef.current.getBoundingClientRect();
      const visible = callbacks.current.visible !== false && rect.width > 0 && rect.height > 0
        && containerRef.current.getClientRects().length > 0;
      // Tính geometry trước khi quyết định đưa HWND lên trên WebView. Trước
      // đây visibility được ACK trước resize; trong vài frame layout đầu HWND
      // nằm ở bounds cũ và che preview bằng surface vừa configure nhưng chưa có
      // pixel. Giữ fallback cho tới khi bounds đã được áp dụng xong.
      const dpr = window.devicePixelRatio || 1;
      const bounds = { x: Math.round(rect.left * dpr), y: Math.round(rect.top * dpr),
        width: Math.max(1, Math.round(rect.right * dpr) - Math.round(rect.left * dpr)),
        height: Math.max(1, Math.round(rect.bottom * dpr) - Math.round(rect.top * dpr)), dpr };
      const key = JSON.stringify(bounds);
      const opening = !opened;
      const geometryStable = opening || key === previous;
      // Không coi frame cũ là scene mới đã sẵn sàng. Một số driver/resize có
      // thể xoá surface trong lúc `load_native_gpu_scene`; nếu vẫn giữ HWND ở
      // trên WebView thì cả fallback cũng bị che và người dùng thấy một khung
      // trống. Chỉ đưa HWND lên sau khi đúng revision đã present.
      const scenePresented = presentedRevision.current === sceneRevision.current;
      const isInteractionReady = !callbacks.current.interactive || interactionRevision.current === sceneRevision.current;

      // UIUX (audit 2026-09-26 Lô 2 - Bất biến chống chớp & hai pha hiển thị):
      // - Pha 1 (Chưa hiện - shown === false): Cần đủ proof nội dung (scenePresented),
      //   tương tác sẵn sàng (isInteractionReady), và geometry ban đầu ổn định (geometryStable).
      // - Pha 2 (Đã hiện - shown === true): DUY TRÌ hiển thị Native, TUYỆT ĐỐI KHÔNG
      //   ẩn HWND khi bounds đang resize hoặc camera stale trong lúc pan/zoom.
      //   Chỉ ẩn khi: visible === false (đổi tab, modal che, occluded) hoặc đổi trang/scene.
      const shouldShow = shown
        ? (visible && scenePresented)
        : (visible && scenePresented && geometryStable && isInteractionReady);
      // Popup nhận cả vùng vẽ lẫn hit-test; không ẩn cả PDF để hiện toolbar/menu.
      if (opened && visible && callbacks.current.interactive) {
        const popups = Array.from(document.querySelectorAll<HTMLElement>('.text-selection-toolbar > div, .acrobat-comment-card > div, [role="menu"]'))
          .filter(el => !el.closest('.opacity-0, [inert], [aria-hidden="true"]') && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden').map(el => el.getBoundingClientRect());
        const holes = nativePopupExclusions(rect, window.devicePixelRatio || 1, popups);
        const key = JSON.stringify(holes);
        if (key !== exclusions) {
          busy = true;
          void invoke('set_native_gpu_viewport_exclusions', { ...args(lease), holes }).then(() => { exclusions = key; })
            .catch(e => { if (!lease.closed && active.current === lease) report(e); }).finally(() => { busy = false; geometryDirty=true; });
          return;
        }
      }
      if (opened && shouldShow !== shown) {
        const requestedRevision = sceneRevision.current;
        if (import.meta.env.DEV && isGpuDebugVerbose()) {
          console.debug('[GPU_VISIBILITY_TRANSITION]', {
            from: shown,
            to: shouldShow,
            visible,
            scenePresented,
            geometryStable,
            isInteractionReady,
            presentedRev: presentedRevision.current,
            sceneRev: requestedRevision
          });
        }
        trace('visibility-start', lease, { visible: shouldShow, revision: requestedRevision, geometry_stable: geometryStable, bounds });
        busy = true;
        void invoke('set_native_gpu_viewport_visibility', { ...args(lease), visible: shouldShow, revision: requestedRevision })
          .then(() => {
            if (active.current !== lease || lease.closed) return;
            shown = shouldShow;
            if (requestedRevision !== sceneRevision.current) return;
            setIsVisible(shown);
            trace('visibility-done', lease, { visible: shown });
          }).catch(e => {
            if (active.current === lease && !lease.closed && sceneRevision.current === requestedRevision) report(e);
          }).finally(() => { busy = false; geometryDirty=true; });
        return;
      }
      if (!visible) return;
      if (key === previous) return;
      if (key !== pendingBoundsKey) {
        pendingBoundsKey = key;
        pendingBoundsAt = performance.now();
        if (!opening) return;
      }
      if (!opening && performance.now() - pendingBoundsAt < 80) return;
      busy = true;
      trace(opening ? 'open-start' : 'resize-start', lease, bounds);
      const surfaceChanged = expectedSurface !== null && (expectedSurface.width !== bounds.width
        || expectedSurface.height !== bounds.height || Math.abs(expectedSurface.dpr - bounds.dpr) >= .001);
      expectedSurface = { width: bounds.width, height: bounds.height, dpr: bounds.dpr };
      void (async () => {
        if (surfaceChanged) {
          minimumSurfaceEpoch = lastSurfaceEpoch + 1;
          presentedRevision.current = 0; setIsPresented(false);
          // Giữ bitmap proof bên dưới trước khi configure xóa swapchain.
          if (shown) {
            await invoke('set_native_gpu_viewport_visibility', { ...args(lease), visible: false, revision: sceneRevision.current });
            shown = false; setIsVisible(false);
          }
        }
        if (lease.closed || active.current !== lease) return null;
        return invoke(opening ? 'open_native_gpu_viewport' : 'resize_native_gpu_viewport', { ...args(lease), ...bounds });
      })()
        .then(async value => {
          if (lease.closed) { if (opening) await retire(lease); return; }
          previous = key; exclusions = '';
          if (opening) {
            accept(lease, value); opened = true; lease.ready = true; setIsReady(true);
            trace('open-done', lease);
          }
        })
        .catch(e => {
          if (!lease.closed) {
            report(e);
            // Schema lỗi cũng phải đóng HWND vừa tạo; không tự mở lại mỗi frame.
            void retire(lease).catch(report);
            setIsReady(false);
          }
        }).finally(() => { busy = false; geometryDirty=true; });
    };
    measure();
    return () => {
      trace('unmount', lease, { revision: sceneRevision.current });
      cancelAnimationFrame(raf);
      mutations.disconnect();sizes?.disconnect();window.removeEventListener('resize',dirty);
      document.removeEventListener('scroll',dirty,true);
      transitionEvents.forEach(name=>document.removeEventListener(name,transition,true));
      unlisteners.forEach(stop => stop()); sceneRevision.current++;
      if (active.current === lease) active.current = null;
      void retire(lease).catch(report);
    };
  }, [enabled, accept, report, retire]);

  const filePath = options.document?.filePath;
  const page = options.document?.page;
  const token = options.document?.token;
  useEffect(() => {
    const lease = active.current;
    const revision = ++sceneRevision.current;
    acceptedCamera.current=null;
    acceptedCameraVersion.current=null;
    acceptedUserZoomVersion.current=null;
    setIsSceneReady(false); setIsPresented(false);
    // Ẩn native trong toàn bộ khoảng scene mới đang compile. Fallback đang
    // mounted sẽ tiếp tục hiện; native chỉ giành quyền sau first-present đúng
    // revision, tránh blank khi surface cũ bị driver xoá giữa chừng.
    setIsVisible(false);
    if (!isReady || !lease?.ready || lease.closed || !filePath || !page) return;
    trace('scene-start', lease, { revision, page });
    void invoke('load_native_gpu_scene', { ...args(lease), filePath, page, revision, documentToken: token ?? '' })
      .then(value => {
        if (sceneRevision.current !== revision || active.current !== lease || lease.closed) return;
        accept(lease, value); setIsSceneReady(true);
        trace('scene-done', lease, { revision });
      }).catch(e => {
        if (sceneRevision.current === revision && active.current === lease && !lease.closed) report(e);
      });
    return () => { sceneRevision.current++; };
  }, [isReady, filePath, page, token, accept, report]);

  const cameraCommand = useCallback(async (command: string, payload: Record<string, unknown> = {}) => {
    const lease = active.current;
    if (!lease?.ready || lease.closed) return null;
    const revision = sceneRevision.current;
    try {
      const value = await invoke(command, { ...args(lease), revision, ...payload });
      return revision === sceneRevision.current ? accept(lease, value) : null;
    }
    catch (e) {
      // R34.04: lỗi của lệnh camera có thể quay về sau khi trang đã đổi.
      if (!lease.closed && active.current === lease && sceneRevision.current === revision) report(e);
      return null;
    }
  }, [accept, report]);
  const setZoom = useCallback((zoom: number, cursorX?: number, cursorY?: number) =>
    cameraCommand('set_native_gpu_viewport_zoom', { zoom, cursorX: cursorX ?? null, cursorY: cursorY ?? null }), [cameraCommand]);
  const fitPage = useCallback((maxZoom?: number) => {
    const lease = active.current; const revision = sceneRevision.current;
    if (!lease?.ready || lease.closed) return Promise.resolve(null);
    return cameraCommand('fit_native_gpu_viewport_page', { revision,
      ...(maxZoom === undefined ? {} : { maxZoom }) });
  }, [cameraCommand]);
  const refreshCamera = useCallback(() => cameraCommand('get_native_gpu_viewport_camera'), [cameraCommand]);
  const setInteraction = useCallback((update: NativeInteractionUpdate): Promise<boolean> => {
    const lease = active.current; const revision = sceneRevision.current;
    if (!lease?.ready || lease.closed) return Promise.resolve(false);
    const work = interactionQueue.current.then(async () => {
      if (active.current !== lease || lease.closed || sceneRevision.current !== revision) return false;
      try {
        await invoke('set_native_gpu_viewport_interaction', { ...args(lease), revision, ...update });
        if (active.current !== lease || lease.closed || sceneRevision.current !== revision) return false;
        interactionRevision.current = revision; return true;
      } catch (e) { if (!lease.closed && sceneRevision.current === revision) report(e); return false; }
    });
    interactionQueue.current = work; return work;
  }, [report]);
  const triggerInvalidation = useCallback(async (level: InvalidationLevel) => {
    const lease = active.current; if (!lease?.ready || lease.closed) return false;
    const revision = sceneRevision.current;
    try {
      await invoke('trigger_native_gpu_viewport_invalidation', { ...args(lease), level, revision });
      return !lease.closed && active.current === lease && sceneRevision.current === revision;
    }
    catch (e) {
      if (!lease.closed && active.current === lease && sceneRevision.current === revision) report(e);
      return false;
    }
  }, [report]);
  return { containerRef, isReady, isSceneReady, isPresented, isVisible, camera, setZoom, fitPage, setInteraction, refreshCamera, triggerInvalidation, closeViewport };
}
