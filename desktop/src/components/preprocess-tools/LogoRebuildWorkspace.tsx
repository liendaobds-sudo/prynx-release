import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { Download, ImagePlus, Loader2, OctagonX, Plus, Redo2, Trash2, Undo2, WandSparkles } from 'lucide-react';

import { tv as translateVi } from '../../i18n';
import {
  cancelLogoRebuildPreview,
  createLogoRebuildPreview,
  getLogoRebuildCapabilities,
  preflightLogoRebuild,
  type LogoCurvePreset,
  type LogoRebuildCapabilities,
  type LogoRebuildEngine,
  type LogoRebuildMode,
  type LogoPaletteSuggestion,
  type LogoRebuildPreflight,
  type LogoRebuildPreview,
  type LogoRebuildSettings,
  type NormalizedPoint,
} from '../../lib/logoRebuildApi';
import { saveBlob } from '../../lib/saveBlob';
import { IMAGE_BATCH_DROP_EVENTS } from '../../lib/tabNavigation';
import LogoCompareViewport from './LogoCompareViewport';

type SelectionMode = 'full' | 'crop' | 'perspective';
const LOGO_REBUILD_I18N_NS = 'preprocess.logoRebuild';
const DEFAULT_LOGO_ENGINE: LogoRebuildEngine = 'prynx_core';

const CURVE_PRESET_OPTIONS: ReadonlyArray<{
  value: LogoCurvePreset;
  label: string;
  description: string;
}> = [
  {
    value: 'automatic',
    label: 'Tự động (Khuyến nghị)',
    description: 'Tự chọn hình học và mức làm mượt theo từng quỹ đạo.',
  },
  {
    value: 'faithful',
    label: 'Bám sát bản gốc',
    description: 'Giữ chi tiết nhỏ, chấp nhận nhiều node hơn.',
  },
  {
    value: 'balanced',
    label: 'Cân bằng',
    description: 'Giảm node thận trọng và bảo toàn góc thật.',
  },
  {
    value: 'trajectory_completion',
    label: 'Hoàn thiện quỹ đạo',
    description: 'Ưu tiên đường hình học sạch trong sai số được kiểm chứng.',
  },
];

function tv(value: string | undefined | null): string {
  return translateVi(value, LOGO_REBUILD_I18N_NS);
}

interface LogoRebuildWorkspaceProps {
  hasOtherDirtyChanges?: boolean;
  isActive?: boolean;
  isLocked?: boolean;
  onDirtyChange?: (isDirty: boolean) => void;
  tabId?: string;
}

interface LogoIncomingFilesDetail {
  tabId?: string;
  files?: File[];
}

interface LogoSaveCommandDetail {
  requestId?: string;
  tabId?: string;
}

type LogoSaveResult = 'saved' | 'cancelled' | 'failed';
type CapabilitiesStatus = 'loading' | 'ready' | 'error';

interface EditorState {
  mode: LogoRebuildMode;
  palette: string[];
  paletteConfirmed: boolean;
  removeBackground: boolean;
  backgroundColor: string;
  selectionMode: SelectionMode;
  crop: { x: number; y: number; width: number; height: number };
  perspective: NormalizedPoint[];
  smoothing: number;
  curvePreset: LogoCurvePreset;
  despeckle: number;
  illumination: boolean;
  physicalWidthMm: number | null;
  physicalHeightMm: number | null;
}

const DEFAULT_PALETTE = ['#000000', '#ffffff'];
// LOGO-REBUILD (audit 2026-08-13 §LR4.01): đồng bộ ngưỡng upscale của backend
// (_upscale_target_dimensions: cạnh ngắn < 600 px sẽ bị nâng NEAREST trước khi
// dựng nét). Khử hạt tính theo px ẢNH NGUỒN — giá trị N nuốt mọi chi tiết nhỏ
// hơn N×N px nguồn (dấu tiếng Việt, chấm, ®), nên ảnh nhỏ phải mặc định 0.
const UPSCALE_SHORTEST_SIDE_PX = 600;
const DEFAULT_DESPECKLE_SIZE_PX = 4;
const MAX_LOGO_UPLOAD_BYTES = 500 * 1024 * 1024;
const ACCEPTED_LOGO_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

function willUpscaleSource(source: { width_px: number; height_px: number } | null): boolean {
  return source !== null && Math.min(source.width_px, source.height_px) < UPSCALE_SHORTEST_SIDE_PX;
}
const DEFAULT_PERSPECTIVE: NormalizedPoint[] = [
  { x: 0.05, y: 0.05 },
  { x: 0.95, y: 0.05 },
  { x: 0.95, y: 0.95 },
  { x: 0.05, y: 0.95 },
];
const MAX_HISTORY_STEPS = 60;
const HISTORY_COALESCE_MS = 500;
const INITIAL_EDITOR_STATE: EditorState = {
  mode: 'fixed_palette',
  palette: DEFAULT_PALETTE,
  paletteConfirmed: false,
  removeBackground: false,
  backgroundColor: '#ffffff',
  selectionMode: 'full',
  crop: { x: 0, y: 0, width: 100, height: 100 },
  perspective: DEFAULT_PERSPECTIVE,
  smoothing: 0,
  curvePreset: 'automatic',
  despeckle: DEFAULT_DESPECKLE_SIZE_PX,
  illumination: false,
  physicalWidthMm: null,
  physicalHeightMm: null,
};

function cloneEditorState(state: EditorState): EditorState {
  return {
    ...state,
    palette: [...state.palette],
    crop: { ...state.crop },
    perspective: state.perspective.map(point => ({ ...point })),
  };
}

function editorStatesEqual(left: EditorState, right: EditorState): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function newJobId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => {
    const random = Math.floor(Math.random() * 16);
    const value = character === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

function clampPercent(value: number, minimum = 0, maximum = 100): number {
  return Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : minimum));
}

function roundMillimeters(value: number): number {
  // LOGO-REBUILD (audit 2026-08-24 §LR5.05): sáu chữ số tránh sai tỷ lệ
  // vượt tolerance khi người dùng xác nhận kích thước rất nhỏ.
  return Math.round(value * 1_000_000) / 1_000_000;
}

function formatCoverage(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio <= 0) return '0%';
  if (ratio < 0.005) return '<0.5%';
  const digits = ratio < 0.1 ? 2 : 1;
  return `${(ratio * 100).toFixed(digits).replace(/\\.?0+$/, '')}%`;
}

function selectionValidationCode(state: EditorState): 'crop' | 'perspective' | null {
  if (state.selectionMode === 'crop') {
    const { x, y, width, height } = state.crop;
    if (width < 1 || height < 1 || x < 0 || y < 0 || x + width > 100 || y + height > 100) {
      return 'crop';
    }
  }
  if (state.selectionMode === 'perspective') {
    const points = state.perspective;
    const crossProducts = points.map((point, index) => {
      const next = points[(index + 1) % points.length];
      const after = points[(index + 2) % points.length];
      return (next.x - point.x) * (after.y - next.y)
        - (next.y - point.y) * (after.x - next.x);
    });
    const area = Math.abs(points.reduce((sum, point, index) => {
      const next = points[(index + 1) % points.length];
      return sum + point.x * next.y - next.x * point.y;
    }, 0) / 2);
    const hasPositive = crossProducts.some(value => value > 0.0001);
    const hasNegative = crossProducts.some(value => value < -0.0001);
    if (area < 0.0001 || hasPositive === hasNegative) return 'perspective';
  }
  return null;
}

