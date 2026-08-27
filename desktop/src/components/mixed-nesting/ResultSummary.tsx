/**
 * Tóm tắt kết quả — phase P11.
 *
 * Kế hoạch: `docs/KE_HOACH_MIXED_TRUE_SHAPE_NESTING_DOC_LAP_2026-08-26.md` §11.5, §13, §17.
 *
 * Ba quyết định về cách trình bày số:
 *
 * 1. **`materialUtilization` được tính LẠI từ contour**, không lấy số solver tự báo (§17).
 *    Nếu hai số lệch quá ngưỡng, UI nói ra thay vì im lặng chọn một số — lệch nghĩa là dữ
 *    liệu không nhất quán, và thợ in cần biết.
 * 2. **Pose hiển thị đủ chữ số.** Góc `13.372849°` được in nguyên; không `toFixed(1)`. Số
 *    chữ số hiển thị không được làm tròn dữ liệu (§9.3).
 * 3. **`terminationReason` được dịch thành câu người đọc hiểu**, và phân biệt rõ "không
 *    vừa thật" với "hết ngân sách tìm kiếm" — §11.4 cấm nói sai hai chuyện này.
 *
 * Chuỗi hiển thị đang là tiếng Việt trực tiếp; P13 chuyển sang namespace i18n.
 */

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import {
  shapesBySheet,
  usedAreaMm2,
  usedBoundsOf,
  type PartSource,
} from '../../lib/mixed-nesting/previewGeometry';
import {
  TERMINATION_TEXT,
  UNPLACED_TEXT,
  UTILIZATION_MISMATCH_TOLERANCE,
  formatMm,
  formatPercent,
  formatSeconds,
} from '../../lib/mixed-nesting/resultText';
import { collectPoseMetrics } from '../../lib/mixed-nesting/resultValidator';
import type { PlacementManifest, SheetSpec } from '../../lib/mixed-nesting/types';

export interface ResultSummaryProps {
  manifest: PlacementManifest;
  sheet: SheetSpec;
  sources: readonly PartSource[];
}

/**
 * Một dòng nhãn/giá trị. Nhãn 11px màu nhạt, giá trị đậm căn phải và dùng chữ số bảng —
 * cùng dáng với các dòng thống kê trong panel Bình tem bế.
 *
 * Giữ nguyên cặp `dt`/`dd`: đó là ngữ nghĩa đúng cho danh sách định nghĩa, và cũng là thứ
 * test tra theo (`dt` có nhãn → `nextElementSibling` là giá trị).
 */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-[11px] text-slate-500 dark:text-zinc-400 shrink-0">{label}</dt>
      <dd className="text-[12px] font-medium text-slate-800 dark:text-zinc-200 text-right tabular-nums min-w-0 truncate">
        {children}
      </dd>
    </div>
  );
}

