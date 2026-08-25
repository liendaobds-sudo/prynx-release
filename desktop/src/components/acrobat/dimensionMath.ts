import type { Guide } from './GuideLayer';
import { roundMeasurement } from '../../lib/measurementFormat';

export type MeasurementUnit = 'mm' | 'cm' | 'inch';
export type DimensionMeasurement = { id: string; page: number; orientation: 'horizontal' | 'vertical'; guideAId: string; guideBId: string; offsetRatio: number };
export type DimensionCandidate = Pick<DimensionMeasurement, 'orientation' | 'guideAId' | 'guideBId'>;

export function findDimensionCandidate(guides: Guide[], xRatio: number, yRatio: number, pageWidthPt: number, pageHeightPt: number): DimensionCandidate | null {
  const pair = (type: Guide['type'], value: number) => {
    const sorted = guides.filter(g => g.type === type).sort((a, b) => a.pos - b.pos);
    for (let i = 0; i < sorted.length - 1; i += 1) if (sorted[i].pos <= value && value <= sorted[i + 1].pos) return [sorted[i], sorted[i + 1]] as const;
    return null;
  };
  const vertical = pair('vertical', xRatio);
  const horizontal = pair('horizontal', yRatio);
  if (!vertical && !horizontal) return null;
  if (vertical && !horizontal) return { orientation: 'horizontal', guideAId: vertical[0].id, guideBId: vertical[1].id };
  if (horizontal && !vertical) return { orientation: 'vertical', guideAId: horizontal[0].id, guideBId: horizontal[1].id };
  const verticalSpanPt = Math.abs(vertical![1].pos - vertical![0].pos) * pageWidthPt;
  const horizontalSpanPt = Math.abs(horizontal![1].pos - horizontal![0].pos) * pageHeightPt;
  return verticalSpanPt <= horizontalSpanPt
    ? { orientation: 'horizontal', guideAId: vertical![0].id, guideBId: vertical![1].id }
    : { orientation: 'vertical', guideAId: horizontal![0].id, guideBId: horizontal![1].id };
}

export function formatDimension(points: number, unit: MeasurementUnit): string {
  const value = unit === 'mm' ? points * 25.4 / 72 : unit === 'cm' ? points * 2.54 / 72 : points / 72;
  const digits = unit === 'inch' ? 3 : 2;
  return `${value.toFixed(digits).replace(/\.?0+$/, '')} ${unit === 'inch' ? 'in' : unit}`;
}

// UIUX (fix 2026-08-04): badge kích thước trang giữ chính xác 0,1 mm,
// đồng bộ với thumbnail, thanh trạng thái và kích thước thành phẩm Bình trang.
export function formatPageSizeMm(widthPoints: number, heightPoints: number): string {
  const ptToMm = 25.4 / 72;
  return `${roundMeasurement(widthPoints * ptToMm).toFixed(1)} × ${roundMeasurement(heightPoints * ptToMm).toFixed(1)} mm`;
}

// UIUX (fix New Window 2026-08-25 §NW.TH.1): `thumbBaseWidth` là chiều rộng
// HIỂN THỊ sau xoay. Main giữ góc ở CSS còn child đã bake góc vào PDF, nên phải
// tính inner box theo góc để cả hai biểu diễn có cùng footprint.
export function fitThumbnailPageSize(
  widthPx: number | undefined,
  heightPx: number | undefined,
  displayWidthPx: number,
  rotationDegrees = 0,
): { width: number; height: number } {
  const hasValidPageSize = typeof widthPx === 'number'
    && Number.isFinite(widthPx)
    && widthPx > 0
    && typeof heightPx === 'number'
    && Number.isFinite(heightPx)
    && heightPx > 0;
  const safeWidth = hasValidPageSize ? widthPx : 1;
  const safeHeight = hasValidPageSize ? heightPx : 1.414;
  const safeDisplayWidth = Number.isFinite(displayWidthPx) && displayWidthPx > 0
    ? displayWidthPx
    : 1;
  const ratio = safeHeight / safeWidth;
  const normalizedRotation = ((rotationDegrees % 360) + 360) % 360;
  const swapsAxes = normalizedRotation === 90 || normalizedRotation === 270;

  return {
    width: Math.max(1, Math.round(swapsAxes ? safeDisplayWidth / ratio : safeDisplayWidth)),
    height: Math.max(1, Math.round(swapsAxes ? safeDisplayWidth : safeDisplayWidth * ratio)),
  };
}

// UIUX (audit 2026-08-04 §DIM.6): tooltip thumbnail phải phản ánh khổ trang sau xoay;
// px@96 chỉ được đổi sang mm tại tầng hiển thị và luôn giữ chính xác 0,1 mm.
export function formatRotatedPageSizePx96(
  widthPx: number,
  heightPx: number,
  rotationDegrees: number,
): { widthMm: string; heightMm: string } {
  const normalizedRotation = ((rotationDegrees % 360) + 360) % 360;
  const swapsAxes = normalizedRotation === 90 || normalizedRotation === 270;
  const displayWidthPx = swapsAxes ? heightPx : widthPx;
  const displayHeightPx = swapsAxes ? widthPx : heightPx;
  const pxToMm = 25.4 / 96;

  return {
    widthMm: roundMeasurement(displayWidthPx * pxToMm).toFixed(1),
    heightMm: roundMeasurement(displayHeightPx * pxToMm).toFixed(1),
  };
}