export default function LogoRebuildWorkspace({
  hasOtherDirtyChanges = false,
  isActive = true,
  isLocked = false,
  onDirtyChange,
  tabId = '',
}: LogoRebuildWorkspaceProps) {
  const [capabilities, setCapabilities] = useState<LogoRebuildCapabilities | null>(null);
  const [capabilitiesStatus, setCapabilitiesStatus] = useState<CapabilitiesStatus>('loading');
  const [capabilitiesError, setCapabilitiesError] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [sourceUrl, setSourceUrl] = useState('');
  const [editor, setEditor] = useState<EditorState>(() => cloneEditorState(INITIAL_EDITOR_STATE));
  const [preview, setPreview] = useState<LogoRebuildPreview | null>(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [paletteSuggestions, setPaletteSuggestions] = useState<LogoPaletteSuggestion[]>([]);
  const [preflightWarnings, setPreflightWarnings] = useState<string[]>([]);
  const [sourceInfo, setSourceInfo] = useState<LogoRebuildPreflight['source'] | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [isPreflighting, setIsPreflighting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [reviewAccepted, setReviewAccepted] = useState(false);
  const [sessionDirty, setSessionDirty] = useState(false);
  const [, setHistoryVersion] = useState(0);
  const activeJobRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const preflightAbortRef = useRef<AbortController | null>(null);
  const cancelledJobRef = useRef<string | null>(null);
  const previewUrlRef = useRef('');
  const revisionRef = useRef(0);
  const editorRef = useRef(editor);
  const pastRef = useRef<EditorState[]>([]);
  const futureRef = useRef<EditorState[]>([]);
  const lastCommitRef = useRef<{ key: string; at: number } | null>(null);
  const selectIncomingFileRef = useRef<(selected?: File | null) => void>(() => undefined);
  const exportSvgRef = useRef<() => Promise<LogoSaveResult>>(async () => 'failed');
  const capabilitiesRequestRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const errorRef = useRef<HTMLParagraphElement | null>(null);
  const markDirty = useCallback(() => setSessionDirty(true), []);

  const {
    mode,
    palette,
    paletteConfirmed,
    removeBackground,
    backgroundColor,
    selectionMode,
    crop,
    perspective,
    smoothing,
    curvePreset,
    despeckle,
    illumination,
    physicalWidthMm,
    physicalHeightMm,
  } = editor;

  const clearPreview = useCallback(() => {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = '';
    }
    setPreviewUrl('');
    setPreview(null);
    setReviewAccepted(false);
  }, []);

  const invalidatePreview = useCallback(() => {
    // UIUX (audit 2026-07-29 §LR.05): mọi thay đổi đầu vào làm preview cũ mất hiệu lực.
    revisionRef.current += 1;
    const jobId = activeJobRef.current;
    if (jobId) {
      cancelledJobRef.current = jobId;
      void cancelLogoRebuildPreview(jobId).catch(() => undefined);
      abortRef.current?.abort();
      activeJobRef.current = null;
      abortRef.current = null;
      setIsRunning(false);
    }
    preflightAbortRef.current?.abort();
    preflightAbortRef.current = null;
    setIsPreflighting(false);
    setStatus('');
    clearPreview();
  }, [clearPreview]);

  const refreshHistoryButtons = useCallback(() => setHistoryVersion(version => version + 1), []);

  const resetHistory = useCallback(() => {
    pastRef.current = [];
    futureRef.current = [];
    lastCommitRef.current = null;
    refreshHistoryButtons();
  }, [refreshHistoryButtons]);

  const commitEditor = useCallback((
    historyKey: string,
    update: EditorState | ((current: EditorState) => EditorState),
  ) => {
    const current = editorRef.current;
    let next = typeof update === 'function' ? update(current) : update;
    const changesSelection = historyKey === 'selection-mode'
      || historyKey.startsWith('crop-')
      || historyKey.startsWith('perspective-');
    if (changesSelection && (next.physicalWidthMm !== null || next.physicalHeightMm !== null)) {
      // LOGO-REBUILD (audit 2026-08-09 §LR3.03/§LR3.07): kích thước mm xác
      // nhận thuộc đúng vùng output; đổi crop/quad phải yêu cầu xác nhận lại.
      next = { ...next, physicalWidthMm: null, physicalHeightMm: null };
    }
    if (editorStatesEqual(current, next)) return;

    const now = Date.now();
    const last = lastCommitRef.current;
    if (!last || last.key !== historyKey || now - last.at > HISTORY_COALESCE_MS) {
      pastRef.current.push(cloneEditorState(current));
      if (pastRef.current.length > MAX_HISTORY_STEPS) pastRef.current.shift();
    }
    futureRef.current = [];
    lastCommitRef.current = { key: historyKey, at: now };
    editorRef.current = next;
    setEditor(next);
    markDirty();
    refreshHistoryButtons();
    invalidatePreview();
    if (
      changesSelection
    ) {
      setPaletteSuggestions([]);
      setPreflightWarnings([]);
    }
  }, [invalidatePreview, markDirty, refreshHistoryButtons]);

  const undo = useCallback(() => {
    const previous = pastRef.current.pop();
    if (!previous) return;
    futureRef.current.unshift(cloneEditorState(editorRef.current));
    editorRef.current = previous;
    setEditor(previous);
    markDirty();
    lastCommitRef.current = null;
    refreshHistoryButtons();
    invalidatePreview();
    setPaletteSuggestions([]);
    setPreflightWarnings([]);
  }, [invalidatePreview, markDirty, refreshHistoryButtons]);

  const redo = useCallback(() => {
    const next = futureRef.current.shift();
    if (!next) return;
    pastRef.current.push(cloneEditorState(editorRef.current));
    editorRef.current = next;
    setEditor(next);
    markDirty();
    lastCommitRef.current = null;
    refreshHistoryButtons();
    invalidatePreview();
    setPaletteSuggestions([]);
    setPreflightWarnings([]);
  }, [invalidatePreview, markDirty, refreshHistoryButtons]);

  useEffect(() => {
    // UIUX (audit 2026-08-09 §LR3.04): không reset false trong cleanup;
    // parent chỉ gỡ workspace sau khi tab đã qua cổng xác nhận đóng.
    onDirtyChange?.(sessionDirty);
  }, [onDirtyChange, sessionDirty]);

  const refreshCapabilities = useCallback(async () => {
    const requestId = capabilitiesRequestRef.current + 1;
    capabilitiesRequestRef.current = requestId;
    setCapabilitiesStatus('loading');
    setCapabilitiesError('');
    try {
      const result = await getLogoRebuildCapabilities();
      if (capabilitiesRequestRef.current !== requestId) return;
      setCapabilities(result);
      setCapabilitiesStatus('ready');
    } catch (reason) {
      if (capabilitiesRequestRef.current !== requestId) return;
      setCapabilities(null);
      setCapabilitiesError(reason instanceof Error ? reason.message : String(reason));
      setCapabilitiesStatus('error');
    }
  }, []);

  useEffect(() => {
    void refreshCapabilities();
    return () => { capabilitiesRequestRef.current += 1; };
  }, [refreshCapabilities]);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  useEffect(() => {
    if (!file) {
      setSourceUrl('');
      return;
    }
    const url = URL.createObjectURL(file);
    setSourceUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => () => {
    // UIUX (audit 2026-07-29 §LR.05): đóng tab là trạng thái terminal của request đang chạy.
    revisionRef.current += 1;
    const jobId = activeJobRef.current;
    const controller = abortRef.current;
    activeJobRef.current = null;
    abortRef.current = null;
    if (jobId) void cancelLogoRebuildPreview(jobId).catch(() => undefined);
    controller?.abort();
    preflightAbortRef.current?.abort();
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
  }, []);

  useEffect(() => {
    if (!isActive) return;
    const handleHistoryShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      const target = event.target;
      const nativeInputHistory = target instanceof HTMLInputElement
        && !['range', 'checkbox', 'color', 'file', 'button', 'submit', 'reset'].includes(target.type);
      if (
        target instanceof HTMLTextAreaElement
        || target instanceof HTMLSelectElement
        || nativeInputHistory
        || (target instanceof HTMLElement && target.isContentEditable)
      ) return;

      const key = event.key.toLowerCase();
      if (key === 'z') {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.shiftKey) redo(); else undo();
      } else if (key === 'y') {
        event.preventDefault();
        event.stopImmediatePropagation();
        redo();
      }
    };
    window.addEventListener('keydown', handleHistoryShortcut, true);
    return () => window.removeEventListener('keydown', handleHistoryShortcut, true);
  }, [isActive, redo, undo]);

  const engineReady = capabilities?.preview_engine_enabled === true;
  const supportedCurvePresets = capabilities?.engine?.curve_presets ?? [];
  const supportsCurvePresets = supportedCurvePresets.length > 0;
  const selectionError = selectionValidationCode(editor);
  const uniquePalette = useMemo(
    () => [...new Set(palette.map(color => color.toLowerCase()))],
    [palette],
  );

  const replacePreview = (result: LogoRebuildPreview) => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    if (result.status !== 'rejected' && result.svg) {
      const url = URL.createObjectURL(new Blob([result.svg], { type: 'image/svg+xml' }));
      previewUrlRef.current = url;
      setPreviewUrl(url);
    } else {
      previewUrlRef.current = '';
      setPreviewUrl('');
    }
    setPreview(result);
    // UIUX (audit 2026-08-24 §LR5.11): trạng thái ready là kết quả QC,
    // không phải bằng chứng người dùng đã xem artifact. State này chỉ dùng cho
    // override review; không tự ghi nhận một hành động người dùng chưa làm.
    setReviewAccepted(false);
    markDirty();
  };

  const buildSettings = (source: EditorState = editorRef.current): LogoRebuildSettings => {
    const normalizedPalette = [...new Set(source.palette.map(color => color.toLowerCase()))];
    const settings: LogoRebuildSettings = {
      mode: source.mode,
      engine: DEFAULT_LOGO_ENGINE,
      palette: source.mode === 'fixed_palette' ? normalizedPalette : [],
      ...(source.mode === 'fixed_palette' && source.removeBackground
        ? { background_color: source.backgroundColor.toLowerCase() }
        : {}),
      smoothing: source.smoothing,
      ...(supportsCurvePresets ? { curve_preset: source.curvePreset } : {}),
      despeckle_size_px: source.despeckle,
      illumination_correction: source.illumination,
      ...(source.physicalWidthMm !== null && source.physicalHeightMm !== null
        ? {
          physical_width_mm: source.physicalWidthMm,
          physical_height_mm: source.physicalHeightMm,
        }
        : {}),
    };
    if (source.selectionMode === 'crop') {
      settings.crop = {
        x: source.crop.x / 100,
        y: source.crop.y / 100,
        width: source.crop.width / 100,
        height: source.crop.height / 100,
      };
    } else if (source.selectionMode === 'perspective') {
      settings.perspective_points = source.perspective;
    }
    return settings;
  };

  const analyzePalette = async (
    targetFile: File,
    source: EditorState = editorRef.current,
    requestRevision: number = revisionRef.current,
  ) => {
    const selectionError = selectionValidationCode(source);
    if (selectionError) {
      setError(selectionError === 'crop'
        ? tv('Vùng crop phải nằm trọn trong ảnh và có kích thước lớn hơn 0.')
        : tv('Bốn điểm phối cảnh phải tạo thành một tứ giác lồi, không suy biến.'));
      return;
    }
    preflightAbortRef.current?.abort();
    const controller = new AbortController();
    preflightAbortRef.current = controller;
    setIsPreflighting(true);
    setError('');
    try {
      const result = await preflightLogoRebuild(
        targetFile,
        buildSettings(source),
        controller.signal,
      );
      if (
        preflightAbortRef.current === controller
        && revisionRef.current === requestRevision
        && !controller.signal.aborted
      ) {
        setSourceInfo(result.source);
        // LOGO-REBUILD (audit 2026-08-13 §LR4.01): chỉ khi biết kích thước nguồn
        // mới hạ mặc định khử hạt; không đụng giá trị user đã tự đổi (mọi thay
        // đổi editor đều tăng revision nên response cũ không ghi đè được).
        if (
          willUpscaleSource(result.source)
          && editorRef.current.despeckle === DEFAULT_DESPECKLE_SIZE_PX
        ) {
          const adjustedEditor = { ...editorRef.current, despeckle: 0 };
          editorRef.current = adjustedEditor;
          setEditor(adjustedEditor);
          setStatus(tv('Ảnh nhỏ sẽ được phóng to khi dựng nét: khử hạt đã đặt về 0 để giữ dấu và chi tiết nhỏ.'));
        }
        setPaletteSuggestions(result.palette_suggestions);
        setPreflightWarnings(result.warnings);
      }
    } catch (reason) {
      if (!controller.signal.aborted && revisionRef.current === requestRevision) {
        setError(reason instanceof Error ? reason.message : tv('Không thể phân tích màu từ ảnh.'));
      }
    } finally {
      if (preflightAbortRef.current === controller) {
        preflightAbortRef.current = null;
        setIsPreflighting(false);
      }
    }
  };

  const selectFile = (selected?: File | null) => {
    if (isLocked || !selected) return;
    if (!/\.(png|jpe?g|webp)$/i.test(selected.name)) {
      setError(tv('Chỉ hỗ trợ ảnh PNG, JPEG hoặc WebP.'));
      return;
    }
    // UIUX (audit 2026-08-24 §LR5.10): chặn sớm file đổi đuôi hoặc vượt
    // giới hạn backend; MIME rỗng vẫn cho phép vì File path-backed trên Tauri
    // có thể không được WebView gắn type.
    if (selected.type && !ACCEPTED_LOGO_MIME_TYPES.has(selected.type.toLowerCase())) {
      setError(tv('File không khớp định dạng ảnh; hãy chọn lại PNG, JPEG hoặc WebP.'));
      return;
    }
    if (selected.size > MAX_LOGO_UPLOAD_BYTES) {
      setError(tv('File logo quá lớn. Tối đa 500MB.'));
      return;
    }
    invalidatePreview();
    // LOGO-REBUILD (audit 2026-08-03 §LR2.03 + 2026-08-13 §LR4.01): JPEG dùng
    // simplify để gọn lớp và mượt biên. Despeckle 4 px nguồn KHÔNG an toàn tuyệt
    // đối với dấu tiếng Việt (vẫn nuốt chi tiết < 4×4 px nguồn); preflight sẽ hạ
    // về 0 khi phát hiện ảnh nhỏ sắp bị upscale — xem analyzePalette.
    const jpegSource = selected.type === 'image/jpeg' || /\.jpe?g$/i.test(selected.name);
    const nextEditor = {
      ...editorRef.current,
      paletteConfirmed: false,
      smoothing: jpegSource ? 1 : 0,
      despeckle: DEFAULT_DESPECKLE_SIZE_PX,
      physicalWidthMm: null,
      physicalHeightMm: null,
    };
    editorRef.current = nextEditor;
    setEditor(nextEditor);
    resetHistory();
    setPaletteSuggestions([]);
    setPreflightWarnings([]);
    setSourceInfo(null);
    setFile(selected);
    markDirty();
    setError('');
    setStatus('');
    void analyzePalette(selected, nextEditor, revisionRef.current);
  };

  const applyPaletteSuggestions = () => {
    const suggestedColors = paletteSuggestions.map(item => item.color.toLowerCase());
    const nextPalette = removeBackground
      ? suggestedColors.filter(color => color !== backgroundColor.toLowerCase())
      : suggestedColors;
    if (nextPalette.length === 0) {
      setError(tv('Cần giữ ít nhất một màu logo khác màu nền.'));
      return;
    }
    commitEditor('palette-suggestion', current => ({
      ...current,
      palette: nextPalette,
      paletteConfirmed: true,
    }));
    setError('');
    setStatus(tv('Đã áp dụng bảng màu gợi ý.'));
  };

  const applySuggestedBackground = (color: string) => {
    const normalizedBackground = color.toLowerCase();
    const nextPalette = paletteSuggestions
      .map(item => item.color.toLowerCase())
      .filter(item => item !== normalizedBackground);
    if (nextPalette.length === 0) {
      setError(tv('Cần giữ ít nhất một màu logo khác màu nền.'));
      return;
    }
    // LOGO-REBUILD (audit 2026-08-09 §LR3.11): một history step đồng thời
    // đặt nền và loại chính màu đó khỏi palette, không tạo cấu hình tự xung đột.
    commitEditor('background-suggestion', current => ({
      ...current,
      palette: nextPalette,
      paletteConfirmed: true,
      removeBackground: true,
      backgroundColor: normalizedBackground,
    }));
    setError('');
    setStatus(tv('Đã đặt màu gợi ý làm nền và loại khỏi bảng màu logo.'));
  };

  const toggleBackgroundRemoval = (enabled: boolean) => {
    if (!enabled) {
      commitEditor('remove-background', current => ({ ...current, removeBackground: false }));
      return;
    }
    const nextPalette = palette.filter(color => color.toLowerCase() !== backgroundColor.toLowerCase());
    if (nextPalette.length === 0) {
      setError(tv('Cần giữ ít nhất một màu logo khác màu nền.'));
      return;
    }
    commitEditor('remove-background', current => ({
      ...current,
      removeBackground: true,
      palette: nextPalette,
      paletteConfirmed: true,
    }));
    setError('');
  };

  useEffect(() => {
    selectIncomingFileRef.current = selectFile;
  });

  useEffect(() => {
    if (!isActive || isLocked || !tabId) return;
    const handleIncomingFiles = (event: Event) => {
      const detail = (event as CustomEvent<LogoIncomingFilesDetail>).detail;
      if (detail?.tabId !== tabId || !detail.files?.length) return;
      const selected = detail.files.find(candidate => /\.(png|jpe?g|webp)$/i.test(candidate.name))
        ?? detail.files[0];
      selectIncomingFileRef.current(selected);
    };

    // UIUX (audit 2026-08-09 §LR3.05): file native mang tabId đích;
    // workspace nền/đã đóng không được nhận intent của tab đang hoạt động.
    window.addEventListener(IMAGE_BATCH_DROP_EVENTS.logo_rebuild, handleIncomingFiles);
    return () => {
      window.removeEventListener(IMAGE_BATCH_DROP_EVENTS.logo_rebuild, handleIncomingFiles);
    };
  }, [isActive, isLocked, tabId]);

  const handleWorkspaceDragOver = (event: DragEvent<HTMLDivElement>) => {
    const hasFiles = event.dataTransfer.files?.length > 0
      || Array.from(event.dataTransfer.types ?? []).includes('Files');
    if (!isActive || !hasFiles) return;
    event.preventDefault();
  };

  const handleWorkspaceDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!isActive) return;
    event.preventDefault();
    event.stopPropagation();
    const files = Array.from(event.dataTransfer.files);
    const selected = files.find(candidate => /\.(png|jpe?g|webp)$/i.test(candidate.name))
      ?? files[0];
    selectFile(selected);
  };

  const runPreview = async () => {
    if (!file) {
      setError(tv('Hãy chọn ảnh có logo trước.'));
      return;
    }
    if (!engineReady) {
      setError(tv('Engine preview chưa sẵn sàng. Hãy build lại lõi native.'));
      return;
    }
    if (mode === 'fixed_palette' && !paletteConfirmed) {
      setError(tv('Hãy áp dụng bảng màu gợi ý hoặc chỉnh màu thủ công trước.'));
      return;
    }
    if (mode === 'fixed_palette' && uniquePalette.some(color => !/^#[0-9a-f]{6}$/i.test(color))) {
      setError(tv('Mỗi màu phải có dạng #RRGGBB.'));
      return;
    }
    if (mode === 'fixed_palette' && uniquePalette.length < 1) {
      setError(tv('Logo màu cần ít nhất một màu đã xác nhận.'));
      return;
    }
    if (mode === 'fixed_palette' && removeBackground) {
      if (!/^#[0-9a-f]{6}$/i.test(backgroundColor)) {
        setError(tv('Màu nền phải có dạng #RRGGBB.'));
        return;
      }
      if (uniquePalette.includes(backgroundColor.toLowerCase())) {
        setError(tv('Màu nền cần bỏ phải khác bảng màu logo.'));
        return;
      }
    }
    const geometryError = selectionValidationCode(editorRef.current);
    if (geometryError) {
      setError(geometryError === 'crop'
        ? tv('Vùng crop phải nằm trọn trong ảnh và có kích thước lớn hơn 0.')
        : tv('Bốn điểm phối cảnh phải tạo thành một tứ giác lồi, không suy biến.'));
      return;
    }
    markDirty();
    lastCommitRef.current = null;
    const requestRevision = revisionRef.current;
    const jobId = newJobId();
    const controller = new AbortController();
    clearPreview();
    activeJobRef.current = jobId;
    abortRef.current = controller;
    cancelledJobRef.current = null;
    setIsRunning(true);
    setError('');
    setStatus(tv('Đang xử lý logo trên thiết bị…'));
    try {
      const result = await createLogoRebuildPreview(file, buildSettings(), jobId, controller.signal);
      if (
        activeJobRef.current === jobId
        && revisionRef.current === requestRevision
        && cancelledJobRef.current !== jobId
        && !controller.signal.aborted
      ) {
        replacePreview(result);
        if (result.status === 'rejected') {
          setStatus(tv('Preview bị từ chối vì không có hình vector dùng được.'));
        } else if (result.status === 'review') {
          setStatus(tv('Preview cần kiểm tra trước khi cho phép xuất SVG.'));
        } else {
          setStatus(tv('Preview đã sẵn sàng. Hãy phóng to và kiểm tra chữ, nét nhỏ trước khi in.'));
        }
      }
    } catch (reason) {
      if (revisionRef.current !== requestRevision) {
        // Response thuộc file/settings cũ; invalidatePreview đã dọn trạng thái hiển thị.
      } else if (cancelledJobRef.current === jobId || controller.signal.aborted) {
        setStatus(tv('Đã hủy preview.'));
      } else {
        setError(reason instanceof Error ? reason.message : String(reason));
        setStatus('');
      }
    } finally {
      if (activeJobRef.current === jobId) {
        activeJobRef.current = null;
        if (abortRef.current === controller) abortRef.current = null;
        setIsRunning(false);
      }
    }
  };

  const cancelPreview = async () => {
    const jobId = activeJobRef.current;
    if (!jobId) return;
    const controller = abortRef.current;
    const cancelRevision = revisionRef.current + 1;
    revisionRef.current = cancelRevision;
    cancelledJobRef.current = jobId;
    controller?.abort();
    if (activeJobRef.current === jobId) activeJobRef.current = null;
    if (abortRef.current === controller) abortRef.current = null;
    setIsRunning(false);
    clearPreview();
    setError('');
    setStatus(tv('Đang hủy preview…'));
    try {
      await cancelLogoRebuildPreview(jobId);
      if (
        revisionRef.current === cancelRevision
        && cancelledJobRef.current === jobId
        && activeJobRef.current === null
      ) {
        setStatus(tv('Đã hủy preview.'));
      }
    } catch (reason) {
      if (
        revisionRef.current === cancelRevision
        && cancelledJobRef.current === jobId
        && activeJobRef.current === null
      ) {
        setError(reason instanceof Error ? reason.message : tv('Không thể gửi yêu cầu hủy preview.'));
        setStatus('');
      }
    }
  };

  const exportSvg = async (): Promise<LogoSaveResult> => {
    if (
      !preview
      || !file
      || preview.status === 'rejected'
      || (preview.status === 'review' && !reviewAccepted)
    ) {
      setError(tv('Hãy tạo và kiểm tra preview SVG trước khi lưu.'));
      return 'failed';
    }
    setIsSaving(true);
    setError('');
    try {
      const result = await saveBlob(
        new Blob([preview.svg], { type: 'image/svg+xml;charset=utf-8' }),
        `${file.name.replace(/\.[^.]+$/, '')}_vector.svg`,
        { title: tv('Lưu file SVG'), filterName: 'SVG', extensions: ['svg'] },
      );
      if (result.kind === 'saved') {
        setStatus(tv('Đã lưu file SVG.'));
        setSessionDirty(false);
        return 'saved';
      }
      return 'cancelled';
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : tv('Không thể lưu file SVG.'));
      return 'failed';
    } finally {
      setIsSaving(false);
    }
  };

  // UIUX (audit 2026-08-24 §LR5.14): layout effect chạy ngay sau commit DOM;
  // event save từ queue không thể rơi vào khoảng trống trước passive effect.
  useLayoutEffect(() => {
    exportSvgRef.current = exportSvg;
  });

  useEffect(() => {
    if (!isActive || !tabId) return;
    const handleSaveCommand = async (event: Event) => {
      const detail = (event as CustomEvent<LogoSaveCommandDetail>).detail;
      if (detail?.tabId !== tabId) return;
      // Khi Logo đã sạch nhưng PDF cùng tab còn dirty, nhường event cho parent.
      if (!sessionDirty && hasOtherDirtyChanges) return;
      const result = await exportSvgRef.current();
      if (!detail.requestId) return;
      const queueResult = result === 'saved' && hasOtherDirtyChanges
        ? 'cancelled'
        : result;
      if (result === 'saved' && hasOtherDirtyChanges) {
        setStatus(tv('Đã lưu SVG; tab vẫn còn thay đổi tài liệu cần lưu.'));
      }
      window.dispatchEvent(new CustomEvent('app-save-result', {
        detail: { requestId: detail.requestId, result: queueResult, tabId },
      }));
    };
    window.addEventListener('app-trigger-save', handleSaveCommand);
    return () => window.removeEventListener('app-trigger-save', handleSaveCommand);
  }, [hasOtherDirtyChanges, isActive, sessionDirty, tabId]);

  const updatePerspective = (index: number, axis: 'x' | 'y', percent: number) => {
    commitEditor(`perspective-${index}-${axis}`, current => ({
      ...current,
      perspective: current.perspective.map((point, pointIndex) => (
        pointIndex === index ? { ...point, [axis]: clampPercent(percent) / 100 } : point
      )),
    }));
  };

  const sourceAspectRatio = (() => {
    if (!sourceInfo || sourceInfo.width_px <= 0 || sourceInfo.height_px <= 0) return null;
    const width = sourceInfo.width_px;
    const height = sourceInfo.height_px;
    let selectedWidth = width;
    let selectedHeight = height;
    if (selectionMode === 'crop') {
      // LOGO-REBUILD (audit 2026-08-24 §LR5.05): dùng đúng floor/ceil của
      // worker, thay vì tỷ lệ crop liên tục rồi để backend từ chối sau lượng tử hóa.
      const left = Math.max(0, Math.min(width - 1, Math.floor((crop.x / 100) * width)));
      const top = Math.max(0, Math.min(height - 1, Math.floor((crop.y / 100) * height)));
      const right = Math.max(left + 1, Math.min(width, Math.ceil(((crop.x + crop.width) / 100) * width)));
      const bottom = Math.max(top + 1, Math.min(height, Math.ceil(((crop.y + crop.height) / 100) * height)));
      selectedWidth = right - left;
      selectedHeight = bottom - top;
    } else if (selectionMode === 'perspective') {
      const points = perspective.map(point => ({
        x: point.x * (width - 1),
        y: point.y * (height - 1),
      }));
      const distance = (left: NormalizedPoint, right: NormalizedPoint) => Math.hypot(
        right.x - left.x,
        right.y - left.y,
      );
      selectedWidth = Math.max(1, Math.round(Math.max(distance(points[0], points[1]), distance(points[2], points[3]))));
      selectedHeight = Math.max(1, Math.round(Math.max(distance(points[1], points[2]), distance(points[3], points[0]))));
    }
    return selectedWidth > 0 && selectedHeight > 0 ? selectedWidth / selectedHeight : null;
  })();
  const dpiSuggestedSize = selectionMode === 'full' && sourceInfo?.dpi
    ? {
      width: roundMillimeters((sourceInfo.width_px / sourceInfo.dpi[0]) * 25.4),
      height: roundMillimeters((sourceInfo.height_px / sourceInfo.dpi[1]) * 25.4),
    }
    : null;

  const updatePhysicalWidth = (rawValue: string) => {
    const width = Number(rawValue);
    if (!rawValue || !sourceAspectRatio || !Number.isFinite(width) || width <= 0) {
      commitEditor('physical-size', current => ({
        ...current,
        physicalWidthMm: null,
        physicalHeightMm: null,
      }));
      return;
    }
    commitEditor('physical-size', current => ({
      ...current,
      physicalWidthMm: width,
      physicalHeightMm: roundMillimeters(width / sourceAspectRatio),
    }));
  };

  const updatePhysicalHeight = (rawValue: string) => {
    const height = Number(rawValue);
    if (!rawValue || !sourceAspectRatio || !Number.isFinite(height) || height <= 0) {
      commitEditor('physical-size', current => ({
        ...current,
        physicalWidthMm: null,
        physicalHeightMm: null,
      }));
      return;
    }
    commitEditor('physical-size', current => ({
      ...current,
      physicalWidthMm: roundMillimeters(height * sourceAspectRatio),
      physicalHeightMm: height,
    }));
  };

  const canUndo = pastRef.current.length > 0;
  const canRedo = futureRef.current.length > 0;
  const canExport = Boolean(
    preview
    && preview.status !== 'rejected'
    && (preview.status === 'ready' || reviewAccepted),
  );

  return (
    <div
      data-testid="logo-rebuild-workspace"
      tabIndex={-1}
      onDragOver={handleWorkspaceDragOver}
      onDrop={handleWorkspaceDrop}
      className="h-full min-h-0 w-full min-w-0 overflow-auto bg-slate-100 text-slate-800 outline-none dark:bg-zinc-950 dark:text-zinc-100 xl:overflow-hidden"
    >
      <div className="mx-auto grid h-full min-h-0 max-w-[1500px] grid-rows-[auto_minmax(0,1fr)] gap-4 p-4">
        <header className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <div>
            <h1 className="flex items-center gap-2 text-lg font-bold">
              <WandSparkles className="h-5 w-5 text-violet-600" />
              {/* UIUX (audit 2026-08-13 §LR4.07): engine chỉ nội suy NEAREST, không
                  phục hồi nét — tên tính năng không được hứa "phục hồi". */}
              {tv('Vector hóa Logo')}
            </h1>
            <p className="mt-1 text-xs text-slate-500 dark:text-zinc-400">
              {tv('Logo màu dùng gợi ý từ pixel nhìn thấy và chỉ áp dụng sau khi bạn xác nhận.')}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex gap-1">
              <button type="button" aria-label={tv('Hoàn tác')} title={tv('Hoàn tác (Ctrl+Z)')} disabled={!canUndo} onClick={undo} className="rounded-md border border-slate-200 p-2 text-slate-600 disabled:opacity-30 dark:border-zinc-700 dark:text-zinc-300">
                <Undo2 className="h-4 w-4" />
              </button>
              <button type="button" aria-label={tv('Làm lại')} title={tv('Làm lại (Ctrl+Y)')} disabled={!canRedo} onClick={redo} className="rounded-md border border-slate-200 p-2 text-slate-600 disabled:opacity-30 dark:border-zinc-700 dark:text-zinc-300">
                <Redo2 className="h-4 w-4" />
              </button>
            </div>
            <div role="status" className="text-right text-xs text-slate-500 dark:text-zinc-400">
              {capabilitiesStatus === 'loading' && tv('Đang kiểm tra engine…')}
              {capabilitiesStatus === 'ready' && (
                engineReady
                  ? `${capabilities?.engine?.engine ?? 'PrynX core'} ${capabilities?.engine?.version ?? ''}${
                    capabilities?.engine?.structured_result && capabilities.engine.result_schema_version !== null
                      ? ` · ${tv('Schema kết quả')} ${capabilities.engine.result_schema_version}`
                      : ''
                  }`
                  : tv('Engine preview chưa sẵn sàng')
              )}
              {capabilitiesStatus === 'error' && (
                <div className="flex items-center gap-2">
                  <span title={capabilitiesError}>{tv('Không kiểm tra được engine')}</span>
                  <button
                    type="button"
                    onClick={() => void refreshCapabilities()}
                    className="rounded border border-red-300 px-2 py-1 font-semibold text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950/30"
                  >
                    {tv('Thử lại')}
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        <div className="grid min-h-0 min-w-0 gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
          <aside className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 xl:min-h-0 xl:overflow-y-auto xl:overscroll-contain">
            {capabilitiesStatus === 'ready' && capabilities && capabilities.limitations.length > 0 && (
              <section aria-label={tv('Giới hạn hiện tại')} className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
                <strong>{tv('Phạm vi hiện tại: artwork/logo phẳng')}</strong>
                <ul className="mt-1 list-disc space-y-1 pl-4">
                  {capabilities.limitations.map(limitation => <li key={limitation}>{limitation}</li>)}
                </ul>
              </section>
            )}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex w-full items-center justify-center gap-2 rounded-lg border-2 border-dashed border-violet-300 px-4 py-3 text-sm font-semibold text-violet-700 hover:bg-violet-50 dark:border-violet-800 dark:text-violet-300 dark:hover:bg-violet-950/30"
            >
              <ImagePlus className="h-4 w-4" />
              {file ? tv('Chọn ảnh khác') : tv('Chọn ảnh có logo')}
            </button>
            <label htmlFor="logo-rebuild-file-input" className="hidden">{tv('Chọn ảnh có logo')}</label>
            {file && <label htmlFor="logo-rebuild-file-input" className="hidden">{tv('Chọn ảnh khác')}</label>}
            <input
              id="logo-rebuild-file-input"
              ref={fileInputRef}
              className="hidden"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={event => {
                selectFile(event.target.files?.[0]);
                event.currentTarget.value = '';
              }}
            />
            {file && <p className="truncate text-xs text-slate-500" title={file.name}>{file.name}</p>}

            <section>
              <h2 className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">{tv('Chế độ')}</h2>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  aria-pressed={mode === 'monochrome'}
                  // LOGO-REBUILD (audit 2026-08-13 §LR4.06): Silhouette chưa thực thi
                  // khử hạt — giữ despeckle > 0 chỉ ép kết quả vào review vô cớ,
                  // nên đen trắng mặc định 0.
                  onClick={() => commitEditor('mode', current => ({ ...current, mode: 'monochrome', smoothing: 0.5, despeckle: 0 }))}
                  className={`rounded-lg border px-3 py-2 text-xs font-semibold ${mode === 'monochrome' ? 'border-violet-500 bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-200' : 'border-slate-200 dark:border-zinc-700'}`}
                >
                  {tv('Đen trắng')}
                </button>
                <button
                  type="button"
                  aria-pressed={mode === 'fixed_palette'}
                  onClick={() => commitEditor('mode', current => ({
                    ...current,
                    mode: 'fixed_palette',
                    smoothing: 0,
                    // Quay lại chế độ màu: khôi phục mặc định theo ảnh (0 nếu ảnh
                    // nhỏ sẽ upscale — §LR4.01) trừ khi user đã tự đặt giá trị khác.
                    despeckle: current.despeckle === 0
                      ? (willUpscaleSource(sourceInfo) ? 0 : DEFAULT_DESPECKLE_SIZE_PX)
                      : current.despeckle,
                  }))}
                  className={`rounded-lg border px-3 py-2 text-xs font-semibold ${mode === 'fixed_palette' ? 'border-violet-500 bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-200' : 'border-slate-200 dark:border-zinc-700'}`}
                >
                  {tv('Logo màu')}
                </button>
              </div>
            </section>

            {mode === 'fixed_palette' && file && (
              <section className="rounded-lg border border-violet-200 bg-violet-50/60 p-3 dark:border-violet-900 dark:bg-violet-950/20">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-xs font-bold uppercase tracking-wide text-violet-700 dark:text-violet-300">
                    {tv('Gợi ý màu từ ảnh')}
                  </h2>
                  <button
                    type="button"
                    disabled={isPreflighting}
                    onClick={() => void analyzePalette(file)}
                    className="text-xs font-semibold text-violet-700 disabled:opacity-40 dark:text-violet-300"
                  >
                    {isPreflighting ? tv('Đang phân tích…') : tv('Gợi ý lại')}
                  </button>
                </div>
                <p className="mt-1 text-[11px] text-slate-500 dark:text-zinc-400">
                  {tv('Gợi ý theo pixel nhìn thấy; cần kiểm tra trước khi dùng.')}
                </p>
                {paletteSuggestions.length > 0 ? (
                  <>
                    <div className="mt-2 space-y-1" role="list">
                      {paletteSuggestions.map((suggestion, index) => (
                        <div
                          key={suggestion.color}
                          role="listitem"
                          aria-label={tv('Màu gợi ý') + ' ' + (index + 1)}
                          className="flex items-center gap-2 rounded bg-white/80 px-2 py-1 text-[11px] dark:bg-zinc-900/70"
                        >
                          <span
                            className="h-5 w-5 rounded border border-black/10"
                            style={{ backgroundColor: suggestion.color }}
                          />
                          <code className="flex-1 uppercase">{suggestion.color}</code>
                          <span className="text-slate-500">
                            {formatCoverage(suggestion.coverage_ratio)}
                          </span>
                          <button
                            type="button"
                            aria-label={`${tv('Đặt làm nền')} ${suggestion.color}`}
                            onClick={() => applySuggestedBackground(suggestion.color)}
                            className="rounded border border-slate-200 px-1.5 py-1 font-semibold text-slate-600 hover:border-violet-300 hover:text-violet-700 dark:border-zinc-700 dark:text-zinc-300"
                          >
                            {tv('Đặt làm nền')}
                          </button>
                        </div>
                      ))}
                    </div>
                    <button
                      type="button"
                      onClick={applyPaletteSuggestions}
                      className="mt-2 w-full rounded-md bg-violet-600 px-3 py-2 text-xs font-bold text-white hover:bg-violet-700"
                    >
                      {tv('Áp dụng gợi ý')}
                    </button>
                  </>
                ) : !isPreflighting ? (
                  <p className="mt-2 text-[11px] text-slate-500">{tv('Chưa có gợi ý màu.')}</p>
                ) : null}
                {preflightWarnings.map((warning, index) => (
                  <p key={index} className="mt-1 text-[11px] text-amber-700 dark:text-amber-300">⚠ {warning}</p>
                ))}
              </section>
            )}

            {mode === 'fixed_palette' && (
              <section>
                <div className="mb-2 flex items-center justify-between">
                  <h2 className="text-xs font-bold uppercase tracking-wide text-slate-500">{tv('Bảng màu logo')}</h2>
                  <button
                    type="button"
                    disabled={palette.length >= 12}
                    onClick={() => commitEditor('palette-add', current => ({ ...current, palette: [...current.palette, '#808080'], paletteConfirmed: true }))}
                    className="flex items-center gap-1 text-xs font-semibold text-violet-600 disabled:opacity-40"
                  >
                    <Plus className="h-3.5 w-3.5" /> {tv('Thêm màu')}
                  </button>
                </div>
                <div className="space-y-2">
                  {palette.map((color, index) => (
                    <div key={index} className="flex items-center gap-2">
                      <input
                        aria-label={`${tv('Màu')} ${index + 1}`}
                        type="color"
                        value={/^#[0-9a-f]{6}$/i.test(color) ? color : '#000000'}
                        onChange={event => commitEditor('palette-' + index, current => ({ ...current, palette: current.palette.map((item, itemIndex) => itemIndex === index ? event.target.value : item), paletteConfirmed: true }))}
                        className="h-8 w-11 cursor-pointer rounded border border-slate-200 bg-transparent"
                      />
                      <input
                        aria-label={`${tv('Mã màu')} ${index + 1}`}
                        value={color}
                        maxLength={7}
                        spellCheck={false}
                        onChange={event => commitEditor('palette-' + index, current => ({ ...current, palette: current.palette.map((item, itemIndex) => itemIndex === index ? event.target.value.toLowerCase() : item), paletteConfirmed: true }))}
                        className="min-w-0 flex-1 rounded border border-slate-200 bg-transparent px-2 py-1.5 font-mono text-xs uppercase dark:border-zinc-700"
                      />
                      <button
                        type="button"
                        aria-label={`${tv('Xóa màu')} ${index + 1}`}
                        disabled={palette.length <= 1}
                        onClick={() => commitEditor('palette-remove', current => ({ ...current, palette: current.palette.filter((_, itemIndex) => itemIndex !== index), paletteConfirmed: true }))}
                        className="rounded p-1 text-slate-400 hover:text-red-600 disabled:opacity-30"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
                </div>
                <div className="mt-3 border-t border-slate-200 pt-3 dark:border-zinc-700">
                  <label className="flex items-center gap-2 text-xs font-semibold">
                    <input type="checkbox" checked={removeBackground} onChange={event => toggleBackgroundRemoval(event.target.checked)} />
                    {tv('Loại màu nền khỏi SVG')}
                  </label>
                  {removeBackground && (
                    <div className="mt-2 flex items-center gap-2">
                      <input
                        aria-label={tv('Màu nền')}
                        type="color"
                        value={/^#[0-9a-f]{6}$/i.test(backgroundColor) ? backgroundColor : '#ffffff'}
                        onChange={event => commitEditor('background-color', current => ({ ...current, backgroundColor: event.target.value }))}
                        className="h-8 w-11 cursor-pointer rounded border border-slate-200 bg-transparent"
                      />
                      <input
                        aria-label={tv('Mã màu nền')}
                        value={backgroundColor}
                        maxLength={7}
                        spellCheck={false}
                        onChange={event => commitEditor('background-color', current => ({ ...current, backgroundColor: event.target.value.toLowerCase() }))}
                        className="min-w-0 flex-1 rounded border border-slate-200 bg-transparent px-2 py-1.5 font-mono text-xs uppercase dark:border-zinc-700"
                      />
                    </div>
                  )}
                </div>
              </section>
            )}

            <section>
              <h2 className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">{tv('Vùng logo')}</h2>
              <select
                aria-label={tv('Cách chọn vùng logo')}
                value={selectionMode}
                onChange={event => commitEditor('selection-mode', current => ({ ...current, selectionMode: event.target.value as SelectionMode }))}
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs dark:border-zinc-700 dark:bg-zinc-900"
              >
                <option value="full">{tv('Toàn bộ ảnh')}</option>
                <option value="crop">{tv('Crop chữ nhật')}</option>
                <option value="perspective">{tv('Nắn phối cảnh 4 điểm')}</option>
              </select>
              {selectionMode === 'crop' && (
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {(['x', 'y', 'width', 'height'] as const).map(key => (
                    <label key={key} className="text-[11px] text-slate-500">
                      {key === 'x' ? 'X %' : key === 'y' ? 'Y %' : key === 'width' ? tv('Rộng %') : tv('Cao %')}
                      <input
                        type="number"
                        min={0}
                        max={100}
                        value={crop[key]}
                        onChange={event => commitEditor(`crop-${key}`, current => ({ ...current, crop: { ...current.crop, [key]: clampPercent(Number(event.target.value), key === 'width' || key === 'height' ? 1 : 0) } }))}
                        className="mt-1 w-full rounded border border-slate-200 bg-transparent px-2 py-1.5 text-xs dark:border-zinc-700"
                      />
                    </label>
                  ))}
                </div>
              )}
              {selectionMode === 'perspective' && (
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {perspective.map((point, index) => (
                    <div key={index} className="rounded border border-slate-200 p-2 text-[11px] dark:border-zinc-700">
                      <strong>{tv('Điểm')} {index + 1}</strong>
                      <div className="mt-1 flex gap-1">
                        <input aria-label={`P${index + 1} X`} type="number" min={0} max={100} value={Math.round(point.x * 100)} onChange={event => updatePerspective(index, 'x', Number(event.target.value))} className="w-1/2 rounded border bg-transparent px-1 py-1 dark:border-zinc-700" />
                        <input aria-label={`P${index + 1} Y`} type="number" min={0} max={100} value={Math.round(point.y * 100)} onChange={event => updatePerspective(index, 'y', Number(event.target.value))} className="w-1/2 rounded border bg-transparent px-1 py-1 dark:border-zinc-700" />
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {selectionError && (
                <p role="alert" className="mt-2 rounded bg-red-50 px-2 py-1.5 text-[11px] text-red-700 dark:bg-red-950/30 dark:text-red-300">
                  {selectionError === 'crop'
                    ? tv('Vùng crop phải nằm trọn trong ảnh và có kích thước lớn hơn 0.')
                    : tv('Bốn điểm phối cảnh phải tạo thành một tứ giác lồi, không suy biến.')}
                </p>
              )}
            </section>

            <section className="rounded-lg border border-slate-200 p-3 dark:border-zinc-700">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-xs font-bold uppercase tracking-wide text-slate-500">{tv('Kích thước in')}</h2>
                {(physicalWidthMm !== null || physicalHeightMm !== null) && (
                  <button
                    type="button"
                    onClick={() => commitEditor('physical-size-clear', current => ({ ...current, physicalWidthMm: null, physicalHeightMm: null }))}
                    className="text-[11px] font-semibold text-red-600 hover:underline"
                  >
                    {tv('Xóa kích thước')}
                  </button>
                )}
              </div>
              <p className="mt-1 text-[11px] text-slate-500 dark:text-zinc-400">🔒 {tv('Khóa tỷ lệ theo ảnh nguồn')}</p>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <label className="text-[11px] font-semibold">
                  {tv('Rộng (mm)')}
                  <input
                    aria-label={tv('Rộng (mm)')}
                    type="number"
                    min={0.1}
                    step={0.1}
                    disabled={!sourceAspectRatio}
                    value={physicalWidthMm ?? ''}
                    onChange={event => updatePhysicalWidth(event.target.value)}
                    className="mt-1 w-full rounded border border-slate-200 bg-transparent px-2 py-1.5 text-xs disabled:opacity-40 dark:border-zinc-700"
                  />
                </label>
                <label className="text-[11px] font-semibold">
                  {tv('Cao (mm)')}
                  <input
                    aria-label={tv('Cao (mm)')}
                    type="number"
                    min={0.1}
                    step={0.1}
                    disabled={!sourceAspectRatio}
                    value={physicalHeightMm ?? ''}
                    onChange={event => updatePhysicalHeight(event.target.value)}
                    className="mt-1 w-full rounded border border-slate-200 bg-transparent px-2 py-1.5 text-xs disabled:opacity-40 dark:border-zinc-700"
                  />
                </label>
              </div>
              {dpiSuggestedSize && (
                <button
                  type="button"
                  onClick={() => commitEditor('physical-size-dpi', current => ({
                    ...current,
                    physicalWidthMm: dpiSuggestedSize.width,
                    physicalHeightMm: dpiSuggestedSize.height,
                  }))}
                  className="mt-2 w-full rounded border border-violet-200 px-2 py-1.5 text-[11px] font-semibold text-violet-700 hover:bg-violet-50 dark:border-violet-900 dark:text-violet-300"
                >
                  {tv('Dùng gợi ý DPI')} · {dpiSuggestedSize.width} × {dpiSuggestedSize.height} mm
                </button>
              )}
              <p className="mt-2 text-[11px] text-slate-500 dark:text-zinc-400">
                {physicalWidthMm !== null && physicalHeightMm !== null
                  ? `${tv('Kích thước đã xác nhận')}: ${physicalWidthMm} × ${physicalHeightMm} mm`
                  : tv('Chưa xác nhận mm; SVG sẽ ở trạng thái cần kiểm tra.')}
              </p>
              {dpiSuggestedSize && <p className="mt-1 text-[10px] text-amber-700 dark:text-amber-300">{tv('DPI nguồn chỉ là gợi ý; hãy đối chiếu kích thước in thực tế.')}</p>}
            </section>

            <section className="space-y-3">
              {supportsCurvePresets ? (
                <fieldset className="space-y-2">
                  <legend className="text-xs font-semibold">{tv('Mục tiêu đường cong')}</legend>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {CURVE_PRESET_OPTIONS
                      .filter(option => supportedCurvePresets.includes(option.value))
                      .map(option => (
                        <label
                          key={option.value}
                          className={`cursor-pointer rounded-lg border px-3 py-2 text-xs transition-colors ${curvePreset === option.value
                            ? 'border-violet-500 bg-violet-50 text-violet-900 dark:bg-violet-950/30 dark:text-violet-100'
                            : 'border-slate-200 hover:border-violet-300 dark:border-zinc-700'}`}
                        >
                          <span className="flex items-center gap-2 font-semibold">
                            <input
                              type="radio"
                              name="logo-curve-preset"
                              value={option.value}
                              checked={curvePreset === option.value}
                              onChange={() => commitEditor('curve-preset', current => ({
                                ...current,
                                curvePreset: option.value,
                              }))}
                            />
                            {tv(option.label)}
                          </span>
                          <span className="mt-1 block pl-5 text-[11px] font-normal text-slate-500 dark:text-zinc-400">
                            {tv(option.description)}
                          </span>
                        </label>
                      ))}
                  </div>
                  <p className="text-[11px] text-slate-500 dark:text-zinc-400">
                    {tv('Hình tròn/elip có thể còn 4 hoặc 8 điểm neo; đường tự do không bị ép về một số node cố định nếu sai số sẽ tăng.')}
                  </p>
                </fieldset>
              ) : (
                <label className="block text-xs font-semibold">
                  {tv('Độ mượt đường cong')}: {smoothing.toFixed(1)}
                  <input aria-label={tv('Độ mượt đường cong')} type="range" min={0} max={1} step={0.1} value={smoothing} onChange={event => commitEditor('smoothing', current => ({ ...current, smoothing: Number(event.target.value) }))} className="mt-1 w-full" />
                  <span className="mt-1 block text-[11px] font-normal text-slate-500 dark:text-zinc-400">
                    {tv('0 = trung thực nét; 1 = mượt và gọn node hơn.')}
                  </span>
                </label>
              )}
              <label className="block text-xs font-semibold">
                {tv('Khử hạt nhỏ (px)')}
                <input aria-label={tv('Khử hạt nhỏ')} type="number" min={0} max={128} value={despeckle} onChange={event => commitEditor('despeckle', current => ({ ...current, despeckle: clampPercent(Number(event.target.value), 0, 128) }))} className="mt-1 w-full rounded border border-slate-200 bg-transparent px-2 py-1.5 dark:border-zinc-700" />
                {mode === 'monochrome' && despeckle > 0 && capabilities?.engine?.engine === 'prynx-logo-core' && (
                  <span className="mt-1 block text-[11px] font-normal text-amber-700 dark:text-amber-300">
                    {tv('Khử hạt chưa được PrynX core áp dụng; giá trị lớn hơn 0 sẽ đưa kết quả vào trạng thái cần kiểm tra.')}
                  </span>
                )}
                {mode === 'fixed_palette' && despeckle > 0 && willUpscaleSource(sourceInfo) && (
                  <span className="mt-1 block text-[11px] font-normal text-amber-700 dark:text-amber-300">
                    {tv('Ảnh nhỏ sẽ được phóng to khi dựng nét: chi tiết nhỏ hơn')} {despeckle}×{despeckle} px {tv('ảnh gốc sẽ bị gộp vào màu lân cận; đặt 0 nếu cần giữ dấu nhỏ.')}
                  </span>
                )}
              </label>
              <label className="flex items-center gap-2 text-xs font-semibold">
                <input type="checkbox" checked={illumination} onChange={event => commitEditor('illumination', current => ({ ...current, illumination: event.target.checked }))} />
                {tv('Cân bằng độ sáng cho artwork phẳng không đều màu')}
              </label>
            </section>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void runPreview()}
                disabled={isRunning || !file || !engineReady || Boolean(selectionError)}
                className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-violet-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-45"
              >
                {isRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <WandSparkles className="h-4 w-4" />}
                {tv('Tạo preview SVG')}
              </button>
              {isRunning && (
                <button type="button" onClick={() => void cancelPreview()} className="rounded-lg border border-red-300 px-3 text-red-600 hover:bg-red-50" title={tv('Hủy preview')}>
                  <OctagonX className="h-4 w-4" />
                </button>
              )}
            </div>
            {error && <p ref={errorRef} role="alert" tabIndex={-1} className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 outline-none dark:bg-red-950/30 dark:text-red-300">{error}</p>}
            <p role="status" aria-live="polite" aria-atomic="true" className="min-h-4 text-xs text-slate-500 dark:text-zinc-400">{status}</p>
            {isRunning && (
              <p className="text-[11px] text-slate-500 dark:text-zinc-400">
                {tv('Tiến độ theo phase chưa được backend cung cấp; trạng thái chỉ phản ánh yêu cầu hiện tại.')}
              </p>
            )}
          </aside>

          <main className="grid min-w-0 grid-rows-[minmax(320px,auto)_auto] gap-4 pb-1 xl:min-h-0 xl:grid-rows-[minmax(0,1fr)_auto] xl:overflow-y-auto xl:overscroll-contain">
            <LogoCompareViewport
              key={`${sourceUrl}:${previewUrl}`}
              selectionMode={selectionMode}
              crop={crop}
              perspective={perspective}
              onCropChange={nextCrop => commitEditor('crop-overlay', current => ({ ...current, crop: nextCrop }))}
              onPerspectiveChange={nextPoints => commitEditor('perspective-overlay', current => ({ ...current, perspective: nextPoints }))}
              sourceUrl={sourceUrl}
              previewSvg={preview?.svg ?? null}
              previewUrl={previewUrl}
              labels={{
                viewport: tv('Vùng so sánh logo'),
                source: tv('Gốc'),
                vector: tv('Vector'),
                split: tv('Chia đôi'),
                overlay: tv('Chồng lớp'),
                zoomOut: tv('Thu nhỏ'),
                zoomIn: tv('Phóng to'),
                zoomLevel: tv('Mức phóng đại'),
                resetZoom: tv('Về 100%'),
                overlayOpacity: tv('Độ mờ vector'),
                noImage: tv('Chưa chọn ảnh'),
                noPreview: tv('Chưa có preview'),
                panHint: tv('Kéo để di chuyển · Ctrl + cuộn để thu phóng'),
                sourceAlt: tv('Ảnh logo nguồn'),
                previewAlt: tv('SVG vector đã dựng'),
                selection: selectionMode === 'crop' ? tv('Crop chữ nhật') : tv('Nắn phối cảnh 4 điểm'),
                point: tv('Điểm'),
                showAnchors: tv('Hiện điểm neo'),
                comparisonWarning: tv('Chọn toàn ảnh để so sánh Chia đôi/Chồng lớp; khi crop hoặc nắn phối cảnh hãy dùng Gốc hoặc Vector.'),
                keyboardHint: tv('Phím mũi tên chỉnh tay nắm; Shift + phím mũi tên bước lớn'),
              }}
            />

            <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
              <header className="flex items-center justify-between border-b border-slate-200 px-4 py-3 text-xs font-bold uppercase tracking-wide text-slate-500 dark:border-zinc-800">
                <span>{tv('Kết quả vector')}</span>
                <button type="button" disabled={!canExport || isSaving} onClick={() => void exportSvg()} className="flex items-center gap-1 rounded-md bg-emerald-600 px-2.5 py-1.5 text-[11px] font-bold normal-case text-white disabled:opacity-40">
                  {isSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />} {tv('Tải SVG')}
                </button>
              </header>
              {preview && (
                <div className="border-t border-slate-200 px-4 py-3 text-xs text-slate-500 dark:border-zinc-800 dark:text-zinc-400">
                  <p>{preview.width_px}×{preview.height_px} px · {preview.engine} {preview.engine_version}</p>
                  {preview.result_schema_version !== null && (
                    <p className="mt-1 font-semibold text-violet-700 dark:text-violet-300">
                      {tv('Schema kết quả')}: {preview.result_schema_version}
                    </p>
                  )}
                  {typeof preview.physical_width_mm === 'number' && typeof preview.physical_height_mm === 'number' && (
                    <p className="mt-1 font-semibold text-emerald-700 dark:text-emerald-300">
                      {tv('Kích thước in')}: {preview.physical_width_mm} × {preview.physical_height_mm} mm
                    </p>
                  )}
                  <p className="mt-1">
                    {tv('Độ phức tạp SVG')}: {preview.complexity.path_count} path · {preview.complexity.node_count} node · {preview.complexity.removed_redundant_paths} {tv('mảng dư đã dọn')}
                  </p>
                  {preview.native_metrics && (
                    <section aria-label={tv('Độ sạch đường cong')} className="mt-2 grid gap-1 rounded-lg bg-slate-50 px-3 py-2 dark:bg-zinc-950/50 sm:grid-cols-2">
                      <p className="font-semibold text-violet-700 dark:text-violet-300">
                        {tv('Điểm neo nguồn / đầu ra')}: {preview.native_metrics.source_nodes} → {preview.native_metrics.output_nodes}
                        {preview.native_metrics.source_nodes > 0
                          ? ` (−${Math.max(0, Math.round((1 - preview.native_metrics.output_nodes / preview.native_metrics.source_nodes) * 100))}%)`
                          : ''}
                      </p>
                      {typeof preview.native_metrics.line_segments === 'number'
                        && typeof preview.native_metrics.cubic_segments === 'number' && (
                        <p>{tv('Đoạn thẳng / Bézier')}: {preview.native_metrics.line_segments} / {preview.native_metrics.cubic_segments}</p>
                      )}
                      {typeof preview.native_metrics.circle_count === 'number'
                        && typeof preview.native_metrics.ellipse_count === 'number' && (
                        <p>{tv('Hình tròn / elip')}: {preview.native_metrics.circle_count} / {preview.native_metrics.ellipse_count}</p>
                      )}
                      <p>{tv('Sai số hai chiều lớn nhất')}: {(preview.native_metrics.max_symmetric_distance_px ?? preview.native_metrics.max_error_px).toFixed(4)} px</p>
                      {typeof preview.native_metrics.artifact_max_tangent_jump_degrees === 'number' ? (
                        <p>{tv('Lệch tiếp tuyến SVG cuối lớn nhất')}: {preview.native_metrics.artifact_max_tangent_jump_degrees.toFixed(2)}°</p>
                      ) : typeof preview.native_metrics.max_smooth_tangent_jump_degrees === 'number' ? (
                        <p>{tv('Lệch tiếp tuyến mượt lớn nhất')}: {preview.native_metrics.max_smooth_tangent_jump_degrees.toFixed(2)}°</p>
                      ) : null}
                      <p>{tv('Biên ngoài / lỗ')}: {preview.native_metrics.outer_count} / {preview.native_metrics.hole_count}</p>
                      <details className="sm:col-span-2">
                        <summary className="cursor-pointer font-semibold">{tv('Độ khớp raster')}</summary>
                        <p className="mt-1"><strong>IoU</strong>: {preview.native_metrics.iou.toFixed(4)} · <strong>MAE</strong>: {preview.native_metrics.mae.toFixed(4)} · {preview.native_metrics.raster_scale}×</p>
                        <p>{tv('Lớp / thành phần')}: {preview.native_metrics.layer_count} / {preview.native_metrics.component_count}</p>
                      </details>
                    </section>
                  )}
                  {preview.artifact_sha256 && (
                    <p className="mt-2 font-mono text-[11px]">
                      {tv('Hash artifact')}: <span title={preview.artifact_sha256}>{preview.artifact_sha256.slice(0, 12)}…</span>
                    </p>
                  )}
                  {preview.preprocess_hash && (
                    <p className="mt-1 font-mono text-[11px]">
                      {tv('Hash tiền xử lý')}: <span title={preview.preprocess_hash}>{preview.preprocess_hash.slice(0, 12)}…</span>
                    </p>
                  )}
                  {preview.status !== 'ready' && (
                    <div className={`mt-2 rounded-lg px-3 py-2 ${preview.status === 'rejected' ? 'bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-300' : 'bg-amber-50 text-amber-800 dark:bg-amber-950/30 dark:text-amber-200'}`}>
                      <strong>{preview.status === 'rejected' ? tv('Không thể xuất SVG') : tv('Cần kiểm tra SVG')}</strong>
                      {preview.review_reasons.map((reason, index) => <p key={`reason-${index}`} className="mt-1">{reason}</p>)}
                      {preview.review_actions.map((action, index) => <p key={`action-${index}`} className="mt-1">→ {action}</p>)}
                      {preview.status === 'review' && !reviewAccepted && (
                        <button type="button" onClick={() => setReviewAccepted(true)} className="mt-2 rounded border border-amber-400 px-2 py-1 font-semibold">
                          {tv('Tôi đã kiểm tra và vẫn muốn xuất')}
                        </button>
                      )}
                    </div>
                  )}
                  {preview.warnings.map((warning, index) => <p key={index} className="mt-1 text-amber-700 dark:text-amber-300">⚠ {warning}</p>)}
                </div>
              )}
            </section>
          </main>
        </div>
      </div>
    </div>
  );
}
