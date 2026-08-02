import { degrees, type PDFDocument, type PDFPage } from 'pdf-lib';
import type { BackendMergeManifestItem } from './api';
import { isBackendManifestSourceName } from './combineDelegation';
// UIUX (audit 2026-07-27 §D-13): thông báo lỗi tiếng Việt qua i18n
import i18n from '../i18n';

export type CombineAssemblyNode = {
  type: 'single' | 'collapsed_group' | 'blank';
  file?: File;
  pageIndex?: number;
  rotation?: number;
};

const PDF_HEADER = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
const PDF_EOF = [0x25, 0x25, 0x45, 0x4f, 0x46]; // %%EOF

export function hasPdfHeader(bytes: Uint8Array): boolean {
  return bytes.byteLength >= PDF_HEADER.length
    && PDF_HEADER.every((value, index) => bytes[index] === value);
}

export function hasPdfEofMarker(bytes: Uint8Array): boolean {
  if (bytes.byteLength < PDF_EOF.length) return false;
  const start = Math.max(0, bytes.byteLength - 1024);
  for (let offset = bytes.byteLength - PDF_EOF.length; offset >= start; offset--) {
    if (PDF_EOF.every((value, index) => bytes[offset + index] === value)) return true;
  }
  return false;
}

export function isCompletePdfBytes(bytes: Uint8Array): boolean {
  return hasPdfHeader(bytes) && hasPdfEofMarker(bytes);
}

export function toExactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.buffer instanceof ArrayBuffer
    && bytes.byteOffset === 0
    && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer;
  }
  // PDF (audit 2026-08-01 §B.1): subarray không được kéo cả prefix/suffix của backing buffer vào Blob.
  const exact = new Uint8Array(bytes.byteLength);
  exact.set(bytes);
  return exact.buffer;
}

export function buildBackendCombineManifest(nodes: CombineAssemblyNode[]): {
  files: File[];
  manifest: BackendMergeManifestItem[];
} {
  const files: File[] = [];
  const indexes = new Map<File, number>();
  const manifest: BackendMergeManifestItem[] = [];

  for (const node of nodes) {
    if (node.type === 'blank') {
      manifest.push({ blank: true, rotation: node.rotation || 0 });
      continue;
    }
    if (!node.file || !isBackendManifestSourceName(node.file.name)) {
      // UIUX (audit 2026-07-27 §D-13): câu Việt qua i18n thay chuỗi tiếng Anh hardcode
      throw new Error(i18n.t('lib.combineAssembly:chi_nhan_file_pdf_png_jpg', { defaultValue: 'Chức năng ghép qua backend chỉ nhận PDF, PNG hoặc JPG' }));
    }

    let fileIndex = indexes.get(node.file);
    if (fileIndex === undefined) {
      fileIndex = files.length;
      indexes.set(node.file, fileIndex);
      files.push(node.file);
    }

    const item: BackendMergeManifestItem = {
      file_index: fileIndex,
      rotation: node.rotation || 0,
    };
    // Missing page_index is intentional: it means append the whole source PDF.
    // Do not serialize it as null because the backend treats null as invalid.
    if (node.pageIndex !== undefined) item.page_index = node.pageIndex;
    manifest.push(item);
  }

  return { files, manifest };
}

export function visiblePageSize(page: PDFPage): [number, number] {
  const width = page.getWidth();
  const height = page.getHeight();
  const angle = ((page.getRotation().angle % 360) + 360) % 360;
  return angle === 90 || angle === 270 ? [height, width] : [width, height];
}

/** Add a blank page and apply its rotation just like a copied source page. */
export function addRotatedBlankPage(
  document: PDFDocument,
  size: [number, number],
  rotation = 0,
): PDFPage {
  const page = document.addPage(size);
  if (rotation) page.setRotation(degrees(rotation));
  return page;
}
