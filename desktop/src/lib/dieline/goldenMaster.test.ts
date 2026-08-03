// ============================================================
// goldenMaster.test.ts — Golden-master snapshot cho ổn định
// chuỗi SVG + giá trị kích thước (Requirement 4.6)
//
// Mục tiêu: KHOÁ baseline đầu ra hình học của Shared_Geometry_Module
// (buildChains + chainToSvgD) và công thức kích thước dùng chung
// (computeEnvelopeDims) cho một tập DielineModel mẫu đại diện
// (một mẫu / loại hộp với params cố định, xác định).
//
// Refactor Export ↔ Canvas (task 3) đã hoàn tất và GIỮ NGUYÊN đầu
// ra hình học; test này chụp đầu ra module dùng chung HIỆN TẠI làm
// golden baseline. Bất kỳ drift nào trong tương lai sẽ làm fail:
//   - Chuỗi SVG `d`: so khớp CHAR-IDENTICAL (toMatchSnapshot)
//   - Giá trị kích thước (FH/SF): ổn định trong dung sai ≤ 0.001mm
// ============================================================

import { describe, it, expect } from 'vitest';
import { BoxParams, DEFAULT_PARAMS, DielineModel } from './types';
import { buildChains, chainToSvgD, computeEnvelopeDims } from './sharedGeometry';
import { generateReverseTuckEnd } from './ReverseTuckEnd';
import { generateSnapLockBottom } from './SnapLockBottom';
import { generateAutoBottomBox } from './AutoBottomBox';
import { generateGableBox } from './GableBox';
import { generatePaperBag } from './PaperBag';
import { generateCupSleeve } from './CupSleeve';
import { generatePizzaBox } from './PizzaBox';
import { generateEnvelope } from './Envelope';
import { generateMatchboxTray } from './MatchboxTray';
import { generateDoubleTray } from './DoubleTray';
// [HANGING-WINDOW 2026-07-27] Hộp treo có cửa sổ — khoá baseline hình học
import { generateHangingWindowBox } from './HangingWindowBox';
import { generateFlipTopTuckBox } from './FlipTopTuckBox';

/** Dung sai kích thước theo Requirement 4.6 */
const DIM_TOLERANCE = 0.001; // mm

/** Tạo params cố định, xác định từ DEFAULT_PARAMS + override. */
const make = (overrides: Partial<BoxParams>): BoxParams => ({
    ...DEFAULT_PARAMS,
    ...overrides,
});

/**
 * Mẫu DielineModel đại diện — một mẫu / loại hộp với params CỐ ĐỊNH.
 * Giá trị params không dùng random để snapshot luôn xác định.
 */
const FIXTURES: { name: string; generate: (p: BoxParams) => DielineModel; params: BoxParams }[] = [
    {
        name: 'rte (Reverse Tuck End)',
        generate: generateReverseTuckEnd,
        params: make({ boxType: 'rte', L: 100, W: 60, D: 200 }),
    },
    {
        name: 'slb (Snap-Lock Bottom)',
        generate: generateSnapLockBottom,
        params: make({ boxType: 'slb', L: 120, W: 80, D: 180 }),
    },
    {
        name: 'auto_bottom (Hộp đáy dán)',
        generate: generateAutoBottomBox,
        params: make({ boxType: 'auto_bottom', L: 120, W: 80, D: 180 }),
    },
    {
        name: 'gable (Gable Box)',
        generate: generateGableBox,
        params: make({ boxType: 'gable', L: 150, W: 90, D: 220 }),
    },
    {
        name: 'paper_bag (Túi giấy SOS)',
        generate: generatePaperBag,
        params: make({ boxType: 'paper_bag', L: 180, W: 100, D: 250 }),
    },
    {
        name: 'cup_sleeve (Bọc ly)',
        generate: generateCupSleeve,
        params: make({ boxType: 'cup_sleeve', cupD1: 70, cupD2: 80, cupH: 90 }),
    },
    {
        name: 'pizza (Pizza Box FEFCO 0426)',
        generate: generatePizzaBox,
        params: make({ boxType: 'pizza', L: 300, W: 300, D: 40 }),
    },
    {
        name: 'envelope (Bì thư DL)',
        generate: generateEnvelope,
        params: make({ boxType: 'envelope', envW: 220, envH: 110 }),
    },
    {
        name: 'tray (Hộp diêm / Khay)',
        generate: generateMatchboxTray,
        params: make({ boxType: 'tray', L: 100, W: 60, D: 30 }),
    },
    {
        // [DOUBLE-TRAY 2026-07-26] params = mẫu chuẩn 100010-01
        name: 'double_tray (Hộp âm dương)',
        generate: generateDoubleTray,
        params: make({ boxType: 'double_tray', L: 361, W: 261, D: 52, T: 1.5, C: 1, G: 5, TH: 15 }),
    },
    {
        // [HANGING-WINDOW 2026-07-27] params = Preset_Dacdora (bản vẽ khuôn mẫu
        // "hanging electronic product box with window", L=80 × W=30 × D=140).
        // Cửa sổ BẬT + tai treo euro gập đôi ⇒ snapshot khoá cả hai cụm riêng.
        name: 'hanging_window (Hộp treo có cửa sổ)',
        generate: generateHangingWindowBox,
        params: make({
            boxType: 'hanging_window',
            L: 80, W: 30, D: 140, T: 0.5, C: 0.5, G: 15, TH: 15,
            hgbWindow: true, WNW: 0, WNH: 0, HTH: 0,
        }),
    },
    {
        // [FLIP-TOP-TUCK 2026-08-02] Fixture chuẩn đo từ khuon-01.svg.
        name: 'flip_top_tuck (Hộp nắp lật tự khóa)',
        generate: generateFlipTopTuckBox,
        params: make({
            boxType: 'flip_top_tuck',
            L: 200, W: 200, D: 60, T: 0.5, C: 0.5,
        }),
    },
];

