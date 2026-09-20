import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import {
  Download,
  ImagePlus,
  LayoutGrid,
  Loader2,
  OctagonX,
  Plus,
  Redo2,
  Scissors,
  Sparkles,
  Trash2,
  Undo2,
  WandSparkles,
  X,
} from 'lucide-react';

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
import { IMAGE_BATCH_DROP_EVENTS, registerActiveTabFeature, requestOpenTool } from '../../lib/tabNavigation';
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

function roundMillimeters(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export interface LogoBatchItem {
  id: string;
  file: File;
  name: string;
  thumbnailUrl: string;
  editor: EditorState;
  preview: LogoRebuildPreview | null;
  previewUrl: string;
  paletteSuggestions: LogoPaletteSuggestion[];
  preflightWarnings: string[];
  sourceInfo: LogoRebuildPreflight['source'] | null;
  past: EditorState[];
  future: EditorState[];
  status: 'idle' | 'processing' | 'ready' | 'review' | 'rejected' | 'error';
}

interface LogoRebuildWorkspaceProps {
  tabId?: string;
  hasOtherDirtyChanges?: boolean;
  isActive?: boolean;
  isLocked?: boolean;
  showLimitations?: boolean;
  onDirtyChange?: (isDirty: boolean) => void;
  onClose?: () => void;
  portalEl?: HTMLElement | null;
}

interface EditorState {
  mode: LogoRebuildMode;
  palette: string[];
  paletteConfirmed: boolean;
  removeBackground: boolean;
  backgroundColor: string;
  smoothing: number;
  curvePreset: LogoCurvePreset;
  despeckle: number;
  illumination: boolean;
  physicalWidthMm: number | null;
  physicalHeightMm: number | null;
  selectionMode: SelectionMode;
  crop: { x: number; y: number; width: number; height: number };
  perspective: NormalizedPoint[];
}

type CapabilitiesStatus = 'loading' | 'ready' | 'error';

const DEFAULT_DESPECKLE_SIZE_PX = 4;
const HISTORY_COALESCE_MS = 500;
const MAX_HISTORY_STEPS = 60;
const MAX_LOGO_UPLOAD_BYTES = 500 * 1024 * 1024;
const ACCEPTED_LOGO_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

const DEFAULT_PALETTE: string[] = ['#000000', '#ffffff'];
const DEFAULT_PERSPECTIVE: NormalizedPoint[] = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];

const INITIAL_EDITOR_STATE: EditorState = {
  mode: 'fixed_palette',
  palette: DEFAULT_PALETTE,
  paletteConfirmed: false,
  removeBackground: false,
  backgroundColor: '#ffffff',
  smoothing: 0,
  curvePreset: 'automatic',
  despeckle: DEFAULT_DESPECKLE_SIZE_PX,
  illumination: false,
  physicalWidthMm: null,
  physicalHeightMm: null,
  selectionMode: 'full',
  crop: { x: 0, y: 0, width: 100, height: 100 },
  perspective: DEFAULT_PERSPECTIVE,
};

function newJobId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function clampPercent(value: number, min = 0, max = 100): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

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

function isConvexQuad(points: NormalizedPoint[]): boolean {
  if (points.length !== 4) return false;
  let sign = 0;
  for (let index = 0; index < 4; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % 4];
    const after = points[(index + 2) % 4];
    const crossProduct = (next.x - current.x) * (after.y - next.y) - (next.y - current.y) * (after.x - next.x);
    if (Math.abs(crossProduct) < 1e-6) return false;
    if (sign === 0) {
      sign = crossProduct > 0 ? 1 : -1;
    } else if ((crossProduct > 0 ? 1 : -1) !== sign) {
      return false;
    }
  }
  return true;
}

function selectionValidationCode(state: EditorState): 'crop' | 'perspective' | null {
  if (state.selectionMode === 'crop') {
    const { x, y, width, height } = state.crop;
    const isValid = width > 0 && height > 0 && x >= 0 && y >= 0 && x + width <= 100.001 && y + height <= 100.001;
    return isValid ? null : 'crop';
  }
  if (state.selectionMode === 'perspective') {
    const validBounds = state.perspective.every(point => point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1);
    return validBounds && isConvexQuad(state.perspective) ? null : 'perspective';
  }
  return null;
}

