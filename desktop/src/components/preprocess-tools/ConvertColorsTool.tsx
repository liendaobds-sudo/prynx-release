import { useState, useEffect, useCallback, useRef } from 'react';
import { HelpCircle } from 'lucide-react';
import { authenticatedFetch, getApiUrl, uploadPDF } from '../../lib/api';
import { useWorkingPdf } from '../../hooks/useWorkingPdf';
import { recipeRecorder, type RecipeOperationTicket } from '../../lib/recipe/RecipeRecorder';
import ToolHelpModal from '../ToolHelpModal';
import type { ToolHelp } from '../../lib/toolHelp';
import { useTranslation } from 'react-i18next';
import {
  useWorkspaceStore,
  workspaceDocumentIdentity,
  type OutputPreviewRenderingIntent,
} from '../../stores/useWorkspaceStore';

interface Props {
  tabId?: string;
  pdfFile: File | null;
  onFileFixed?: (
    blob: Blob,
    name: string,
    path?: string,
    recipeTicket?: RecipeOperationTicket | null,
  ) => void | Promise<void>;
}

interface IccProfile {
  id: string;
  name: string;
  description: string;
  available: boolean;
}

type ColorAdjustmentStage = 'post_cmyk' | 'pre_icc';

type ColorGamutMapping = 'icc' | 'adaptive_vivid';

type ColorPreviewPreset = 'manual' | 'balanced-v1';

interface ColorAdjustments {
  brightness_lstar: number;
  contrast_percent: number;
  vibrance_percent: number;
  adjustment_stage: ColorAdjustmentStage;
}

interface ColorTransformOptions extends ColorAdjustments {
  conversions: string[];
  icc_profile: string;
  rendering_intent: OutputPreviewRenderingIntent;
  preserve_black: boolean;
  black_point_compensation: boolean;
  gamut_mapping: ColorGamutMapping;
}

interface ColorPreviewResponse {
  success: true;
  request_id: string;
  page: number;
  requested_dpi: number;
  effective_dpi: number;
  effective_adjustments: ColorAdjustments;
  effective_options: {
    gamut_mapping: ColorGamutMapping;
  };
  preview: {
    source_b64: string;
    output_b64: string;
    gamut_b64: string | null;
    mime: string;
    width: number;
    height: number;
    proof_accuracy: string;
    proof_engine: string;
    measurement_basis: string;
  };
  metrics: {
    sample_pixels: number;
    delta_lstar_mean: number;
    delta_chroma_mean: number;
    delta_e00_mean: number;
    delta_e00_p95: number;
    new_highlight_clip_pct: number;
    new_paper_white_pct: number;
    new_shadow_clip_pct: number;
    neutral_delta_e00_mean: number | null;
    skin_delta_e00_mean: number | null;
    out_of_gamut_pct: number;
    tac: {
      available: boolean;
      mean_pct: number | null;
      p95_pct: number | null;
      max_pct: number | null;
      engine: string;
      spot_excluded: boolean;
      spot_plate_count: number;
    };
  };
  recommendation: {
    policy: string;
    status: 'manual' | 'recommended' | 'identity' | 'unavailable';
    gates_passed: boolean;
    reason_codes: string[];
  };
  warnings: string[];
}

interface PreviewSettings extends ColorAdjustments {
  file_identity: string;
  mode: 'cmyk' | 'grayscale';
  include_spot: boolean;
  page: number;
  icc_profile: string;
  rendering_intent: OutputPreviewRenderingIntent;
  preserve_black: boolean;
  black_point_compensation: boolean;
  gamut_mapping: ColorGamutMapping;
}

interface ColorPreviewRecord {
  response: ColorPreviewResponse;
  fingerprint: string;
  contextKey: string;
  transformOptions: ColorTransformOptions;
}

interface ActiveColorPreview {
  requestId: string;
  settingsKey: string;
  controller: AbortController;
}

interface ActiveColorExecution {
  requestId: string;
  settingsKey: string;
  controller: AbortController;
  committing: boolean;
}

interface ConvertColorsLogEntry {
  action_id?: string;
  status?: string;
  message?: string;
  duration_ms?: number;
}

interface ConvertColorsRunResponse {
  success?: boolean;
  output_filename?: string | null;
  log?: ConvertColorsLogEntry[];
  error?: string | null;
  detail?: string;
}


function colorTransformOptions(settings: PreviewSettings): ColorTransformOptions {
  return {
    conversions: settings.mode === 'grayscale'
      ? ['gray_to_cmyk']
      : ['rgb_to_cmyk', ...(settings.include_spot ? ['spot_to_cmyk'] : [])],
    icc_profile: settings.icc_profile,
    rendering_intent: settings.rendering_intent,
    preserve_black: settings.preserve_black,
    black_point_compensation: settings.black_point_compensation,
    gamut_mapping: settings.mode === 'cmyk' ? settings.gamut_mapping : 'icc',
    brightness_lstar: settings.brightness_lstar,
    contrast_percent: settings.contrast_percent,
    vibrance_percent: settings.vibrance_percent,
    adjustment_stage: settings.adjustment_stage,
  };
}

function colorTransformOptionsKey(options: ColorTransformOptions): string {
  return JSON.stringify([
    options.conversions,
    options.icc_profile,
    options.rendering_intent,
    options.preserve_black,
    options.black_point_compensation,
    options.gamut_mapping,
    options.adjustment_stage,
    options.brightness_lstar,
    options.contrast_percent,
    options.vibrance_percent,
  ]);
}

function previewContextKey(settings: PreviewSettings): string {
  const options = colorTransformOptions(settings);
  // Context không gồm ba slider để gợi ý cân bằng đã đo vẫn có thể điền vào
  // slider; mọi thay đổi file/trang/profile/intent/Spot đều làm gợi ý hết hạn.
  return JSON.stringify([
    settings.file_identity,
    settings.page,
    options.conversions,
    options.icc_profile,
    options.rendering_intent,
    options.preserve_black,
    options.black_point_compensation,
    options.gamut_mapping,
    options.adjustment_stage,
  ]);
}

function previewSettingsKey(settings: PreviewSettings): string {
  // COLOR (audit 2026-08-22 §COLOR.38): fingerprint lấy đúng contract gửi
  // backend để preview/execute không lệch khi thêm một policy transform mới.
  return JSON.stringify([
    settings.file_identity,
    settings.page,
    colorTransformOptionsKey(colorTransformOptions(settings)),
  ]);
}

function previewFingerprint(fileId: string, settings: PreviewSettings): string {
  return `${fileId}:${previewSettingsKey(settings)}`;
}

function isAbortError(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'name' in error
    && (error as { name?: unknown }).name === 'AbortError';
}

function createAbortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function metric(value: number | null | undefined, digits = 2): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? value.toFixed(digits)
    : '—';
}

