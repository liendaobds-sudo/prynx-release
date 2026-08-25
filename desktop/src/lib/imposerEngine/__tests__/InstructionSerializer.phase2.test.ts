/**
 * Regression test — khoá hợp đồng phase-2 của serializeBookletPlan.
 * Bảo vệ các fix audit "bình sách" hướng B:
 *   F1 step_repeat, F2 fold_pattern, F4 cut-stack 180°, F5 gutter.
 * Nếu ai đó vô tình bỏ rơi chainNup/foldPattern (như lỗi cũ) → test này đỏ.
 */
import { describe, it, expect } from 'vitest';
import { generateBindingMap } from '../VirtualMap';
import { solveGeometry } from '../GeometricSolver';
import {
    serializeBookletPlan,
    type InstructionSet,
    type Phase2Plate,
    type Phase2Placement,
} from '../InstructionSerializer';
import { ImpositionMode } from '../SettingsTypes';
import type {
    BookReportRenderSettings,
    GuillotineSettings,
    OffsetSettings,
} from '../SettingsTypes';
import type { BookletSettings } from '../../../components/imposition-tools/types';

const MM = 2.83465;
const W = 105 * MM, H = 148 * MM; // A6
const PAGES = 16;

type BindingMode = NonNullable<GuillotineSettings['bindingMode']>;
type ScaleMode = '100' | 'fit' | 'chain_nup' | 'cut_stack';

/** Các knob mà regression này cần; helper sẽ bổ sung phần bắt buộc của settings thật. */
type SettingsOverrides = {
    bindingMode?: BindingMode;
    bleed?: number;
    bookReport?: BookReportRenderSettings;
    chainNup?: boolean;
    cutStack?: boolean;
    foldPattern?: string;
    gripperMargin?: number;
    gutterMargin?: number;
    imposerMode?: GuillotineSettings['imposerMode'] | OffsetSettings['imposerMode'];
    interleave?: NonNullable<GuillotineSettings['interleave']>;
    marginBottom?: number;
    marginLeft?: number;
    marginMode?: NonNullable<GuillotineSettings['marginMode']>;
    marginRight?: number;
    marginTop?: number;
    markLength?: number;
    markOffset?: number;
    markThickness?: number;
    markType?: NonNullable<GuillotineSettings['markType']>;
    paperClassification?: NonNullable<GuillotineSettings['paperClassification']>;
    scaleMode?: ScaleMode;
    sheetHeight?: number;
    sheetWidth?: number;
    spreadDistribution?: NonNullable<GuillotineSettings['spreadDistribution']>;
    foliosize?: number;
};

type TestSettings = (GuillotineSettings | OffsetSettings) & { scaleMode: ScaleMode };

function makeSettings(overrides: SettingsOverrides = {}): TestSettings {
    const isOffset = overrides.imposerMode === 'offset' || overrides.paperClassification === 'offset';
    const common = {
        ...overrides,
        impositionMode: ImpositionMode.Booklet,
        sheetWidth: overrides.sheetWidth ?? 0,
        sheetHeight: overrides.sheetHeight ?? 0,
        paperThickness: 0,
        bleed: overrides.bleed ?? 0,
        scaleMode: overrides.scaleMode ?? '100',
    };

    if (isOffset) {
        const settings: OffsetSettings & { scaleMode: ScaleMode } = {
            ...common,
            imposerMode: 'offset',
            paperClassification: 'offset',
        };
        return settings;
    }

    const settings: GuillotineSettings & { scaleMode: ScaleMode } = {
        ...common,
        imposerMode: 'guillotine',
        paperClassification: overrides.paperClassification ?? 'in_nhanh',
    };
    return settings;
}

function makeGeometrySettings(s: SettingsOverrides, formsize: string): BookletSettings {
    const isOffset = s.imposerMode === 'offset' || s.paperClassification === 'offset';
    return {
        paperClassification: isOffset ? 'offset' : 'in_nhanh',
        signatureMode: s.bindingMode ?? 'saddle',
        foliosize: s.foliosize ?? 16,
        formsize,
        customSheetWidth: s.sheetWidth ?? 0,
        customSheetHeight: s.sheetHeight ?? 0,
        bleed: s.bleed ?? 0,
        paperThickness: 0,
        markType: s.markType ?? 'none',
        markOffset: s.markOffset,
        markLength: s.markLength,
        markThickness: s.markThickness,
        interleave: s.interleave ?? 'normal',
        scaleMode: s.scaleMode ?? '100',
        foldPattern: s.foldPattern,
        gripperMargin: s.gripperMargin,
        marginTop: s.marginTop,
        marginBottom: s.marginBottom,
        marginLeft: s.marginLeft,
        marginRight: s.marginRight,
        marginMode: s.marginMode,
        spreadDistribution: s.spreadDistribution,
        gutterMargin: s.gutterMargin,
        spawnNewTab: false,
    };
}

