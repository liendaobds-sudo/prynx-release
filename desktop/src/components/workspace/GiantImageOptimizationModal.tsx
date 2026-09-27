import React, { useState } from 'react';
import { AlertTriangle, CheckCircle, RefreshCw, X, SlidersHorizontal, Sparkles } from 'lucide-react';
import type { ImageHeaderInfo } from '../../lib/imageHeaderInspector';
import { useTranslation } from 'react-i18next';

interface Props {
  open: boolean;
  fileName: string;
  headerInfo: ImageHeaderInfo;
  isOptimizing?: boolean;
  optimizingDpi?: number;
  onOptimize: (targetDpi: number) => void;
  onProceedOriginal: () => void;
  onCancel: () => void;
}

export default function GiantImageOptimizationModal({
  open,
  fileName,
  headerInfo,
  isOptimizing = false,
  optimizingDpi = 150,
  onOptimize,
  onProceedOriginal,
  onCancel,
}: Props) {
  const { t } = useTranslation();
  const [customDpi, setCustomDpi] = useState<number>(300);
  const [showCustom, setShowCustom] = useState<boolean>(false);

  if (!open) return null;

  const {
    width,
    height,
    totalPixels,
    dpiX,
    physicalWidthCm,
    physicalHeightCm,
    estimatedRawMb,
  } = headerInfo;

  const currentDpi = dpiX && dpiX > 0 ? dpiX : 72;
  const megapixels = (totalPixels / 1_000_000).toFixed(1);

  const calculateDpiStats = (targetDpi: number) => {
    let scale = 1.0;
    if (currentDpi > targetDpi) {
      scale = targetDpi / currentDpi;
    } else if (Math.max(width, height) > 8000) {
      scale = 8000 / Math.max(width, height);
    }
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    const mp = ((w * h) / 1_000_000).toFixed(1);
    const rawMb = Math.round((w * h * 4) / (1024 * 1024));
    return { w, h, mp, rawMb };
  };

  const stats150 = calculateDpiStats(150);
  const stats200 = calculateDpiStats(200);
  const stats300 = calculateDpiStats(300);
  const stats100 = calculateDpiStats(100);

  const safeCustomDpi = Math.max(50, Math.min(customDpi || 150, Math.max(currentDpi, 600)));
  const customStats = calculateDpiStats(safeCustomDpi);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
      <div
        className="w-full max-w-lg max-h-[92vh] overflow-y-auto rounded-xl border border-amber-300 bg-white p-5 shadow-2xl dark:border-amber-700/60 dark:bg-zinc-900"
        role="dialog"
        aria-modal="true"
        aria-labelledby="giant-image-modal-title"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-amber-100 text-amber-600 dark:bg-amber-950/60 dark:text-amber-400">
              <AlertTriangle className="h-5 w-5" />
            </div>
            <div>
              <h3 id="giant-image-modal-title" className="text-[15px] font-bold text-slate-800 dark:text-zinc-100">
                {t('image_gate:phat_hien_anh_sieu_lon', 'Phát hiện ảnh siêu lớn (DPI rất cao)')}
              </h3>
              <p className="text-[11px] text-slate-500 dark:text-zinc-400">
                {t('image_gate:canh_bao_dung_luong_ram', 'Ảnh có số lượng điểm ảnh vượt chuẩn thường, dễ làm nghẽn bộ nhớ.')}
              </p>
            </div>
          </div>
          {!isOptimizing && (
            <button
              type="button"
              onClick={onCancel}
              className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
              aria-label={t('common:close', 'Đóng')}
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        {/* Thông số file */}
        <div className="mt-3.5 rounded-lg border border-slate-200 bg-slate-50 p-3 text-[11px] dark:border-zinc-800 dark:bg-zinc-800/50">
          <div className="truncate font-semibold text-slate-700 dark:text-zinc-200 mb-2">
            📄 {fileName}
          </div>
          <div className="grid grid-cols-2 gap-2 text-slate-600 dark:text-zinc-300">
            <div>
              <span className="text-slate-400 dark:text-zinc-500">{t('image_gate:kich_thuoc_pixel', 'Kích thước')}:</span>{' '}
              <strong className="font-semibold text-slate-800 dark:text-zinc-100">
                {width.toLocaleString()} × {height.toLocaleString()} px
              </strong>
            </div>
            <div>
              <span className="text-slate-400 dark:text-zinc-500">{t('image_gate:tong_diem_anh', 'Tổng điểm ảnh')}:</span>{' '}
              <strong className="font-bold text-amber-600 dark:text-amber-400">
                {megapixels} MP
              </strong>
            </div>
            <div>
              <span className="text-slate-400 dark:text-zinc-500">{t('image_gate:do_phan_giai_goc', 'Độ phân giải')}:</span>{' '}
              <strong className="font-semibold text-slate-800 dark:text-zinc-100">
                {dpiX || 72} DPI
              </strong>
            </div>
            <div>
              <span className="text-slate-400 dark:text-zinc-500">{t('image_gate:kho_in_thuc_te', 'Khổ in thực tế')}:</span>{' '}
              <strong className="font-semibold text-slate-800 dark:text-zinc-100">
                ~{physicalWidthCm} × {physicalHeightCm} cm
              </strong>
            </div>
            <div className="col-span-2 border-t border-slate-200/80 pt-1.5 dark:border-zinc-700/80">
              <span className="text-slate-400 dark:text-zinc-500">{t('image_gate:bo_nho_giai_nen_du_tinh', 'Bộ nhớ RAM giải nén dự tính')}:</span>{' '}
              <strong className="font-bold text-rose-600 dark:text-rose-400">
                ~{(estimatedRawMb / 1024).toFixed(2)} GB RAM
              </strong>
            </div>
          </div>
        </div>

        {/* Lời khuyên ngành in */}
        <div className="mt-2.5 rounded-lg border border-indigo-100 bg-indigo-50/70 p-2.5 text-[11px] leading-relaxed text-indigo-900 dark:border-indigo-900/50 dark:bg-indigo-950/40 dark:text-indigo-200">
          💡 <strong>{t('image_gate:chuan_nganh_in', 'Quy chuẩn in ấn')}:</strong>{' '}
          {t(
            'image_gate:loi_khuyen_poster',
            'Với poster/pano/standee khổ lớn từ 1 mét, độ phân giải 150 – 200 DPI đã đạt độ nét tối đa cho mắt nhìn. Độ phân giải quá cao (600 DPI) chỉ làm nặng máy gấp 16 lần mà không tăng thêm chất lượng in.',
          )}
        </div>

        {/* Danh sách các mức DPI */}
        <div className="mt-3.5 space-y-2">
          <div className="text-[11px] font-semibold text-slate-600 dark:text-zinc-400">
            {t('image_gate:chon_do_phan_giai', 'Chọn độ phân giải mong muốn:')}
          </div>

          {/* 150 DPI (Khuyến nghị chuẩn) */}
          <button
            type="button"
            disabled={isOptimizing}
            onClick={() => onOptimize(150)}
            className="flex w-full items-center justify-between rounded-lg border border-indigo-600 bg-indigo-600 px-3.5 py-2.5 text-left text-white shadow-sm transition hover:bg-indigo-700 disabled:opacity-60"
          >
            <div>
              <div className="text-[12px] font-bold flex items-center gap-1.5">
                <CheckCircle className="h-4 w-4 text-white" />
                {t('image_gate:toi_uu_150_dpi', 'Tự động tối ưu về 150 DPI (Khuyến nghị in ấn)')}
              </div>
              <div className="text-[10px] text-indigo-100 mt-0.5">
                {t('image_gate:giam_dung_luong_mo_ngay', `Giảm xuống ~${stats150.mp} MP, mở ngay trong 2-3s, giữ 100% độ nét khi in.`, { mp: stats150.mp })}
              </div>
            </div>
            {isOptimizing && optimizingDpi === 150 && (
              <RefreshCw className="h-4 w-4 animate-spin text-white" />
            )}
          </button>

          {/* 200 DPI (Chất lượng cao) */}
          <button
            type="button"
            disabled={isOptimizing}
            onClick={() => onOptimize(200)}
            className="flex w-full items-center justify-between rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-left text-slate-700 hover:bg-slate-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-750 disabled:opacity-60"
          >
            <div>
              <div className="text-[11px] font-semibold">
                {t('image_gate:toi_uu_200_dpi', 'Tối ưu về 200 DPI (Chất lượng cao)')}
              </div>
              <div className="text-[9.5px] text-slate-400 dark:text-zinc-400">
                {t('image_gate:chat_luong_cao_mo_ta', `~${stats200.mp} MP — Độ mịn cao hơn, phù hợp cự ly nhìn gần < 0.8m.`, { mp: stats200.mp })}
              </div>
            </div>
            {isOptimizing && optimizingDpi === 200 && (
              <RefreshCw className="h-4 w-4 animate-spin text-indigo-600 dark:text-indigo-400" />
            )}
          </button>

          {/* 300 DPI (Sắc nét tối đa) */}
          <button
            type="button"
            disabled={isOptimizing}
            onClick={() => onOptimize(300)}
            className="flex w-full items-center justify-between rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-left text-slate-700 hover:bg-slate-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-750 disabled:opacity-60"
          >
            <div>
              <div className="text-[11px] font-semibold flex items-center gap-1.5">
                <Sparkles className="h-3.5 w-3.5 text-amber-500" />
                {t('image_gate:toi_uu_300_dpi', 'Tối ưu về 300 DPI (Sắc nét tối đa)')}
              </div>
              <div className="text-[9.5px] text-slate-400 dark:text-zinc-400">
                {t('image_gate:sac_net_toi_da_mo_ta', `~${stats300.mp} MP — Chuẩn in offset cự ly cực gần < 0.4m, chi tiết cao.`, { mp: stats300.mp })}
              </div>
            </div>
            {isOptimizing && optimizingDpi === 300 && (
              <RefreshCw className="h-4 w-4 animate-spin text-indigo-600 dark:text-indigo-400" />
            )}
          </button>

          {/* 100 DPI (Pano / Billboard) */}
          <button
            type="button"
            disabled={isOptimizing}
            onClick={() => onOptimize(100)}
            className="flex w-full items-center justify-between rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-left text-slate-700 hover:bg-slate-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-750 disabled:opacity-60"
          >
            <div>
              <div className="text-[11px] font-semibold">
                {t('image_gate:toi_uu_100_dpi', 'Tối ưu về 100 DPI (Pano / Billboard)')}
              </div>
              <div className="text-[9.5px] text-slate-400 dark:text-zinc-400">
                {t('image_gate:pano_billboard_mo_ta', `~${stats100.mp} MP — Siêu nhẹ, phù hợp bảng hiệu, backdrop khổ lớn nhìn xa > 2m.`, { mp: stats100.mp })}
              </div>
            </div>
            {isOptimizing && optimizingDpi === 100 && (
              <RefreshCw className="h-4 w-4 animate-spin text-indigo-600 dark:text-indigo-400" />
            )}
          </button>

          {/* Tùy chỉnh DPI thủ công */}
          <div className="rounded-lg border border-slate-200 bg-slate-50/80 p-2.5 dark:border-zinc-800 dark:bg-zinc-800/40">
            <button
              type="button"
              disabled={isOptimizing}
              onClick={() => setShowCustom(!showCustom)}
              className="flex w-full items-center justify-between text-left text-[11px] font-semibold text-slate-700 hover:text-indigo-600 dark:text-zinc-300 dark:hover:text-indigo-400"
            >
              <span className="flex items-center gap-1.5">
                <SlidersHorizontal className="h-3.5 w-3.5 text-slate-500" />
                {t('image_gate:tuy_chinh_dpi', 'Tùy chỉnh DPI khác')}
              </span>
              <span className="text-[10px] text-slate-400">{showCustom ? '▲ Thu gọn' : '▼ Nhập số DPI'}</span>
            </button>

            {showCustom && (
              <div className="mt-2.5 pt-2 border-t border-slate-200 dark:border-zinc-700 flex flex-wrap items-center gap-2">
                <div className="flex items-center gap-1.5">
                  <input
                    type="number"
                    min={50}
                    max={Math.max(currentDpi, 600)}
                    step={10}
                    value={customDpi}
                    onChange={(e) => setCustomDpi(Number(e.target.value) || 150)}
                    disabled={isOptimizing}
                    className="w-20 rounded border border-slate-300 bg-white px-2 py-1 text-[11px] font-bold text-slate-800 focus:border-indigo-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                  />
                  <span className="text-[11px] font-medium text-slate-500">DPI</span>
                </div>
                <div className="text-[10px] text-slate-500 dark:text-zinc-400 flex-1 min-w-[140px]">
                  ~{customStats.mp} MP (~{customStats.rawMb} MB RAM)
                </div>
                <button
                  type="button"
                  disabled={isOptimizing || !customDpi}
                  onClick={() => onOptimize(safeCustomDpi)}
                  className="rounded bg-indigo-600 px-3 py-1 text-[11px] font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
                >
                  {isOptimizing && optimizingDpi === safeCustomDpi ? (
                    <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    t('image_gate:ap_dung_tuy_chinh', `Áp dụng ${safeCustomDpi} DPI`, { dpi: safeCustomDpi })
                  )}
                </button>
              </div>
            )}
          </div>

          {/* Chân Modal */}
          <div className="flex items-center justify-between pt-2 border-t border-slate-200 dark:border-zinc-800">
            <button
              type="button"
              disabled={isOptimizing}
              onClick={onProceedOriginal}
              className="text-[10.5px] font-medium text-slate-500 hover:text-slate-800 hover:underline dark:text-zinc-400 dark:hover:text-zinc-200 disabled:opacity-50"
            >
              {t('image_gate:tiep_tuc_mo_anh_goc', 'Mở ảnh gốc không nén (Nguy cơ đơ máy)')}
            </button>
            <button
              type="button"
              disabled={isOptimizing}
              onClick={onCancel}
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-[11px] font-semibold text-slate-600 hover:bg-slate-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800 disabled:opacity-50"
            >
              {t('common:cancel', 'Hủy bỏ')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
