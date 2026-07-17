import { describe, expect, it } from 'vitest';
import { findDimensionCandidate, formatDimension } from './dimensionMath';
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
