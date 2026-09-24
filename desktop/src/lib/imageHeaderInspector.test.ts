// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { inspectImageHeader, OVERSIZED_PIXEL_THRESHOLD } from './imageHeaderInspector';

// PNG 100x200 pixel, pHYs = 300 DPI
function createMockPngBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(64);
  // PNG signature
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  // IHDR chunk: length 13, type IHDR
  bytes.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8);
  // width (32-bit BE)
  bytes[16] = (width >>> 24) & 0xff;
  bytes[17] = (width >>> 16) & 0xff;
  bytes[18] = (width >>> 8) & 0xff;
  bytes[19] = width & 0xff;
  // height (32-bit BE)
  bytes[20] = (height >>> 24) & 0xff;
  bytes[21] = (height >>> 16) & 0xff;
  bytes[22] = (height >>> 8) & 0xff;
  bytes[23] = height & 0xff;
  return bytes;
}

// JPEG 150x250 pixel
function createMockJpegBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(64);
  // SOI marker
  bytes.set([0xff, 0xd8, 0xff, 0xc0], 0);
  // SOF0 length (11 bytes), precision (8)
  bytes.set([0x00, 0x11, 0x08], 4);
  // height (16-bit BE)
  bytes[7] = (height >>> 8) & 0xff;
  bytes[8] = height & 0xff;
  // width (16-bit BE)
  bytes[9] = (width >>> 8) & 0xff;
  bytes[10] = width & 0xff;
  return bytes;
}

describe('imageHeaderInspector', () => {
  it('đọc đúng kích thước PNG thông thường và xác định không bị oversized', async () => {
    const pngBytes = createMockPngBytes(1200, 1800);
    const file = new File([pngBytes as unknown as BlobPart], 'normal.png', { type: 'image/png' });

    const info = await inspectImageHeader(file);
    expect(info).not.toBeNull();
    expect(info?.format).toBe('png');
    expect(info?.width).toBe(1200);
    expect(info?.height).toBe(1800);
    expect(info?.totalPixels).toBe(2160000);
    expect(info?.isOversized).toBe(false);
  });

  it('phát hiện chính xác ảnh PNG khổng lồ (oversized > 80 Megapixels)', async () => {
    // 18896 x 28346 px (như file HADECO poster 535 Megapixels)
    const pngBytes = createMockPngBytes(18896, 28346);
    const file = new File([pngBytes as unknown as BlobPart], 'giant_poster.png', { type: 'image/png' });

    const info = await inspectImageHeader(file);
    expect(info).not.toBeNull();
    expect(info?.width).toBe(18896);
    expect(info?.height).toBe(28346);
    expect(info?.totalPixels).toBe(535626016);
    expect(info?.totalPixels).toBeGreaterThan(OVERSIZED_PIXEL_THRESHOLD);
    expect(info?.isOversized).toBe(true);
    expect(info?.estimatedRawMb).toBeGreaterThan(2000);
  });

  it('đọc đúng kích thước JPEG', async () => {
    const jpegBytes = createMockJpegBytes(800, 600);
    const file = new File([jpegBytes as unknown as BlobPart], 'photo.jpg', { type: 'image/jpeg' });

    const info = await inspectImageHeader(file);
    expect(info).not.toBeNull();
    expect(info?.format).toBe('jpeg');
    expect(info?.width).toBe(800);
    expect(info?.height).toBe(600);
    expect(info?.isOversized).toBe(false);
  });

  it('trả về null nếu file không phải định dạng ảnh được hỗ trợ hoặc bị cắt cụt', async () => {
    const emptyFile = new File([new Uint8Array([0, 1, 2]) as unknown as BlobPart], 'corrupt.png', { type: 'image/png' });
    const info = await inspectImageHeader(emptyFile);
    expect(info).toBeNull();
  });

  it('bảo vệ an toàn cho path-stub File lớn (khi blob rỗng nhưng file.size >= 50MB)', async () => {
    const stubFile = new File([], 'HADECO_Poster 90x120_L copy.png', { type: 'image/png' });
    Object.defineProperty(stubFile, 'size', { value: 151_000_000, configurable: true });
    Object.defineProperty(stubFile, 'path', { value: 'C:\\test\\poster.png', configurable: true });

    const info = await inspectImageHeader(stubFile);
    expect(info).not.toBeNull();
    expect(info?.isOversized).toBe(true);
  });
});

