// PERF (audit 2026-09-25 §R25.GPU.17): hình chữ nhật riêng của HWND, không đặt HTML lên surface.
// @refresh reset
import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { viewerTraceLog } from '../../lib/previewPerfLog';
import { useNativeGpuViewport, type NativeCameraSnapshot } from '../../hooks/viewer/useNativeGpuViewport';
import { NativeViewportInteractions } from './NativeViewportInteractions';
import type { WheelNavInput } from '../../hooks/viewer/wheelPageNav';
import { isNativeViewerCommand, type NativeInteractionEvent, type NativeTextBlocks } from '../../hooks/viewer/nativeViewportInteraction';

export interface NativeGpuViewportContainerProps {
  enabled?: boolean;
  selected?: boolean;
  children?: ReactNode;
  visible?: boolean;
  className?: string;
  style?: CSSProperties;
  filePath: string;
  page: number;
  documentToken: string;
  scale: number;
  fitMode?: string;
  /** Mức native tương ứng 100% vật lý; chỉ Smart Fit mới dùng làm giới hạn. */
  smartFitScale?: number;
  onCameraChange?: (camera: NativeCameraSnapshot, userInitiatedZoom: boolean) => void;
  onError?: (err: Error) => void;
  /** Báo cho shell khi HWND native thực sự đã được đưa lên trên WebView. */
  onNativeVisibilityChange?: (visible: boolean) => void;
  tool?: 'pointer' | 'hand';
  textBlocks?: NativeTextBlocks;
  onContextMenu?: (x: number, y: number) => void;
  onDismiss?: () => void;
  onPageWheel?: (input: WheelNavInput) => void;
  zoomAnchor?: { x: number; y: number; clientX?: number; clientY?: number } | null;
}
export function NativeGpuViewportContainer({ enabled = true, selected = true, children, visible = true, className = '', style,
  filePath, page, documentToken, scale, fitMode, smartFitScale, onCameraChange, onError, onNativeVisibilityChange, tool = 'pointer', textBlocks, onContextMenu, onDismiss, onPageWheel, zoomAnchor }: NativeGpuViewportContainerProps) {
  const [occluded, setOccluded] = useState(false);
  const diagnosticId = useId();
  const diagnosticScale = useRef(scale);
  diagnosticScale.current = scale;
  // PERF (audit 2026-09-25 §R25.GPU.29): đổi công cụ chỉ ẩn HWND đã có scene.
  // Khởi tạo theo setting; đổi pointer/hand chỉ gửi trạng thái input.
  // Hook chỉ mở HWND khi visible; lease đã mở được giữ khi tạm chuyển công cụ.
  const nativeEnabled = enabled;
  const loaded = useRef(false);
  const nativeScale = useRef<number | null>(null);
  const lastNativeReportedScale = useRef<number | null>(null);
  const lastNativeInteractionTime = useRef<number>(0);
  const fitSceneKeyRef = useRef<string | null>(null);
  const fallbackRef = useRef<HTMLDivElement | null>(null);
  const sceneKey = `${filePath}\u0000${page}\u0000${documentToken}`;
  const onCamera = useCallback((camera: NativeCameraSnapshot, userInitiatedZoom = false) => {
    // UIUX (audit 2026-09-26 GPU_DIAG): phân biệt camera native báo về với
    // scale React gửi xuống; không ghi đường dẫn hoặc nội dung tài liệu.
    void viewerTraceLog('GPU_DIAG_FE_CAMERA', { instance: diagnosticId, page,
      camera, prop_scale: diagnosticScale.current, loaded: loaded.current,
      selected, visible, occluded, user_initiated_zoom: userInitiatedZoom,
      forwarded: loaded.current && selected && visible && !occluded });
    nativeScale.current = camera.zoom;
    lastNativeReportedScale.current = camera.zoom;
    if (userInitiatedZoom) lastNativeInteractionTime.current = performance.now();
    if (loaded.current && selected && visible && !occluded) onCameraChange?.(camera, userInitiatedZoom);
  }, [onCameraChange, selected, visible, occluded, diagnosticId, page]);
  const [interactionEvent, setInteractionEvent] = useState<NativeInteractionEvent | null>(null);
  // UIUX (audit 2026-09-25 §R25.GPU.32): chuyển từng delta trực tiếp;
  // setState cho wheel sẽ làm mất sự kiện khi React gộp nhiều cập nhật.
  const onInteraction = useCallback((event: NativeInteractionEvent) => {
    // UIUX (audit 2026-09-27 §V27.CAMERA): phím giữ/lặp cũng phải đi từng
    // lệnh qua đường menu hiện hành, không chờ React commit interactionEvent.
    if (event.kind === 'viewer_command') {
      if (selected && visible && !occluded && isNativeViewerCommand(event.command)) {
        window.dispatchEvent(new CustomEvent('prynx-menu-command', { detail: { cmd: event.command } }));
      }
      return;
    }
    if (event.kind === 'wheel') {
      if (selected && visible && !occluded && Number.isFinite(event.delta_y) && Number.isFinite(event.viewport_height)) {
        onPageWheel?.({ deltaY: event.delta_y, atTop: event.at_top, atBottom: event.at_bottom,
          viewportHeight: event.viewport_height, timestamp: performance.now() });
      }
    } else setInteractionEvent(event);
  }, [selected, visible, occluded, onPageWheel]);
  const api = useNativeGpuViewport({ enabled: nativeEnabled, interactive: true, onInteraction,
    visible: selected && visible && !occluded, document: { filePath, page, token: documentToken },
    onCameraChange: onCamera, onError });
  const { containerRef, isReady, isSceneReady, isPresented, isVisible, setZoom, fitPage, camera } = api;
  // UIUX (audit 2026-09-27 §V27.CAMERA): Smart Fit không phóng quá 100%
  // đã hiệu chuẩn. Không dùng scale hiện hành vì nó chính là kết quả Fit.
  const fitMaxZoom = fitMode === 'smart' ? smartFitScale : undefined;
  const fitTargetKey = camera
    ? `${sceneKey}\u0000${camera.viewport_width}:${camera.viewport_height}:${camera.dpr}:${fitMaxZoom ?? 'unlimited'}` : null;
  useEffect(() => {
    const scan = () => setOccluded(Boolean(document.querySelector('dialog[open], [role="dialog"][aria-modal="true"], [role="alertdialog"], [data-native-viewport-occluder]')));
    const observer = new MutationObserver(scan);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open', 'aria-modal'] });
    scan(); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    loaded.current = false;
    nativeScale.current = null;
    fitSceneKeyRef.current = null;
  }, [filePath, page, documentToken]);
  // UIUX (Khắc phục camera ping-pong): Khi camera cập nhật từ native Rust (do wheel/pan),
  // ghi nhận ngay nativeScale.current để phản ánh mức zoom thực tế của viewport, tránh echo ngược lại Rust.
  useEffect(() => {
    if (camera && Number.isFinite(camera.zoom)) {
      nativeScale.current = camera.zoom;
    }
  }, [camera]);

  useEffect(() => {
    if (!isSceneReady) { loaded.current = false; return; }
    loaded.current = true;
    const isFitPageMode = fitMode === 'page' || fitMode === 'smart';
    if (isFitPageMode) {
      // UIUX (PPE-VIEW-03): Khi fitMode là page hoặc smart, camera ban đầu do Rust fit_page tự tính;
      // không được gọi setZoom(scale) ở tâm view làm đè hỏng camera fit.
      if (nativeScale.current === null && camera) {
        nativeScale.current = camera.zoom;
      }
      return;
    }
    // Ngưỡng 0.005 để tránh sai số làm tròn float giữa scale (React) và camera.zoom (Rust).
    // Chỉ đồng bộ khi có thay đổi zoom thực sự từ bên ngoài (toolbar dropdown, nút phóng to/thu nhỏ...).
    // Không echo ngược lại Rust khi scale chỉ là phản hồi của chính camera native hoặc đang trong cử chỉ lăn chuột native.
    const isEchoOfNative = lastNativeReportedScale.current !== null && Math.abs(lastNativeReportedScale.current - scale) <= 0.05;
    const isRecentNativeInteraction = performance.now() - lastNativeInteractionTime.current < 400;
    const shouldSync = selected && visible && !occluded && !isEchoOfNative && !isRecentNativeInteraction && (nativeScale.current === null || Math.abs(nativeScale.current - scale) > 0.005);
    void viewerTraceLog('GPU_DIAG_FE_SCALE_SYNC', { instance: diagnosticId, page,
      target_scale: scale, native_scale: nativeScale.current, selected, visible, occluded,
      action: shouldSync ? 'set-zoom' : 'skip', anchor_source: zoomAnchor ? 'cursor' : 'viewport-center' });
    if (shouldSync) {
      nativeScale.current = scale;
      let anchorX: number | undefined = zoomAnchor?.x;
      let anchorY: number | undefined = zoomAnchor?.y;
      if (zoomAnchor && typeof zoomAnchor.clientX === 'number' && typeof zoomAnchor.clientY === 'number' && containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          const cx = zoomAnchor.clientX - rect.left;
          const cy = zoomAnchor.clientY - rect.top;
          if (cx >= 0 && cx <= rect.width && cy >= 0 && cy <= rect.height) {
            anchorX = cx;
            anchorY = cy;
          }
        }
      }
      void setZoom(scale, anchorX, anchorY);
    }
  }, [isSceneReady, scale, setZoom, selected, visible, occluded, diagnosticId, page, fitMode, zoomAnchor]);
  useEffect(() => {
    const isFitPageMode = fitMode === 'page' || fitMode === 'smart';
    if (!isFitPageMode) {
      // Cho phép người dùng chọn lại Fit Page/Smart Fit sau khi đã chuyển sang custom/width.
      fitSceneKeyRef.current = null;
      return;
    }
    if (isSceneReady && selected && visible && !occluded && fitTargetKey !== null && fitSceneKeyRef.current !== fitTargetKey) {
      // Không fit lại khi tab chỉ chuyển ẩn → hiện; camera native lúc đó vẫn là
      // camera người dùng đang xem. UIUX (audit 2026-09-27 §V27.CAMERA): scene
      // hoặc extent/DPR mới cần fit lại; pan/zoom không đổi khung thì không.
      fitSceneKeyRef.current = fitTargetKey;
      void viewerTraceLog('GPU_DIAG_FE_FIT', { instance: diagnosticId, page, fit_mode: fitMode, max_zoom: fitMaxZoom });
      void fitPage(fitMaxZoom);
    }
  }, [isSceneReady, fitMode, fitPage, fitMaxZoom, selected, visible, occluded, fitTargetKey, diagnosticId, page]);
  const showingNative = nativeEnabled && selected && visible && !occluded && isVisible;
  useEffect(() => {
    void viewerTraceLog('GPU_DIAG_FE_STATE', { schema_version: 1, instance: diagnosticId, page,
      enabled: nativeEnabled, selected, visible, occluded, tool, fit_mode: fitMode,
      is_ready: isReady, scene_ready: isSceneReady, presented: isPresented,
      native_visible: showingNative, fallback_hidden: showingNative });
  }, [diagnosticId, page, nativeEnabled, selected, visible, occluded, tool, fitMode,
    isReady, isSceneReady, isPresented, showingNative]);
  useEffect(() => {
    const root = fallbackRef.current;
    const first = root?.querySelector<HTMLElement>('*');
    void viewerTraceLog('GPU_DIAG_FE_FALLBACK_LAYER', {
      instance: diagnosticId, page, native_visible: showingNative,
      fallback_attr: root?.getAttribute('data-native-fallback-hidden') ?? null,
      fallback_class: root?.className ?? null,
      fallback_style: root?.getAttribute('style') ?? null,
      root_opacity: root ? getComputedStyle(root).opacity : null,
      root_visibility: root ? getComputedStyle(root).visibility : null,
      root_pointer_events: root ? getComputedStyle(root).pointerEvents : null,
      child_visibility: first ? getComputedStyle(first).visibility : null,
      child_pointer_events: first ? getComputedStyle(first).pointerEvents : null,
    });
  }, [diagnosticId, page, showingNative]);
  // PERF (audit 2026-09-27 §V27.02/C2): visible không đủ nếu HWND còn giữ
  // frame của scene trước. Chỉ pause producer sau proof scene hiện hành.
  const nativeContentReady = showingNative && isSceneReady && isPresented;
  useEffect(() => { onNativeVisibilityChange?.(nativeContentReady); }, [onNativeVisibilityChange, nativeContentReady]);
  const fallbackStyle: CSSProperties = showingNative
    // UIUX (Khắc phục màn hình xám): Không bao giờ ép opacity 0 hay visibility hidden lên fallback PDFium.
    ? { pointerEvents: 'none' }
    : {};
  return <div data-testid="native-gpu-viewport-container"
    data-native-diagnostic-id={diagnosticId} data-native-tool={tool} data-native-page={page}
    data-native-ready={isReady} data-scene-ready={isSceneReady} data-presented={isPresented} data-native-visible={showingNative}
    className={`relative flex flex-1 min-w-0 min-h-0 w-full h-full overflow-hidden ${className}`} style={{ background: '#525659', ...style }}>
    {/* Khắc phục màn hình xám: Giữ nguyên cây trang PDFium bên dưới làm đệm an toàn, không bao giờ ép opacity 0 */}
    <div ref={fallbackRef} className="absolute inset-0 flex" data-native-fallback-hidden={showingNative ? 'true' : 'false'} style={fallbackStyle} aria-hidden={false}>{children}</div>
    <div ref={containerRef} className="absolute inset-0 pointer-events-none" />
    {nativeEnabled && <NativeViewportInteractions key={`${documentToken}:${page}`} api={api} tool={tool} textBlocks={textBlocks} page={page} active={showingNative}
      event={interactionEvent} onContextMenu={onContextMenu} onDismiss={onDismiss} />}
    {!children && nativeEnabled && selected && !showingNative && <div role="status" className="absolute inset-0 flex items-center justify-center text-sm text-white/80">Đang chuẩn bị trang…</div>}
  </div>;
}
export default NativeGpuViewportContainer;
