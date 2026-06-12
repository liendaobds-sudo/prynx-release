// src/lib/preprocessEngine/PdfSplitter.ts
// =========================================================================
//  Tách PDF theo range, count, hoặc danh sách trang
// =========================================================================

import { PDFDocument } from 'pdf-lib';

export type SplitMode = 'by_range' | 'by_count' | 'extract_pages';

export interface SplitResult {
    filename: string;
    bytes: Uint8Array;
    pageCount: number;
}

/**
 * Parse range string into array of [start, end] pairs (1-based, inclusive).
 * "1-4, 5-8, 9-12" → [[1,4], [5,8], [9,12]]
 * "1,3,5" → [[1,1], [3,3], [5,5]]
 * "1-4, 7, 10-12" → [[1,4], [7,7], [10,12]]
 */
export function parseRanges(rangeStr: string, maxPage: number): [number, number][] {
    const ranges: [number, number][] = [];
    const parts = rangeStr.split(',').map(s => s.trim()).filter(Boolean);

    for (const part of parts) {
        if (part.includes('-')) {
            const [startStr, endStr] = part.split('-').map(s => s.trim());
            const start = parseInt(startStr, 10);
            const end = endStr ? parseInt(endStr, 10) : maxPage;
            if (!isNaN(start) && !isNaN(end) && start >= 1 && end >= start) {
                ranges.push([Math.min(start, maxPage), Math.min(end, maxPage)]);
            }
        } else {
            const num = parseInt(part, 10);
            if (!isNaN(num) && num >= 1 && num <= maxPage) {
                ranges.push([num, num]);
            }
        }
    }

    return ranges;
}

/**
 * Extract pages from a PDF into a new document.
 * @param srcPdf   - Source PDF document
 * @param pages    - 0-based page indices to extract
 * @returns New PDF bytes
 */
async function extractPages(srcPdf: PDFDocument, pages: number[]): Promise<Uint8Array> {
    const newPdf = await PDFDocument.create();
    const copied = await newPdf.copyPages(srcPdf, pages);
    for (const page of copied) {
        newPdf.addPage(page);
    }
    return newPdf.save();
}

/**
 * Split a PDF into multiple files.
 *
 * @param inputBytes - Raw PDF bytes
 * @param mode       - Split strategy
 * @param options    - Mode-specific options
 * @param baseName   - Base filename for output files
 * @returns Array of split results
 */
export async function splitPdf(
    inputBytes: Uint8Array | ArrayBuffer,
    mode: SplitMode,
    options: {
        ranges?: string;       // "1-4, 5-8" — for by_range
        pagesPerFile?: number; // 4 — for by_count
        pageList?: number[];   // [1, 3, 5] — for extract_pages (1-based)
    },
    baseName: string = 'split'
): Promise<SplitResult[]> {
    const srcPdf = await PDFDocument.load(inputBytes);
    const totalPages = srcPdf.getPageCount();
    const results: SplitResult[] = [];

    switch (mode) {
        case 'by_range': {
            const ranges = parseRanges(options.ranges || '1-' + totalPages, totalPages);
            for (let i = 0; i < ranges.length; i++) {
                const [start, end] = ranges[i];
                const indices = Array.from({ length: end - start + 1 }, (_, j) => start - 1 + j);
                const bytes = await extractPages(srcPdf, indices);
                results.push({
                    filename: `${baseName}_${String(i + 1).padStart(2, '0')}_p${start}-${end}.pdf`,
                    bytes,
                    pageCount: indices.length,
                });
            }
            break;
        }

        case 'by_count': {
            const perFile = options.pagesPerFile || 1;
            const numFiles = Math.ceil(totalPages / perFile);
            for (let i = 0; i < numFiles; i++) {
                const start = i * perFile;
                const end = Math.min(start + perFile, totalPages);
                const indices = Array.from({ length: end - start }, (_, j) => start + j);
                const bytes = await extractPages(srcPdf, indices);
                results.push({
                    filename: `${baseName}_${String(i + 1).padStart(2, '0')}_p${start + 1}-${end}.pdf`,
                    bytes,
                    pageCount: indices.length,
                });
            }
            break;
        }

        case 'extract_pages': {
            const pages = (options.pageList || []).filter(p => p >= 1 && p <= totalPages);
            if (pages.length > 0) {
                const indices = pages.map(p => p - 1);
                const bytes = await extractPages(srcPdf, indices);
                results.push({
                    filename: `${baseName}_extracted.pdf`,
                    bytes,
                    pageCount: indices.length,
                });
            }
            break;
        }
    }

    return results;
}
