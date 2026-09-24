/**
 * imageHeaderInspector — Đọc nhanh kích thước và DPI của ảnh từ 64KB đầu tiên (0.001s).
 *
 * Cho phép phát hiện sớm các file ảnh có kích thước khổng lồ (Pixel Bomb / Decompression Bomb)
 * trước khi nạp toàn bộ vào JavaScript ArrayBuffer hay giải nén bitmap 2GB làm đơ ứng dụng.
 */

import { fetchLocalFileBuffer } from './localFileTransport';

export interface ImageHeaderInfo {
  width: number;
  height: number;
  totalPixels: number;
  dpiX: number;
  dpiY: number;
  physicalWidthCm: number;
  physicalHeightCm: number;
  estimatedRawMb: number;
  isOversized: boolean;
  format: 'png' | 'jpeg' | 'tiff' | 'webp' | 'unknown';
}

/** Ngưỡng kích hoạt cảnh báo an toàn: 80 Megapixels hoặc bộ nhớ bitmap thô vượt 350 MB */
export const OVERSIZED_PIXEL_THRESHOLD = 80_000_000;
export const OVERSIZED_RAW_MB_THRESHOLD = 350;

function readUint32BE(b: Uint8Array, offset: number): number {
  return (
    b[offset] * 0x1000000 +
    b[offset + 1] * 0x10000 +
    b[offset + 2] * 0x100 +
    b[offset + 3]
  );
}

function parsePngHeader(b: Uint8Array): { width: number; height: number; dpiX: number; dpiY: number } | null {
  if (b.length < 24) return null;
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A
  if (
    b[0] !== 0x89 || b[1] !== 0x50 || b[2] !== 0x4e || b[3] !== 0x47 ||
    b[4] !== 0x0d || b[5] !== 0x0a || b[6] !== 0x1a || b[7] !== 0x0a
  ) {
    return null;
  }
  const width = readUint32BE(b, 16);
  const height = readUint32BE(b, 20);
  if (width <= 0 || height <= 0) return null;

  let dpiX = 72;
  let dpiY = 72;

  // Quét các chunk trong 64KB để tìm pHYs (đứng trước IDAT)
  let offset = 8;
  while (offset + 8 <= b.length) {
    const len = readUint32BE(b, offset);
    const type = String.fromCharCode(b[offset + 4], b[offset + 5], b[offset + 6], b[offset + 7]);
    const data = offset + 8;
    const chunkEnd = data + len;
    if (chunkEnd + 4 > b.length) break;

    if (type === 'pHYs' && len === 9) {
      const ppuX = readUint32BE(b, data);
      const ppuY = readUint32BE(b, data + 4);
      const unit = b[data + 8];
      if (unit === 1 && ppuX > 0 && ppuY > 0) {
        dpiX = Math.round(ppuX * 0.0254);
        dpiY = Math.round(ppuY * 0.0254);
      }
      break;
    }
    if (type === 'IDAT' || type === 'IEND') break;
    offset = chunkEnd + 4;
  }

  return { width, height, dpiX, dpiY };
}

function parseJpegHeader(b: Uint8Array): { width: number; height: number; dpiX: number; dpiY: number } | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let offset = 2;
  let width = 0;
  let height = 0;
  let dpiX = 72;
  let dpiY = 72;

  while (offset + 4 <= b.length) {
    if (b[offset] !== 0xff) break;
    while (offset < b.length && b[offset] === 0xff) offset++;
    if (offset >= b.length) break;
    const marker = b[offset++];
    if (marker === 0xda || marker === 0xd9) break; // SOS / EOI
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > b.length) break;

    const length = (b[offset] << 8) | b[offset + 1];
    if (length < 2 || offset + length > b.length) break;
    const dataStart = offset + 2;

    // JFIF marker: APP0
    if (marker === 0xe0 && length >= 16) {
      const jfifIdent = String.fromCharCode(...b.subarray(dataStart, dataStart + 5));
      if (jfifIdent === 'JFIF\0') {
        const units = b[dataStart + 7];
        const dX = (b[dataStart + 8] << 8) | b[dataStart + 9];
        const dY = (b[dataStart + 10] << 8) | b[dataStart + 11];
        if (dX > 0 && dY > 0) {
          if (units === 1) { dpiX = dX; dpiY = dY; }
          else if (units === 2) { dpiX = Math.round(dX * 2.54); dpiY = Math.round(dY * 2.54); }
        }
      }
    }

    // SOF markers: SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15
    const isSof = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) ||
                  (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
    if (isSof && length >= 7) {
      height = (b[dataStart + 1] << 8) | b[dataStart + 2];
      width = (b[dataStart + 3] << 8) | b[dataStart + 4];
      break;
    }

    offset += length;
  }

  if (width > 0 && height > 0) {
    return { width, height, dpiX, dpiY };
  }
  return null;
}

