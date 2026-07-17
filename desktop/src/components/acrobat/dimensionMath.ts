import type { Guide } from './GuideLayer';

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
