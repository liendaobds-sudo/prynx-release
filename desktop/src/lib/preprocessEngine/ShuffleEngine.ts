// src/lib/preprocessEngine/ShuffleEngine.ts
// =========================================================================
//  Quite-compatible Shuffle Engine
//  Supports: Rule-based reorder, 4 repeat modes, Even/Odd, Reverse
//
//  Rule syntax (Quite Imposing Plus compatible):
//    "5 4 3 6 7* 2* 1* 8*"
//    Numbers = page positions (1-based)
//    * = rotate 180°
//    > = rotate 90° clockwise
//    < = rotate 90° counter-clockwise
//    X = blank page
// =========================================================================

import { PDFDocument, degrees } from 'pdf-lib';

// ─── Types ───────────────────────────────────────────────────────────────

export interface ShuffleRule {
    pageIndex: number;  // 1-based, 0 = blank
    rotation: 0 | 90 | 180 | 270;
}

export interface PageMapping {
    srcPage: number;    // 0-based source index, -1 = blank
    rotation: number;   // degrees
}

export type RepeatMode =
    | 'normal'           // Bóc tép: rule lặp cho mỗi group
    | 'saddle'           // Bấm giữa: rule kéo giãn, số lớn nhất = trang cuối
    | 'cut_stack_1side'  // Cắt xếp 1 mặt
    | 'cut_stack_2side'; // Cắt xếp 2 mặt

export interface ShufflePreset {
    id: string;
    name: string;
    description: string;
    rule: string;
    groupSize: number;
    mode: RepeatMode;
}

// ─── Rule Parser ─────────────────────────────────────────────────────────

/**
 * Parse Quite-compatible rule text into ShuffleRule array.
 * "5 4 3 6 7* 2* 1* 8*" → [{pageIndex:5, rotation:0}, ..., {pageIndex:8, rotation:180}]
 */
export function parseRule(ruleText: string): ShuffleRule[] {
    const tokens = ruleText.trim().split(/\s+/);
    const rules: ShuffleRule[] = [];

    for (const token of tokens) {
        if (!token) continue;

        // Blank page
        if (token.toUpperCase() === 'X') {
            rules.push({ pageIndex: 0, rotation: 0 });
            continue;
        }

        // Extract rotation modifier from end
        let rotation: 0 | 90 | 180 | 270 = 0;
        let numPart = token;

        if (token.endsWith('*')) {
            rotation = 180;
            numPart = token.slice(0, -1);
        } else if (token.endsWith('>')) {
            rotation = 90;
            numPart = token.slice(0, -1);
        } else if (token.endsWith('<')) {
            rotation = 270;
            numPart = token.slice(0, -1);
        }

        const pageNum = parseInt(numPart, 10);
        if (isNaN(pageNum) || pageNum < 1) {
            console.warn(`ShuffleEngine: Invalid token "${token}", treating as blank`);
            rules.push({ pageIndex: 0, rotation: 0 });
            continue;
        }

        rules.push({ pageIndex: pageNum, rotation });
    }

    return rules;
}

/**
 * Serialize ShuffleRule array back to rule text.
 */
export function serializeRule(rules: ShuffleRule[]): string {
    return rules.map(r => {
        if (r.pageIndex === 0) return 'X';
        const suffix = r.rotation === 180 ? '*' : r.rotation === 90 ? '>' : r.rotation === 270 ? '<' : '';
        return `${r.pageIndex}${suffix}`;
    }).join(' ');
}

// ─── Repeat Mode Logic ──────────────────────────────────────────────────

/**
 * Apply shuffle rules to generate full page mapping for the entire document.
 *
 * @param rules     - Parsed shuffle rules (positions within a group)
 * @param totalPages - Total pages in the document
 * @param groupSize  - Pages per group
 * @param mode       - How to repeat/stretch the rule
 * @returns Full mapping array: output[i] = { srcPage, rotation }
 */