/** Dựng mảng chuỗi SVG `d` từ model qua module dùng chung. */
function buildSvgDStrings(model: DielineModel): string[] {
    return buildChains(model.allPaths).map(chain => chainToSvgD(chain.segs));
}

describe('golden-master: ổn định chuỗi SVG (Shared_Geometry_Module)', () => {
    for (const fx of FIXTURES) {
        it(`giữ char-identical chuỗi SVG cho ${fx.name}`, () => {
            const model = fx.generate(fx.params);
            const dStrings = buildSvgDStrings(model);

            // Baseline phải có nội dung
            expect(dStrings.length).toBeGreaterThan(0);
            for (const d of dStrings) {
                expect(d.startsWith('M ')).toBe(true);
            }

            // So khớp char-identical với golden baseline đã ghi.
            expect(dStrings).toMatchSnapshot();
        });
    }
});

describe('golden-master: ổn định giá trị kích thước (computeEnvelopeDims ≤ 0.001mm)', () => {
    // Baseline kích thước (FH/SF) đã chụp cho từng mẫu. Drift > 0.001mm sẽ fail.
    const DIM_BASELINE: Record<string, { FH: number; SF: number }> = {
        'rte (Reverse Tuck End)': { FH: 50, SF: 13 },
        'slb (Snap-Lock Bottom)': { FH: 50, SF: 13 },
        'auto_bottom (Hộp đáy dán)': { FH: 50, SF: 13 },
        'gable (Gable Box)': { FH: 50, SF: 13 },
        'paper_bag (Túi giấy SOS)': { FH: 50, SF: 13 },
        'cup_sleeve (Bọc ly)': { FH: 50, SF: 13 },
        'pizza (Pizza Box FEFCO 0426)': { FH: 50, SF: 13 },
        'envelope (Bì thư DL)': { FH: 50, SF: 13 },
        'tray (Hộp diêm / Khay)': { FH: 50, SF: 13 },
        'double_tray (Hộp âm dương)': { FH: 50, SF: 13 },
        // [HANGING-WINDOW 2026-07-27] FH/SF do computeEnvelopeDims lấy từ params
        // chung (không phụ thuộc loại hộp) nên baseline giống các mẫu còn lại.
        'hanging_window (Hộp treo có cửa sổ)': { FH: 50, SF: 13 },
        'flip_top_tuck (Hộp nắp lật tự khóa)': { FH: 50, SF: 13 },
    };

    for (const fx of FIXTURES) {
        it(`giữ FH/SF ổn định trong ${DIM_TOLERANCE}mm cho ${fx.name}`, () => {
            const dims = computeEnvelopeDims(fx.params);
            const baseline = DIM_BASELINE[fx.name];

            expect(Math.abs(dims.FH - baseline.FH)).toBeLessThanOrEqual(DIM_TOLERANCE);
            expect(Math.abs(dims.SF - baseline.SF)).toBeLessThanOrEqual(DIM_TOLERANCE);

            // Đồng thời snapshot để khoá thêm tầng baseline.
            expect(dims).toMatchSnapshot();
        });
    }
});
