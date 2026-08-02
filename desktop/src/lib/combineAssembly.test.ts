import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import {
  addRotatedBlankPage,
  buildBackendCombineManifest,
  hasPdfHeader,
  isCompletePdfBytes,
  toExactArrayBuffer,
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

describe('Combine PDF byte contract', () => {
  it('chỉ chuyển đúng byte-window của Uint8Array sang Blob', async () => {
    const backing = new Uint8Array([99, 37, 80, 68, 70, 45, 49, 46, 55, 10, 37, 37, 69, 79, 70, 88]);
    const pdfWindow = backing.subarray(1, backing.length - 1);

    const exact = toExactArrayBuffer(pdfWindow);
    const blob = new Blob([exact], { type: 'application/pdf' });

    expect(exact.byteLength).toBe(pdfWindow.byteLength);
    expect(blob.size).toBe(pdfWindow.byteLength);
    expect(Array.from(new Uint8Array(await blob.arrayBuffer()))).toEqual(Array.from(pdfWindow));
  });

  it('không copy thêm khi Uint8Array đã phủ toàn ArrayBuffer', () => {
    const bytes = new Uint8Array([37, 80, 68, 70, 45, 37, 37, 69, 79, 70]);

    expect(toExactArrayBuffer(bytes)).toBe(bytes.buffer);
  });

  it('kiểm chữ ký đầu và %%EOF ở phần cuối byte-window', () => {
    const complete = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55, 10, 37, 37, 69, 79, 70]);
    const backing = new Uint8Array(complete.byteLength + 2);
    backing[0] = 99;
    backing.set(complete, 1);
    backing[backing.length - 1] = 88;
    const pdfWindow = backing.subarray(1, backing.length - 1);

    expect(hasPdfHeader(pdfWindow)).toBe(true);
    expect(isCompletePdfBytes(pdfWindow)).toBe(true);
    expect(isCompletePdfBytes(backing)).toBe(false);
    expect(isCompletePdfBytes(complete.subarray(0, 9))).toBe(false);
    expect(isCompletePdfBytes(new Uint8Array())).toBe(false);
  });

  it('chấp nhận PDF thật do pdf-lib tạo', async () => {
    const document = await PDFDocument.create();
    document.addPage([200, 300]);

    expect(isCompletePdfBytes(await document.save())).toBe(true);
  });
});

describe('Combine backend image manifest contract', () => {
  it('accepts PNG/JPG sources and rejects formats outside the backend whitelist', () => {
    const png = new File([new Uint8Array([1])], 'first.PNG', { type: 'image/png' });
    const jpeg = new File([new Uint8Array([2])], 'second.jpeg', { type: 'image/jpeg' });

    const result = buildBackendCombineManifest([
      { type: 'single', file: png, rotation: 90 },
      { type: 'single', file: jpeg },
    ]);

    expect(result.files).toEqual([png, jpeg]);
    expect(result.manifest).toEqual([
      { file_index: 0, rotation: 90 },
      { file_index: 1, rotation: 0 },
    ]);

    const webp = new File([new Uint8Array([3])], 'third.webp', { type: 'image/webp' });
    expect(() => buildBackendCombineManifest([{ type: 'single', file: webp }]))
      .toThrow(/PDF, PNG hoặc JPG/);
  });
});
