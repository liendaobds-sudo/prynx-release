import { PDFDocument } from 'pdf-lib';

import { getFileArrayBuffer } from './utils';
import {
    beginOptionalContentTransfer,
    finishOptionalContentTransfer,
} from './pdfOptionalContent';

export function isWorkingPageSelectionCurrent(
    viewerIndices: readonly number[],
    expectedInstanceIds: readonly string[],
    currentInstanceIds: readonly string[] | undefined,
): boolean {
    return expectedInstanceIds.length === viewerIndices.length
        && viewerIndices.every((index, selectionIndex) => (
            Number.isInteger(index)
            && index >= 0
            && currentInstanceIds?.[index] === expectedInstanceIds[selectionIndex]
        ));
}

/**
 * Tách trực tiếp các VỊ TRÍ của PDF đã materialize. Rotation/order/duplicate đã
 * nằm trong file này nên tuyệt đối không ánh xạ ngược về source page lần nữa.
 */
export async function extractWorkingPagePositions(
    workingFile: File,
    viewerIndices: readonly number[],
): Promise<File> {
    if (viewerIndices.length === 0) {
        throw new Error('Chưa chọn trang để bóc tách.');
    }

    const source = await PDFDocument.load(
        await getFileArrayBuffer(workingFile),
        { ignoreEncryption: true },
    );
    const pageCount = source.getPageCount();
    const positions = viewerIndices.map((index) => {
        if (!Number.isInteger(index) || index < 0 || index >= pageCount) {
            throw new Error(`Vị trí trang ${index + 1} không còn tồn tại trong PDF làm việc.`);
        }
        return index;
    });

    const output = await PDFDocument.create();
    const optionalContent = beginOptionalContentTransfer([source]);
    const copied = await output.copyPages(source, positions);
    for (const page of copied) output.addPage(page);
    finishOptionalContentTransfer(optionalContent, output);

    const bytes = await output.save();
    return new File(
        [new Uint8Array(bytes) as unknown as BlobPart],
        `Bi_Boc_Tach_${workingFile.name}`,
        { type: 'application/pdf' },
    );
}