const RENDERING_INTENTS: readonly OutputPreviewRenderingIntent[] = [
  'relative',
  'perceptual',
  'saturation',
  'absolute',
];

// PERF (audit 2026-08-22): gộp các lần kéo slider thành một preview; không giới hạn
// độ phân giải hay số worker, nên máy mạnh vẫn dùng full pipeline hiện có.
const REALTIME_PREVIEW_DEBOUNCE_MS = 280;

// COLOR (audit 2026-08-20 §COLOR.08/.09): BPC luôn bật ở cả chuyển đổi và mô phỏng
// để bảo toàn chi tiết vùng tối; profile + intent dùng chung state theo từng tab.
const BLACK_POINT_COMPENSATION = true;

async function responseError(response: Response, fallback: string): Promise<string> {
  try {
    const payload = await response.json();
    const detail = payload?.detail;
    if (typeof detail === 'string' && detail.trim()) return detail;
  } catch {
    // Response lỗi có thể không phải JSON; dùng mã HTTP bên dưới.
  }
  return `${fallback} (HTTP ${response.status})`;
}

const COLOR_HELP: ToolHelp = {
  title: 'Chuyển đổi màu — Hướng dẫn',
  tagline: 'Đưa file về đúng hệ màu để in. Chọn 1 trong 2 chế độ rồi bấm Thực thi.',
  sections: [
    {
      heading: 'Hai chế độ',
      items: [
        'Chuyển sang CMYK: đổi màu RGB sang 4 mực C-M-Y-K để in offset/in 4 màu. Dùng cho hầu hết file gửi nhà in.',
        'Chuyển sang đen trắng: bỏ toàn bộ màu, in một màu đen. Chỉ dùng khi CỐ Ý in trắng đen.',
      ],
    },
    {
      heading: 'Màu pha (Spot / Pantone)',
      items: [
        'Bật "Đổi luôn màu pha → CMYK" nếu muốn gộp Pantone/HKS vào 4 màu (in 4 màu thường).',
        'Tắt nếu cần giữ bản màu pha riêng (in spot).',
      ],
    },
    {
      heading: 'Đã tự tối ưu sẵn',
      items: [
        'Tự giữ chữ & nét đen in 1 màu đen (K) → chống lệch viền khi in offset.',
        'Chọn hồ sơ đúng loại giấy/máy in; Relative + BPC là điểm bắt đầu tốt để giữ sáng và chi tiết vùng tối.',
        'Mặc định đổi sang CMYK trước, sau đó bù sáng/tương phản/độ rực trên bản proof — gần quy trình Photoshop. Chế độ Trước ICC chỉ dành cho trường hợp cần giữ gamut nguồn.',
      ],
    },
  ],
  printNote: 'Chuyển CMYK quan trọng nhất cho IN OFFSET. In nhanh (kỹ thuật số) nhiều máy nhận RGB nên có thể không cần.',
};