export function applyRule(
    rules: ShuffleRule[],
    totalPages: number,
    groupSize: number,
    mode: RepeatMode
): PageMapping[] {
    // Pad to multiple of groupSize
    const paddedTotal = Math.ceil(totalPages / groupSize) * groupSize;
    const result: PageMapping[] = [];

    switch (mode) {
        case 'normal':
            // Each group is reordered independently using the same rule
            for (let groupStart = 0; groupStart < paddedTotal; groupStart += groupSize) {
                for (const rule of rules) {
                    if (rule.pageIndex === 0) {
                        result.push({ srcPage: -1, rotation: rule.rotation });
                    } else {
                        const srcPage = groupStart + rule.pageIndex - 1;
                        result.push({
                            srcPage: srcPage < totalPages ? srcPage : -1,
                            rotation: rule.rotation,
                        });
                    }
                }
            }
            break;

        case 'saddle': {
            // Rule is "stretched" so the highest number maps to the last page.
            // The rule effectively describes how to interleave from outside-in.
            //
            // Example: rule "4 1 2 3" with 16 pages:
            // "4" becomes the max page in the doc → 16
            // Generates: 16,1,2,15 | 14,3,4,13 | 12,5,6,11 | 10,7,8,9
            const maxInRule = Math.max(...rules.map(r => r.pageIndex));
            const halfGroup = groupSize / 2;

            for (let sheet = 0; sheet < paddedTotal / groupSize; sheet++) {
                for (const rule of rules) {
                    if (rule.pageIndex === 0) {
                        result.push({ srcPage: -1, rotation: rule.rotation });
                        continue;
                    }

                    // Map rule position to actual page in saddle order
                    let actualPage: number;
                    if (rule.pageIndex <= halfGroup) {
                        // Low numbers: count from the beginning, offset by sheet
                        actualPage = sheet * halfGroup + rule.pageIndex;
                    } else {
                        // High numbers: count from the end, offset by sheet
                        const fromEnd = maxInRule - rule.pageIndex;
                        actualPage = paddedTotal - sheet * halfGroup - fromEnd;
                    }

                    result.push({
                        srcPage: actualPage > 0 && actualPage <= totalPages ? actualPage - 1 : -1,
                        rotation: rule.rotation,
                    });
                }
            }
            break;
        }

        case 'cut_stack_1side': {
            // Rule describes one side. Stretched for cut & stack.
            // Example: rule "1 2" with 8 pages → 1,5 | 2,6 | 3,7 | 4,8
            const slotsPerSheet = rules.length;
            const totalSheets = Math.ceil(paddedTotal / slotsPerSheet);

            for (let sheet = 0; sheet < totalSheets; sheet++) {
                for (let slot = 0; slot < slotsPerSheet; slot++) {
                    const rule = rules[slot];
                    if (rule.pageIndex === 0) {
                        result.push({ srcPage: -1, rotation: rule.rotation });
                        continue;
                    }
                    const srcPage = sheet + (rule.pageIndex - 1) * totalSheets;
                    result.push({
                        srcPage: srcPage < totalPages ? srcPage : -1,
                        rotation: rule.rotation,
                    });
                }
            }
            break;
        }

        case 'cut_stack_2side': {
            // Rule describes front and back of double-sided sheet.
            // First half = front, second half = back.
            const slotsPerSide = Math.floor(rules.length / 2);
            const frontRules = rules.slice(0, slotsPerSide);
            const backRules = rules.slice(slotsPerSide);
            const totalSheets = Math.ceil(paddedTotal / (slotsPerSide * 2));

            for (let sheet = 0; sheet < totalSheets; sheet++) {
                // Front side
                for (const rule of frontRules) {
                    if (rule.pageIndex === 0) {
                        result.push({ srcPage: -1, rotation: rule.rotation });
                        continue;
                    }
                    const srcPage = sheet + (rule.pageIndex - 1) * totalSheets;
                    result.push({
                        srcPage: srcPage < totalPages ? srcPage : -1,
                        rotation: rule.rotation,
                    });
                }
                // Back side
                for (const rule of backRules) {
                    if (rule.pageIndex === 0) {
                        result.push({ srcPage: -1, rotation: rule.rotation });
                        continue;
                    }
                    const srcPage = sheet + (rule.pageIndex - 1) * totalSheets;
                    result.push({
                        srcPage: srcPage < totalPages ? srcPage : -1,
                        rotation: rule.rotation,
                    });
                }
            }
            break;
        }
    }

    return result;
}

// ─── Special Shuffles ───────────────────────────────────────────────────

/** Tách trang chẵn/lẻ riêng biệt */
export function shuffleEvenOdd(
    totalPages: number,
    mode: 'even_first' | 'odd_first' | 'interleave' | 'reverse_even'
): PageMapping[] {
    const result: PageMapping[] = [];
    const odds  = Array.from({ length: totalPages }, (_, i) => i).filter(i => i % 2 === 0); // 0,2,4... (page 1,3,5...)
    const evens = Array.from({ length: totalPages }, (_, i) => i).filter(i => i % 2 === 1); // 1,3,5... (page 2,4,6...)

    switch (mode) {
        case 'odd_first':
            // All odd pages first, then all even pages
            for (const p of odds) result.push({ srcPage: p, rotation: 0 });
            for (const p of evens) result.push({ srcPage: p, rotation: 0 });
            break;
        case 'even_first':
            for (const p of evens) result.push({ srcPage: p, rotation: 0 });
            for (const p of odds) result.push({ srcPage: p, rotation: 0 });
            break;
        case 'interleave':
            // Interleave: odd1, even1, odd2, even2...
            for (let i = 0; i < Math.max(odds.length, evens.length); i++) {
                if (i < odds.length) result.push({ srcPage: odds[i], rotation: 0 });
                if (i < evens.length) result.push({ srcPage: evens[i], rotation: 0 });
            }
            break;
        case 'reverse_even':
            // Odd pages normal, even pages reversed (for manual duplex printing)
            for (const p of odds) result.push({ srcPage: p, rotation: 0 });
            for (const p of [...evens].reverse()) result.push({ srcPage: p, rotation: 0 });
            break;
    }

    return result;
}

