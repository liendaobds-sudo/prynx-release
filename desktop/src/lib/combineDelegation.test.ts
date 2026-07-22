import { describe, expect, it } from 'vitest';
import {
  LARGE_COMBINE_BYTES,
  LARGE_COMBINE_PAGES,
  shouldDelegateLargePdfJob,
} from './combineDelegation';

const pdfNode = (name: string, size: number, extra = {}) => ({
  type: 'single',
  file: { name, size },
  rotation: 0,
  ...extra,
});

describe('shouldDelegateLargePdfJob', () => {
  it('delegates a simple PDF job at the byte threshold', () => {
    const nodes = [pdfNode('a.pdf', LARGE_COMBINE_BYTES / 2), pdfNode('b.pdf', LARGE_COMBINE_BYTES / 2)];
    expect(shouldDelegateLargePdfJob(nodes, {}, { scaleMode: 'keep' })).toBe(true);
  });

  it('delegates a simple PDF job at the page threshold', () => {
    const nodes = [pdfNode('a.pdf', 1), pdfNode('b.pdf', 1)];
    const counts = { 'a.pdf-1': LARGE_COMBINE_PAGES - 1, 'b.pdf-1': 1 };
    expect(shouldDelegateLargePdfJob(nodes, counts, { scaleMode: 'keep' })).toBe(true);
  });

  it.each([
    { nodes: [pdfNode('a.pdf', LARGE_COMBINE_BYTES), pdfNode('b.pdf', 1, { rotation: 90 })], options: { scaleMode: 'keep' } },
    { nodes: [pdfNode('a.pdf', LARGE_COMBINE_BYTES), pdfNode('b.pdf', 1, { pageIndex: 0 })], options: { scaleMode: 'keep' } },
    { nodes: [pdfNode('a.pdf', LARGE_COMBINE_BYTES), pdfNode('b.png', 1)], options: { scaleMode: 'keep' } },
    { nodes: [pdfNode('a.pdf', LARGE_COMBINE_BYTES), pdfNode('b.pdf', 1)], options: { scaleMode: 'fit_a4' } },
    { nodes: [pdfNode('a.pdf', LARGE_COMBINE_BYTES), pdfNode('b.pdf', 1)], options: { scaleMode: 'keep', groupingEnabled: true } },
  ])('keeps transformed or non-PDF jobs in the frontend path', ({ nodes, options }) => {
    expect(shouldDelegateLargePdfJob(nodes, {}, options)).toBe(false);
  });

  it('delegates transformed PDF nodes through the manifest path', () => {
    const nodes = [
      pdfNode('a.pdf', LARGE_COMBINE_BYTES, { pageIndex: 2, rotation: 90 }),
      { type: 'blank', rotation: 0 },
    ];
    expect(shouldDelegateLargePdfJob(nodes, {}, { scaleMode: 'keep', allowManifest: true })).toBe(true);
  });
});