export default function ResultSummary({ manifest, sheet, sources }: ResultSummaryProps) {
  const { t } = useTranslation();
  const { stats } = manifest;

  const derived = useMemo(() => {
    const bySheet = shapesBySheet(manifest.placements, sources);
    const sheetArea = sheet.widthMm * sheet.heightMm * Math.max(1, stats.sheetCount);
    let placedArea = 0;
    for (const shapes of bySheet.values()) placedArea += usedAreaMm2(shapes);

    const lastIndex = Math.max(0, stats.sheetCount - 1);
    const lastBounds = usedBoundsOf(bySheet.get(lastIndex) ?? []);

    return {
      recomputedUtilization: sheetArea > 0 ? placedArea / sheetArea : null,
      lastSheetBounds: lastBounds,
      poseMetrics: collectPoseMetrics(manifest.placements),
    };
  }, [manifest.placements, sheet.heightMm, sheet.widthMm, sources, stats.sheetCount]);

  const utilizationMismatch =
    derived.recomputedUtilization !== null
    && Math.abs(derived.recomputedUtilization - stats.materialUtilization)
      > UTILIZATION_MISMATCH_TOLERANCE;

  return (
    <section className="flex flex-col gap-3" data-testid="mn-result-summary">
      <span className="text-[11px] font-bold text-slate-600 dark:text-zinc-400 uppercase tracking-wide">
        {t('mixedNesting.resultSummary:ket_qua')}
      </span>
      <dl className="flex flex-col gap-1.5">
        <Row label={t('mixedNesting.resultSummary:so_to')}>{stats.sheetCount}</Row>
        <Row label={t('mixedNesting.resultSummary:da_xep')}>{stats.placedCount}</Row>
        <Row label={t('mixedNesting.resultSummary:chua_xep')}>
          <span className={stats.unplacedCount > 0 ? 'text-red-600 dark:text-red-400' : undefined}>
            {stats.unplacedCount}
          </span>
        </Row>
        <Row label={t('mixedNesting.resultSummary:ty_le_dung_vat_lieu')}>
          {derived.recomputedUtilization === null
            ? '—'
            : formatPercent(derived.recomputedUtilization)}
        </Row>
        <Row label={t('mixedNesting.resultSummary:ket_thuc_vi')}>
          <span className="whitespace-normal">{TERMINATION_TEXT[stats.terminationReason]}</span>
        </Row>
        <Row label={t('mixedNesting.resultSummary:thoi_gian')}>
          {formatSeconds(stats.elapsedMs)}
        </Row>
        {derived.lastSheetBounds && (
          <Row label={t('mixedNesting.resultSummary:phan_da_dung_o_to_cuoi')}>
            {`${formatMm(derived.lastSheetBounds.maxX - derived.lastSheetBounds.minX)} × ${formatMm(
              derived.lastSheetBounds.maxY - derived.lastSheetBounds.minY,
            )}`}
          </Row>
        )}
        <Row label={t('mixedNesting.resultSummary:goc_khong_vuong')}>
          {`${derived.poseMetrics.nonCardinalAngleCount} / ${manifest.placements.length}`}
        </Row>
      </dl>

      {utilizationMismatch && (
        <p
          className="rounded border border-amber-300 bg-amber-50 p-2 text-[11px] text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300"
          role="alert"
          data-testid="mn-utilization-mismatch"
        >
          {t('mixedNesting.resultSummary:ty_le_tinh_lai_khac_so_engine', {
            recomputed: formatPercent(derived.recomputedUtilization ?? 0),
            reported: formatPercent(stats.materialUtilization),
          })}
        </p>
      )}

      {stats.unplacedCount > 0 && (
        <div className="flex flex-col gap-1" data-testid="mn-unplaced">
          <h3 className="text-[11px] font-bold text-red-600 dark:text-red-400 uppercase tracking-wide">
            {t('mixedNesting.resultSummary:chua_xep_duoc_n', { n: stats.unplacedCount })}
          </h3>
          <ul className="flex flex-col gap-0.5 text-[11px] text-slate-600 dark:text-zinc-300">
            {manifest.unplaced.map((entry) => (
              <li key={entry.instanceId}>
                <span className="font-medium">{entry.instanceId}</span>
                {' — '}
                {UNPLACED_TEXT[entry.reason]}
              </li>
            ))}
          </ul>
        </div>
      )}

      <details className="text-[11px] text-slate-500 dark:text-zinc-400">
        <summary className="cursor-pointer">
          {t('mixedNesting.resultSummary:chi_tiet_ky_thuat')}
        </summary>
        <dl className="mt-2 flex flex-col gap-1">
          <Row label={t('mixedNesting.resultSummary:phien_ban_engine')}>
            {manifest.engineVersion}
          </Row>
          <Row label={t('mixedNesting.resultSummary:seed')}>{manifest.seed}</Row>
          <Row label={t('mixedNesting.resultSummary:so_luot_thu')}>{stats.attempts}</Row>
          <Row label={t('mixedNesting.resultSummary:luot_xet_huong')}>
            {stats.orientationEvaluations}
          </Row>
          <Row label={t('mixedNesting.resultSummary:luot_tinh_chinh')}>
            {stats.poseRefinements}
          </Row>
          <Row label={t('mixedNesting.resultSummary:toa_do_co_phan_le')}>
            {`${derived.poseMetrics.fractionalTranslationCount} / ${manifest.placements.length}`}
          </Row>
          <Row label={t('mixedNesting.resultSummary:so_goc_khac_nhau')}>
            {derived.poseMetrics.distinctAngles}
          </Row>
          <Row label={t('mixedNesting.resultSummary:ban_kiem')}>
            {`v${manifest.validation.validatorVersion}`}
          </Row>
        </dl>
      </details>
    </section>
  );
}