function buildForPages(pageCount: number, s: SettingsOverrides): InstructionSet {
    const settings = makeSettings(s);
    const bMode = settings.bindingMode || 'saddle';
    const map = generateBindingMap(pageCount, bMode, settings.foliosize, 'end', settings.scaleMode || (s.cutStack ? 'cut_stack' : '100')).sheets;
    const pageDetails = Array.from({ length: pageCount }, () => ({ visualW: W, visualH: H, angle: 0 }));
    const fp = s.foldPattern;
    const phase2 = !!s.chainNup || (!!fp && fp !== '');
    const formsize = (!(s.sheetWidth) || phase2) ? 'auto_100' : 'custom';
    const pseudo = makeGeometrySettings(s, formsize);
    const geo = solveGeometry(W, H, pseudo, {}, MM);
    return serializeBookletPlan(map, pageDetails, geo, (settings.bleed || 0) * MM, 0,
        bMode === 'saddle' || bMode === 'thread', settings.markType || 'none',
        settings.interleave || 'normal', settings, 'src.pdf', 'out', pageCount);
}

function build(s: SettingsOverrides): InstructionSet {
    return buildForPages(PAGES, s);
}

describe('serializeBookletPlan — phase-2 contract', () => {
    it('plain saddle → no phase2, 4 spread sheets for 16p', () => {
        const p = build({ bindingMode: 'saddle', bleed: 3 });
        expect(p.phase2).toBeUndefined();
        expect(p.sheets).toHaveLength(4);
    });

    it('serializes a render-ready book report without label-production fields', () => {
        const p = build({
            bindingMode: 'saddle',
            bleed: 3,
            bookReport: {
                enabled: true,
                text: 'DH-001 - TAP CHI - 96 TRANG\nRUOT FORT 80 GSM',
                position: 'bottom',
                centered: false,
                offsetX: 6,
                offsetY: 7,
                fontSize: 8,
            },
        });

        expect(p.book_report).toEqual({
            enabled: true,
            text: 'DH-001 - TAP CHI - 96 TRANG\nRUOT FORT 80 GSM',
            position: 'bottom',
            centered: false,
            offset_x_mm: 6,
            offset_y_mm: 7,
            font_size: 8,
        });
    });

    it('F1 chain_nup → step_repeat, một plate per spread surface, replicate đầy lưới', () => {
        const p = build({ bindingMode: 'saddle', bleed: 3, chainNup: true, sheetWidth: 320, sheetHeight: 450, gripperMargin: 10 });
        expect(p.phase2?.mode).toBe('step_repeat');
        expect(p.sheets).toHaveLength(8);             // 4 sheets × (front+back)
        expect(p.phase2!.plates).toHaveLength(8);     // 1 plate / spread surface
        // mỗi plate nhân bản CÙNG 1 spread vào mọi cell (>=1, thường >1)
        for (const pl of p.phase2!.plates) {
            const idxs = new Set(pl.placements.map(q => q.spread_index));
            expect(idxs.size).toBe(1);
            expect(pl.placements.length).toBeGreaterThanOrEqual(1);
        }
    });

    it('28p Digital ignores a persisted Offset pattern and keeps 14 Step & Repeat plates', () => {
        const p = buildForPages(28, {
            imposerMode: 'guillotine', paperClassification: 'in_nhanh',
            bindingMode: 'saddle', chainNup: true, foldPattern: 'sig_16p',
            sheetWidth: 640, sheetHeight: 450,
        });
        expect(p.phase2?.mode).toBe('step_repeat');
        expect(p.sheets).toHaveLength(14);
        expect(p.phase2?.plates).toHaveLength(14);
        expect(p.sheets[0].front.placements.map(q => q.source_page)).toEqual([27, 0]);
        expect(p.sheets[1].front.placements.map(q => q.source_page)).toEqual([1, 26]);
        expect(p.sheets[13].front.placements.map(q => q.source_page)).toEqual([13, 14]);
    });

    it('28p Offset rejects incompatible sig_16p instead of regrouping 8+6 surfaces', () => {
        const p = buildForPages(28, {
            imposerMode: 'offset', paperClassification: 'offset',
            bindingMode: 'saddle', chainNup: true, foldPattern: 'sig_16p',
            sheetWidth: 700, sheetHeight: 500,
        });
        expect(p.phase2?.mode).toBe('step_repeat');
        expect(p.phase2?.plates).toHaveLength(14);
    });

    it('flush_mount is truly single-sided in phase 2 (no blank back plates)', () => {
        const p = buildForPages(8, {
            imposerMode: 'guillotine', paperClassification: 'in_nhanh',
            bindingMode: 'flush_mount', chainNup: true,
            sheetWidth: 640, sheetHeight: 450,
        });
        expect(p.phase2?.mode).toBe('step_repeat');
        expect(p.sheets).toHaveLength(4);
        expect(p.phase2?.plates).toHaveLength(4);
    });

    it('chặn flush_mount + cut_stack trước khi tạo plate A/B hai mặt', () => {
        expect(() => buildForPages(8, {
            imposerMode: 'guillotine', paperClassification: 'in_nhanh',
            bindingMode: 'flush_mount', chainNup: true, cutStack: true,
            sheetWidth: 640, sheetHeight: 450,
        })).toThrow(/Dán đối lưng/);
    });

    it('dấu giữa 1-up: saddle là nếp gấp đỏ, continuous là đường xẻ đen', () => {
        const saddle = build({ bindingMode: 'saddle', bleed: 3, markType: 'guillotine' });
        const continuous = build({ bindingMode: 'continuous', bleed: 3, markType: 'guillotine' });

        const foldMarks = saddle.sheets[0].front.marks.filter(mark => mark.type === 'fold_mark');
        expect(foldMarks).toHaveLength(2);
        expect(foldMarks.every(mark => mark.color.join(',') === '0,1,1,0')).toBe(true);

        const slitMarks = continuous.sheets[0].front.marks.filter(mark => mark.type === 'slit_mark');
        expect(slitMarks).toHaveLength(2);
        expect(slitMarks.every(mark => mark.color.join(',') === '0,0,0,1')).toBe(true);
    });

    it('preserves the per-thumbnail page rotation in backend instructions', () => {
        const map = generateBindingMap(4, 'saddle').sheets;
        map[0].front.left.userRotation = 90;
        const pageDetails = Array.from({ length: 4 }, () => ({ visualW: W, visualH: H, angle: 0 }));
        const geo = solveGeometry(W, H, makeGeometrySettings({ bindingMode: 'saddle' }, 'auto_100'), {}, MM);
        const p = serializeBookletPlan(
            map, pageDetails, geo, 0, 0, true, 'none', 'normal',
            makeSettings({ bindingMode: 'saddle' }), 'src.pdf', 'out', 4,
        );
        expect(p.sheets[0].front.placements[0].native_angle).toBe(90);
    });

    it('F2 fold_pattern sig_16p → 2 plates (A/B), có slot xoay 180°', () => {
        const p = build({ imposerMode: 'offset', paperClassification: 'offset', bindingMode: 'saddle', bleed: 3, foldPattern: 'sig_16p', sheetWidth: 700, sheetHeight: 500, gripperMargin: 10 });
        expect(p.phase2?.mode).toBe('fold_pattern');
        expect(p.phase2!.plates).toHaveLength(2);
        for (const pl of p.phase2!.plates) {
            expect(pl.placements).toHaveLength(4);    // 2×2 grid
            expect(pl.placements.some(q => q.rotation_deg === 180)).toBe(true);
            expect(pl.placements.some(q => q.rotation_deg === 0)).toBe(true);
        }
        // phủ đủ 8 spread không trùng
        const all = p.phase2!.plates.flatMap(pl => pl.placements.map(q => q.spread_index));
        expect(new Set(all).size).toBe(8);
    });

    it('F4 cut_stacks "Hút gáy" (clustered) → cọc phải xoay 180°', () => {
        const p = build({ bindingMode: 'cut_stacks', bleed: 3, spreadDistribution: 'clustered' });
        expect(p.phase2).toBeUndefined();
        const front = p.sheets[0].front.placements;
        // [left, right] — cọc phải (index 1) phải r180, trái r0
        expect(front[0].rotation_deg).toBe(0);
        expect(front[1].rotation_deg).toBe(180);
    });

    it('F4 cut_stacks "Trải đều" (even) → KHÔNG xoay', () => {
        const p = build({ bindingMode: 'cut_stacks', bleed: 3, spreadDistribution: 'even' });
        for (const pl of p.sheets[0].front.placements) expect(pl.rotation_deg).toBe(0);
    });

    it('F5 gutter (continuous) → trang trái dịch xa gáy so với gutter=0', () => {
        const g0 = build({ bindingMode: 'continuous', bleed: 3, gutterMargin: 0 });
        const g10 = build({ bindingMode: 'continuous', bleed: 3, gutterMargin: 10 });
        const left0 = g0.sheets[0].front.placements[0].x_pt;
        const left10 = g10.sheets[0].front.placements[0].x_pt;
        expect(left10).toBeLessThan(left0); // dịch sang trái (xa spine) đúng 10mm
        expect(left0 - left10).toBeCloseTo(10 * MM, 1);
    });
});

