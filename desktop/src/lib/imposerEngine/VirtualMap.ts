export interface PageSlot {
    srcIndex: number | null; // 0-based original page index, or null if blank padding
    logicalIndex: number; // 1-based reading order index
    /** Góc xoay riêng của instance trong thumbnail order (không phải rotation gốc của PDF). */
    userRotation?: number;
}

export interface SheetSide {
    left: PageSlot;
    right: PageSlot;
}

export interface VirtualSheet {
    sheetIndex: number;
    front: SheetSide;
    back: SheetSide;
    sigLocalIndex?: number;
    sigTotalSheets?: number;
    signatureIndex?: number; // 1-based signature (tép) index
}

export interface BindingMapResult {
    sheets: VirtualSheet[];
    report: string;
}

export const generateBindingMap = (
    effectivePageCount: number,
    bindingMode: 'continuous' | 'saddle' | 'thread' | 'cut_stacks' | 'flush_mount',
    foliosize: number = 16,
    blankPlacement: 'end' | 'center' = 'end'
): BindingMapResult => {
    const paddedPageCount = bindingMode === 'flush_mount'
        ? Math.ceil(effectivePageCount / 2) * 2
        : Math.ceil(effectivePageCount / 4) * 4;
    const totalSheets = bindingMode === 'flush_mount'
        ? paddedPageCount / 2
        : paddedPageCount / 4;
    const sheets: VirtualSheet[] = [];
    let report = '';

    // Map each 1-based logical reading slot → source page index (or null = blank padding).
    // 'end'    : blanks go at the tail of the reading order (last pages / back cover).
    // 'center' : blanks go at the innermost pages (physical center of the book), which is
    //            the print-shop default so cover and early pages are never blank.
    const blankCount = paddedPageCount - effectivePageCount;
    const logicalToSrc: (number | null)[] = new Array(paddedPageCount);
    if (blankPlacement === 'center' && blankCount > 0) {
        const firstHalf = Math.ceil(effectivePageCount / 2);
        let cursor = 0;
        for (let i = 0; i < paddedPageCount; i++) {
            if (i < firstHalf) logicalToSrc[i] = cursor++;
            else if (i < firstHalf + blankCount) logicalToSrc[i] = null;
            else logicalToSrc[i] = cursor++;
        }
    } else {
        for (let i = 0; i < paddedPageCount; i++) {
            logicalToSrc[i] = i < effectivePageCount ? i : null;
        }
    }

    const getSlot = (logical1Based: number): PageSlot => {
        const idx = logical1Based - 1;
        return {
            srcIndex: (idx >= 0 && idx < paddedPageCount) ? logicalToSrc[idx] : null,
            logicalIndex: logical1Based
        };
    };

    if (bindingMode === 'flush_mount') {
        for (let i = 0; i < totalSheets; i++) {
            sheets.push({
                sheetIndex: i,
                signatureIndex: 1,
                front: {
                    left: getSlot(2 * i + 1),
                    right: getSlot(2 * i + 2)
                },
                back: {
                    left: { srcIndex: null, logicalIndex: -1 },
                    right: { srcIndex: null, logicalIndex: -1 }
                }
            });
        }
    } else if (bindingMode === 'continuous') {
        for (let i = 0; i < totalSheets; i++) {
            sheets.push({
                sheetIndex: i,
                signatureIndex: 1,
                front: {
                    left: getSlot(4 * i + 1),
                    right: getSlot(4 * i + 2)
                },
                back: {
                    left: getSlot(4 * i + 3),
                    right: getSlot(4 * i + 4)
                }
            });
        }
    } else if (bindingMode === 'cut_stacks') {
        const half = paddedPageCount / 2;
        for (let i = 0; i < totalSheets; i++) {
            sheets.push({
                sheetIndex: i,
                signatureIndex: 1,
                front: {
                    left: getSlot(2 * i + 1),
                    right: getSlot(half + 2 * i + 1)
                },
                back: {
                    left: getSlot(2 * i + 2),
                    right: getSlot(half + 2 * i + 2)
                }
            });
        }
    } else if (bindingMode === 'saddle') {
        const N = paddedPageCount;
        for (let i = 0; i < totalSheets; i++) {
            sheets.push({
                sheetIndex: i,
                signatureIndex: 1,
                front: {
                    left: getSlot(N - 2 * i),
                    right: getSlot(2 * i + 1)
                },
                back: {
                    left: getSlot(2 * i + 2),
                    right: getSlot(N - 2 * i - 1)
                }
            });
        }
    } else if (bindingMode === 'thread') {
        let pagesProcessed = 0;
        const validFolioSize = foliosize > 0 && foliosize % 4 === 0 ? foliosize : 16;
        let globalSheetIndex = 0;
        let signatureIndex = 1;
        const sigCounts: Record<number, number> = {};
        let modifiedLastSig = false;

        while (pagesProcessed < paddedPageCount) {
            const pagesRemaining = paddedPageCount - pagesProcessed;
            let currentSigPageCount = Math.min(validFolioSize, pagesRemaining);
            
            // Optimization for commercial printing: Never leave a single 4-page signature at the end if we can merge it.
            // If the remaining pages after this signature would be exactly 4 pages, just combine them into this signature.
            if (pagesRemaining - currentSigPageCount === 4) {
                 currentSigPageCount = pagesRemaining;
                 modifiedLastSig = true;
            }

            sigCounts[currentSigPageCount] = (sigCounts[currentSigPageCount] || 0) + 1;

            const numSheets = currentSigPageCount / 4;
            const N = currentSigPageCount;
            const offset = pagesProcessed;

            for (let i = 0; i < numSheets; i++) {
                sheets.push({
                    sheetIndex: globalSheetIndex++,
                    sigLocalIndex: i,
                    sigTotalSheets: numSheets,
                    signatureIndex: signatureIndex,
                    front: {
                        left: getSlot(offset + N - 2 * i),
                        right: getSlot(offset + 2 * i + 1)
                    },
                    back: {
                        left: getSlot(offset + 2 * i + 2),
                        right: getSlot(offset + N - 2 * i - 1)
                    }
                });
            }
            pagesProcessed += currentSigPageCount;
            signatureIndex++;
        }

        const details = Object.keys(sigCounts)
            .sort((a,b) => Number(b) - Number(a))
            .map(size => `${sigCounts[Number(size)]} tép ${size} trang`)
            .join(', ');
            
        report = `Báo cáo chia tép: Tổng cộng ${details}.`;
        if (modifiedLastSig) {
            report += ` (Hệ thống đã tự động gộp 4 trang dư cuối cùng vào tay sách liền trước để tránh rách chỉ khi kẹp lên máy khâu).`;
        }
    }

    return { sheets, report };
};
