import { PDFDocument, degrees } from 'pdf-lib';

import {
  beginOptionalContentTransfer,
  finishOptionalContentTransfer,
} from '../../lib/pdfOptionalContent';

export type PreviewViewerState = {
  order: number[];
  rotations: number[];
};

export function parsePreviewViewerState(key?: string): PreviewViewerState {
  try {
    const parsed = JSON.parse(key || '{}');
    return {
      order: Array.isArray(parsed?.o)
        ? parsed.o.map((value: unknown) => Number(value)).filter(Number.isInteger)
        : [],
      rotations: Array.isArray(parsed?.r)
        ? parsed.r.map((value: unknown) => Number(value) || 0)
        : [],
    };
  } catch {
    return { order: [], rotations: [] };
  }
}

/**
 * The thumbnail order and the viewer page counter are updated through separate
 * UI paths. During a duplicate operation either one may arrive first, so use
 * the larger count instead of allowing a stale order array to hide new pages.
 */
export function resolvePreviewPageCount(key?: string, fallbackCount = 0): number {
  const orderCount = parsePreviewViewerState(key).order.length;
  const normalizedFallback = Number.isFinite(fallbackCount)
    ? Math.max(0, Math.floor(fallbackCount))
    : 0;
  return Math.max(orderCount, normalizedFallback);
}

/**
 * Guillotine step-repeat contains only the currently selected design, so its
 * cell label must follow the live thumbnail position even when a cached/backend
 * cell has no pageIdx (or still carries the previous one).
 */
export function resolvePreviewCellType(
  backendPageIdx: unknown,
  activePageIdx: number | undefined,
  taskMode: string,
  isDieCut: boolean,
): number {
  if (!isDieCut && taskMode === 'step_repeat') {
    return Number.isInteger(activePageIdx) && Number(activePageIdx) >= 0
      ? Number(activePageIdx)
      : 0;
  }
  return Number.isInteger(backendPageIdx) && Number(backendPageIdx) >= 0
    ? Number(backendPageIdx)
    : 0;
}

/**
 * Shape-aware nesting is expensive and cannot be correct before detection has
 * finished. Page-sheet/guillotine preview is rectangular, so it must not wait
 * for a detector that it does not use.
 */
export function shouldDeferPreviewLayout(
  isDieCut: boolean,
  isDetectingShape: boolean,
): boolean {
  return isDieCut && isDetectingShape;
}

/**
 * Materialize the exact thumbnail order into a standalone PDF.
 * Repeated source page numbers are intentional duplicates; -1 is a blank page.
 */
export async function materializePreviewViewerPdf(
  sourceBytes: ArrayBuffer | Uint8Array,
  state: PreviewViewerState,
): Promise<Uint8Array> {
  const srcDoc = await PDFDocument.load(sourceBytes, { ignoreEncryption: true });
  if (state.order.length === 0) return new Uint8Array(await srcDoc.save());

  const outDoc = await PDFDocument.create();
  const fallback = srcDoc.getPages()[0]?.getSize() || { width: 595.28, height: 841.89 };

  // [OCG FIX 2026-07-28] copyPages bỏ /OCProperties → layer đã ẩn hiện lại ngay trên
  // khung xem trước. Vòng lặp có throw giữa đường nên dọn dấu trong finally.
  const ocTransfer = beginOptionalContentTransfer([srcDoc]);
  try {
    for (let position = 0; position < state.order.length; position += 1) {
      const sourcePage = state.order[position];
      if (sourcePage === -1) {
        outDoc.addPage([fallback.width, fallback.height]);
        continue;
      }
      const sourceIndex = sourcePage - 1;
      if (sourceIndex < 0 || sourceIndex >= srcDoc.getPageCount()) {
        throw new Error(`Invalid preview page ${sourcePage} at position ${position + 1}`);
      }
      const [copied] = await outDoc.copyPages(srcDoc, [sourceIndex]);
      const rotation = state.rotations[position] || 0;
      if (rotation) copied.setRotation(degrees(copied.getRotation().angle + rotation));
      outDoc.addPage(copied);
    }
  } finally {
    finishOptionalContentTransfer(ocTransfer, outDoc);
  }

  return new Uint8Array(await outDoc.save());
}
