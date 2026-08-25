import { describe, expect, it } from 'vitest';
import {
  fitThumbnailPageSize,
  findDimensionCandidate,
  formatDimension,
  formatPageSizeMm,
  formatRotatedPageSizePx96,
} from './dimensionMath';
import type { Guide } from './GuideLayer';

const guides: Guide[] = [
  { id: 'v1', type: 'vertical', pos: 0.1 },
  { id: 'v2', type: 'vertical', pos: 0.6 },
  { id: 'h1', type: 'horizontal', pos: 0.2 },
  { id: 'h2', type: 'horizontal', pos: 0.8 },
];

describe('dimensionMath', () => {
  it('formats real PDF point distances', () => {
    expect(formatDimension(72, 'inch')).toBe('1 in');
    expect(formatDimension(72, 'mm')).toBe('25.4 mm');
    expect(formatDimension(72, 'cm')).toBe('2.54 cm');
  });
  it('giữ một chữ số thập phân cho kích thước trang PDF', () => {
    const pointsPerMm = 72 / 25.4;
    expect(formatPageSizeMm(147.1215 * pointsPerMm, 51.3327 * pointsPerMm))
      .toBe('147.1 × 51.3 mm');
    expect(formatPageSizeMm(210 * pointsPerMm, 297 * pointsPerMm))
      .toBe('210.0 × 297.0 mm');
    expect(formatPageSizeMm(148.55 * pointsPerMm, 50 * pointsPerMm))
      .toBe('148.6 × 50.0 mm');
  });
  it('hoán rộng và cao của tooltip thumbnail sau khi xoay 90 hoặc 270 độ', () => {
    const pxPerMm = 96 / 25.4;
    const widthPx = 147.1215 * pxPerMm;
    const heightPx = 51.3327 * pxPerMm;
    const portrait = { widthMm: '147.1', heightMm: '51.3' };
    const landscape = { widthMm: '51.3', heightMm: '147.1' };

    expect(formatRotatedPageSizePx96(widthPx, heightPx, 0)).toEqual(portrait);
    expect(formatRotatedPageSizePx96(widthPx, heightPx, 90)).toEqual(landscape);
    expect(formatRotatedPageSizePx96(widthPx, heightPx, 180)).toEqual(portrait);
    expect(formatRotatedPageSizePx96(widthPx, heightPx, 270)).toEqual(landscape);
    expect(formatRotatedPageSizePx96(widthPx, heightPx, -90)).toEqual(landscape);
  });
  it('giữ cùng footprint thumbnail trước và sau khi bake góc xoay 90 độ', () => {
    const displayWidth = 120;
    const cases: Array<[number, number, { width: number; height: number }]> = [
      [160, 100, { width: 120, height: 192 }],
      [100, 160, { width: 120, height: 75 }],
    ];

    for (const [sourceWidth, sourceHeight, expectedFootprint] of cases) {
      for (const rotation of [90, 270, -90]) {
        const source = fitThumbnailPageSize(sourceWidth, sourceHeight, displayWidth, rotation);
        const sourceAfterCssRotation = { width: source.height, height: source.width };
        const baked = fitThumbnailPageSize(sourceHeight, sourceWidth, displayWidth, 0);

        expect(sourceAfterCssRotation).toEqual(expectedFootprint);
        expect(baked).toEqual(sourceAfterCssRotation);
      }
    }
  });
  it('creates a horizontal DIM between vertical guides', () => {
    expect(findDimensionCandidate(guides.slice(0, 2), 0.3, 0.5, 600, 800)).toEqual({ orientation: 'horizontal', guideAId: 'v1', guideBId: 'v2' });
  });
  it('allows the DIM display position to be outside the page', () => {
    expect(findDimensionCandidate(guides.slice(0, 2), 0.3, -0.25, 600, 800)?.orientation).toBe('horizontal');
    expect(findDimensionCandidate(guides.slice(2), 1.25, 0.4, 600, 800)?.orientation).toBe('vertical');
  });
  it('creates a vertical DIM between horizontal guides', () => {
    expect(findDimensionCandidate(guides.slice(2), 0.5, 0.4, 600, 800)).toEqual({ orientation: 'vertical', guideAId: 'h1', guideBId: 'h2' });
  });
  it('returns null outside every guide pair', () => {
    expect(findDimensionCandidate(guides, 0.9, 0.9, 600, 800)).toBeNull();
  });
  it('chooses the smaller physical span when both axes match', () => {
    expect(findDimensionCandidate(guides, 0.3, 0.4, 600, 800)?.orientation).toBe('horizontal');
  });
});
