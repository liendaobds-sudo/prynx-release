import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import {
  addRotatedBlankPage,
  buildBackendCombineManifest,
  visiblePageSize,
} from './combineAssembly';

describe('Combine backend manifest contract', () => {
  it('deduplicates files while preserving whole-file and selected-page semantics', () => {
    const first = new File([new Uint8Array([1])], 'first.pdf', { type: 'application/pdf' });
    const second = new File([new Uint8Array([2])], 'second.pdf', { type: 'application/pdf' });

    const result = buildBackendCombineManifest([
      { type: 'single', file: first, rotation: 90 },
      { type: 'single', file: first, pageIndex: 2, rotation: 180 },
      { type: 'blank', rotation: 270 },
      { type: 'single', file: second },
    ]);

    expect(result.files).toEqual([first, second]);
    expect(result.manifest).toEqual([
      { file_index: 0, rotation: 90 },
      { file_index: 0, page_index: 2, rotation: 180 },
      { blank: true, rotation: 270 },
      { file_index: 1, rotation: 0 },
    ]);
    expect('page_index' in result.manifest[0]).toBe(false);
  });

  it('rotates blank pages and reports their visible dimensions', async () => {
    const document = await PDFDocument.create();
    const blank = addRotatedBlankPage(document, [200, 300], 90);

    expect(blank.getRotation().angle).toBe(90);
    expect(visiblePageSize(blank)).toEqual([300, 200]);

    const saved = await document.save();
    const reopened = await PDFDocument.load(saved);
    expect(reopened.getPage(0).getRotation().angle).toBe(90);
    expect(visiblePageSize(reopened.getPage(0))).toEqual([300, 200]);
  });
});