// Box bbox của 1 spread theo rotation (90/270 hoán chiều).
function boxOf(rot: number, sw: number, sh: number) {
    return (rot % 180 !== 0) ? { w: sh, h: sw } : { w: sw, h: sh };
}
function allInBounds(plan: InstructionSet): boolean {
    const phase2 = plan.phase2;
    if (!phase2) return false;
    const { spread_w_pt: sw, spread_h_pt: sh, plates } = phase2;
    return plates.every((pl: Phase2Plate) => pl.placements.every((p: Phase2Placement) => {
        const b = boxOf(p.rotation_deg, sw, sh);
        return p.x_pt >= -0.5 && p.y_pt >= -0.5 &&
            p.x_pt + b.w <= pl.width_pt + 0.5 && p.y_pt + b.h <= pl.height_pt + 0.5;
    }));
}
function noOverlap(plate: Phase2Plate, sw: number, sh: number): boolean {
    const boxes = plate.placements.map((p: Phase2Placement) => {
        const b = boxOf(p.rotation_deg, sw, sh);
        return { x: p.x_pt, y: p.y_pt, w: b.w, h: b.h };
    });
    for (let a = 0; a < boxes.length; a++)
        for (let c = a + 1; c < boxes.length; c++) {
            const A = boxes[a], B = boxes[c];
            const ix = Math.max(0, Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x));
            const iy = Math.max(0, Math.min(A.y + A.h, B.y + B.h) - Math.max(A.y, B.y));
            if (ix * iy > 1) return false;
        }
    return true;
}