function BatchThumbnailImage({
  item,
  isSelected,
  currentSourceUrl,
}: {
  item: LogoBatchItem;
  isSelected: boolean;
  currentSourceUrl: string;
}) {
  const [thumbUrl, setThumbUrl] = useState<string>('');

  useEffect(() => {
    if (isSelected) return;
    const url = URL.createObjectURL(item.file);
    setThumbUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [item.file, isSelected]);

  const displayUrl = isSelected ? currentSourceUrl : (thumbUrl || currentSourceUrl);

  if (!displayUrl) {
    return <div className="h-full w-full animate-pulse bg-slate-200 dark:bg-zinc-800" />;
  }

  return (
    <img
      src={displayUrl}
      alt={item.name}
      className="h-full w-full object-cover"
      draggable={false}
    />
  );
}

export default function LogoRebuildWorkspace({
  tabId,
  hasOtherDirtyChanges = false,
  isActive = true,
  isLocked = false,
  showLimitations: _showLimitations = true,
  onDirtyChange,
  onClose,
  portalEl,
}: LogoRebuildWorkspaceProps) {
  const [showLimitationsBanner, setShowLimitationsBanner] = useState(_showLimitations);
  const [capabilities, setCapabilities] = useState<LogoRebuildCapabilities | null>(null);
  const [capabilitiesStatus, setCapabilitiesStatus] = useState<CapabilitiesStatus>('loading');
  const [capabilitiesError, setCapabilitiesError] = useState('');
  const [batchItems, setBatchItems] = useState<LogoBatchItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const batchItemsRef = useRef<LogoBatchItem[]>([]);
  batchItemsRef.current = batchItems;
  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;
  const [file, setFile] = useState<File | null>(null);
  const [sourceUrl, setSourceUrl] = useState('');
  const [editor, setEditor] = useState<EditorState>(() => cloneEditorState(INITIAL_EDITOR_STATE));
  const editorRef = useRef(editor);
  editorRef.current = editor;

  const pastRef = useRef<EditorState[]>([]);
  const futureRef = useRef<EditorState[]>([]);
  const lastCommitRef = useRef<{ key: string; at: number } | null>(null);
  const [, setHistoryVersion] = useState(0);

  const [preview, setPreview] = useState<LogoRebuildPreview | null>(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const previewUrlRef = useRef(previewUrl);
  previewUrlRef.current = previewUrl;

  const [isRunning, setIsRunning] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [reviewAccepted, setReviewAccepted] = useState(false);

  const [paletteSuggestions, setPaletteSuggestions] = useState<LogoPaletteSuggestion[]>([]);
  const [preflightWarnings, setPreflightWarnings] = useState<string[]>([]);
  const [sourceInfo, setSourceInfo] = useState<LogoRebuildPreflight['source'] | null>(null);
  const [isPaletteLoading, setIsPaletteLoading] = useState(false);

  const isMountedRef = useRef(true);
  const activeJobRef = useRef<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const cancelledJobRef = useRef<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const revisionRef = useRef(0);
  const errorRef = useRef<HTMLParagraphElement | null>(null);

  const isOperationLocked = isRunning || isSaving || isLocked;
  const [sessionDirty, setSessionDirty] = useState(false);

  const willUpscaleSource = (info: LogoRebuildPreflight['source'] | null): boolean => {
    if (!info) return false;
    const maxDimension = Math.max(info.width_px, info.height_px);
    return maxDimension > 0 && maxDimension < 600;
  };

  const markDirty = useCallback(() => {
    setSessionDirty(true);
  }, []);

  const clearDirty = useCallback(() => {
    setSessionDirty(false);
  }, []);

  useEffect(() => {
    onDirtyChange?.(sessionDirty);
  }, [onDirtyChange, sessionDirty]);

  const clearPreview = useCallback(() => {
    activeJobRef.current = null;
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = '';
    }
    setPreview(null);
    setPreviewUrl('');
    setReviewAccepted(false);
    setStatus('');
  }, []);

  const refreshCapabilities = useCallback(async () => {
    setCapabilitiesStatus('loading');
    setCapabilitiesError('');
    try {
      const caps = await getLogoRebuildCapabilities();
      setCapabilities(caps);
      setCapabilitiesStatus('ready');
    } catch (reason) {
      setCapabilitiesStatus('error');
      setCapabilitiesError(reason instanceof Error ? reason.message : tv('Không thể kết nối backend.'));
    }
  }, []);

  useEffect(() => {
    void refreshCapabilities();
  }, [refreshCapabilities]);

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
    if (selectedIdRef.current) {
      const activeId = selectedIdRef.current;
      setBatchItems(prev => prev.map(item => item.id === activeId ? { ...item, editor: cloneEditorState(next) } : item));
    }
    markDirty();
    refreshHistoryButtons();
    clearPreview();
    if (changesSelection) {
      setPaletteSuggestions([]);
      setPreflightWarnings([]);
    }
  }, [clearPreview, markDirty, refreshHistoryButtons]);

  const undo = useCallback(() => {
    const previous = pastRef.current.pop();
    if (!previous) return;
    futureRef.current.unshift(cloneEditorState(editorRef.current));
    editorRef.current = previous;
    setEditor(previous);
    if (selectedIdRef.current) {
      const activeId = selectedIdRef.current;
      setBatchItems(prev => prev.map(item => item.id === activeId ? { ...item, editor: cloneEditorState(previous) } : item));
    }
    markDirty();
    lastCommitRef.current = null;
    refreshHistoryButtons();
    clearPreview();
  }, [clearPreview, markDirty, refreshHistoryButtons]);

  const redo = useCallback(() => {
    const next = futureRef.current.shift();
    if (!next) return;
    pastRef.current.push(cloneEditorState(editorRef.current));
    editorRef.current = next;
    setEditor(next);
    if (selectedIdRef.current) {
      const activeId = selectedIdRef.current;
      setBatchItems(prev => prev.map(item => item.id === activeId ? { ...item, editor: cloneEditorState(next) } : item));
    }
    markDirty();
    lastCommitRef.current = null;
    refreshHistoryButtons();
    clearPreview();
  }, [clearPreview, markDirty, refreshHistoryButtons]);

  const analyzePalette = useCallback(async (
    targetFile: File,
    targetEditor: EditorState,
    requestRevision: number,
  ) => {
    setIsPaletteLoading(true);
    try {
      const preflightSettings: LogoRebuildSettings = {
        mode: 'fixed_palette',
        engine: DEFAULT_LOGO_ENGINE,
        palette: targetEditor.palette && targetEditor.palette.length > 0 ? targetEditor.palette : DEFAULT_PALETTE,
        background_color: targetEditor.removeBackground ? targetEditor.backgroundColor : undefined,
        smoothing: targetEditor.smoothing,
        curve_preset: targetEditor.curvePreset,
        despeckle_size_px: targetEditor.despeckle,
        illumination_correction: targetEditor.illumination,
        crop: targetEditor.selectionMode === 'crop'
          ? {
            x: targetEditor.crop.x / 100,
            y: targetEditor.crop.y / 100,
            width: targetEditor.crop.width / 100,
            height: targetEditor.crop.height / 100,
          }
          : undefined,
        perspective_points: targetEditor.selectionMode === 'perspective' ? targetEditor.perspective : undefined,
      };
      const result = await preflightLogoRebuild(targetFile, preflightSettings);
      if (revisionRef.current === requestRevision) {
        setSourceInfo(result.source);
        if (targetEditor.mode === 'fixed_palette' && targetEditor.despeckle === DEFAULT_DESPECKLE_SIZE_PX) {
          const maxDim = Math.max(result.source.width_px, result.source.height_px);
          if (maxDim > 0 && maxDim < 600) {
            commitEditor('auto-despeckle-zero', current => ({
              ...current,
              despeckle: 0,
            }));
            setStatus(tv('Ảnh nhỏ sẽ được phóng to khi dựng nét: khử hạt đã đặt về 0 để giữ dấu và chi tiết nhỏ.'));
          }
        }
        setPaletteSuggestions(result.palette_suggestions);
        setPreflightWarnings(result.warnings);
      }
    } catch (reason) {
      if (revisionRef.current === requestRevision) {
        setPaletteSuggestions([]);
        setPreflightWarnings([reason instanceof Error ? reason.message : tv('Không thể phân tích ảnh.')]);
      }
    } finally {
      if (revisionRef.current === requestRevision) {
        setIsPaletteLoading(false);
      }
    }
  }, [commitEditor]);

  const switchToItem = useCallback((targetId: string) => {
    if (targetId === selectedIdRef.current) return;
    const currentId = selectedIdRef.current;
    if (currentId) {
      setBatchItems(prev => prev.map(item => {
        if (item.id === currentId) {
          return {
            ...item,
            editor: editorRef.current,
            preview,
            previewUrl: previewUrlRef.current,
            paletteSuggestions,
            preflightWarnings,
            sourceInfo,
            past: pastRef.current,
            future: futureRef.current,
          };
        }
        return item;
      }));
    }
    const target = batchItemsRef.current.find(item => item.id === targetId);
    if (!target) return;
    selectedIdRef.current = targetId;
    setSelectedId(targetId);
    setFile(target.file);
    editorRef.current = target.editor;
    setEditor(target.editor);
    pastRef.current = target.past;
    futureRef.current = target.future;
    refreshHistoryButtons();
    setPreview(target.preview);
    previewUrlRef.current = target.previewUrl;
    setPreviewUrl(target.previewUrl);
    setPaletteSuggestions(target.paletteSuggestions);
    setPreflightWarnings(target.preflightWarnings);
    setSourceInfo(target.sourceInfo);
    setError('');
    setStatus('');
    if (target.paletteSuggestions.length === 0 && !target.sourceInfo) {
      void analyzePalette(target.file, target.editor, revisionRef.current);
    }
  }, [preview, paletteSuggestions, preflightWarnings, sourceInfo, refreshHistoryButtons, analyzePalette]);

  const removeBatchItem = useCallback((targetId: string) => {
    const itemToRemove = batchItemsRef.current.find(item => item.id === targetId);
    if (itemToRemove?.previewUrl) {
      URL.revokeObjectURL(itemToRemove.previewUrl);
    }
    const nextItems = batchItemsRef.current.filter(item => item.id !== targetId);
    setBatchItems(nextItems);
    batchItemsRef.current = nextItems;
    if (selectedIdRef.current === targetId) {
      if (nextItems.length > 0) {
        switchToItem(nextItems[0].id);
      } else {
        selectedIdRef.current = null;
        setSelectedId(null);
        setFile(null);
        clearPreview();
        setPaletteSuggestions([]);
        setPreflightWarnings([]);
        setSourceInfo(null);
        resetHistory();
      }
    }
  }, [clearPreview, resetHistory, switchToItem]);

  const applySuggestedBackground = useCallback((color: string) => {
    const normalizedBackground = color.toLowerCase();
    const nextPalette = paletteSuggestions
      .map(item => item.color.toLowerCase())
      .filter(item => item !== normalizedBackground);
    if (nextPalette.length === 0) {
      setError(tv('Cần giữ ít nhất một màu logo khác màu nền.'));
      return;
    }
    commitEditor('background-suggestion', current => ({
      ...current,
      palette: nextPalette,
      paletteConfirmed: true,
      removeBackground: true,
      backgroundColor: normalizedBackground,
    }));
    setError('');
    setStatus(tv('Đã đặt màu gợi ý làm nền và loại khỏi bảng màu logo.'));
  }, [commitEditor, paletteSuggestions]);

  const selectFile = useCallback((selected?: File | null) => {
    if (!selected || isOperationLocked) return;
    const isJpeg = selected.type === 'image/jpeg' || /\.jpe?g$/i.test(selected.name);
    const initialEditor: EditorState = {
      ...cloneEditorState(editorRef.current),
      paletteConfirmed: false,
      smoothing: isJpeg ? 1 : 0,
      despeckle: DEFAULT_DESPECKLE_SIZE_PX,
      physicalWidthMm: null,
      physicalHeightMm: null,
    };
    const newItem: LogoBatchItem = {
      id: `logo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      file: selected,
      name: selected.name,
      thumbnailUrl: '',
      editor: initialEditor,
      preview: null,
      previewUrl: '',
      paletteSuggestions: [],
      preflightWarnings: [],
      sourceInfo: null,
      past: [],
      future: [],
      status: 'idle',
    };
    setBatchItems([newItem]);
    batchItemsRef.current = [newItem];
    selectedIdRef.current = newItem.id;
    setSelectedId(newItem.id);
    clearPreview();
    editorRef.current = initialEditor;
    setEditor(initialEditor);
    resetHistory();
    setPaletteSuggestions([]);
    setPreflightWarnings([]);
    setSourceInfo(null);
    setFile(selected);
    markDirty();
    setError('');
    setStatus('');
    const requestRevision = revisionRef.current + 1;
    revisionRef.current = requestRevision;
    void analyzePalette(selected, initialEditor, requestRevision);
  }, [analyzePalette, clearPreview, isOperationLocked, markDirty, resetHistory]);

  const addFiles = useCallback((incoming: File[]) => {
    if (isOperationLocked || !incoming.length) return;
    const validFiles: File[] = [];
    for (const f of incoming) {
      if (!/\.(png|jpe?g|webp)$/i.test(f.name)) {
        setError(tv('Chỉ hỗ trợ ảnh PNG, JPEG hoặc WebP.'));
        continue;
      }
      if (f.type && !ACCEPTED_LOGO_MIME_TYPES.has(f.type.toLowerCase())) {
        setError(tv('File không khớp định dạng ảnh; hãy chọn lại PNG, JPEG hoặc WebP.'));
        continue;
      }
      if (f.size > MAX_LOGO_UPLOAD_BYTES) {
        setError(tv('File logo quá lớn. Tối đa 500MB.'));
        continue;
      }
      validFiles.push(f);
    }
    if (!validFiles.length) return;

    if (validFiles.length === 1 && batchItemsRef.current.length <= 1) {
      selectFile(validFiles[0]);
      return;
    }

    const newItems: LogoBatchItem[] = validFiles.map(f => {
      const isJpeg = f.type === 'image/jpeg' || /\.jpe?g$/i.test(f.name);
      const initialEditor: EditorState = {
        ...editorRef.current,
        paletteConfirmed: false,
        smoothing: isJpeg ? 1 : 0,
        despeckle: DEFAULT_DESPECKLE_SIZE_PX,
        physicalWidthMm: null,
        physicalHeightMm: null,
      };
      return {
        id: `logo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        file: f,
        name: f.name,
        thumbnailUrl: '',
        editor: initialEditor,
        preview: null,
        previewUrl: '',
        paletteSuggestions: [],
        preflightWarnings: [],
        sourceInfo: null,
        past: [],
        future: [],
        status: 'idle',
      };
    });

    const currentId = selectedIdRef.current;
    let baseItems = batchItemsRef.current;
    if (currentId) {
      baseItems = baseItems.map(item => item.id === currentId ? {
        ...item,
        editor: editorRef.current,
        preview,
        previewUrl: previewUrlRef.current,
        paletteSuggestions,
        preflightWarnings,
        sourceInfo,
        past: pastRef.current,
        future: futureRef.current,
      } : item);
    }
    const combined = [...baseItems, ...newItems];
    setBatchItems(combined);
    batchItemsRef.current = combined;

    const first = newItems[0];
    selectedIdRef.current = first.id;
    setSelectedId(first.id);
    clearPreview();
    editorRef.current = first.editor;
    setEditor(first.editor);
    resetHistory();
    setPaletteSuggestions([]);
    setPreflightWarnings([]);
    setSourceInfo(null);
    setFile(first.file);
    markDirty();
    setError('');
    setStatus('');
    const requestRevision = revisionRef.current + 1;
    revisionRef.current = requestRevision;
    void analyzePalette(first.file, first.editor, requestRevision);
  }, [clearPreview, isOperationLocked, markDirty, paletteSuggestions, preflightWarnings, preview, resetHistory, selectFile, sourceInfo, analyzePalette]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      activeJobRef.current = null;
      abortControllerRef.current?.abort();
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      batchItemsRef.current.forEach(item => {
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      });
    };
  }, []);

  useEffect(() => {
    if (!file) {
      setSourceUrl('');
      return undefined;
    }
    const nextUrl = URL.createObjectURL(file);
    setSourceUrl(nextUrl);
    return () => URL.revokeObjectURL(nextUrl);
  }, [file]);

  const {
    mode,
    palette,
    paletteConfirmed,
    removeBackground,
    backgroundColor,
    smoothing,
    curvePreset,
    despeckle,
    illumination,
    physicalWidthMm,
    physicalHeightMm,
    selectionMode,
    crop,
    perspective,
  } = editor;

  const uniquePalette = useMemo(() => {
    const normalized = palette.map(color => color.trim().toLowerCase());
    return Array.from(new Set(normalized));
  }, [palette]);

  const supportsCurvePresets = capabilities?.engine?.engine === 'prynx-logo-core'
    && Array.isArray(capabilities.engine.curve_presets);
  const supportedCurvePresets = capabilities?.engine?.curve_presets
    ?? ['automatic', 'faithful', 'balanced', 'trajectory_completion'];

  const buildSettings = useCallback((overrideEditor?: EditorState): LogoRebuildSettings => {
    const current = overrideEditor ?? editorRef.current;
    const currentPalette = current.palette.map(item => item.trim().toLowerCase());
    const currentUniquePalette = Array.from(new Set(currentPalette));
    return {
      mode: current.mode,
      engine: DEFAULT_LOGO_ENGINE,
      palette: current.mode === 'fixed_palette' ? currentUniquePalette : [],
      background_color: current.mode === 'fixed_palette' && current.removeBackground ? current.backgroundColor : undefined,
      smoothing: current.smoothing,
      curve_preset: supportsCurvePresets ? current.curvePreset : undefined,
      despeckle_size_px: current.despeckle,
      illumination_correction: current.illumination,
      crop: current.selectionMode === 'crop'
        ? {
          x: current.crop.x / 100,
          y: current.crop.y / 100,
          width: current.crop.width / 100,
          height: current.crop.height / 100,
        }
        : undefined,
      perspective_points: current.selectionMode === 'perspective' ? current.perspective : undefined,
      physical_width_mm: typeof current.physicalWidthMm === 'number' && current.physicalWidthMm > 0 ? current.physicalWidthMm : undefined,
      physical_height_mm: typeof current.physicalHeightMm === 'number' && current.physicalHeightMm > 0 ? current.physicalHeightMm : undefined,
    };
  }, [supportsCurvePresets]);

  const runPreview = async (overrideFile?: File, overrideState?: EditorState) => {
    const currentFile = overrideFile ?? file;
    const currentEditor = overrideState ?? editorRef.current;
    if (!currentFile) {
      setError(tv('Hãy chọn ảnh có logo trước.'));
      return;
    }
    const engineReady = capabilitiesStatus === 'ready' && Boolean(capabilities?.preview_engine_enabled);
    if (!engineReady) {
      setError(tv('Engine preview chưa sẵn sàng. Hãy build lại lõi native.'));
      return;
    }
    const currentPalette = currentEditor.palette.map(item => item.trim().toLowerCase());
    const currentUniquePalette = Array.from(new Set(currentPalette));
    if (currentEditor.mode === 'fixed_palette' && !currentEditor.paletteConfirmed) {
      setError(tv('Hãy áp dụng bảng màu gợi ý hoặc chỉnh màu thủ công trước.'));
      return;
    }
    if (currentEditor.mode === 'fixed_palette' && currentUniquePalette.some(color => !/^#[0-9a-f]{6}$/i.test(color))) {
      setError(tv('Mỗi màu phải có dạng #RRGGBB.'));
      return;
    }
    if (currentEditor.mode === 'fixed_palette' && currentUniquePalette.length < 1) {
      setError(tv('Logo màu cần ít nhất một màu đã xác nhận.'));
      return;
    }
    if (currentEditor.mode === 'fixed_palette' && currentEditor.removeBackground) {
      if (!/^#[0-9a-f]{6}$/i.test(currentEditor.backgroundColor)) {
        setError(tv('Màu nền phải có dạng #RRGGBB.'));
        return;
      }
      if (currentUniquePalette.includes(currentEditor.backgroundColor.toLowerCase())) {
        setError(tv('Màu nền cần bỏ phải khác bảng màu logo.'));
        return;
      }
    }
    const geometryError = selectionValidationCode(currentEditor);
    if (geometryError) {
      setError(geometryError === 'crop'
        ? tv('Vùng crop phải nằm trọn trong ảnh và có kích thước lớn hơn 0.')
        : tv('Tứ giác nắn phối cảnh phải lồi, 4 điểm không giao cắt và nằm trọn trong ảnh.'));
      return;
    }

    const controller = new AbortController();
    abortControllerRef.current = controller;
    const jobId = newJobId();
    activeJobRef.current = jobId;
    const requestRevision = revisionRef.current + 1;
    revisionRef.current = requestRevision;
    cancelledJobRef.current = null;
    lastCommitRef.current = null;
    setIsRunning(true);
    if (selectedIdRef.current) {
      const activeId = selectedIdRef.current;
      setBatchItems(prev => prev.map(item => item.id === activeId ? { ...item, status: 'processing' } : item));
    }
    setError('');
    setStatus(tv('Đang xử lý logo trên thiết bị…'));
    try {
      const result = await createLogoRebuildPreview(currentFile, buildSettings(currentEditor), jobId, controller.signal);
      if (
        isMountedRef.current
        && !controller.signal.aborted
        && activeJobRef.current === jobId
        && revisionRef.current === requestRevision
        && cancelledJobRef.current !== jobId
      ) {
        if (previewUrlRef.current) {
          URL.revokeObjectURL(previewUrlRef.current);
        }
        const blob = new Blob([result.svg], { type: 'image/svg+xml' });
        const nextUrl = URL.createObjectURL(blob);
        previewUrlRef.current = nextUrl;
        setPreview(result);
        setPreviewUrl(nextUrl);
        setReviewAccepted(result.status === 'ready');
        if (selectedIdRef.current) {
          const activeId = selectedIdRef.current;
          setBatchItems(prev => prev.map(item => item.id === activeId ? {
            ...item,
            preview: result,
            previewUrl: nextUrl,
            status: result.status === 'ready' ? 'ready' : result.status === 'review' ? 'review' : 'rejected',
          } : item));
        }
        markDirty();
        setStatus(result.status === 'ready'
          ? tv('Preview đã sẵn sàng. Hãy phóng to và kiểm tra chữ, nét nhỏ trước khi in.')
          : result.status === 'review'
            ? tv('Đã tạo vector; một số chỉ số cần bạn kiểm tra.')
            : tv('Không đạt tiêu chuẩn xuất vector; hãy điều chỉnh thông số.'));
      }
    } catch (reason) {
      if (isMountedRef.current && !controller.signal.aborted && revisionRef.current === requestRevision) {
        setError(reason instanceof Error ? reason.message : tv('Tạo preview thất bại.'));
        setStatus('');
        if (selectedIdRef.current) {
          const activeId = selectedIdRef.current;
          setBatchItems(prev => prev.map(item => item.id === activeId ? { ...item, status: 'error' } : item));
        }
      }
    } finally {
      if (isMountedRef.current && activeJobRef.current === jobId) {
        setIsRunning(false);
        abortControllerRef.current = null;
      }
    }
  };

  const cancelPreview = async () => {
    const currentJob = activeJobRef.current;
    if (!currentJob) return;
    cancelledJobRef.current = currentJob;
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    clearPreview();
    setIsRunning(false);
    setStatus(tv('Đã hủy tạo preview.'));
    try {
      await cancelLogoRebuildPreview(currentJob);
    } catch {
      // Bỏ qua lỗi hủy trên backend
    }
  };

  const exportSvg = async (): Promise<'saved' | 'cancelled' | 'failed'> => {
    if (
      !preview
      || !file
      || preview.status === 'rejected'
    ) {
      setError(tv('Hãy tạo và kiểm tra preview SVG trước khi lưu.'));
      return 'failed';
    }
    const defaultName = file.name.replace(/\.[^/.]+$/, '') + '_vector.svg';
    setIsSaving(true);
    setStatus(tv('Đang xuất SVG…'));
    try {
      const blob = new Blob([preview.svg], { type: 'image/svg+xml;charset=utf-8' });
      const result = await saveBlob(blob, defaultName, {
        title: tv('Lưu file SVG'),
        filterName: 'SVG',
        extensions: ['svg'],
      });
      if (result.kind === 'saved') {
        setStatus(tv('Đã lưu file SVG.'));
        clearDirty();
        return 'saved';
      }
      setStatus(tv('Đã hủy lưu file.'));
      return 'cancelled';
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : tv('Lưu file SVG thất bại.'));
      return 'failed';
    } finally {
      setIsSaving(false);
    }
  };

  const exportSvgRef = useRef(exportSvg);
  useLayoutEffect(() => {
    exportSvgRef.current = exportSvg;
  });

  useEffect(() => {
    if (!isActive || !tabId) return;
    const handleSaveCommand = async (event: Event) => {
      const detail = (event as CustomEvent<{ tabId: string; requestId?: string; saveAs?: boolean }>).detail;
      if (detail?.tabId !== tabId) return;
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

  useEffect(() => {
    if (!tabId) return undefined;
    return registerActiveTabFeature(tabId, 'logo_rebuild');
  }, [tabId]);

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

  const getSvgFile = useCallback((): File | null => {
    if (!preview?.svg || !file) return null;
    const baseName = file.name.replace(/\.[^/.]+$/, '');
    const cleanName = `${baseName}_vector.svg`;
    return new File([preview.svg], cleanName, { type: 'image/svg+xml' });
  }, [preview, file]);

  const sendToImposition = useCallback(() => {
    const svgFile = getSvgFile();
    if (!svgFile) {
      setError(tv('Hãy tạo preview vector trước khi đưa sang Bình bản.'));
      return;
    }
    requestOpenTool('imposition', svgFile);
    setStatus(tv('Đã mở logo vector trong tab Bình bản.'));
  }, [getSvgFile]);

  const sendToDiecut = useCallback(() => {
    const svgFile = getSvgFile();
    if (!svgFile) {
      setError(tv('Hãy tạo preview vector trước khi tạo tem bế.'));
      return;
    }
    requestOpenTool('diecut', svgFile);
    setStatus(tv('Đã mở logo vector trong tab Tem bế.'));
  }, [getSvgFile]);

  const pastSvgRef = useRef<string[]>([]);
  const [, setSvgHistoryVersion] = useState(0);

  const deleteSvgPath = useCallback((pathIndex: number) => {
    if (!preview?.svg) return;
    try {
      const doc = new DOMParser().parseFromString(preview.svg, 'image/svg+xml');
      const paths = doc.querySelectorAll('path');
      if (pathIndex < 0 || pathIndex >= paths.length) return;
      pastSvgRef.current.push(preview.svg);
      setSvgHistoryVersion(v => v + 1);
      paths[pathIndex].remove();
      const newSvg = new XMLSerializer().serializeToString(doc.documentElement);

      const newPreview: LogoRebuildPreview = {
        ...preview,
        svg: newSvg,
        complexity: {
          ...preview.complexity,
          path_count: Math.max(0, preview.complexity.path_count - 1),
          removed_redundant_paths: preview.complexity.removed_redundant_paths + 1,
        },
      };
      setPreview(newPreview);
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      const blob = new Blob([newSvg], { type: 'image/svg+xml' });
      const nextUrl = URL.createObjectURL(blob);
      previewUrlRef.current = nextUrl;
      setPreviewUrl(nextUrl);
      markDirty();
      setStatus(tv('Đã xóa 1 mảng rác khỏi vector. Bấm Hoàn tác nếu muốn phục hồi.'));
    } catch {
      setError(tv('Không thể xóa mảng vector đã chọn.'));
    }
  }, [preview, markDirty]);

  const undoDeletePath = useCallback(() => {
    const previousSvg = pastSvgRef.current.pop();
    if (!previousSvg || !preview) return;
    setSvgHistoryVersion(v => v + 1);
    const doc = new DOMParser().parseFromString(previousSvg, 'image/svg+xml');
    const pathCount = doc.querySelectorAll('path').length;
    const restoredPreview: LogoRebuildPreview = {
      ...preview,
      svg: previousSvg,
      complexity: {
        ...preview.complexity,
        path_count: pathCount,
      },
    };
    setPreview(restoredPreview);
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    const blob = new Blob([previousSvg], { type: 'image/svg+xml' });
    const nextUrl = URL.createObjectURL(blob);
    previewUrlRef.current = nextUrl;
    setPreviewUrl(nextUrl);
    markDirty();
    setStatus(tv('Đã phục hồi mảng vector vừa xóa.'));
  }, [preview, markDirty]);

  const applyPrintPreset = useCallback((presetKey: 'typography' | 'flat_badge' | 'lineart' | 'stamp') => {
    if (!file) return;
    const suggestedColors = paletteSuggestions.map(item => item.color.toLowerCase());
    let nextPalette = suggestedColors.length > 0 ? suggestedColors : editorRef.current.palette;
    if (nextPalette.length > 6) nextPalette = nextPalette.slice(0, 6);

    let nextEditor: EditorState;
    if (presetKey === 'typography') {
      nextEditor = {
        ...editorRef.current,
        mode: 'fixed_palette',
        palette: nextPalette,
        paletteConfirmed: true,
        smoothing: 0,
        despeckle: 0,
        curvePreset: 'automatic',
      };
      setStatus(tv('Đã áp dụng Preset Logo Chữ: bảo vệ dấu tiếng Việt, ưu tiên cạnh thẳng.'));
    } else if (presetKey === 'flat_badge') {
      nextEditor = {
        ...editorRef.current,
        mode: 'fixed_palette',
        palette: nextPalette,
        paletteConfirmed: true,
        smoothing: 1,
        despeckle: 4,
        curvePreset: 'trajectory_completion',
      };
      setStatus(tv('Đã áp dụng Preset Biểu tượng: tối ưu hình tròn/oval/khối hộp.'));
    } else if (presetKey === 'lineart') {
      nextEditor = {
        ...editorRef.current,
        mode: 'monochrome',
        paletteConfirmed: true,
        smoothing: 0,
        despeckle: 0,
        curvePreset: 'faithful',
      };
      setStatus(tv('Đã áp dụng Preset Chữ ký & Nét mảnh: giữ trọn vẹn nét vẽ mảnh.'));
    } else {
      const bg = '#ffffff';
      const inkPalette = nextPalette.filter(c => c !== bg);
      nextEditor = {
        ...editorRef.current,
        mode: 'fixed_palette',
        palette: inkPalette.length > 0 ? inkPalette : ['#c41230'],
        paletteConfirmed: true,
        removeBackground: true,
        backgroundColor: bg,
        smoothing: 1,
        despeckle: 2,
        curvePreset: 'automatic',
      };
      setStatus(tv('Đã áp dụng Preset Con dấu scan: lọc nền giấy trắng, giữ mực dấu.'));
    }
    editorRef.current = nextEditor;
    setEditor(nextEditor);
    markDirty();
    void runPreview(file, nextEditor);
  }, [file, paletteSuggestions, markDirty]);

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (isOperationLocked) return;
    const droppedFiles = Array.from(event.dataTransfer.files);
    if (droppedFiles.length > 0) {
      addFiles(droppedFiles);
    }
  };

  useEffect(() => {
    if (!isActive || isOperationLocked) return undefined;
    const handleIncomingFiles = (event: Event) => {
      const detail = (event as CustomEvent<FileList | File[] | { tabId?: string; files?: FileList | File[] }>).detail;
      if (detail && typeof detail === 'object' && 'tabId' in detail && detail.tabId && detail.tabId !== tabId) {
        return;
      }
      const incomingList = Array.isArray(detail)
        ? detail
        : detail instanceof FileList
          ? Array.from(detail)
          : Array.isArray(detail?.files)
            ? detail.files
            : detail?.files
              ? Array.from(detail.files)
              : [];
      if (incomingList.length > 0) {
        addFiles(incomingList);
      }
    };
    const eventName = IMAGE_BATCH_DROP_EVENTS.logo_rebuild;
    window.addEventListener(eventName, handleIncomingFiles);
    return () => {
      window.removeEventListener(eventName, handleIncomingFiles);
    };
  }, [addFiles, isActive, isOperationLocked, tabId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isActive) return;
      const target = event.target as HTMLElement | null;
      const isTextInput = target && (
        (target.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'button', 'submit'].includes((target as HTMLInputElement).type.toLowerCase()))
        || target.tagName === 'TEXTAREA'
        || target.isContentEditable
      );
      if (isTextInput) return;

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) {
          redo();
        } else {
          undo();
        }
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isActive, undo, redo]);

  useLayoutEffect(() => {
    if (error && errorRef.current) {
      errorRef.current.focus();
    }
  }, [error]);

  const canUndo = pastRef.current.length > 0;
  const canRedo = futureRef.current.length > 0;
  const canExport = Boolean(
    preview
    && (preview.status === 'ready' || (preview.status === 'review' && reviewAccepted)),
  );

  const engineReady = capabilitiesStatus === 'ready' && Boolean(capabilities?.preview_engine_enabled);
  const selectionError = selectionValidationCode(editor);

  const asideElement = (
    <aside className="order-2 space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 xl:min-h-0 xl:overflow-y-auto xl:overscroll-contain">
      {/* Header thanh bên: Hoàn tác/Làm lại, Trạng thái Engine & Đóng */}
      <div className="flex items-center justify-between gap-2 border-b border-slate-100 pb-2.5 dark:border-zinc-800">
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label={tv('Hoàn tác')}
            title={tv('Hoàn tác (Ctrl+Z)')}
            disabled={!canUndo}
            onClick={undo}
            className="rounded-md border border-slate-200 p-1.5 text-slate-600 hover:bg-slate-100 disabled:opacity-30 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            <Undo2 className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            aria-label={tv('Làm lại')}
            title={tv('Làm lại (Ctrl+Y)')}
            disabled={!canRedo}
            onClick={redo}
            className="rounded-md border border-slate-200 p-1.5 text-slate-600 hover:bg-slate-100 disabled:opacity-30 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            <Redo2 className="h-3.5 w-3.5" />
          </button>
        </div>
        <div role="status" className="text-right text-[11px] font-mono text-slate-400 dark:text-zinc-500 truncate">
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
                className="rounded border border-red-300 px-1.5 py-0.5 font-semibold text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950/30"
              >
                {tv('Thử lại')}
              </button>
            </div>
          )}
        </div>
        {!portalEl && onClose && (
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-slate-200 p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            title={tv('Đóng công cụ')}
            aria-label={tv('Đóng công cụ')}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Dải Thumbnail nhiều Logo (Batch Thumbnails) */}
      {batchItems.length > 0 && (
        <section aria-label={tv('Danh sách ảnh logo')} className="space-y-1.5">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-bold uppercase tracking-wide text-slate-500">
              {tv('Danh sách logo')} ({batchItems.length})
            </h2>
            <span className="text-[10px] text-slate-400">
              {batchItems.filter(i => i.preview && i.preview.status !== 'rejected').length}/{batchItems.length} {tv('đã dựng')}
            </span>
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1.5 scrollbar-thin flex-wrap items-center">
            {batchItems.map((item, index) => (
              <div
                key={item.id}
                role="button"
                tabIndex={0}
                aria-label={`${item.name} (${index + 1}/${batchItems.length})`}
                aria-pressed={selectedId === item.id}
                onClick={() => switchToItem(item.id)}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') switchToItem(item.id); }}
                className={`group relative shrink-0 w-14 h-14 rounded-lg overflow-hidden cursor-pointer border-2 transition-all ${
                  selectedId === item.id
                    ? 'border-violet-500 ring-2 ring-violet-300 dark:ring-violet-700 shadow-xs'
                    : 'border-slate-200 dark:border-zinc-700 hover:border-slate-400'
                }`}
                title={item.name}
              >
                <BatchThumbnailImage
                  item={item}
                  isSelected={selectedId === item.id}
                  currentSourceUrl={sourceUrl}
                />
                <div
                  className={`absolute bottom-0 left-0 right-0 text-center text-[8px] font-bold py-[1px] ${
                    item.preview && item.preview.status !== 'rejected'
                      ? 'bg-emerald-500 text-white'
                      : item.status === 'processing'
                      ? 'bg-amber-500 text-white'
                      : item.status === 'error' || (item.preview && item.preview.status === 'rejected')
                      ? 'bg-red-500 text-white'
                      : 'bg-slate-500/80 text-white'
                  }`}
                >
                  {item.preview && item.preview.status !== 'rejected'
                    ? '✓'
                    : item.status === 'processing'
                    ? '⏳'
                    : item.status === 'error'
                    ? '✗'
                    : '•'}
                </div>
                {batchItems.length > 1 && (
                  <button
                    type="button"
                    onClick={e => {
                      e.stopPropagation();
                      removeBatchItem(item.id);
                    }}
                    className="absolute top-0 right-0 w-4 h-4 bg-red-500 text-white text-[9px] font-bold rounded-bl flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-600"
                    title={tv('Xóa logo này')}
                    aria-label={`${tv('Xóa')} ${item.name}`}
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="shrink-0 w-14 h-14 rounded-lg border-2 border-dashed border-slate-300 dark:border-zinc-600 flex items-center justify-center cursor-pointer hover:bg-slate-50 dark:hover:bg-zinc-800 transition-colors text-slate-400 hover:text-slate-600"
              title={tv('Thêm logo khác')}
              aria-label={tv('Thêm logo khác')}
            >
              <span className="text-xl font-bold leading-none">+</span>
            </button>
          </div>
        </section>
      )}

      {showLimitationsBanner && capabilitiesStatus === 'ready' && capabilities && capabilities.limitations.length > 0 && (
        <section aria-label={tv('Giới hạn hiện tại')} className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          <div className="flex items-start justify-between gap-2">
            <strong>{tv('Phạm vi hiện tại: artwork/logo phẳng')}</strong>
            <button
              type="button"
              onClick={() => setShowLimitationsBanner(false)}
              className="rounded p-0.5 text-amber-700 hover:bg-amber-100 dark:text-amber-300 dark:hover:bg-amber-900/50"
              title={tv('Ẩn')}
              aria-label={tv('Ẩn')}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <ul className="mt-1 list-disc space-y-1 pl-4">
            {capabilities.limitations.map(limitation => <li key={limitation}>{limitation}</li>)}
          </ul>
        </section>
      )}

      {/* Tải ảnh & Chọn file */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-bold uppercase tracking-wide text-slate-500">{tv('Ảnh nguồn')}</h2>
          {file && (
            <span className="text-[11px] text-slate-400">
              {(file.size / 1024).toFixed(1)} KB
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-slate-300 px-3 py-2 text-xs font-semibold hover:border-violet-400 dark:border-zinc-700"
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
          multiple
          accept="image/png,image/jpeg,image/webp"
          onChange={event => {
            if (event.target.files?.length) {
              addFiles(Array.from(event.target.files));
            }
            event.currentTarget.value = '';
          }}
        />
        {file && <p className="truncate text-xs text-slate-500" title={file.name}>{file.name}</p>}

        {/* Preset In Ấn (1-Chạm) */}
        {file && (
          <section className="rounded-lg border border-indigo-200 bg-gradient-to-br from-indigo-50/70 to-violet-50/70 p-3 shadow-xs dark:border-indigo-900/60 dark:from-indigo-950/30 dark:to-violet-950/30">
            <div className="flex items-center justify-between">
              <h2 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-indigo-900 dark:text-indigo-200">
                <Sparkles className="h-3.5 w-3.5 text-indigo-600 dark:text-indigo-400" />
                {tv('Preset In Ấn (1-Chạm)')}
              </h2>
              <span className="text-[10px] font-medium text-indigo-600/80 dark:text-indigo-400/80">Khuyên dùng</span>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-1.5">
              <button
                type="button"
                onClick={() => applyPrintPreset('typography')}
                className="flex flex-col items-start rounded-md border border-indigo-200 bg-white p-2 text-left hover:border-indigo-500 hover:shadow-xs dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-indigo-500"
              >
                <span className="text-xs font-bold text-slate-800 dark:text-zinc-100">🖋️ Logo Chữ</span>
                <span className="mt-0.5 text-[10px] leading-tight text-slate-500 dark:text-zinc-400">Khóa góc 90°, giữ dấu tiếng Việt</span>
              </button>
              <button
                type="button"
                onClick={() => applyPrintPreset('flat_badge')}
                className="flex flex-col items-start rounded-md border border-indigo-200 bg-white p-2 text-left hover:border-indigo-500 hover:shadow-xs dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-indigo-500"
              >
                <span className="text-xs font-bold text-slate-800 dark:text-zinc-100">🔷 Biểu Tượng</span>
                <span className="mt-0.5 text-[10px] leading-tight text-slate-500 dark:text-zinc-400">Tròn, elip, hộp & mảng phẳng</span>
              </button>
              <button
                type="button"
                onClick={() => applyPrintPreset('lineart')}
                className="flex flex-col items-start rounded-md border border-indigo-200 bg-white p-2 text-left hover:border-indigo-500 hover:shadow-xs dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-indigo-500"
              >
                <span className="text-xs font-bold text-slate-800 dark:text-zinc-100">✍️ Chữ Ký / Nét</span>
                <span className="mt-0.5 text-[10px] leading-tight text-slate-500 dark:text-zinc-400">Nét vẽ mảnh, chữ ký scan</span>
              </button>
              <button
                type="button"
                onClick={() => applyPrintPreset('stamp')}
                className="flex flex-col items-start rounded-md border border-indigo-200 bg-white p-2 text-left hover:border-indigo-500 hover:shadow-xs dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-indigo-500"
              >
                <span className="text-xs font-bold text-slate-800 dark:text-zinc-100">🔴 Dấu Đỏ Scan</span>
                <span className="mt-0.5 text-[10px] leading-tight text-slate-500 dark:text-zinc-400">Lọc sạch nền giấy trắng</span>
              </button>
            </div>
          </section>
        )}

        <section>
          <h2 className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">{tv('Chế độ')}</h2>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              aria-pressed={mode === 'monochrome'}
              onClick={() => commitEditor('mode', current => ({
                ...current,
                mode: 'monochrome',
                smoothing: 0.5,
                despeckle: 0,
              }))}
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

        {mode === 'fixed_palette' && (
          <section className="space-y-3 rounded-lg border border-slate-200 p-3 dark:border-zinc-700">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500">{tv('Bảng màu')}</h3>
              <button
                type="button"
                disabled={paletteSuggestions.length === 0}
                onClick={() => commitEditor('apply-palette-suggestions', current => ({
                  ...current,
                  palette: paletteSuggestions.map(item => item.color.toLowerCase()),
                  paletteConfirmed: true,
                }))}
                className="rounded border border-violet-300 px-2 py-1 text-[11px] font-semibold text-violet-700 hover:bg-violet-50 disabled:opacity-40 dark:border-violet-700 dark:text-violet-300 dark:hover:bg-violet-950/30"
              >
                {tv('Áp dụng gợi ý')}
              </button>
            </div>
            {isPaletteLoading && <p className="text-xs text-slate-500">{tv('Đang trích xuất màu gợi ý…')}</p>}
            {paletteSuggestions.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {paletteSuggestions.map(item => (
                  <span key={item.color} className="flex items-center gap-1 rounded border border-slate-200 px-2 py-0.5 text-[11px] dark:border-zinc-700">
                    <span className="h-3 w-3 rounded-full border border-black/20" style={{ backgroundColor: item.color }} />
                    {item.color}
                    <button
                      type="button"
                      aria-label={`Đặt làm nền ${item.color}`}
                      onClick={() => applySuggestedBackground(item.color)}
                      className="ml-1 text-[10px] text-violet-600 hover:underline dark:text-violet-400"
                      title={tv('Đặt làm nền')}
                    >
                      {tv('Nền')}
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="space-y-2">
              {palette.map((color, index) => (
                <div key={index} className="flex items-center gap-2">
                  <input
                    aria-label={`${tv('Bộ chọn màu')} ${index + 1}`}
                    type="color"
                    value={/^#[0-9a-f]{6}$/i.test(color) ? color : '#000000'}
                    onChange={event => {
                      const next = [...palette];
                      next[index] = event.target.value.toLowerCase();
                      commitEditor(`palette-${index}`, current => ({ ...current, palette: next, paletteConfirmed: true }));
                    }}
                    className="h-7 w-8 cursor-pointer rounded border border-slate-200 bg-transparent p-0 dark:border-zinc-700"
                  />
                  <input
                    aria-label={`${tv('Mã màu')} ${index + 1}`}
                    type="text"
                    value={color}
                    onChange={event => {
                      const next = [...palette];
                      next[index] = event.target.value;
                      commitEditor(`palette-text-${index}`, current => ({ ...current, palette: next, paletteConfirmed: true }));
                    }}
                    className="flex-1 rounded border border-slate-200 bg-transparent px-2 py-1 font-mono text-xs uppercase dark:border-zinc-700"
                  />
                  <button
                    type="button"
                    aria-label={`${tv('Xóa màu')} ${index + 1}`}
                    onClick={() => {
                      const next = palette.filter((_, itemIndex) => itemIndex !== index);
                      commitEditor(`palette-remove-${index}`, current => ({ ...current, palette: next, paletteConfirmed: next.length > 0 }));
                    }}
                    className="rounded border border-slate-200 p-1 text-slate-500 hover:text-red-600 dark:border-zinc-700"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => {
                  const fallback = paletteSuggestions.find(item => !palette.includes(item.color.toLowerCase()))?.color ?? '#111827';
                  commitEditor('palette-add', current => ({
                    ...current,
                    palette: [...current.palette, fallback.toLowerCase()],
                    paletteConfirmed: true,
                  }));
                }}
                className="flex items-center gap-1 rounded border border-slate-200 px-2 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                <Plus className="h-3.5 w-3.5" /> {tv('Thêm màu')}
              </button>
            </div>
            <label className="flex items-center gap-2 text-xs font-semibold">
              <input
                type="checkbox"
                aria-label={tv('Loại màu nền khỏi SVG')}
                checked={removeBackground}
                onChange={event => commitEditor('remove-background', current => ({ ...current, removeBackground: event.target.checked }))}
              />
              {tv('Loại màu nền khỏi SVG')}
            </label>
            {removeBackground && (
              <div className="flex items-center gap-2 pl-5">
                <span className="text-xs text-slate-500">{tv('Màu nền')}:</span>
                <input
                  aria-label={tv('Bộ chọn màu nền')}
                  type="color"
                  value={/^#[0-9a-f]{6}$/i.test(backgroundColor) ? backgroundColor : '#ffffff'}
                  onChange={event => commitEditor('background-color', current => ({ ...current, backgroundColor: event.target.value.toLowerCase() }))}
                  className="h-6 w-7 cursor-pointer rounded border border-slate-200 bg-transparent p-0 dark:border-zinc-700"
                />
                <input
                  aria-label={tv('Mã màu nền')}
                  type="text"
                  value={backgroundColor}
                  onChange={event => commitEditor('background-color-text', current => ({ ...current, backgroundColor: event.target.value }))}
                  className="w-24 rounded border border-slate-200 bg-transparent px-2 py-1 font-mono text-xs uppercase dark:border-zinc-700"
                />
              </div>
            )}
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
                    aria-label={key === 'x' ? 'X %' : key === 'y' ? 'Y %' : key === 'width' ? tv('Rộng %') : tv('Cao %')}
                    type="number"
                    min={0}
                    max={100}
                    value={crop[key]}
                    onChange={event => commitEditor(`crop-${key}`, current => ({ ...current, crop: { ...current.crop, [key]: clampPercent(Number(event.target.value), 0, 100) } }))}
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
          <p className="mt-1 text-[11px] text-slate-500 dark:text-zinc-400">
            {physicalWidthMm !== null && physicalHeightMm !== null
              ? `${tv('Kích thước đã xác nhận')}: ${physicalWidthMm} × ${physicalHeightMm} mm`
              : tv('Chưa xác nhận mm; SVG sẽ ở trạng thái cần kiểm tra.')}
          </p>
          {dpiSuggestedSize && (
            <p className="mt-1 text-[10px] text-amber-700 dark:text-amber-300">
              {tv('DPI nguồn chỉ là gợi ý; hãy đối chiếu kích thước in thực tế.')}
            </p>
          )}
        </section>

        <section className="space-y-3 rounded-lg border border-slate-200 p-3 dark:border-zinc-700">
          <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500">{tv('Đường nét & Tối ưu')}</h3>
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

        {/* Thông số kỹ thuật chi tiết (thu gọn mặc định để ưu tiên không gian cho view) */}
        {preview && (
          <details className="mt-2 rounded-lg border border-slate-200 p-2 text-xs text-slate-500 dark:border-zinc-800 dark:text-zinc-400">
            <summary className="cursor-pointer text-[11px] font-semibold text-slate-600 hover:text-slate-900 dark:text-zinc-400 dark:hover:text-zinc-200">
              {tv('Thông số kỹ thuật chi tiết')}
            </summary>
            <div className="mt-2 space-y-1.5 border-t border-slate-100 pt-2 dark:border-zinc-800">
              <p>{preview.width_px}×{preview.height_px} px · {preview.engine} {preview.engine_version}</p>
              {preview.result_schema_version !== null && (
                <p className="font-semibold text-violet-700 dark:text-violet-300">
                  {tv('Schema kết quả')}: {preview.result_schema_version}
                </p>
              )}
              {typeof preview.physical_width_mm === 'number' && typeof preview.physical_height_mm === 'number' && (
                <p className="font-semibold text-emerald-700 dark:text-emerald-300">
                  {tv('Kích thước in')}: {preview.physical_width_mm} × {preview.physical_height_mm} mm
                </p>
              )}
              <p>
                {tv('Độ phức tạp SVG')}: {preview.complexity.path_count} path · {preview.complexity.node_count} node · {preview.complexity.removed_redundant_paths} {tv('mảng dư đã dọn')}
              </p>
              {preview.native_metrics && (
                <section aria-label={tv('Độ sạch đường cong')} className="mt-2 grid gap-1 rounded-lg bg-slate-50 px-2.5 py-2 dark:bg-zinc-950/50">
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
                  <details className="mt-1">
                    <summary className="cursor-pointer font-semibold">{tv('Độ khớp raster')}</summary>
                    <p className="mt-1"><strong>IoU</strong>: {preview.native_metrics.iou.toFixed(4)} · <strong>MAE</strong>: {preview.native_metrics.mae.toFixed(4)} · {preview.native_metrics.raster_scale}×</p>
                    <p>{tv('Lớp / thành phần')}: {preview.native_metrics.layer_count} / {preview.native_metrics.component_count}</p>
                  </details>
                </section>
              )}
              {preview.artifact_sha256 && (
                <p className="font-mono text-[11px]">
                  {tv('Hash artifact')}: <span title={preview.artifact_sha256}>{preview.artifact_sha256.slice(0, 12)}…</span>
                </p>
              )}
              {preview.preprocess_hash && (
                <p className="font-mono text-[11px]">
                  {tv('Hash tiền xử lý')}: <span title={preview.preprocess_hash}>{preview.preprocess_hash.slice(0, 12)}…</span>
                </p>
              )}
              {preview.status !== 'ready' && (
                <div className={`mt-2 rounded-lg px-2.5 py-2 ${preview.status === 'rejected' ? 'bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-300' : 'bg-amber-50 text-amber-800 dark:bg-amber-950/30 dark:text-amber-200'}`}>
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
          </details>
        )}
      </section>
    </aside>
  );

  return (
    <div
      ref={workspaceRef}
      tabIndex={-1}
      data-testid="logo-rebuild-workspace"
      onDrop={handleDrop}
      onDragOver={event => event.preventDefault()}
      className={`h-full min-h-0 w-full min-w-0 bg-slate-100 text-slate-800 outline-none dark:bg-zinc-950 dark:text-zinc-100 ${portalEl ? 'overflow-hidden' : 'overflow-auto xl:overflow-hidden'}`}
    >
      <div className={`grid h-full min-h-0 w-full min-w-0 ${portalEl ? 'grid-cols-1 p-0' : 'gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_380px]'}`}>
        {asideElement}

        {/* Khung nhìn chính: chiếm trọn 100% không gian màn hình, tích hợp các nút xuất file trên thanh công cụ */}
        <main className="order-1 grid min-w-0 flex-1 h-full min-h-0 xl:grid-rows-[minmax(0,1fr)_auto] xl:overflow-y-auto xl:overscroll-contain">
          <LogoCompareViewport
            key={sourceUrl || 'empty'}
            className="h-full flex-1 min-h-0 w-full rounded-xl border border-slate-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
            selectionMode={selectionMode}
            crop={crop}
            perspective={perspective}
            onCropChange={nextCrop => commitEditor('crop-overlay', current => ({ ...current, crop: nextCrop }))}
            onPerspectiveChange={nextPoints => commitEditor('perspective-overlay', current => ({ ...current, perspective: nextPoints }))}
            sourceUrl={sourceUrl}
            previewSvg={preview?.svg ?? null}
            previewUrl={previewUrl}
            onDeletePath={deleteSvgPath}
            onUndoDeletePath={undoDeletePath}
            canUndoDeletePath={pastSvgRef.current.length > 0}
            onPickFile={() => fileInputRef.current?.click()}
            actions={
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={!canExport || isSaving}
                  onClick={() => void exportSvg()}
                  className="flex items-center gap-1 rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-bold text-white hover:bg-emerald-700 disabled:opacity-40"
                  title={tv('Tải file SVG vector về máy')}
                >
                  {isSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />} {tv('Tải SVG')}
                </button>
                <button
                  type="button"
                  disabled={!canExport}
                  onClick={sendToImposition}
                  className="flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-40 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
                  title={tv('Đưa logo vector này sang tab Bình bản để xếp trang in')}
                >
                  <LayoutGrid className="h-3.5 w-3.5 text-violet-600 dark:text-violet-400" />
                  {tv('Đưa vào Bình bản')}
                </button>
                <button
                  type="button"
                  disabled={!canExport}
                  onClick={sendToDiecut}
                  className="flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-40 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
                  title={tv('Chuyển logo sang tab Tem bế để tạo đường viền cắt sticker')}
                >
                  <Scissors className="h-3.5 w-3.5 text-pink-600 dark:text-pink-400" />
                  {tv('Tạo Tem bế')}
                </button>
              </div>
            }
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
              emptyTitle: tv('Vector hóa Logo'),
              emptyHint: tv('Kéo thả ảnh logo vào đây hoặc bấm để chọn'),
              emptyFormat: tv('Hỗ trợ PNG, JPEG, WebP (tối đa 500MB)'),
            }}
          />
        </main>
      </div>
    </div>
  );
}
