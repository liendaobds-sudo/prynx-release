import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, ImagePlus, Loader2, OctagonX, Plus, Redo2, Trash2, Undo2, WandSparkles } from 'lucide-react';

import { tv } from '../../i18n';
import {
  cancelLogoRebuildPreview,
  createLogoRebuildPreview,
  getLogoRebuildCapabilities,
  type LogoRebuildCapabilities,
  type LogoRebuildMode,
  type LogoRebuildPreview,
  type LogoRebuildSettings,
  type NormalizedPoint,
} from '../../lib/logoRebuildApi';
import { saveBlob } from '../../lib/saveBlob';

type SelectionMode = 'full' | 'crop' | 'perspective';

interface LogoRebuildWorkspaceProps {
  isActive?: boolean;
}

interface EditorState {
  mode: LogoRebuildMode;
  palette: string[];
  removeBackground: boolean;
  backgroundColor: string;
  selectionMode: SelectionMode;
  crop: { x: number; y: number; width: number; height: number };
  perspective: NormalizedPoint[];
  smoothing: number;
  despeckle: number;
  illumination: boolean;
}

const DEFAULT_PALETTE = ['#000000', '#ffffff'];
const DEFAULT_PERSPECTIVE: NormalizedPoint[] = [
  { x: 0.05, y: 0.05 },
  { x: 0.95, y: 0.05 },
  { x: 0.95, y: 0.95 },
  { x: 0.05, y: 0.95 },
];
const MAX_HISTORY_STEPS = 60;
const HISTORY_COALESCE_MS = 500;
const INITIAL_EDITOR_STATE: EditorState = {
  mode: 'monochrome',
  palette: DEFAULT_PALETTE,
  removeBackground: false,
  backgroundColor: '#ffffff',
  selectionMode: 'full',
  crop: { x: 0, y: 0, width: 100, height: 100 },
  perspective: DEFAULT_PERSPECTIVE,
  smoothing: 0.5,
  despeckle: 4,
  illumination: false,
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

export default function LogoRebuildWorkspace({ isActive = true }: LogoRebuildWorkspaceProps) {
  const [capabilities, setCapabilities] = useState<LogoRebuildCapabilities | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [sourceUrl, setSourceUrl] = useState('');
  const [editor, setEditor] = useState<EditorState>(() => cloneEditorState(INITIAL_EDITOR_STATE));
  const [preview, setPreview] = useState<LogoRebuildPreview | null>(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [, setHistoryVersion] = useState(0);
  const activeJobRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const cancelledJobRef = useRef<string | null>(null);
  const previewUrlRef = useRef('');
  const revisionRef = useRef(0);
  const editorRef = useRef(editor);
  const pastRef = useRef<EditorState[]>([]);
  const futureRef = useRef<EditorState[]>([]);
  const lastCommitRef = useRef<{ key: string; at: number } | null>(null);

  const {
    mode,
    palette,
    removeBackground,
    backgroundColor,
    selectionMode,
    crop,
    perspective,
    smoothing,
    despeckle,
    illumination,
  } = editor;

  const clearPreview = useCallback(() => {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = '';
    }
    setPreviewUrl('');
    setPreview(null);
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
    const next = typeof update === 'function' ? update(current) : update;
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
    refreshHistoryButtons();
    invalidatePreview();
  }, [invalidatePreview, refreshHistoryButtons]);

  const undo = useCallback(() => {
    const previous = pastRef.current.pop();
    if (!previous) return;
    futureRef.current.unshift(cloneEditorState(editorRef.current));
    editorRef.current = previous;
    setEditor(previous);
    lastCommitRef.current = null;
    refreshHistoryButtons();
    invalidatePreview();
  }, [invalidatePreview, refreshHistoryButtons]);

  const redo = useCallback(() => {
    const next = futureRef.current.shift();
    if (!next) return;
    pastRef.current.push(cloneEditorState(editorRef.current));
    editorRef.current = next;
    setEditor(next);
    lastCommitRef.current = null;
    refreshHistoryButtons();
    invalidatePreview();
  }, [invalidatePreview, refreshHistoryButtons]);

  useEffect(() => {
    let disposed = false;
    void getLogoRebuildCapabilities()
      .then(result => { if (!disposed) setCapabilities(result); })
      .catch(reason => { if (!disposed) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { disposed = true; };
  }, []);

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
  const uniquePalette = useMemo(
    () => [...new Set(palette.map(color => color.toLowerCase()))],
    [palette],
  );

  const replacePreview = (result: LogoRebuildPreview) => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    const url = URL.createObjectURL(new Blob([result.svg], { type: 'image/svg+xml' }));
    previewUrlRef.current = url;
    setPreviewUrl(url);
    setPreview(result);
  };

  const selectFile = (selected?: File | null) => {
    if (!selected) return;
    if (!/\.(png|jpe?g|webp)$/i.test(selected.name)) {
      setError(tv('Chỉ hỗ trợ ảnh PNG, JPEG hoặc WebP.'));
      return;
    }
    invalidatePreview();
    resetHistory();
    setFile(selected);
    setError('');
    setStatus('');
  };

  const buildSettings = (): LogoRebuildSettings => {
    const settings: LogoRebuildSettings = {
      mode,
      palette: mode === 'fixed_palette' ? uniquePalette : [],
      ...(mode === 'fixed_palette' && removeBackground ? { background_color: backgroundColor.toLowerCase() } : {}),
      smoothing,
      despeckle_size_px: despeckle,
      illumination_correction: illumination,
    };
    if (selectionMode === 'crop') {
      settings.crop = {
        x: crop.x / 100,
        y: crop.y / 100,
        width: crop.width / 100,
        height: crop.height / 100,
      };
    } else if (selectionMode === 'perspective') {
      settings.perspective_points = perspective;
    }
    return settings;
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
    setStatus(tv('Đang tiền xử lý và dựng đường vector…'));
    try {
      const result = await createLogoRebuildPreview(file, buildSettings(), jobId, controller.signal);
      if (
        activeJobRef.current === jobId
        && revisionRef.current === requestRevision
        && cancelledJobRef.current !== jobId
        && !controller.signal.aborted
      ) {
        replacePreview(result);
        setStatus(tv('Preview đã sẵn sàng. Hãy phóng to và kiểm tra chữ, nét nhỏ trước khi in.'));
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

  const exportSvg = async () => {
    if (!preview || !file) return;
    setIsSaving(true);
    setError('');
    try {
      const result = await saveBlob(
        new Blob([preview.svg], { type: 'image/svg+xml;charset=utf-8' }),
        `${file.name.replace(/\.[^.]+$/, '')}_vector.svg`,
        { title: tv('Lưu file SVG'), filterName: 'SVG', extensions: ['svg'] },
      );
      if (result.kind === 'saved') setStatus(tv('Đã lưu file SVG.'));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : tv('Không thể lưu file SVG.'));
    } finally {
      setIsSaving(false);
    }
  };

  const updatePerspective = (index: number, axis: 'x' | 'y', percent: number) => {
    commitEditor(`perspective-${index}-${axis}`, current => ({
      ...current,
      perspective: current.perspective.map((point, pointIndex) => (
        pointIndex === index ? { ...point, [axis]: clampPercent(percent) / 100 } : point
      )),
    }));
  };

  const canUndo = pastRef.current.length > 0;
  const canRedo = futureRef.current.length > 0;

  return (
    <div tabIndex={-1} className="h-full w-full overflow-auto bg-slate-100 p-4 text-slate-800 outline-none dark:bg-zinc-950 dark:text-zinc-100">
      <div className="mx-auto flex min-h-full max-w-[1500px] flex-col gap-4">
        <header className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <div>
            <h1 className="flex items-center gap-2 text-lg font-bold">
              <WandSparkles className="h-5 w-5 text-violet-600" />
              {tv('Phục hồi & Vector hóa Logo')}
            </h1>
            <p className="mt-1 text-xs text-slate-500 dark:text-zinc-400">
              {tv('MVP chỉ hỗ trợ logo đen trắng hoặc bảng màu do bạn xác nhận; không tự đoán màu thương hiệu.')}
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
            <div className="text-right text-xs text-slate-500 dark:text-zinc-400">
              {capabilities === null
                ? tv('Đang kiểm tra engine…')
                : engineReady
                  ? `${capabilities.engine?.engine ?? 'VTracer'} ${capabilities.engine?.version ?? ''}`
                  : tv('Engine preview chưa sẵn sàng')}
            </div>
          </div>
        </header>

        <div className="grid flex-1 gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
          <aside className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            <label className="flex cursor-pointer items-center justify-center gap-2 rounded-lg border-2 border-dashed border-violet-300 px-4 py-3 text-sm font-semibold text-violet-700 hover:bg-violet-50 dark:border-violet-800 dark:text-violet-300 dark:hover:bg-violet-950/30">
              <ImagePlus className="h-4 w-4" />
              {file ? tv('Chọn ảnh khác') : tv('Chọn ảnh có logo')}
              <input
                aria-label={tv('Chọn ảnh có logo')}
                className="hidden"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={event => selectFile(event.target.files?.[0])}
              />
            </label>
            {file && <p className="truncate text-xs text-slate-500" title={file.name}>{file.name}</p>}

            <section>
              <h2 className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">{tv('Chế độ')}</h2>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  aria-pressed={mode === 'monochrome'}
                  onClick={() => commitEditor('mode', current => ({ ...current, mode: 'monochrome', smoothing: 0.5 }))}
                  className={`rounded-lg border px-3 py-2 text-xs font-semibold ${mode === 'monochrome' ? 'border-violet-500 bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-200' : 'border-slate-200 dark:border-zinc-700'}`}
                >
                  {tv('Đen trắng')}
                </button>
                <button
                  type="button"
                  aria-pressed={mode === 'fixed_palette'}
                  onClick={() => commitEditor('mode', current => ({ ...current, mode: 'fixed_palette', smoothing: 1 }))}
                  className={`rounded-lg border px-3 py-2 text-xs font-semibold ${mode === 'fixed_palette' ? 'border-violet-500 bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-200' : 'border-slate-200 dark:border-zinc-700'}`}
                >
                  {tv('Màu đã xác nhận')}
                </button>
              </div>
            </section>

            {mode === 'fixed_palette' && (
              <section>
                <div className="mb-2 flex items-center justify-between">
                  <h2 className="text-xs font-bold uppercase tracking-wide text-slate-500">{tv('Bảng màu in')}</h2>
                  <button
                    type="button"
                    disabled={palette.length >= 12}
                    onClick={() => commitEditor('palette-add', current => ({ ...current, palette: [...current.palette, '#808080'] }))}
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
                        onChange={event => commitEditor(`palette-${index}`, current => ({ ...current, palette: current.palette.map((item, itemIndex) => itemIndex === index ? event.target.value : item) }))}
                        className="h-8 w-11 cursor-pointer rounded border border-slate-200 bg-transparent"
                      />
                      <input
                        aria-label={`${tv('Mã màu')} ${index + 1}`}
                        value={color}
                        maxLength={7}
                        spellCheck={false}
                        onChange={event => commitEditor(`palette-${index}`, current => ({ ...current, palette: current.palette.map((item, itemIndex) => itemIndex === index ? event.target.value.toLowerCase() : item) }))}
                        className="min-w-0 flex-1 rounded border border-slate-200 bg-transparent px-2 py-1.5 font-mono text-xs uppercase dark:border-zinc-700"
                      />
                      <button
                        type="button"
                        aria-label={`${tv('Xóa màu')} ${index + 1}`}
                        disabled={palette.length <= 1}
                        onClick={() => commitEditor('palette-remove', current => ({ ...current, palette: current.palette.filter((_, itemIndex) => itemIndex !== index) }))}
                        className="rounded p-1 text-slate-400 hover:text-red-600 disabled:opacity-30"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
                </div>
                <div className="mt-3 border-t border-slate-200 pt-3 dark:border-zinc-700">
                  <label className="flex items-center gap-2 text-xs font-semibold">
                    <input type="checkbox" checked={removeBackground} onChange={event => commitEditor('remove-background', current => ({ ...current, removeBackground: event.target.checked }))} />
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
            </section>

            <section className="space-y-3">
              <label className="block text-xs font-semibold">
                {tv('Độ mượt')}: {smoothing.toFixed(1)}
                <input aria-label={tv('Độ mượt')} type="range" min={0} max={1} step={0.1} value={smoothing} onChange={event => commitEditor('smoothing', current => ({ ...current, smoothing: Number(event.target.value) }))} className="mt-1 w-full" />
              </label>
              <label className="block text-xs font-semibold">
                {tv('Khử hạt nhỏ (px)')}
                <input aria-label={tv('Khử hạt nhỏ')} type="number" min={0} max={128} value={despeckle} onChange={event => commitEditor('despeckle', current => ({ ...current, despeckle: clampPercent(Number(event.target.value), 0, 128) }))} className="mt-1 w-full rounded border border-slate-200 bg-transparent px-2 py-1.5 dark:border-zinc-700" />
              </label>
              <label className="flex items-center gap-2 text-xs font-semibold">
                <input type="checkbox" checked={illumination} onChange={event => commitEditor('illumination', current => ({ ...current, illumination: event.target.checked }))} />
                {tv('Cân bằng ánh sáng trên vải/ảnh chụp')}
              </label>
            </section>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void runPreview()}
                disabled={isRunning || !file || !engineReady}
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
            {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/30 dark:text-red-300">{error}</p>}
            {status && <p className="text-xs text-slate-500 dark:text-zinc-400">{status}</p>}
          </aside>

          <main className="grid min-h-[620px] gap-4 lg:grid-cols-2">
            <figure className="flex min-h-[420px] flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
              <figcaption className="border-b border-slate-200 px-4 py-3 text-xs font-bold uppercase tracking-wide text-slate-500 dark:border-zinc-800">{tv('Ảnh nguồn')}</figcaption>
              <div className="flex flex-1 items-center justify-center overflow-hidden bg-[linear-gradient(45deg,#eee_25%,transparent_25%),linear-gradient(-45deg,#eee_25%,transparent_25%),linear-gradient(45deg,transparent_75%,#eee_75%),linear-gradient(-45deg,transparent_75%,#eee_75%)] bg-[length:20px_20px] bg-[position:0_0,0_10px,10px_-10px,-10px_0px] p-4 dark:bg-zinc-950">
                {sourceUrl ? <img src={sourceUrl} alt={tv('Ảnh logo nguồn')} className="max-h-full max-w-full object-contain" /> : <p className="text-sm text-slate-400">{tv('Chưa chọn ảnh')}</p>}
              </div>
            </figure>

            <figure className="flex min-h-[420px] flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
              <figcaption className="flex items-center justify-between border-b border-slate-200 px-4 py-3 text-xs font-bold uppercase tracking-wide text-slate-500 dark:border-zinc-800">
                <span>{tv('Kết quả vector')}</span>
                <button type="button" disabled={!preview || isSaving} onClick={() => void exportSvg()} className="flex items-center gap-1 rounded-md bg-emerald-600 px-2.5 py-1.5 text-[11px] font-bold normal-case text-white disabled:opacity-40">
                  {isSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />} {tv('Tải SVG')}
                </button>
              </figcaption>
              <div className="flex flex-1 items-center justify-center overflow-hidden bg-[linear-gradient(45deg,#eee_25%,transparent_25%),linear-gradient(-45deg,#eee_25%,transparent_25%),linear-gradient(45deg,transparent_75%,#eee_75%),linear-gradient(-45deg,transparent_75%,#eee_75%)] bg-[length:20px_20px] bg-[position:0_0,0_10px,10px_-10px,-10px_0px] p-4 dark:bg-zinc-950">
                {previewUrl
                  ? <img src={previewUrl} alt={tv('SVG vector đã dựng')} className="max-h-full max-w-full object-contain" />
                  : <p className="text-sm text-slate-400">{tv('Chưa có preview')}</p>}
              </div>
              {preview && (
                <div className="border-t border-slate-200 px-4 py-3 text-xs text-slate-500 dark:border-zinc-800 dark:text-zinc-400">
                  <p>{preview.width_px}×{preview.height_px} px · {preview.engine} {preview.engine_version}</p>
                  {preview.warnings.map((warning, index) => <p key={index} className="mt-1 text-amber-700 dark:text-amber-300">⚠ {warning}</p>)}
                </div>
              )}
            </figure>
          </main>
        </div>
      </div>
    </div>
  );
}