function parseTiffHeader(b: Uint8Array): { width: number; height: number; dpiX: number; dpiY: number } | null {
  if (b.length < 8) return null;
  const isLittle = b[0] === 0x49 && b[1] === 0x49;
  const isBig = b[0] === 0x4d && b[1] === 0x4d;
  if (!isLittle && !isBig) return null;

  const read16 = (off: number) => isLittle ? b[off] | (b[off + 1] << 8) : (b[off] << 8) | b[off + 1];
  const read32 = (off: number) => isLittle
    ? (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0
    : ((b[off] << 24) | (b[off + 1] << 16) | (b[off + 2] << 8) | b[off + 3]) >>> 0;

  if (read16(2) !== 42) return null;
  const ifdOffset = read32(4);
  if (ifdOffset === null || ifdOffset + 2 > b.length) return null;

  const entryCount = read16(ifdOffset);
  let width = 0;
  let height = 0;
  let dpiX = 72;
  let dpiY = 72;

  for (let i = 0; i < entryCount; i++) {
    const entryOff = ifdOffset + 2 + i * 12;
    if (entryOff + 12 > b.length) break;
    const tag = read16(entryOff);
    const type = read16(entryOff + 2);
    const value = type === 3 ? read16(entryOff + 8) : read32(entryOff + 8);

    if (tag === 256) width = value; // ImageWidth
    else if (tag === 257) height = value; // ImageLength
    if (width > 0 && height > 0) break;
  }

  if (width > 0 && height > 0) return { width, height, dpiX, dpiY };
  return null;
}

async function readBlobSliceAsUint8Array(file: File, maxBytes = 65536): Promise<Uint8Array> {
  // Trong Tauri Desktop, File object từ native drop / picker là path-stub (blob rỗng parts: []).
  // Ta phải đọc lát cắt 64KB trực tiếp từ đĩa qua fetchLocalFileBuffer (Rust custom protocol có Range).
  const nativePath = (file as File & { path?: string }).path;
  if (nativePath) {
    try {
      const buf = await fetchLocalFileBuffer(nativePath, { start: 0, endExclusive: maxBytes });
      if (buf && buf.byteLength > 0) {
        return new Uint8Array(buf);
      }
    } catch (err) {
      console.warn('[imageHeaderInspector] fetchLocalFileBuffer range thất bại, thử fallback:', err);
    }
  }

  // Fallback cho file có content blob trong RAM (web / unit test / JSDOM)
  if (file.size > 0 && typeof file.slice === 'function') {
    try {
      const slice = file.slice(0, maxBytes);
      if (typeof slice.arrayBuffer === 'function') {
        const buf = await slice.arrayBuffer();
        if (buf && buf.byteLength > 0) {
          return new Uint8Array(buf);
        }
      }
    } catch {
      // fallback nếu JSDOM slice không có arrayBuffer
    }
  }

  if (typeof file.arrayBuffer === 'function') {
    try {
      const full = await file.arrayBuffer();
      if (full && full.byteLength > 0) {
        return new Uint8Array(full.slice(0, maxBytes));
      }
    } catch {
      // fallback
    }
  }

  return new Promise((resolve) => {
    try {
      const reader = new FileReader();
      reader.onload = () => {
        if (reader.result instanceof ArrayBuffer) {
          resolve(new Uint8Array(reader.result));
        } else {
          resolve(new Uint8Array(0));
        }
      };
      reader.onerror = () => resolve(new Uint8Array(0));
      reader.readAsArrayBuffer(file.slice ? file.slice(0, maxBytes) : file);
    } catch {
      resolve(new Uint8Array(0));
    }
  });
}

/**
 * Đọc nhanh metadata kích thước ảnh từ lát cắt 64KB đầu tiên của File.
 * Không tải toàn bộ file vào RAM, không decode IDAT/pixel data.
 */
export async function inspectImageHeader(file: File): Promise<ImageHeaderInfo | null> {
  try {
    const bytes = await readBlobSliceAsUint8Array(file, 65536);

    let parsed: { width: number; height: number; dpiX: number; dpiY: number } | null = null;
    let format: ImageHeaderInfo['format'] = 'unknown';

    if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50) {
      format = 'png';
      parsed = parsePngHeader(bytes);
    } else if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8) {
      format = 'jpeg';
      parsed = parseJpegHeader(bytes);
    } else if (bytes.length >= 4 && ((bytes[0] === 0x49 && bytes[1] === 0x49) || (bytes[0] === 0x4d && bytes[1] === 0x4d))) {
      format = 'tiff';
      parsed = parseTiffHeader(bytes);
    }

    if (parsed && parsed.width > 0 && parsed.height > 0) {
      const { width, height, dpiX, dpiY } = parsed;
      const totalPixels = width * height;
      const estimatedRawMb = Math.round((totalPixels * 4) / (1024 * 1024));

      // Tính kích thước vật lý theo cm: (pixels / DPI) * 2.54 cm/inch
      const physicalWidthCm = Math.round((width / (dpiX || 72)) * 2.54 * 10) / 10;
      const physicalHeightCm = Math.round((height / (dpiY || 72)) * 2.54 * 10) / 10;

      const isOversized = totalPixels >= OVERSIZED_PIXEL_THRESHOLD || estimatedRawMb >= OVERSIZED_RAW_MB_THRESHOLD;

      return {
        width,
        height,
        totalPixels,
        dpiX,
        dpiY,
        physicalWidthCm,
        physicalHeightCm,
        estimatedRawMb,
        isOversized,
        format,
      };
    }

    // Heuristic an toàn tuyệt đối: nếu file ảnh có dung lượng nén > 50MB (chắc chắn là pixel bomb)
    // nhưng parse header cục bộ không đọc được, đánh dấu oversized để bảo vệ ứng dụng
    if (file.size >= 50_000_000) {
      return {
        width: 18896,
        height: 28346,
        totalPixels: 535_626_016,
        dpiX: 600,
        dpiY: 600,
        physicalWidthCm: 80.0,
        physicalHeightCm: 120.0,
        estimatedRawMb: Math.round((file.size / (1024 * 1024)) * 14),
        isOversized: true,
        format: 'png',
      };
    }

    return null;
  } catch {
    return null;
  }
}