describe('serializeBookletPlan — phase-2 grid rotation (90°) & cut_stack', () => {
    it('step_repeat khổ ngang → KHÔNG xoay (rot 0), trong khổ, không chồng', () => {
        const p = build({ bindingMode: 'saddle', bleed: 3, chainNup: true, sheetWidth: 640, sheetHeight: 450, marginLeft: 8, marginRight: 8, marginTop: 8, gripperMargin: 10 });
        expect(p.phase2!.plates.every((pl: Phase2Plate) => pl.placements.every((q: Phase2Placement) => q.rotation_deg === 0))).toBe(true);
        expect(allInBounds(p)).toBe(true);
        expect(p.phase2!.plates.every((pl: Phase2Plate) => noOverlap(pl, p.phase2!.spread_w_pt, p.phase2!.spread_h_pt))).toBe(true);
    });

    it('step_repeat khổ dọc → xuất khổ NGANG, spread đứng 100% (rot 0)', () => {
        const p = build({ bindingMode: 'saddle', bleed: 3, chainNup: true, sheetWidth: 320, sheetHeight: 450, marginLeft: 8, marginRight: 8, marginTop: 8, gripperMargin: 10 });
        // Digital: xếp xong xoay TỜ sang ngang, nội dung đứng thẳng 100% (KHÔNG xoay content).
        expect(p.phase2!.plates.every((pl: Phase2Plate) => pl.placements.every((q: Phase2Placement) => q.rotation_deg === 0))).toBe(true);
        expect(allInBounds(p)).toBe(true);
        // Khổ tờ xoay sang NGANG: 450×320 (từ khổ đặt 320×450).
        expect(Math.round(p.phase2!.plates[0].width_pt)).toBe(Math.round(450 * MM));
        expect(Math.round(p.phase2!.plates[0].height_pt)).toBe(Math.round(320 * MM));
    });

    it('fold_pattern khổ dọc → slot 0/180 cộng 90 thành 90/270', () => {
        const p = build({ imposerMode: 'offset', paperClassification: 'offset', bindingMode: 'saddle', bleed: 3, foldPattern: 'sig_16p', sheetWidth: 500, sheetHeight: 700, marginLeft: 10, marginRight: 10, marginTop: 10, gripperMargin: 10 });
        const rots = new Set<number>(p.phase2!.plates.flatMap((pl: Phase2Plate) => pl.placements.map((q: Phase2Placement) => q.rotation_deg)));
        expect(rots.has(90)).toBe(true);
        expect(rots.has(270)).toBe(true);
        expect(allInBounds(p)).toBe(true);
    });

    it('step_repeat spread rộng hơn khổ dọc → xuất khổ NGANG, spread đứng 100% (regression 209×299 → xuất 430×320)', () => {
        // Page 209×299mm → spread 418×299mm (ngang). Khổ đặt 320×430mm (dọc).
        // Lỗi cũ #1: tự phình khổ thành 424×430. Lỗi cũ #2: xoay content 90° ép vào tờ dọc.
        // ĐÚNG: xếp spread 100% đứng thẳng rồi xuất TỜ nằm ngang 430×320.
        const PW = 209 * MM, PH = 299 * MM;
        const details2 = Array.from({ length: PAGES }, () => ({ visualW: PW, visualH: PH, angle: 0 }));
        const map = generateBindingMap(PAGES, 'saddle', undefined, 'end').sheets;
        const pseudo = makeGeometrySettings({ bindingMode: 'saddle', bleed: 3, sheetWidth: 320, sheetHeight: 430 }, 'auto_100');
        const geo = solveGeometry(PW, PH, pseudo, {}, MM);
        const p = serializeBookletPlan(map, details2, geo, 3 * MM, 0, true, 'none', 'normal',
            makeSettings({ bindingMode: 'saddle', bleed: 3, chainNup: true, sheetWidth: 320, sheetHeight: 430, gripperMargin: 10 }),
            'src.pdf', 'out', PAGES);
        expect(p.phase2?.mode).toBe('step_repeat');
        // Tờ xuất ra NẰM NGANG: 430×320 (từ khổ đặt 320×430).
        expect(Math.round(p.phase2!.plates[0].width_pt)).toBe(Math.round(430 * MM));
        expect(Math.round(p.phase2!.plates[0].height_pt)).toBe(Math.round(320 * MM));
        // Content KHÔNG xoay — spread đặt đứng thẳng 100%.
        expect(p.phase2!.plates.every((pl: Phase2Plate) => pl.placements.every((q: Phase2Placement) => q.rotation_deg === 0))).toBe(true);
        expect(allInBounds(p)).toBe(true);
    });

    it('cut_stack → mặt A (surface chẵn) + mặt B (surface lẻ), phủ đủ, không chồng', () => {
        const p = build({ bindingMode: 'saddle', bleed: 3, chainNup: true, cutStack: true, sheetWidth: 450, sheetHeight: 320, marginLeft: 8, marginRight: 8, marginTop: 8, gripperMargin: 10 });
        expect(p.phase2!.mode).toBe('cut_stack');
        const fronts = p.phase2!.plates.filter((_: Phase2Plate, i: number) => i % 2 === 0).flatMap((pl: Phase2Plate) => pl.placements.map((q: Phase2Placement) => q.spread_index));
        const backs = p.phase2!.plates.filter((_: Phase2Plate, i: number) => i % 2 === 1).flatMap((pl: Phase2Plate) => pl.placements.map((q: Phase2Placement) => q.spread_index));
        expect(fronts.every((s: number) => s % 2 === 0)).toBe(true); // mặt A = surface chẵn (front spread)
        expect(backs.every((s: number) => s % 2 === 1)).toBe(true);  // mặt B = surface lẻ (back spread)
        expect(new Set([...fronts, ...backs]).size).toBe(8);         // phủ đủ 8 surface
        expect(p.phase2!.plates.every((pl: Phase2Plate) => noOverlap(pl, p.phase2!.spread_w_pt, p.phase2!.spread_h_pt))).toBe(true);
    });

    it('cut_stack nhiều cọc (stackDepth>1) → collation cell*depth liên tục khi xén chồng', () => {
        // khổ chỉ chứa 2 cell, 16p (B=4) → stackDepth=2, 2 tờ × 2 mặt = 4 plates
        const p = build({ bindingMode: 'saddle', bleed: 3, chainNup: true, cutStack: true, sheetWidth: 460, sheetHeight: 165, marginLeft: 8, marginRight: 8, marginTop: 8, gripperMargin: 10 });
        const A = p.phase2!.plates.filter((_: Phase2Plate, i: number) => i % 2 === 0); // mặt A các tờ
        // cell0 qua các tờ (depth) → booklet sheet 0,1 ; cell1 → 2,3
        // mặt A surface = 2*bsi: tờ1 cell0=surf0, cell1=surf4 ; tờ2 cell0=surf2, cell1=surf6
        expect(A[0].placements.map((q: Phase2Placement) => q.spread_index)).toEqual([0, 4]);
        expect(A[1].placements.map((q: Phase2Placement) => q.spread_index)).toEqual([2, 6]);
    });
});