// Module-level: định nghĩa trong render body sẽ tạo type mới mỗi render → remount
// (mất focus/animation của subtree). Nhận selected/onSelect qua props để giữ closure.
function ModeCard({ selected, icon, label, desc, onSelect }: {
  selected: boolean; icon: string; label: string; desc: string; onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex w-full items-center justify-center gap-1.5 rounded-md border px-2.5 py-2 text-center transition-colors
        ${selected
          ? 'border-indigo-500 bg-white text-indigo-700 shadow-sm dark:border-indigo-500 dark:bg-zinc-900 dark:text-indigo-300'
          : 'border-transparent text-slate-500 hover:text-slate-700 dark:text-zinc-400 dark:hover:text-zinc-200'}`}
    >
      <span className="shrink-0 text-[9px] font-black tracking-tight">{icon}</span>
      <span className="text-[11px] font-bold">{label}</span>
      {desc && <span className="sr-only">{desc}</span>}
    </button>
  );
}
// Module-level để không remount slider mỗi lần người dùng kéo (giữ focus và
// thao tác bàn phím ổn định trong panel chế bản).
function ColorAdjustmentSlider({
  label,
  description,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  description: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  const displayValue = value > 0 ? `+${value}` : String(value);
  return (
    <label className="block">
      <span className="flex items-center justify-between gap-2 text-[10px] font-semibold text-slate-600 dark:text-zinc-300">
        <span>{label}</span>
        <span className="tabular-nums text-indigo-600 dark:text-indigo-300">{displayValue}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={1}
        value={value}
        aria-label={label}
        onChange={event => onChange(Number(event.target.value))}
        className="mt-1 h-3 w-full cursor-pointer accent-indigo-600"
      />
      <span className="mt-0.5 block text-[9px] leading-snug text-slate-400 dark:text-zinc-500">
        {description}
      </span>
    </label>
  );
}

export default function ConvertColorsTool({ tabId, pdfFile, onFileFixed }: Props) {
  const { t } = useTranslation();
  const [fileId, setFileId] = useState('');
  const [mode, setMode] = useState<'cmyk' | 'grayscale'>('cmyk');
  const [includeSpot, setIncludeSpot] = useState(false);
  const [preserveBlack, setPreserveBlack] = useState(true);
  const [gamutMapping, setGamutMapping] = useState<ColorGamutMapping>('adaptive_vivid');
  const [brightnessLstar, setBrightnessLstar] = useState(0);
  const [contrastPercent, setContrastPercent] = useState(0);
  const [vibrancePercent, setVibrancePercent] = useState(0);
  // COLOR (audit 2026-08-21): thợ in nhanh thường Convert to Profile trước,
  // rồi chỉnh trên bản CMYK/proof như Photoshop. Giữ lane trước ICC cho
  // recipe nâng cao nhưng không dùng làm mặc định UI.
  const [adjustmentStage, setAdjustmentStage] = useState<ColorAdjustmentStage>('post_cmyk');
  const [profiles, setProfiles] = useState<IccProfile[]>([]);
  const [profilesLoading, setProfilesLoading] = useState(true);
  const [profilesLoadFailed, setProfilesLoadFailed] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ConvertColorsRunResponse | null>(null);
  const [error, setError] = useState('');
  const [showHelp, setShowHelp] = useState(false);
  const [previewPage, setPreviewPage] = useState(1);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [previewRecord, setPreviewRecord] = useState<ColorPreviewRecord | null>(null);
  // UIUX (audit 2026-08-22): giữ luồng chính ngắn; thông số kỹ thuật chỉ mở khi cần.
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [technicalOpen, setTechnicalOpen] = useState(false);
  const [vividRequestNonce, setVividRequestNonce] = useState(0);
  const expectedOutputNameRef = useRef<string | null>(null);
  const previewRequestCounterRef = useRef(0);
  const executionRequestCounterRef = useRef(0);
  const activePreviewRef = useRef<ActiveColorPreview | null>(null);
  const realtimePreviewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasStartedPreviewRef = useRef(false);
  const lastAdjustmentKeyRef = useRef('');
  const currentPreviewSettingsRef = useRef<PreviewSettings | null>(null);
  const runPreviewRef = useRef<((preset: ColorPreviewPreset) => Promise<void>) | null>(null);
  const activeExecutionRef = useRef<ActiveColorExecution | null>(null);
  const latestPreviewSettingsKeyRef = useRef('');
  const uploadedDocumentIdentityRef = useRef('');
  const documentIdentityRef = useRef('');
  const pdfFileRef = useRef<File | null>(pdfFile);
  pdfFileRef.current = pdfFile;

  const profileId = useWorkspaceStore(state => state.outputPreviewProfileId);
  const renderingIntent = useWorkspaceStore(state => state.outputPreviewRenderingIntent);
  const viewerActivePage = useWorkspaceStore(state => state.viewerActivePage);
  const viewerPageOrder = useWorkspaceStore(state => state.viewerPageOrder);
  const viewerPageRotations = useWorkspaceStore(state => state.viewerPageRotations);
  const setProfileId = useWorkspaceStore(state => state.setOutputPreviewProfileId);
  const setRenderingIntent = useWorkspaceStore(state => state.setOutputPreviewRenderingIntent);
  const selectedProfile = profiles.find(profile => profile.id === profileId);
  const profileUnavailable = mode === 'cmyk'
    && profiles.length > 0
    && !selectedProfile?.available;
  // COLOR (audit 2026-08-21 §COLOR.34): cache/upload phải mang cả revision
  // Working PDF; reorder/xóa/xoay trang không nhất thiết đổi File prop.
  const documentIdentity = workspaceDocumentIdentity(
    pdfFile,
    viewerPageOrder,
    viewerPageRotations,
  );
  documentIdentityRef.current = documentIdentity;
  const currentPreviewSettings: PreviewSettings = {
    file_identity: documentIdentity,
    mode,
    include_spot: includeSpot,
    page: previewPage,
    icc_profile: profileId,
    rendering_intent: renderingIntent,
    preserve_black: preserveBlack,
    black_point_compensation: BLACK_POINT_COMPENSATION,
    gamut_mapping: gamutMapping,
    brightness_lstar: brightnessLstar,
    contrast_percent: contrastPercent,
    vibrance_percent: vibrancePercent,
    adjustment_stage: adjustmentStage,
  };
  const currentPreviewSettingsKey = previewSettingsKey(currentPreviewSettings);
  const currentPreviewContextKey = previewContextKey(currentPreviewSettings);
  currentPreviewSettingsRef.current = currentPreviewSettings;
  const adjustmentKey = JSON.stringify([brightnessLstar, contrastPercent, vibrancePercent, adjustmentStage]);
  latestPreviewSettingsKeyRef.current = currentPreviewSettingsKey;
  const previewFresh = mode === 'cmyk'
    && !!fileId
    && previewRecord?.fingerprint === previewFingerprint(fileId, currentPreviewSettings);
  const previewResponse = previewRecord?.response ?? null;
  const recommendationContextFresh = !!previewRecord
    && previewRecord.contextKey === currentPreviewContextKey;
  const recommendationCanApply = !!previewResponse
    && recommendationContextFresh
    && previewResponse.recommendation.policy === 'balanced-v1'
    && previewResponse.recommendation.gates_passed
    && previewResponse.preview.proof_accuracy === 'rip_softproof'
    && previewResponse.preview.measurement_basis === 'display_rgb_vs_rip_softproof'
    && previewResponse.metrics.tac.available
    && (
      previewResponse.recommendation.status === 'recommended'
      || previewResponse.recommendation.status === 'identity'
    );

  useEffect(() => {
    let cancelled = false;
    setProfilesLoading(true);
    setProfilesLoadFailed(false);
    void authenticatedFetch(`${getApiUrl()}/preflight/icc-profiles`)
      .then(response => response.ok
        ? response.json()
        : Promise.reject(new Error(String(response.status))))
      .then(data => {
        if (!cancelled) setProfiles(Array.isArray(data.profiles) ? data.profiles : []);
      })
      .catch(() => {
        if (!cancelled) {
          setProfiles([]);
          setProfilesLoadFailed(true);
        }
      })
      .finally(() => {
        if (!cancelled) setProfilesLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    // UIUX (audit 2026-07-28 §PF.1): giữ kết quả khi viewer nhận đúng file vừa xử lý.
    const preserveSuccess = expectedOutputNameRef.current === pdfFile?.name;
    expectedOutputNameRef.current = null;
    if (realtimePreviewTimerRef.current) clearTimeout(realtimePreviewTimerRef.current);
    realtimePreviewTimerRef.current = null;
    hasStartedPreviewRef.current = false;
    lastAdjustmentKeyRef.current = '';

    activePreviewRef.current?.controller.abort();
    activePreviewRef.current = null;
    const activeExecution = activeExecutionRef.current;
    if (activeExecution && !activeExecution.committing) {
      activeExecution.controller.abort();
    }
    uploadedDocumentIdentityRef.current = '';
    setPreviewLoading(false);
    setPreviewRecord(null);
    setPreviewError('');
    setFileId('');
    if (!preserveSuccess) setResult(null);
    setError('');
  }, [pdfFile]);

  useEffect(() => {
    setPreviewPage(viewerActivePage || 1);
  }, [pdfFile, viewerActivePage]);

  useEffect(() => {
    const active = activePreviewRef.current;
    if (active && active.settingsKey !== currentPreviewSettingsKey) {
      active.controller.abort();
      activePreviewRef.current = null;
      setPreviewLoading(false);
    }
    if (realtimePreviewTimerRef.current) {
      clearTimeout(realtimePreviewTimerRef.current);
      realtimePreviewTimerRef.current = null;
    }
    const execution = activeExecutionRef.current;
    if (
      execution
      && !execution.committing
      && execution.settingsKey !== currentPreviewSettingsKey
    ) {
      execution.controller.abort();
    }
  }, [currentPreviewSettingsKey]);

  useEffect(() => () => {
    activePreviewRef.current?.controller.abort();
    activePreviewRef.current = null;
    activeExecutionRef.current?.controller.abort();
  }, []);

  const getWorkingFile = useWorkingPdf();
  const ensureUploaded = useCallback(async (): Promise<string> => {
    const identityAtStart = documentIdentity;
    if (
      fileId
      && uploadedDocumentIdentityRef.current === identityAtStart
    ) return fileId;
    if (!pdfFile) throw new Error(t('preprocess.convertColors:chua_co_file_pdf'));

    const sourceFile = pdfFile;
    const workingFile = (await getWorkingFile(sourceFile)) || sourceFile;
    if (
      pdfFileRef.current !== sourceFile
      || documentIdentityRef.current !== identityAtStart
    ) {
      throw createAbortError('Working PDF changed while materializing');
    }

    const uploaded = await uploadPDF(workingFile);
    if (
      pdfFileRef.current !== sourceFile
      || documentIdentityRef.current !== identityAtStart
    ) {
      throw createAbortError('Working PDF changed while uploading');
    }
    uploadedDocumentIdentityRef.current = identityAtStart;
    setFileId(uploaded.id);
    return uploaded.id;
  }, [documentIdentity, fileId, pdfFile, getWorkingFile, t]);

  const runPreview = async (preset: ColorPreviewPreset) => {
    if (profileUnavailable) {
      setPreviewError(t('preprocess.convertColors:ho_so_mau_khong_kha_dung'));
      return;
    }

    hasStartedPreviewRef.current = true;
    activePreviewRef.current?.controller.abort();
    const controller = new AbortController();
    const requestId = `color-preview-${Date.now()}-${++previewRequestCounterRef.current}`;
    const settingsAtStart = currentPreviewSettings;
    const settingsKeyAtStart = previewSettingsKey(settingsAtStart);
    const transformOptionsAtStart = colorTransformOptions(settingsAtStart);
    activePreviewRef.current = { requestId, settingsKey: settingsKeyAtStart, controller };
    setPreviewLoading(true);
    setPreviewError('');

    try {
      const fid = await ensureUploaded();
      if (
        controller.signal.aborted
        || activePreviewRef.current?.requestId !== requestId
        || latestPreviewSettingsKeyRef.current !== settingsKeyAtStart
      ) return;

      const response = await authenticatedFetch(
        `${getApiUrl()}/preflight/convert-colors/preview`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            request_id: requestId,
            file_id: fid,
            page: settingsAtStart.page,
            preview_policy: preset,
            ...transformOptionsAtStart,
            dpi: 150,
          }),
        },
      );
      const data = await response.json() as ColorPreviewResponse & { detail?: unknown };
      if (!response.ok) {
        throw new Error(
          typeof data.detail === 'string'
            ? data.detail
            : `${t('preprocess.convertColors:xem_truoc_that_bai')} (HTTP ${response.status})`,
        );
      }
      if (
        data.success !== true
        || data.request_id !== requestId
        || data.recommendation?.policy !== preset
        || data.page !== settingsAtStart.page
        || !data.effective_adjustments
        || !data.effective_options
        || (
          data.effective_options.gamut_mapping !== 'icc'
          && data.effective_options.gamut_mapping !== 'adaptive_vivid'
        )
        || !data.preview
        || !data.metrics
        || !data.recommendation
      ) {
        throw new Error(t('preprocess.convertColors:phan_hoi_xem_truoc_khong_hop_le'));
      }
      if (
        controller.signal.aborted
        || activePreviewRef.current?.requestId !== requestId
        || latestPreviewSettingsKeyRef.current !== settingsKeyAtStart
      ) return;

      const previewedTransformOptions: ColorTransformOptions = {
        ...transformOptionsAtStart,
        ...data.effective_adjustments,
        gamut_mapping: data.effective_options.gamut_mapping,
      };
      const previewedSettings: PreviewSettings = {
        ...settingsAtStart,
        ...data.effective_adjustments,
        gamut_mapping: previewedTransformOptions.gamut_mapping,
      };
      setPreviewRecord({
        response: data,
        fingerprint: previewFingerprint(fid, previewedSettings),
        // COLOR (audit 2026-08-22 §COLOR.41): gợi ý có thể trả stage khác
        // slider hiện tại; quyền điền vẫn thuộc context request đã đo, còn
        // fingerprint/execute dùng đúng transform effective của candidate.
        contextKey: previewContextKey(settingsAtStart),
        transformOptions: previewedTransformOptions,
      });
    } catch (previewFailure: unknown) {
      if (!isAbortError(previewFailure) && activePreviewRef.current?.requestId === requestId) {
        setPreviewError(
          previewFailure instanceof Error
            ? previewFailure.message
            : t('preprocess.convertColors:xem_truoc_that_bai'),
        );
      }
    } finally {
      if (activePreviewRef.current?.requestId === requestId) {
        activePreviewRef.current = null;
        setPreviewLoading(false);
      }
    }
  };

  runPreviewRef.current = runPreview;

  // COLOR (audit 2026-08-22 §COLOR.38): adaptive dùng Relative+BPC làm nền;
  // không đánh tráo thuật toán gamut mapping bằng Saturation intent.
  const activateVividPreset = () => {
    setGamutMapping('adaptive_vivid');
    setRenderingIntent('relative');
    setAdjustmentStage('post_cmyk');
    setBrightnessLstar(0);
    setContrastPercent(0);
    setVibrancePercent(0);
    setVividRequestNonce(value => value + 1);
  };

  useEffect(() => {
    if (!vividRequestNonce) return;
    void runPreviewRef.current?.('manual');
  }, [vividRequestNonce]);

  useEffect(() => {
    const previousAdjustmentKey = lastAdjustmentKeyRef.current;
    const adjustmentChanged = previousAdjustmentKey !== adjustmentKey;
    if (!adjustmentChanged) return;

    if (
      mode !== 'cmyk'
      || !hasStartedPreviewRef.current
      || profileUnavailable
      || !fileId
    ) {
      return;
    }

    lastAdjustmentKeyRef.current = adjustmentKey;
    if (realtimePreviewTimerRef.current) clearTimeout(realtimePreviewTimerRef.current);
    const settingsAtRender = currentPreviewSettingsRef.current;
    if (settingsAtRender && previewRecord?.fingerprint === previewFingerprint(fileId, settingsAtRender)) {
      realtimePreviewTimerRef.current = null;
      return;
    }

    realtimePreviewTimerRef.current = setTimeout(() => {
      realtimePreviewTimerRef.current = null;
      void runPreviewRef.current?.('manual');
    }, REALTIME_PREVIEW_DEBOUNCE_MS);

    return () => {
      if (realtimePreviewTimerRef.current) {
        clearTimeout(realtimePreviewTimerRef.current);
        realtimePreviewTimerRef.current = null;
      }
    };
  }, [
    adjustmentKey,
    currentPreviewContextKey,
    fileId,
    mode,
    previewRecord,
    profileUnavailable,
  ]);
  const applySafeRecommendation = () => {
    if (!previewResponse || !recommendationCanApply) return;
    // COLOR (audit 2026-08-21 §COLOR.32): chỉ điền đúng candidate đã preview;
    // không tự chạy conversion, tải file hay commit Working File.
    setBrightnessLstar(previewResponse.effective_adjustments.brightness_lstar);
    setContrastPercent(previewResponse.effective_adjustments.contrast_percent);
    setVibrancePercent(previewResponse.effective_adjustments.vibrance_percent);
    setAdjustmentStage(previewResponse.effective_adjustments.adjustment_stage);
    // Preview recommendation mang chính candidate đã đo. Đồng bộ record với
    // slider vừa điền để nút Thực thi dùng ngay đúng transform đó; lần kéo kế
    // tiếp vẫn đi qua debounce realtime như bình thường.
    setPreviewRecord(current => current && current.response === previewResponse
      ? {
          ...current,
          fingerprint: previewFingerprint(fileId, {
            ...currentPreviewSettings,
            ...previewResponse.effective_adjustments,
          }),
        }
      : current);
  };

  const run = async () => {
    if (profileUnavailable) {
      setError(t('preprocess.convertColors:ho_so_mau_khong_kha_dung'));
      return;
    }
    if (mode === 'cmyk' && (!previewFresh || !previewResponse || !previewRecord)) {
      setError(t('preprocess.convertColors:can_xem_truoc_moi_truoc_khi_thuc_thi'));
      return;
    }
    const executionOptions = mode === 'cmyk'
      ? previewRecord!.transformOptions
      : colorTransformOptions(currentPreviewSettings);
    setRunning(true);
    setResult(null);
    setError('');
    const shouldRecord = !!tabId && recipeRecorder.isRecordingFor(tabId);
    const recipeTicket = shouldRecord
      ? recipeRecorder.noteOperation('convertcolors', { ...executionOptions }, undefined, tabId)
      : null;
    if (shouldRecord && !recipeTicket) {
      setError(t('tabs.imposition:dang_xu_ly_file'));
      setRunning(false);
      return;
    }

    activeExecutionRef.current?.controller.abort();
    const controller = new AbortController();
    const requestId = `color-execute-${Date.now()}-${++executionRequestCounterRef.current}`;
    const settingsKeyAtStart = currentPreviewSettingsKey;
    const sourceFileAtStart = pdfFile;
    activeExecutionRef.current = {
      requestId,
      settingsKey: settingsKeyAtStart,
      controller,
      committing: false,
    };

    const assertExecutionCurrent = () => {
      const active = activeExecutionRef.current;
      if (
        controller.signal.aborted
        || active?.requestId !== requestId
        || active.settingsKey !== settingsKeyAtStart
        || latestPreviewSettingsKeyRef.current !== settingsKeyAtStart
        || pdfFileRef.current !== sourceFileAtStart
      ) {
        throw createAbortError('Color conversion source changed');
      }
    };

    try {
      const fid = await ensureUploaded();
      assertExecutionCurrent();
      const body = {
        file_id: fid,
        ...executionOptions,
      };
      const res = await authenticatedFetch(`${getApiUrl()}/preflight/convert-colors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const data = await res.json() as ConvertColorsRunResponse;
      assertExecutionCurrent();
      if (!res.ok) {
        throw new Error(
          typeof data?.detail === 'string'
            ? data.detail
            : `${t('preprocess.convertColors:that_bai')} (HTTP ${res.status})`,
        );
      }
      if (data.success) {
        if (!data.output_filename) {
          throw new Error(t('preprocess.convertColors:that_bai'));
        }
        if (onFileFixed) {
          const dl = await authenticatedFetch(
            `${getApiUrl()}/preflight/download/${data.output_filename}`,
            { signal: controller.signal },
          );
          if (!dl.ok) {
            throw new Error(await responseError(dl, t('preprocess.convertColors:that_bai')));
          }
          const artifact = await dl.blob();
          assertExecutionCurrent();
          expectedOutputNameRef.current = data.output_filename;
          const active = activeExecutionRef.current;
          if (active?.requestId === requestId) active.committing = true;
          await onFileFixed(artifact, data.output_filename, undefined, recipeTicket);
        } else {
          recipeRecorder.discardPending(recipeTicket);
        }
        // COLOR (audit 2026-08-20 §COLOR.24): chỉ hiện xanh sau khi download
        // và commit Working File đều thành công; response 404/500 cũng có blob
        // nhưng tuyệt đối không được đưa blob lỗi đó vào viewer như PDF.
        setResult(data);
      } else {
        recipeRecorder.discardPending(recipeTicket);
        setError(data.error || data.detail || t('preprocess.convertColors:that_bai'));
      }
    } catch (executionFailure: unknown) {
      expectedOutputNameRef.current = null;
      setResult(null);
      recipeRecorder.discardPending(recipeTicket);
      if (!isAbortError(executionFailure)) {
        setError(
          executionFailure instanceof Error
            ? executionFailure.message
            : t('preprocess.convertColors:that_bai'),
        );
      }
    } finally {
      if (activeExecutionRef.current?.requestId === requestId) {
        activeExecutionRef.current = null;
        setRunning(false);
      }
    }
  };

  if (!pdfFile) return <div className="py-6 text-center text-[11px] text-slate-400">{t('preprocess.convertColors:vui_long_mo_file_pdf_truoc')}</div>;

  return (
    <div className="space-y-2.5 animate-in fade-in duration-200">

      {/* ═══ NÚT HƯỚNG DẪN ═══ */}
      <button
        type="button"
        aria-label={t('preprocess.convertColors:chua_ro_xem_huong_dan_amp_giai_thich')}
        title={t('preprocess.convertColors:chua_ro_xem_huong_dan_amp_giai_thich')}
        onClick={() => setShowHelp(true)}
        className="ml-auto flex h-7 w-7 items-center justify-center rounded-lg border border-slate-200 text-indigo-600 transition-colors hover:bg-indigo-50 dark:border-white/10 dark:text-indigo-400 dark:hover:bg-indigo-500/10"
      >
        <HelpCircle className="h-4 w-4" />
        <span className="sr-only">{t('preprocess.convertColors:chua_ro_xem_huong_dan_amp_giai_thich')}</span>
      </button>
      {showHelp && <ToolHelpModal help={COLOR_HELP} icon="🎨" onClose={() => setShowHelp(false)} />}

      {/* UIUX (audit 2026-08-22 §COLOR.40): selector ngắn, không lặp mô tả
          nghiệp vụ ở cả hai card trước khi người dùng nhìn thấy preview. */}
      <div className="grid grid-cols-2 rounded-lg bg-slate-100 p-1 dark:bg-zinc-800">
        <ModeCard
          selected={mode === 'cmyk'}
          onSelect={() => setMode('cmyk')}
          icon="CMYK"
          label={t('preprocess.convertColors:chuyen_sang_cmyk')}
          desc=""
        />
        <ModeCard
          selected={mode === 'grayscale'}
          onSelect={() => setMode('grayscale')}
          icon="K"
          label={t('preprocess.convertColors:chuyen_sang_den_trang')}
          desc=""
        />
      </div>
      {/* Tùy chọn màu pha — chỉ hiện ở chế độ CMYK */}
      {mode === 'cmyk' && (
        <>
          <div className="space-y-2 rounded-lg border border-slate-200 bg-white p-2.5 dark:border-zinc-700 dark:bg-zinc-900">
            <label className="block">
              <span className="mb-1 block text-[10px] font-semibold text-slate-600 dark:text-zinc-300">
                {t('preprocess.convertColors:ho_so_mau_dich')}
              </span>
              <select
                aria-label={t('preprocess.convertColors:ho_so_mau_dich')}
                value={profileId}
                onChange={event => setProfileId(event.target.value)}
                className="h-8 w-full rounded-lg border border-slate-200 bg-white px-2 text-[12px] text-slate-700 focus:outline-none focus:ring-1 focus:ring-indigo-400 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
              >
                {profiles.map(profile => (
                  <option key={profile.id} value={profile.id} disabled={!profile.available}>
                    {profile.name}{profile.available ? '' : ` (${t('preprocess.convertColors:chua_cai')})`}
                  </option>
                ))}
                {profiles.length === 0 && (
                  <option value={profileId}>
                    {profilesLoading ? t('preprocess.convertColors:dang_tai_ho_so') : profileId}
                  </option>
                )}
              </select>
              {selectedProfile?.description && (
                <span className="sr-only">
                  {selectedProfile.description}
                </span>
              )}
              {profilesLoadFailed && (
                <span className="mt-1 block text-[10px] leading-snug text-amber-600 dark:text-amber-400">
                  {t('preprocess.convertColors:khong_tai_duoc_danh_sach_ho_so')}
                </span>
              )}
            </label>

            <div className="mt-2 flex items-center justify-between gap-2 rounded-lg bg-white/70 px-2 py-1.5 dark:bg-zinc-900/50">
              <span className="text-[10px] font-semibold text-slate-600 dark:text-zinc-300">
                {gamutMapping === 'adaptive_vivid'
                  ? t('preprocess.convertColors:adaptive_vivid_label')
                  : renderingIntent === 'relative'
                    ? t('preprocess.convertColors:tom_tat_relative_bpc')
                    : t(`preprocess.convertColors:intent_${renderingIntent}`)}
              </span>
              <button
                type="button"
                aria-controls="color-advanced-options"
                data-testid="color-advanced-toggle"
                aria-expanded={advancedOpen}
                onClick={() => setAdvancedOpen(value => !value)}
                className="rounded border border-slate-300 px-2 py-1 text-[10px] font-semibold text-slate-600 hover:bg-white dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-700"
              >
                {advancedOpen ? t('preprocess.convertColors:an_tuy_chon_nang_cao') : t('preprocess.convertColors:tuy_chon_nang_cao')}
              </button>
            </div>
            {advancedOpen && (
              <div id="color-advanced-options" data-testid="color-advanced-options" className="space-y-3 border-t border-slate-200 pt-3 dark:border-zinc-700">
            <label className="block">
              <span className="mb-1 block text-[10px] font-semibold text-slate-600 dark:text-zinc-300">
                {t('preprocess.convertColors:rendering_intent')}
              </span>
              <select
                aria-label={t('preprocess.convertColors:rendering_intent')}
                value={renderingIntent}
                onChange={event => {
                  setGamutMapping('icc');
                  setRenderingIntent(event.target.value as OutputPreviewRenderingIntent);
                }}
                className="h-8 w-full rounded-lg border border-slate-200 bg-white px-2 text-[12px] text-slate-700 focus:outline-none focus:ring-1 focus:ring-indigo-400 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
              >
                {RENDERING_INTENTS.map(intent => (
                  <option key={intent} value={intent}>
                    {t(`preprocess.convertColors:intent_${intent}`)}
                  </option>
                ))}
              </select>
              <span className="sr-only">
                {renderingIntent === 'relative'
                  ? t('preprocess.convertColors:relative_bpc_khuyen_nghi')
                  : t('preprocess.convertColors:chon_intent_theo_noi_dung')}
                </span>
              </label>


            <div className="space-y-1.5 border-t border-indigo-100 pt-2 dark:border-indigo-900/50">
              <label className="flex cursor-pointer items-start gap-2">
                <input
                  type="checkbox"
                  checked={preserveBlack}
                  onChange={event => setPreserveBlack(event.target.checked)}
                  className="mt-0.5 h-3.5 w-3.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                />
                <span className="text-[11px] text-slate-600 dark:text-zinc-300">
                  <strong>{t('preprocess.convertColors:giu_chu_va_net_den_k_thuan')}</strong>
                  <span className="mt-0.5 block text-[10px] text-slate-400">
                    {t('preprocess.convertColors:giu_den_chong_lech_vien')}
                  </span>
                </span>
              </label>
              <div className="flex items-start gap-2 text-[11px] text-slate-600 dark:text-zinc-300">
                <span className="mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded bg-indigo-600 text-[9px] text-white">✓</span>
                <span>
                  <strong>{t('preprocess.convertColors:bpc_luon_bat')}</strong>
                  <span className="mt-0.5 block text-[10px] text-slate-400">
                    {t('preprocess.convertColors:bpc_giu_chi_tiet_vung_toi')}
                  </span>
                </span>
              </div>
            </div>
              </div>
            )}
          </div>

          {advancedOpen && (
          <button onClick={() => setIncludeSpot(!includeSpot)}
            className={`w-full text-left px-3 py-2 rounded-lg border text-[12px] transition-all flex items-start gap-2.5
              ${includeSpot ? 'border-teal-500 bg-teal-500/10 text-teal-700 dark:text-teal-300' : 'border-slate-200 dark:border-white/10 hover:bg-slate-50 dark:hover:bg-zinc-800 text-slate-600 dark:text-zinc-400'}`}>
            <div className={`mt-0.5 w-4 h-4 rounded border flex items-center justify-center shrink-0 ${includeSpot ? 'bg-teal-500 border-teal-500' : 'bg-white dark:bg-zinc-800 border-slate-300 dark:border-zinc-500'}`}>
              {includeSpot && <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={4} d="M5 13l4 4L19 7" /></svg>}
            </div>
            <div className="flex-1">
              <span className="font-semibold block">{t('preprocess.convertColors:doi_luon_mau_pha_spot_pantone_cmyk')}</span>
              <span className="text-[10px] text-slate-500 dark:text-zinc-400 block leading-snug mt-0.5">{t('preprocess.convertColors:bat_khi_in_4_mau_tat_neu_giu_ban_mau')}</span>
            </div>
          </button>
          )}
          <section
            aria-busy={previewLoading}
            className="space-y-2 rounded-lg border border-slate-200 bg-slate-50/60 p-2.5 dark:border-zinc-700 dark:bg-zinc-900/60"
          >
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void runPreview('manual')}
                disabled={previewLoading || profileUnavailable}
                className="min-w-0 flex-1 rounded-lg bg-indigo-600 px-3 py-2 text-[11px] font-bold text-white shadow-sm hover:bg-indigo-700 disabled:opacity-50"
              >
                {previewLoading
                  ? t('preprocess.convertColors:dang_phan_tich_mau')
                  : t('preprocess.convertColors:xem_truoc_thong_so_hien_tai')}
              </button>
              <label className="flex shrink-0 items-center gap-1 text-[9px] font-semibold text-slate-500 dark:text-zinc-400">
                <span>{t('preprocess.convertColors:trang_can_phan_tich')}</span>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={previewPage}
                  aria-label={t('preprocess.convertColors:trang_can_phan_tich')}
                  onChange={event => {
                    const nextPage = Math.max(1, Math.floor(Number(event.target.value) || 1));
                    setPreviewPage(nextPage);
                  }}
                  className="h-8 w-12 rounded-lg border border-slate-200 bg-white px-1 text-center text-[10px] text-slate-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
                />
              </label>
            </div>

            {/* Giữ hai action cũ cho recipe/test và người dùng nâng cao, nhưng
                không để chúng cạnh tranh với hành động xem trước chính. */}
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                data-testid="color-vivid-preset"
                aria-pressed={gamutMapping === 'adaptive_vivid'}
                onClick={activateVividPreset}
                disabled={previewLoading || profileUnavailable}
                className={gamutMapping === 'adaptive_vivid'
                  ? 'sr-only'
                  : 'rounded-md border border-fuchsia-200 bg-white px-2 py-1 text-[9px] font-semibold text-fuchsia-700 hover:bg-fuchsia-50 disabled:opacity-50 dark:border-fuchsia-900 dark:bg-zinc-900 dark:text-fuchsia-300'}
              >
                {t('preprocess.convertColors:adaptive_vivid_label')}
              </button>
              <button
                type="button"
                onClick={() => void runPreview('balanced-v1')}
                disabled={previewLoading || profileUnavailable}
                className="ml-auto rounded-md px-2 py-1 text-[9px] font-semibold text-slate-500 hover:bg-slate-100 disabled:opacity-50 dark:text-zinc-400 dark:hover:bg-zinc-800"
              >
                {t('preprocess.convertColors:goi_y_can_bang_trang')}
              </button>
            </div>

            {previewError && (
              <p className="rounded border border-red-200 bg-red-50 px-2 py-1.5 text-[10px] text-red-600 dark:border-red-900 dark:bg-red-950/20 dark:text-red-300">
                {previewError}
              </p>
            )}

            {previewResponse && (
              <div data-testid="color-preview-result" className="space-y-2">
                <div className="flex items-center justify-between gap-2 text-[9px]">
                  <span className="font-semibold text-slate-500 dark:text-zinc-400">
                    {t('preprocess.convertColors:xem_truoc_trang_dpi', {
                      page: previewResponse.page,
                      dpi: previewResponse.effective_dpi,
                    })}
                  </span>
                  <span data-testid={previewFresh ? 'color-preview-fresh' : 'color-preview-stale'} className={previewFresh
                    ? 'rounded bg-emerald-100 px-1.5 py-0.5 font-semibold text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300'
                    : 'rounded bg-amber-100 px-1.5 py-0.5 font-semibold text-amber-700 dark:bg-amber-950/50 dark:text-amber-300'}
                  >
                    {previewFresh
                      ? t('preprocess.convertColors:preview_da_khop_thong_so')
                      : t('preprocess.convertColors:preview_da_cu')}
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-1.5">
                  <figure className="min-w-0">
                    <figcaption className="mb-1 text-center text-[9px] font-semibold text-slate-500 dark:text-zinc-400">
                      {t('preprocess.convertColors:anh_nguon')}
                    </figcaption>
                    <img
                      src={`data:${previewResponse.preview.mime === 'image/jpeg' ? 'image/jpeg' : 'image/png'};base64,${previewResponse.preview.source_b64}`}
                      alt={t('preprocess.convertColors:anh_nguon_xem_truoc')}
                      className="max-h-56 w-full rounded border border-slate-200 bg-white object-contain dark:border-zinc-700"
                    />
                  </figure>
                  <figure className="min-w-0">
                    <figcaption className="mb-1 text-center text-[9px] font-semibold text-slate-500 dark:text-zinc-400">
                      {t('preprocess.convertColors:ban_cmyk_softproof')}
                    </figcaption>
                    <img
                      src={`data:${previewResponse.preview.mime === 'image/jpeg' ? 'image/jpeg' : 'image/png'};base64,${previewResponse.preview.output_b64}`}
                      alt={t('preprocess.convertColors:anh_softproof_xem_truoc')}
                      className="max-h-56 w-full rounded border border-slate-200 bg-white object-contain dark:border-zinc-700"
                    />
                  </figure>
                </div>

                <div data-testid="color-adjustment-panel" className="space-y-2 rounded-lg border border-indigo-200 bg-indigo-50/50 p-2.5 dark:border-indigo-900/60 dark:bg-indigo-950/20">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[10px] font-semibold text-indigo-700 dark:text-indigo-300">
                      {t('preprocess.convertColors:tinh_chinh_tu_dong_preview')}
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        setBrightnessLstar(0);
                        setContrastPercent(0);
                        setVibrancePercent(0);
                      }}
                      disabled={brightnessLstar === 0 && contrastPercent === 0 && vibrancePercent === 0}
                      className="rounded px-1.5 py-1 text-[9px] font-semibold text-indigo-600 hover:bg-white/70 disabled:opacity-40 dark:text-indigo-300"
                    >
                      {t('preprocess.convertColors:dat_lai')}
                    </button>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <ColorAdjustmentSlider
                      label={t('preprocess.convertColors:bu_sang_lstar')}
                      description=""
                      value={brightnessLstar}
                      min={-10}
                      max={10}
                      onChange={setBrightnessLstar}
                    />
                    <ColorAdjustmentSlider
                      label={t('preprocess.convertColors:tuong_phan_percent')}
                      description=""
                      value={contrastPercent}
                      min={-20}
                      max={20}
                      onChange={setContrastPercent}
                    />
                    <ColorAdjustmentSlider
                      label={t('preprocess.convertColors:do_ruc_percent')}
                      description=""
                      value={vibrancePercent}
                      min={-20}
                      max={20}
                      onChange={setVibrancePercent}
                    />
                  </div>
                  {advancedOpen && (
                    <label className="block border-t border-indigo-100 pt-2 dark:border-indigo-900/50">
                      <span className="mb-1 block text-[9px] font-semibold text-slate-500 dark:text-zinc-400">
                        {t('preprocess.convertColors:vi_tri_tinh_chinh')}
                      </span>
                      <select
                        aria-label={t('preprocess.convertColors:vi_tri_tinh_chinh')}
                        value={adjustmentStage}
                        onChange={event => {
                          const nextStage = event.target.value as ColorAdjustmentStage;
                          setAdjustmentStage(nextStage);
                          if (nextStage === 'pre_icc') setGamutMapping('icc');
                        }}
                        className="h-8 w-full rounded-lg border border-slate-200 bg-white px-2 text-[10px] text-slate-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
                      >
                        <option value="post_cmyk">{t('preprocess.convertColors:tinh_chinh_sau_cmyk_photoshop')}</option>
                        <option value="pre_icc">{t('preprocess.convertColors:tinh_chinh_truoc_icc_gamut')}</option>
                      </select>
                    </label>
                  )}
                </div>

                {previewResponse.warnings[0] && (
                  <p className="sr-only">{previewResponse.warnings[0]}</p>
                )}
                <div className="grid grid-cols-3 gap-1.5">
                  <div className="rounded-md bg-white px-2 py-1.5 dark:bg-zinc-800">
                    <span className="block text-[8px] text-slate-400">{t('preprocess.convertColors:delta_e00_trung_binh')}</span>
                    <strong className="block text-[11px] tabular-nums text-slate-700 dark:text-zinc-200">{metric(previewResponse.metrics.delta_e00_mean)}</strong>
                  </div>
                  <div className="rounded-md bg-white px-2 py-1.5 dark:bg-zinc-800">
                    <span className="block text-[8px] text-slate-400">{t('preprocess.convertColors:cat_sang')}</span>
                    <strong className="block text-[11px] tabular-nums text-slate-700 dark:text-zinc-200">{metric(previewResponse.metrics.new_highlight_clip_pct, 3)}%</strong>
                  </div>
                  <div className="rounded-md bg-white px-2 py-1.5 dark:bg-zinc-800">
                    <span className="block text-[8px] text-slate-400">{t('preprocess.convertColors:tac_lon_nhat')}</span>
                    <strong className="block text-[11px] tabular-nums text-slate-700 dark:text-zinc-200">
                      {previewResponse.metrics.tac.available ? `${metric(previewResponse.metrics.tac.max_pct)}%` : '—'}
                    </strong>
                  </div>
                </div>

                <button
                  type="button"
                  aria-controls="color-technical-details"
                  data-testid="color-technical-toggle"
                  aria-expanded={technicalOpen}
                  onClick={() => setTechnicalOpen(value => !value)}
                  className="flex w-full items-center justify-between border-t border-slate-200 pt-2 text-left text-[9px] font-semibold text-slate-500 dark:border-zinc-700 dark:text-zinc-400"
                >
                  <span>{technicalOpen ? t('preprocess.convertColors:an_chi_tiet_ky_thuat') : t('preprocess.convertColors:chi_tiet_ky_thuat')}</span>
                  <span aria-hidden="true">{technicalOpen ? '−' : '+'}</span>
                </button>

                {technicalOpen && (
                  <div id="color-technical-details" data-testid="color-technical-details" className="space-y-2 rounded-lg bg-white p-2 dark:bg-zinc-900">
                    {previewResponse.preview.gamut_b64 && (
                      <img
                        src={`data:${previewResponse.preview.mime === 'image/jpeg' ? 'image/jpeg' : 'image/png'};base64,${previewResponse.preview.gamut_b64}`}
                        alt={t('preprocess.convertColors:canh_bao_ngoai_gamut')}
                        className="max-h-48 w-full rounded border border-slate-200 bg-white object-contain dark:border-zinc-700"
                      />
                    )}
                    <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[9px] text-slate-500 dark:text-zinc-400">
                      <span>{t('preprocess.convertColors:delta_l_trung_binh')}</span><strong className="text-right tabular-nums">{metric(previewResponse.metrics.delta_lstar_mean)}</strong>
                      <span>{t('preprocess.convertColors:delta_chroma_trung_binh')}</span><strong className="text-right tabular-nums">{metric(previewResponse.metrics.delta_chroma_mean)}</strong>
                      <span>{t('preprocess.convertColors:delta_e00_p95')}</span><strong className="text-right tabular-nums">{metric(previewResponse.metrics.delta_e00_p95)}</strong>
                      <span>{t('preprocess.convertColors:ngoai_gamut')}</span><strong className="text-right tabular-nums">{metric(previewResponse.metrics.out_of_gamut_pct, 2)}%</strong>
                      <span>{t('preprocess.convertColors:tac_trung_binh_p95_lon_nhat')}</span>
                      <strong className="text-right tabular-nums">
                        {previewResponse.metrics.tac.available
                          ? `${metric(previewResponse.metrics.tac.mean_pct)} / ${metric(previewResponse.metrics.tac.p95_pct)} / ${metric(previewResponse.metrics.tac.max_pct)}%`
                          : t('preprocess.convertColors:tac_chua_xac_minh')}
                      </strong>
                    </div>
                    {previewResponse.warnings.map((warning, index) => (
                      <p key={`${warning}-${index}`} className="rounded bg-amber-50 px-2 py-1 text-[9px] text-amber-700 dark:bg-amber-950/30 dark:text-amber-300">
                        {warning}
                      </p>
                    ))}
                  </div>
                )}

                {recommendationCanApply && (
                  <button
                    type="button"
                    onClick={applySafeRecommendation}
                    className="w-full rounded-md border border-teal-200 bg-teal-50 px-2 py-1.5 text-[9px] font-semibold text-teal-700 hover:bg-teal-100 dark:border-teal-900 dark:bg-teal-950/20 dark:text-teal-300"
                  >
                    {t('preprocess.convertColors:ap_dung_goi_y_an_toan')}
                  </button>
                )}
              </div>
            )}
          </section>

        </>
      )}

      {mode === 'cmyk' && !previewFresh && (
        <p className="text-center text-[9px] font-medium text-amber-600 dark:text-amber-400">
          {t('preprocess.convertColors:can_xem_truoc_moi_truoc_khi_thuc_thi')}
        </p>
      )}

      {/* ═══ THỰC THI ═══ */}
      <button onClick={run} disabled={running || profileUnavailable || (mode === 'cmyk' && !previewFresh)}
        className="w-full px-2.5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-[13px] font-bold shadow-sm transition-colors disabled:opacity-50 flex items-center justify-center gap-2 border border-indigo-700">
        {running ? (<><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> {t('preprocess.common:run')}…</>) : (<>{t('preprocess.common:run')}</>)}
      </button>

      {/* ═══ RESULT ═══ */}
      {result && (
        <div className="p-3 rounded-lg border bg-emerald-500/10 border-emerald-500/20">
          <h4 className="text-[11px] font-bold mb-1 text-emerald-600">{t('preprocess.convertColors:thanh_cong')}</h4>
          {result.log?.map((logEntry, index) => (
            <p key={index} className="text-[10px] text-slate-600 dark:text-zinc-300">
              {logEntry.status === 'success' ? '✅' : '❌'} {logEntry.message} ({logEntry.duration_ms}ms)
            </p>
          ))}
          <p className="text-[10px] text-emerald-600 dark:text-emerald-400 mt-1 font-medium">{t('preprocess.convertColors:file_da_duoc_cap_nhat_tren_viewer')}</p>
        </div>
      )}

      {error && <div className="mt-3 text-[11px] text-red-500 bg-red-50 dark:bg-red-900/20 px-3 py-2 rounded border border-red-200 dark:border-red-800/50">{error}</div>}
    </div>
  );
}
