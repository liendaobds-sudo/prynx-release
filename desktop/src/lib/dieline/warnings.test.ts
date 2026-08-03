// ============================================================
// warnings.test.ts
//
// Bao gồm hai task tùy chọn của spec dieline-hardening:
//   • Task 7.3 — Property 6: Warnings được hợp nhất đầy đủ, chính xác
//     và xác định (Validates Requirements 3.1, 3.2, 3.3, 3.5, 3.6)
//   • Task 7.4 — Test biên cho lỗi validate và nguồn cảnh báo
//     (Validates Requirements 3.4, 3.7)
//
// Lưu ý kiến trúc: `generateDieline` là hàm NỘI BỘ của
// `useBoxStore.ts` (không export). Để kiểm thử hợp đồng (contract)
// của nó một cách trung thực, file này tái dựng ĐÚNG luồng dispatch
// của store: validateParams → dispatchGenerator → attachWarnings.
// ============================================================

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import fc from 'fast-check';

import { validateParams, ValidationResult } from './validateParams';
import { attachWarnings } from './attachWarnings';
import { arbBoxParams, GeneratorBoxType } from './arbitraries';
import { BoxParams, DielineModel, DEFAULT_PARAMS } from './types';

import { generateReverseTuckEnd } from './ReverseTuckEnd';
import { generateSnapLockBottom } from './SnapLockBottom';
import { generateAutoBottomBox } from './AutoBottomBox';
import { generateGableBox } from './GableBox';
import { generatePaperBag } from './PaperBag';
import { generateCupSleeve } from './CupSleeve';
import { generateFlipTopTuckBox } from './FlipTopTuckBox';
import { generatePizzaBox } from './PizzaBox';
import { generateEnvelope } from './Envelope';
import { generateMatchboxTray } from './MatchboxTray';

// ─── Dispatch boxType → generator (sao chép từ useBoxStore) ──
function dispatchGenerator(params: BoxParams): DielineModel {
    switch (params.boxType) {
        case 'slb':
            return generateSnapLockBottom(params);
        case 'auto_bottom':
            return generateAutoBottomBox(params);
        case 'gable':
            return generateGableBox(params);
        case 'paper_bag':
            return generatePaperBag(params);
        case 'cup_sleeve':
            return generateCupSleeve(params);
        case 'pizza':
            return generatePizzaBox(params);
        case 'envelope':
            return generateEnvelope(params);
        case 'tray':
            return generateMatchboxTray(params);
        case 'flip_top_tuck':
            return generateFlipTopTuckBox(params);
        case 'rte':
        default:
            return generateReverseTuckEnd(params);
    }
}

/**
 * Bản tái dựng trung thực của `generateDieline` nội bộ trong store,
 * cho phép tiêm (inject) hàm validate để kiểm thử nhánh lỗi (Req 3.7).
 * Luồng giống hệt store: validate → dispatch → attachWarnings.
 */
function generateDielineImpl(
    validate: (raw: BoxParams, changedKey?: keyof BoxParams) => ValidationResult,
    raw: BoxParams,
    changedKey?: keyof BoxParams,
): DielineModel {
    const { params, warnings } = validate(raw, changedKey);
    const model = dispatchGenerator(params);
    return attachWarnings(model, warnings);
}

/** generateDieline thật — dùng validateParams thật (như store). */
function generateDieline(raw: BoxParams, changedKey?: keyof BoxParams): DielineModel {
    return generateDielineImpl(validateParams, raw, changedKey);
}

/** Khử trùng lặp theo nội dung chuỗi, giữ thứ tự xuất hiện đầu tiên. */
function dedupe(items: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const w of items) {
        if (!seen.has(w)) {
            seen.add(w);
            out.push(w);
        }
    }
    return out;
}

const ALL_BOX_TYPES: GeneratorBoxType[] = [
    'rte', 'slb', 'auto_bottom', 'gable', 'paper_bag', 'cup_sleeve', 'pizza', 'envelope', 'tray',
    'flip_top_tuck',
];

