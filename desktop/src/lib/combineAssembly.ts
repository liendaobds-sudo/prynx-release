import { degrees, type PDFDocument, type PDFPage } from 'pdf-lib';
import type { BackendMergeManifestItem } from './api';

export type CombineAssemblyNode = {
  type: 'single' | 'collapsed_group' | 'blank';
  file?: File;
  pageIndex?: number;
  rotation?: number;
};

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
    if (!node.file || !node.file.name.toLowerCase().endsWith('.pdf')) {
      throw new Error('Backend manifest only supports PDF files');
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
