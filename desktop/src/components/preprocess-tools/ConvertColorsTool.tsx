import { useState, useEffect, useCallback, useRef } from 'react';
import { HelpCircle } from 'lucide-react';
import { authenticatedFetch, getApiUrl, uploadPDF } from '../../lib/api';
import { useWorkingPdf } from '../../hooks/useWorkingPdf';
import { recipeRecorder, type RecipeOperationTicket } from '../../lib/recipe/RecipeRecorder';
import ToolHelpModal from '../ToolHelpModal';
import type { ToolHelp } from '../../lib/toolHelp';
import { useTranslation } from 'react-i18next';
import { useWorkspaceStore, type OutputPreviewRenderingIntent } from '../../stores/useWorkspaceStore';

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

const RENDERING_INTENTS: readonly OutputPreviewRenderingIntent[] = [
  'relative',
  'perceptual',
  'saturation',
  'absolute',
];

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
    <button onClick={onSelect}
      className={`w-full text-left px-3 py-3 rounded-xl border transition-all flex items-center gap-3
        ${selected ? 'border-teal-500 bg-teal-500/10 text-teal-700 dark:text-teal-300 shadow-sm' : 'border-slate-200 dark:border-white/10 hover:bg-slate-50 dark:hover:bg-zinc-800 text-slate-600 dark:text-zinc-400'}`}>
      <span className="text-xl shrink-0">{icon}</span>
      <div className="flex-1 min-w-0">
        <span className="font-bold text-[13px] block">{label}</span>
        <span className="text-[11px] text-slate-500 dark:text-zinc-400 block leading-snug mt-0.5">{desc}</span>
      </div>
      <div className={`w-4 h-4 rounded-full border-2 shrink-0 ${selected ? 'border-teal-500 bg-teal-500' : 'border-slate-300 dark:border-zinc-500'}`}>
        {selected && <div className="w-full h-full rounded-full border-2 border-white dark:border-zinc-900" />}
      </div>
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
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState('');
  const [showHelp, setShowHelp] = useState(false);
  const expectedOutputNameRef = useRef<string | null>(null);
  const profileId = useWorkspaceStore(state => state.outputPreviewProfileId);
  const renderingIntent = useWorkspaceStore(state => state.outputPreviewRenderingIntent);
  const setProfileId = useWorkspaceStore(state => state.setOutputPreviewProfileId);
  const setRenderingIntent = useWorkspaceStore(state => state.setOutputPreviewRenderingIntent);
  const selectedProfile = profiles.find(profile => profile.id === profileId);
  const profileUnavailable = mode === 'cmyk'
    && profiles.length > 0
    && !selectedProfile?.available;

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
    setFileId('');
    if (!preserveSuccess) setResult(null);
    setError('');
  }, [pdfFile]);

  const getWorkingFile = useWorkingPdf();
  const ensureUploaded = useCallback(async (): Promise<string> => {
    if (fileId) return fileId;
    if (!pdfFile) throw new Error(t('preprocess.convertColors:chua_co_file_pdf'));
    const r = await uploadPDF((await getWorkingFile()) || pdfFile);
    setFileId(r.id);
    return r.id;
  }, [fileId, pdfFile, getWorkingFile, t]);

  const run = async () => {
    if (profileUnavailable) {
      setError(t('preprocess.convertColors:ho_so_mau_khong_kha_dung'));
      return;
    }
    setRunning(true); setResult(null); setError('');
    const shouldRecord = !!tabId && recipeRecorder.isRecordingFor(tabId);
    const conversions = mode === 'grayscale'
      ? ['gray_to_cmyk']
      : ['rgb_to_cmyk', ...(includeSpot ? ['spot_to_cmyk'] : [])];
    const recipeTicket = shouldRecord
      ? recipeRecorder.noteOperation('convertcolors', {
          conversions,
          icc_profile: profileId,
          rendering_intent: renderingIntent,
          preserve_black: preserveBlack,
          black_point_compensation: BLACK_POINT_COMPENSATION,
          brightness_lstar: brightnessLstar,
          contrast_percent: contrastPercent,
          vibrance_percent: vibrancePercent,
          adjustment_stage: adjustmentStage,
        }, undefined, tabId)
      : null;
    if (shouldRecord && !recipeTicket) {
      setError(t('tabs.imposition:dang_xu_ly_file'));
      setRunning(false);
      return;
    }
    try {
      const fid = await ensureUploaded();
      const body = {
        file_id: fid,
        conversions,
        icc_profile: profileId,
        rendering_intent: renderingIntent,
        preserve_black: preserveBlack,
        black_point_compensation: BLACK_POINT_COMPENSATION,
        brightness_lstar: brightnessLstar,
        contrast_percent: contrastPercent,
        vibrance_percent: vibrancePercent,
        adjustment_stage: adjustmentStage,
      };
      const res = await authenticatedFetch(`${getApiUrl()}/preflight/convert-colors`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
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
          const dl = await authenticatedFetch(`${getApiUrl()}/preflight/download/${data.output_filename}`);
          if (!dl.ok) {
            throw new Error(await responseError(dl, t('preprocess.convertColors:that_bai')));
          }
          const artifact = await dl.blob();
          expectedOutputNameRef.current = data.output_filename;
          await onFileFixed(artifact, data.output_filename, undefined, recipeTicket);
        } else {
          recipeRecorder.discardPending(recipeTicket);
        }
        // COLOR (audit 2026-08-20 §COLOR.24): chỉ hiện xanh sau khi download
        // và commit Working File đều thành công; response 404/500 cũng có blob
        // nhưng tuyệt đối không được đưa blob lỗi đó vào viewer như PDF.
        setResult(data);
      } else { recipeRecorder.discardPending(recipeTicket); setError(data.error || data.detail || t('preprocess.convertColors:that_bai')); }
    } catch (e: any) {
      expectedOutputNameRef.current = null;
      setResult(null);
      recipeRecorder.discardPending(recipeTicket);
      setError(e.message);
    }
    finally { setRunning(false); }
  };

  if (!pdfFile) return <div className="text-[11px] text-slate-400 text-center py-6">{t('preprocess.convertColors:vui_long_mo_file_pdf_truoc')}</div>;

  return (
    <div className="space-y-4 animate-in fade-in duration-200">

      {/* ═══ NÚT HƯỚNG DẪN ═══ */}
      <button onClick={() => setShowHelp(true)}
        className="w-full flex items-center justify-center gap-1.5 text-[12px] font-medium text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-500/10 py-2 rounded-lg border border-indigo-200 dark:border-indigo-800/50 transition-colors">
        <HelpCircle className="w-4 h-4" /> {t('preprocess.convertColors:chua_ro_xem_huong_dan_amp_giai_thich')}
      </button>
      {showHelp && <ToolHelpModal help={COLOR_HELP} icon="🎨" onClose={() => setShowHelp(false)} />}

      {/* ═══ CHỌN CHẾ ĐỘ (chọn 1) ═══ */}
      <div className="space-y-2">
        <ModeCard selected={mode === 'cmyk'} onSelect={() => setMode('cmyk')} icon="🟡" label={t('preprocess.convertColors:chuyen_sang_cmyk')} desc={t('preprocess.convertColors:cho_in_offset_in_4_mau_rgb_cmyk')} />
        <ModeCard selected={mode === 'grayscale'} onSelect={() => setMode('grayscale')} icon="⬛" label={t('preprocess.convertColors:chuyen_sang_den_trang')} desc={t('preprocess.convertColors:bo_mau_in_1_mau_den_grayscale')} />
      </div>

      {/* Tùy chọn màu pha — chỉ hiện ở chế độ CMYK */}
      {mode === 'cmyk' && (
        <>
          <div className="space-y-2.5 rounded-xl border border-indigo-200 bg-indigo-50/50 p-3 dark:border-indigo-900/60 dark:bg-indigo-950/20">
            <div>
              <h3 className="text-[12px] font-bold text-indigo-700 dark:text-indigo-300">
                {t('preprocess.convertColors:dieu_kien_in_va_giu_sang')}
              </h3>
              <p className="mt-0.5 text-[10px] leading-snug text-slate-500 dark:text-zinc-400">
                {t('preprocess.convertColors:dong_bo_voi_output_preview')}
              </p>
            </div>

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
                <span className="mt-1 block text-[10px] leading-snug text-slate-400">
                  {selectedProfile.description}
                </span>
              )}
              {profilesLoadFailed && (
                <span className="mt-1 block text-[10px] leading-snug text-amber-600 dark:text-amber-400">
                  {t('preprocess.convertColors:khong_tai_duoc_danh_sach_ho_so')}
                </span>
              )}
            </label>

            <label className="block">
              <span className="mb-1 block text-[10px] font-semibold text-slate-600 dark:text-zinc-300">
                {t('preprocess.convertColors:rendering_intent')}
              </span>
              <select
                aria-label={t('preprocess.convertColors:rendering_intent')}
                value={renderingIntent}
                onChange={event => setRenderingIntent(event.target.value as OutputPreviewRenderingIntent)}
                className="h-8 w-full rounded-lg border border-slate-200 bg-white px-2 text-[12px] text-slate-700 focus:outline-none focus:ring-1 focus:ring-indigo-400 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
              >
                {RENDERING_INTENTS.map(intent => (
                  <option key={intent} value={intent}>
                    {t(`preprocess.convertColors:intent_${intent}`)}
                  </option>
                ))}
              </select>
              <span className="mt-1 block text-[10px] leading-snug text-slate-400">
                {renderingIntent === 'relative'
                  ? t('preprocess.convertColors:relative_bpc_khuyen_nghi')
                  : t('preprocess.convertColors:chon_intent_theo_noi_dung')}
                </span>
              </label>

            <div className="space-y-2 border-t border-indigo-100 pt-2 dark:border-indigo-900/50">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h4 className="text-[10px] font-bold text-slate-600 dark:text-zinc-300">
                    {adjustmentStage === 'post_cmyk'
                      ? t('preprocess.convertColors:tinh_chinh_sau_khi_doi_cmyk')
                      : t('preprocess.convertColors:tinh_chinh_truoc_icc')}
                  </h4>
                  <p className="mt-0.5 text-[9px] leading-snug text-slate-400 dark:text-zinc-500">
                    {adjustmentStage === 'post_cmyk'
                      ? t('preprocess.convertColors:tinh_chinh_sau_cmyk_mo_ta')
                      : t('preprocess.convertColors:tinh_chinh_truoc_icc_mo_ta')}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      setBrightnessLstar(2);
                      setContrastPercent(0);
                      setVibrancePercent(0);
                    }}
                    className="rounded border border-amber-300 bg-amber-50 px-1.5 py-1 text-[9px] font-semibold text-amber-700 hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300"
                  >
                    {t('preprocess.convertColors:sang_nhe_2')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setBrightnessLstar(0);
                      setContrastPercent(0);
                      setVibrancePercent(0);
                    }}
                    disabled={brightnessLstar === 0 && contrastPercent === 0 && vibrancePercent === 0}
                    className="rounded border border-indigo-200 px-1.5 py-1 text-[9px] font-semibold text-indigo-600 hover:bg-indigo-50 disabled:cursor-default disabled:opacity-40 dark:border-indigo-800 dark:text-indigo-300 dark:hover:bg-indigo-950/40"
                  >
                    {t('preprocess.convertColors:dat_lai')}
                  </button>
                </div>
              </div>
              <label className="block">
                <span className="mb-1 block text-[10px] font-semibold text-slate-600 dark:text-zinc-300">
                  {t('preprocess.convertColors:vi_tri_tinh_chinh')}
                </span>
                <select
                  aria-label={t('preprocess.convertColors:vi_tri_tinh_chinh')}
                  value={adjustmentStage}
                  onChange={event => setAdjustmentStage(event.target.value as ColorAdjustmentStage)}
                  className="h-8 w-full rounded-lg border border-slate-200 bg-white px-2 text-[11px] text-slate-700 focus:outline-none focus:ring-1 focus:ring-indigo-400 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
                >
                  <option value="post_cmyk">
                    {t('preprocess.convertColors:tinh_chinh_sau_cmyk_photoshop')}
                  </option>
                  <option value="pre_icc">
                    {t('preprocess.convertColors:tinh_chinh_truoc_icc_gamut')}
                  </option>
                </select>
                <span className="mt-1 block text-[9px] leading-snug text-slate-400 dark:text-zinc-500">
                  {adjustmentStage === 'post_cmyk'
                    ? t('preprocess.convertColors:tinh_chinh_sau_cmyk_mo_ta')
                    : t('preprocess.convertColors:tinh_chinh_truoc_icc_mo_ta')}
                </span>
              </label>
              <ColorAdjustmentSlider
                label={t('preprocess.convertColors:bu_sang_lstar')}
                description={t('preprocess.convertColors:bu_sang_lstar_mo_ta')}
                value={brightnessLstar}
                min={-10}
                max={10}
                onChange={setBrightnessLstar}
              />
              <ColorAdjustmentSlider
                label={t('preprocess.convertColors:tuong_phan_percent')}
                description={t('preprocess.convertColors:tuong_phan_percent_mo_ta')}
                value={contrastPercent}
                min={-20}
                max={20}
                onChange={setContrastPercent}
              />
              <ColorAdjustmentSlider
                label={t('preprocess.convertColors:do_ruc_percent')}
                description={t('preprocess.convertColors:do_ruc_percent_mo_ta')}
                value={vibrancePercent}
                min={-20}
                max={20}
                onChange={setVibrancePercent}
              />
              <p className="text-[9px] leading-snug text-amber-600 dark:text-amber-400">
                {t('preprocess.convertColors:canh_bao_bu_mau')}
              </p>
            </div>

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
        </>
      )}

      {/* ═══ THỰC THI ═══ */}
      <button onClick={run} disabled={running || profileUnavailable}
        className="w-full px-2.5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-[13px] font-bold shadow-sm transition-colors disabled:opacity-50 flex items-center justify-center gap-2 border border-indigo-700">
        {running ? (<><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> {t('preprocess.common:run')}…</>) : (<>{t('preprocess.common:run')}</>)}
      </button>

      {/* ═══ RESULT ═══ */}
      {result && (
        <div className="p-3 rounded-lg border bg-emerald-500/10 border-emerald-500/20">
          <h4 className="text-[11px] font-bold mb-1 text-emerald-600">{t('preprocess.convertColors:thanh_cong')}</h4>
          {result.log?.map((l: any, i: number) => (
            <p key={i} className="text-[10px] text-slate-600 dark:text-zinc-300">{l.status === 'success' ? '✅' : '❌'} {l.message} ({l.duration_ms}ms)</p>
          ))}
          <p className="text-[10px] text-emerald-600 dark:text-emerald-400 mt-1 font-medium">{t('preprocess.convertColors:file_da_duoc_cap_nhat_tren_viewer')}</p>
        </div>
      )}

      {error && <div className="mt-3 text-[11px] text-red-500 bg-red-50 dark:bg-red-900/20 px-3 py-2 rounded border border-red-200 dark:border-red-800/50">{error}</div>}
    </div>
  );
}