/** Đảo ngược thứ tự trang */
export function reversePages(totalPages: number): PageMapping[] {
    return Array.from({ length: totalPages }, (_, i) => ({
        srcPage: totalPages - 1 - i,
        rotation: 0,
    }));
}

// ─── PDF Executor ───────────────────────────────────────────────────────

/**
 * Execute shuffle: create new PDF with pages reordered according to mapping.
 */
export async function executeShuffle(
    inputPdf: PDFDocument,
    mapping: PageMapping[]
): Promise<Uint8Array> {
    const outputPdf = await PDFDocument.create();
    const srcPageCount = inputPdf.getPageCount();

    for (const entry of mapping) {
        if (entry.srcPage < 0 || entry.srcPage >= srcPageCount) {
            // Blank page — add empty page with same size as first page
            const refPage = inputPdf.getPage(0);
            const { width, height } = refPage.getSize();
            outputPdf.addPage([width, height]);
        } else {
            const [copiedPage] = await outputPdf.copyPages(inputPdf, [entry.srcPage]);
            if (entry.rotation !== 0) {
                const currentRotation = copiedPage.getRotation().angle;
                copiedPage.setRotation(degrees(currentRotation + entry.rotation));
            }
            outputPdf.addPage(copiedPage);
        }
    }

    return outputPdf.save();
}

// ─── Preset Library ─────────────────────────────────────────────────────

export const SHUFFLE_PRESETS: ShufflePreset[] = [
    // Saddle stitch booklets
    {
        id: 'saddle_4p', name: 'Booklet 4 trang',
        description: 'Bấm giữa. 1 tờ gấp đôi = 4 trang.',
        rule: '4 1 2 3', groupSize: 4, mode: 'saddle',
    },
    {
        id: 'saddle_8p', name: 'Booklet 8 trang',
        description: 'Bấm giữa. 2 tờ lồng = 8 trang.',
        rule: '8 1 2 7 6 3 4 5', groupSize: 8, mode: 'saddle',
    },
    {
        id: 'saddle_16p', name: 'Booklet 16 trang',
        description: 'Bấm giữa. 4 tờ lồng = 16 trang.',
        rule: '16 1 2 15 14 3 4 13 12 5 6 11 10 7 8 9', groupSize: 16, mode: 'saddle',
    },

    // Perfect / Thread binding
    {
        id: 'thread_8p', name: 'Bóc tép 8 trang/tay',
        description: 'Mỗi tay 8 trang, rule lặp cho từng tay.',
        rule: '8 1 2 7 6 3 4 5', groupSize: 8, mode: 'normal',
    },
    {
        id: 'thread_16p', name: 'Bóc tép 16 trang/tay',
        description: 'Mỗi tay 16 trang, rule lặp cho từng tay.',
        rule: '16 1 2 15 14 3 4 13 12 5 6 11 10 7 8 9', groupSize: 16, mode: 'normal',
    },

    // Cut & Stack
    {
        id: 'cut_2up', name: 'Cut & Stack 2-Up',
        description: 'In rồi cắt đôi, xếp chồng đúng thứ tự.',
        rule: '1 2', groupSize: 2, mode: 'cut_stack_1side',
    },
    {
        id: 'cut_4up', name: 'Cut & Stack 4-Up',
        description: 'In rồi cắt 4, xếp chồng đúng thứ tự.',
        rule: '1 2 3 4', groupSize: 4, mode: 'cut_stack_1side',
    },
    {
        id: 'cut_2up_duplex', name: 'Cut & Stack 2-Up (2 mặt)',
        description: 'In 2 mặt rồi cắt đôi, xếp chồng.',
        rule: '1 2 3 4', groupSize: 4, mode: 'cut_stack_2side',
    },
];

export function getPresetById(id: string): ShufflePreset | undefined {
    return SHUFFLE_PRESETS.find(p => p.id === id);
}
