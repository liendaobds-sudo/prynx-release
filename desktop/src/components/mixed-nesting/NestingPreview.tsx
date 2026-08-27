/**
 * Xem trước nhiều tờ — phase P11.
 *
 * Kế hoạch: `docs/KE_HOACH_MIXED_TRUE_SHAPE_NESTING_DOC_LAP_2026-08-26.md` §13, §16.4.
 *
 * Bốn ràng buộc:
 *
 * 1. **Nguồn chân lý duy nhất là placement manifest.** Component này không tính lại layout,
 *    không nén lại, không đổi pivot. Mọi phép biến đổi đi qua
 *    `lib/mixed-nesting/previewGeometry` — cùng module mà bước xuất PDF đối chiếu.
 * 2. **Đổi hệ Y chỉ ở adapter.** SVG dùng `viewBox` theo mm và `toSvgPath` lo việc lật;
 *    component không tự trừ `height - y` ở đâu khác.
 * 3. **Tab nền không vẽ.** `isActive === false` thì chỉ hiện tóm tắt một dòng. Mười tab mở
 *    cùng lúc không dựng mười cây SVG hàng nghìn node.
 * 4. **Không có tương tác nào sửa pose.** Không kéo, không thả, không snap. Preview là
 *    *xem*; muốn đổi thì sửa đầu vào rồi chạy lại.
 *
 * Chuỗi hiển thị đang là tiếng Việt trực tiếp; P13 chuyển sang namespace i18n.
 */

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import {
  isInsideUsable,
  shapesBySheet,
  sheetViewBox,
  toSvgPath,
  usableRectMm,
  type PartSource,
  type PlacedShape,
} from '../../lib/mixed-nesting/previewGeometry';
import type { PlacementManifest, SheetSpec } from '../../lib/mixed-nesting/types';

export interface NestingPreviewProps {
  manifest: PlacementManifest;
  sheet: SheetSpec;
  sources: readonly PartSource[];
  activeSheetIndex: number;
  onActiveSheetChange: (index: number) => void;
  /** `false` ⇒ không dựng SVG. Đây là phần "pause tab nền" của gate P11. */
  isActive?: boolean;
}

/** Bảng màu theo `partId`, ổn định theo thứ tự xuất hiện để mắt nhận ra được loại nào. */
const PART_FILLS = [
  '#93c5fd',
  '#fca5a5',
  '#86efac',
  '#fcd34d',
  '#c4b5fd',
  '#f9a8d4',
  '#7dd3fc',
  '#fdba74',
] as const;

function fillFor(partIds: readonly string[], partId: string): string {
  const index = partIds.indexOf(partId);
  return PART_FILLS[(index < 0 ? 0 : index) % PART_FILLS.length];
}

function SheetSvg({
  sheet,
  shapes,
  partIds,
}: {
  sheet: SheetSpec;
  shapes: readonly PlacedShape[];
  partIds: readonly string[];
}) {
  const { t } = useTranslation();
  const usable = usableRectMm(sheet);
  return (
    <svg
      // Tỷ lệ do `viewBox` giữ; class chỉ chặn tràn khung.
      className="block h-auto max-w-full"
      viewBox={sheetViewBox(sheet)}
      // Khổ hiển thị do CSS quyết; `viewBox` giữ tỷ lệ thật của tờ.
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={t('mixedNesting.nestingPreview:to_w_x_h_mm_voi_n_chi_tiet', {
        w: sheet.widthMm,
        h: sheet.heightMm,
        n: shapes.length,
      })}
    >
      {/* Nền tờ */}
      <rect x={0} y={0} width={sheet.widthMm} height={sheet.heightMm} fill="#ffffff" />
      {/* Vùng dùng được sau khi trừ lề */}
      <rect
        x={usable.minX}
        y={sheet.heightMm - usable.maxY}
        width={usable.maxX - usable.minX}
        height={usable.maxY - usable.minY}
        fill="none"
        stroke="#cbd5e1"
        strokeWidth={0.5}
        strokeDasharray="3 2"
      />
      {shapes.map((shape) => {
        const canhBao = !isInsideUsable(shape, sheet);
        return (
          <path
            key={shape.instanceId}
            d={toSvgPath(shape, sheet)}
            fillRule="evenodd"
            fill={canhBao ? '#fecaca' : fillFor(partIds, shape.partId)}
            fillOpacity={0.85}
            stroke={canhBao ? '#dc2626' : '#334155'}
            strokeWidth={canhBao ? 0.8 : 0.4}
            data-instance-id={shape.instanceId}
            data-part-id={shape.partId}
            data-rotation-deg={shape.rotationDeg}
          />
        );
      })}
    </svg>
  );
}

export default function NestingPreview({
  manifest,
  sheet,
  sources,
  activeSheetIndex,
  onActiveSheetChange,
  isActive = true,
}: NestingPreviewProps) {
  const { t } = useTranslation();
  const partIds = useMemo(() => sources.map((source) => source.partId), [sources]);

  // Chỉ dựng hình khi tab đang xem. Đây là chốt "pause tab nền".
  const bySheet = useMemo(
    () => (isActive ? shapesBySheet(manifest.placements, sources) : null),
    [isActive, manifest.placements, sources],
  );

  const sheetIndices = useMemo(
    () => Array.from({ length: Math.max(1, manifest.stats.sheetCount) }, (_, index) => index),
    [manifest.stats.sheetCount],
  );

  if (!isActive) {
    return (
      <p className="text-[13px] text-slate-500 dark:text-zinc-400" data-testid="mn-preview-paused">
        {t('mixedNesting.nestingPreview:n_to_m_con_mo_lai_the_de_xem', {
          n: manifest.stats.sheetCount,
          m: manifest.stats.placedCount,
        })}
      </p>
    );
  }

  const safeIndex = sheetIndices.includes(activeSheetIndex) ? activeSheetIndex : 0;
  const shapes = bySheet?.get(safeIndex) ?? [];

  return (
    <div className="flex flex-col gap-3" data-testid="mn-preview">
      {sheetIndices.length > 1 && (
        <div
          className="flex gap-2 overflow-x-auto pb-1"
          role="tablist"
          aria-label={t('mixedNesting.nestingPreview:chon_to')}
        >
          {sheetIndices.map((index) => (
            <button
              key={index}
              type="button"
              role="tab"
              aria-selected={index === safeIndex}
              className={`h-8 rounded border px-3 text-[12px] font-medium whitespace-nowrap transition-colors ${
                index === safeIndex
                  ? 'border-indigo-500 bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300'
                  : 'border-slate-200 bg-white text-slate-600 hover:border-indigo-400 dark:border-white/10 dark:bg-zinc-900 dark:text-zinc-300'
              }`}
              onClick={() => onActiveSheetChange(index)}
            >
              {t('mixedNesting.nestingPreview:to_n', { n: index + 1 })}
              <span className="ml-1 opacity-60 tabular-nums">
                ({bySheet?.get(index)?.length ?? 0})
              </span>
            </button>
          ))}
        </div>
      )}

      <div
        className="rounded border border-slate-300 bg-white shadow-sm dark:border-white/10"
        data-sheet-index={safeIndex}
      >
        <SheetSvg sheet={sheet} shapes={shapes} partIds={partIds} />
      </div>

      <p className="text-[11px] text-slate-500 dark:text-zinc-400">
        {t('mixedNesting.nestingPreview:to_i_tren_n_m_con_hinh_lay_tu_phuong_an', {
          i: safeIndex + 1,
          n: sheetIndices.length,
          m: shapes.length,
        })}
      </p>
    </div>
  );
}