// ============================================================
// Task 7.3 — Property 6
// Feature: dieline-hardening, Property 6: Warnings được hợp nhất đầy
// đủ, chính xác và xác định — for any bộ params hợp lệ, sau
// generateDieline(params): model.warnings luôn là một mảng (rỗng nếu
// không có cảnh báo, không bao giờ null/undefined), và bằng đúng tập
// hợp đã khử trùng lặp của các cảnh báo từ validateParams(params) hợp
// với các cảnh báo (gồm snap-lock) phát sinh khi sinh mô hình; sinh
// hai lần cùng params cho warnings giống hệt nhau theo nội dung.
//
// Validates: Requirements 3.1, 3.2, 3.3, 3.5, 3.6
// ============================================================
describe('Property 6 — warnings hợp nhất đầy đủ, chính xác và xác định', () => {
    for (const boxType of ALL_BOX_TYPES) {
        it(`model.warnings = dedupe(union) và xác định (${boxType})`, () => {
            fc.assert(
                fc.property(arbBoxParams(boxType), (params: BoxParams) => {
                    // ── Req 3.5: warnings LUÔN là mảng, không null/undefined ──
                    const model = generateDieline(params);
                    expect(Array.isArray(model.warnings)).toBe(true);
                    expect(model.warnings).not.toBeNull();
                    expect(model.warnings).not.toBeUndefined();

                    // ── Req 3.1/3.2/3.3/3.6: bằng đúng union đã dedupe của
                    //    (validateParams warnings) ∪ (generation/snap-lock warnings) ──
                    const { params: validParams, warnings: validationWarnings } =
                        validateParams(params);
                    const rawModel = dispatchGenerator(validParams);
                    const generationWarnings = rawModel.warnings ?? [];
                    const expected = dedupe([...validationWarnings, ...generationWarnings]);

                    expect(model.warnings).toEqual(expected);

                    // Không trùng lặp: độ dài = độ dài tập hợp duy nhất.
                    expect(model.warnings!.length).toBe(new Set(model.warnings).size);

                    // ── Req 3.6: xác định — sinh hai lần cùng params giống hệt ──
                    const again = generateDieline(params);
                    expect(again.warnings).toEqual(model.warnings);
                }),
                { numRuns: 100 },
            );
        });
    }
});

// ============================================================
// Task 7.4 — Test biên cho lỗi validate và nguồn cảnh báo
// Validates: Requirements 3.4, 3.7
// ============================================================

// ─── Req 3.7: validateParams ném lỗi → generateDieline ném lỗi,
//     KHÔNG trả model với warnings thiếu/sai ───────────────────
describe('Edge case — validateParams ném lỗi thì không tạo model (Req 3.7)', () => {
    it('lan truyền lỗi và không trả về DielineModel', () => {
        const boom = new Error('validateParams bị lỗi');
        const throwingValidate = (): ValidationResult => {
            throw boom;
        };

        let result: DielineModel | undefined;
        let caught: unknown;
        try {
            result = generateDielineImpl(throwingValidate, { ...DEFAULT_PARAMS });
        } catch (e) {
            caught = e;
        }

        // Lỗi được lan truyền cho phía gọi …
        expect(caught).toBe(boom);
        // … và KHÔNG có model nào (kể cả model với warnings thiếu/sai) được tạo.
        expect(result).toBeUndefined();
    });
});

// ─── Req 3.4: Canvas đọc cảnh báo CHỈ từ model.warnings — không
//     tham chiếu nguồn riêng `snapLockWarning` ────────────────
function readCanvasSource(): string {
    const candidates = [
        (() => {
            try {
                const here = dirname(fileURLToPath(import.meta.url));
                // src/lib/dieline → src/components/dieline-tool
                return join(here, '..', '..', 'components', 'dieline-tool', 'DielineCanvas2D.tsx');
            } catch {
                return '';
            }
        })(),
        join(process.cwd(), 'src', 'components', 'dieline-tool', 'DielineCanvas2D.tsx'),
        join(process.cwd(), 'desktop', 'src', 'components', 'dieline-tool', 'DielineCanvas2D.tsx'),
    ].filter(Boolean);

    for (const p of candidates) {
        if (existsSync(p)) return readFileSync(p, 'utf8');
    }
    throw new Error(
        `Không tìm thấy DielineCanvas2D.tsx. Đã thử: ${candidates.join(', ')}`,
    );
}

describe('Static source — DielineCanvas2D không tham chiếu snapLockWarning (Req 3.4)', () => {
    const src = readCanvasSource();

    it('không chứa định danh `snapLockWarning`', () => {
        expect(src).not.toMatch(/snapLockWarning/);
    });
});
