import { describe, it, expect } from 'vitest';
import { generateReverseTuckEnd } from './ReverseTuckEnd';
import { generateSnapLockBottom } from './SnapLockBottom';
import { DEFAULT_PARAMS, BoxParams, DielineModel } from './types';

// Helper to create params with overrides
const make = (overrides: Partial<BoxParams> = {}): BoxParams => ({
    ...DEFAULT_PARAMS,
    ...overrides,
});

// ─── Shared assertions for any DielineModel ─────────────────

function assertValidDieline(model: DielineModel) {
    // Basic structure
    expect(model.name).toBeTruthy();
    expect(model.standardCode).toBeTruthy();
    expect(model.panels.length).toBeGreaterThan(0);
    expect(model.allPaths.length).toBeGreaterThan(0);

    // Bounding box
    const { boundingBox: bb } = model;
    expect(bb.width).toBeGreaterThan(0);
    expect(bb.height).toBeGreaterThan(0);
    expect(bb.maxX).toBeGreaterThan(bb.minX);
    expect(bb.maxY).toBeGreaterThan(bb.minY);
    expect(bb.width).toBeCloseTo(bb.maxX - bb.minX, 1);
    expect(bb.height).toBeCloseTo(bb.maxY - bb.minY, 1);

    // All paths have valid tags
    for (const path of model.allPaths) {
        expect(['CUT', 'CREASE', 'BLEED']).toContain(path.tag);
        expect(path.points.length).toBeGreaterThanOrEqual(2);
        expect(['line', 'arc', 'bezier']).toContain(path.type);
    }

    // All panels have paths
    for (const panel of model.panels) {
        expect(panel.name).toBeTruthy();
        expect(panel.paths.length).toBeGreaterThan(0);
    }
}

// ─── Reverse Tuck End ───────────────────────────────────────

describe('generateReverseTuckEnd', () => {
    it('generates valid dieline with default params', () => {
        const model = generateReverseTuckEnd(make({ boxType: 'rte' }));
        assertValidDieline(model);
        expect(model.standardCode).toContain('ECMA');
    });

    it('generates correct panel count', () => {
        const model = generateReverseTuckEnd(make({ boxType: 'rte' }));
        // RTE should have: glue_flap + 4 main panels + 2 closures + 2 tuck flaps + 4 dust flaps = ~13
        expect(model.panels.length).toBeGreaterThanOrEqual(10);
    });

    it('has matching CUT and CREASE paths', () => {
        const model = generateReverseTuckEnd(make({ boxType: 'rte' }));
        const cutPaths = model.allPaths.filter(p => p.tag === 'CUT');
        const creasePaths = model.allPaths.filter(p => p.tag === 'CREASE');
        expect(cutPaths.length).toBeGreaterThan(0);
        expect(creasePaths.length).toBeGreaterThan(0);
    });

    it('bounding box scales with dimensions', () => {
        const small = generateReverseTuckEnd(make({ boxType: 'rte', L: 50, W: 30, D: 100 }));
        const large = generateReverseTuckEnd(make({ boxType: 'rte', L: 200, W: 100, D: 300 }));
        expect(large.boundingBox.width).toBeGreaterThan(small.boundingBox.width);
        expect(large.boundingBox.height).toBeGreaterThan(small.boundingBox.height);
    });

    it('handles L === W edge case', () => {
        const model = generateReverseTuckEnd(make({ boxType: 'rte', L: 80, W: 80 }));
        assertValidDieline(model);
    });

    it('handles minimum dimensions', () => {
        const model = generateReverseTuckEnd(make({
            boxType: 'rte', L: 30, W: 15, D: 10, T: 0.2
        }));
        assertValidDieline(model);
    });

    it('handles LWLW panel order', () => {
        const model = generateReverseTuckEnd(make({
            boxType: 'rte', panelOrder: 'LWLW'
        }));
        assertValidDieline(model);
    });

    it('generates with right glue side', () => {
        const model = generateReverseTuckEnd(make({
            boxType: 'rte', glueSide: 'right'
        }));
        assertValidDieline(model);
    });

    it('stores params in output model', () => {
        const params = make({ boxType: 'rte', L: 120, W: 70, D: 180 });
        const model = generateReverseTuckEnd(params);
        expect(model.params.L).toBe(120);
        expect(model.params.W).toBe(70);
        expect(model.params.D).toBe(180);
    });
});

// ─── Snap-Lock Bottom ───────────────────────────────────────

describe('generateSnapLockBottom', () => {
    it('generates valid dieline with default params', () => {
        const model = generateSnapLockBottom(make({ boxType: 'slb' }));
        assertValidDieline(model);
        expect(model.standardCode).toContain('FEFCO');
    });

    it('has more panels than RTE (bottom mechanism)', () => {
        const rte = generateReverseTuckEnd(make({ boxType: 'rte', L: 100, W: 60, D: 200 }));
        const slb = generateSnapLockBottom(make({ boxType: 'slb', L: 100, W: 60, D: 200 }));
        // SLB should have additional bottom panels
        expect(slb.panels.length).toBeGreaterThan(rte.panels.length);
    });

    it('handles L === W edge case', () => {
        const model = generateSnapLockBottom(make({
            boxType: 'slb', L: 80, W: 80, T: 0.5
        }));
        assertValidDieline(model);
    });

    it('handles different SLP values', () => {
        for (const SLP of [1, 2, 3]) {
            const model = generateSnapLockBottom(make({
                boxType: 'slb', L: 200, W: 60, SLP
            }));
            assertValidDieline(model);
        }
    });

    it('bounding box width matches RTE (crash-lock extends vertically, not horizontally)', () => {
        const params = make({ boxType: 'slb', L: 100, W: 60, D: 200 });
        const rte = generateReverseTuckEnd({ ...params, boxType: 'rte' });
        const slb = generateSnapLockBottom(params);
        // Crash-lock bottom extends downward, width should be >= RTE
        expect(slb.boundingBox.width).toBeGreaterThanOrEqual(rte.boundingBox.width);
    });

    it('uses the same single top-tuck crease geometry as RTE', () => {
        const params = make({ boxType: 'slb', L: 100, W: 60, D: 200, T: 0.5 });
        const slb = generateSnapLockBottom(params);
        const rte = generateReverseTuckEnd({ ...params, boxType: 'rte' });
        const slbTuck = slb.panels.find(panel => panel.name === 'tuck_top');
        const rteTuck = rte.panels.find(panel => panel.name === 'tuck_top');

        expect(slbTuck).toBeDefined();
        expect(rteTuck).toBeDefined();
        expect(slbTuck!.paths.filter(path => path.tag === 'CREASE')).toHaveLength(0);
        expect(slbTuck!.paths).toEqual(rteTuck!.paths);
        expect(slbTuck!.pivotEdge).toEqual(rteTuck!.pivotEdge);
    });
});

// ─── Pizza Box (FEFCO 0426) ─────────────────────────────────

import { generatePizzaBox } from './PizzaBox';

describe('generatePizzaBox', () => {
    it('generates valid dieline with default params', () => {
        const model = generatePizzaBox(make({ boxType: 'pizza', L: 300, W: 300, D: 40 }));
        assertValidDieline(model);
        expect(model.standardCode).toContain('FEFCO');
    });

    it('generates correct panel count', () => {
        const model = generatePizzaBox(make({ boxType: 'pizza', L: 300, W: 300, D: 40 }));
        // Pizza: bottom + front + back + lid + 6 dust flaps + 2 side walls = 12
        expect(model.panels.length).toBeGreaterThanOrEqual(12);
    });

    it('has matching CUT and CREASE paths', () => {
        const model = generatePizzaBox(make({ boxType: 'pizza', L: 300, W: 300, D: 40 }));
        const cutPaths = model.allPaths.filter(p => p.tag === 'CUT');
        const creasePaths = model.allPaths.filter(p => p.tag === 'CREASE');
        expect(cutPaths.length).toBeGreaterThan(0);
        expect(creasePaths.length).toBeGreaterThan(0);
    });

    it('bounding box scales with dimensions', () => {
        const small = generatePizzaBox(make({ boxType: 'pizza', L: 200, W: 200, D: 30 }));
        const large = generatePizzaBox(make({ boxType: 'pizza', L: 400, W: 400, D: 50 }));
        expect(large.boundingBox.width).toBeGreaterThan(small.boundingBox.width);
        expect(large.boundingBox.height).toBeGreaterThan(small.boundingBox.height);
    });

    it('handles L === W (standard square pizza box)', () => {
        const model = generatePizzaBox(make({ boxType: 'pizza', L: 300, W: 300, D: 40 }));
        assertValidDieline(model);
    });

    it('handles L !== W (rectangular pizza box)', () => {
        const model = generatePizzaBox(make({ boxType: 'pizza', L: 350, W: 250, D: 45 }));
        assertValidDieline(model);
    });

    it('handles minimum dimensions', () => {
        const model = generatePizzaBox(make({
            boxType: 'pizza', L: 100, W: 80, D: 20, T: 0.5
        }));
        assertValidDieline(model);
    });

    it('has lid panel attached to back', () => {
        const model = generatePizzaBox(make({ boxType: 'pizza', L: 300, W: 300, D: 40 }));
        const lid = model.panels.find(p => p.name === 'lid');
        expect(lid).toBeDefined();
        expect(lid!.parent).toBe('back');
    });

    it('has front panel attached to bottom', () => {
        const model = generatePizzaBox(make({ boxType: 'pizza', L: 300, W: 300, D: 40 }));
        const front = model.panels.find(p => p.name === 'front');
        expect(front).toBeDefined();
        expect(front!.parent).toBe('bottom');
        // Bottom is ROOT
        const bottom = model.panels.find(p => p.name === 'bottom');
        expect(bottom).toBeDefined();
        expect(bottom!.parent).toBeNull();
    });

    it('has side walls with cuộn structure (like mailer)', () => {
        const model = generatePizzaBox(make({ boxType: 'pizza', L: 300, W: 300, D: 40 }));
        const sideLeft = model.panels.find(p => p.name === 'side_left');
        const sideRight = model.panels.find(p => p.name === 'side_right');
        expect(sideLeft).toBeDefined();
        expect(sideRight).toBeDefined();
        expect(sideLeft!.parent).toBe('bottom');
        expect(sideRight!.parent).toBe('bottom');
    });

    it('has dust flaps on front, back, and lid', () => {
        const model = generatePizzaBox(make({ boxType: 'pizza', L: 300, W: 300, D: 40 }));
        const dustPanels = model.panels.filter(p => p.name.startsWith('dust_'));
        // 6 dust flaps: front-L, front-R, back-L, back-R, lid-L, lid-R
        expect(dustPanels.length).toBe(6);
    });

    it('stores params in output model', () => {
        const params = make({ boxType: 'pizza', L: 350, W: 350, D: 45 });
        const model = generatePizzaBox(params);
        expect(model.params.L).toBe(350);
        expect(model.params.W).toBe(350);
        expect(model.params.D).toBe(45);
    });
});

// ─── Gable Box ──────────────────────────────────────────────

import { generateGableBox } from './GableBox';

describe('generateGableBox', () => {
    it('generates valid dieline with default params', () => {
        const model = generateGableBox(make({ boxType: 'gable' }));
        assertValidDieline(model);
    });

    it('generates correct panel count', () => {
        const model = generateGableBox(make({ boxType: 'gable' }));
        // Gable: 4 body + glue + 2 gable panels + 2 side flaps + crash-lock bottom = ~14+
        expect(model.panels.length).toBeGreaterThanOrEqual(10);
    });

    it('has matching CUT and CREASE paths', () => {
        const model = generateGableBox(make({ boxType: 'gable' }));
        const cutPaths = model.allPaths.filter(p => p.tag === 'CUT');
        const creasePaths = model.allPaths.filter(p => p.tag === 'CREASE');
        expect(cutPaths.length).toBeGreaterThan(0);
        expect(creasePaths.length).toBeGreaterThan(0);
    });

    it('bounding box scales with dimensions', () => {
        const small = generateGableBox(make({ boxType: 'gable', L: 50, W: 30, D: 100 }));
        const large = generateGableBox(make({ boxType: 'gable', L: 200, W: 100, D: 300 }));
        expect(large.boundingBox.width).toBeGreaterThan(small.boundingBox.width);
        expect(large.boundingBox.height).toBeGreaterThan(small.boundingBox.height);
    });

    it('handles L === W edge case', () => {
        const model = generateGableBox(make({ boxType: 'gable', L: 80, W: 80 }));
        assertValidDieline(model);
    });

    it('handles minimum dimensions', () => {
        const model = generateGableBox(make({
            boxType: 'gable', L: 50, W: 30, D: 80, T: 0.5
        }));
        assertValidDieline(model);
    });

    it('has gable panels', () => {
        const model = generateGableBox(make({ boxType: 'gable' }));
        const gablePanels = model.panels.filter(p => p.name.includes('gable'));
        expect(gablePanels.length).toBeGreaterThanOrEqual(2);
    });

    it('stores params in output model', () => {
        const params = make({ boxType: 'gable', L: 120, W: 70, D: 180 });
        const model = generateGableBox(params);
        expect(model.params.L).toBe(120);
        expect(model.params.W).toBe(70);
        expect(model.params.D).toBe(180);
    });
});

// ─── Paper Bag (Túi giấy SOS) ───────────────────────────────

import { generatePaperBag } from './PaperBag';

describe('generatePaperBag', () => {
    it('generates valid dieline with default params', () => {
        const model = generatePaperBag(make({ boxType: 'paper_bag' }));
        assertValidDieline(model);
    });

    it('generates correct panel count', () => {
        const model = generatePaperBag(make({ boxType: 'paper_bag' }));
        // Paper bag: glue + 4 body panels + bottom panels = ~8+
        expect(model.panels.length).toBeGreaterThanOrEqual(5);
    });

    it('has matching CUT and CREASE paths', () => {
        const model = generatePaperBag(make({ boxType: 'paper_bag' }));
        const cutPaths = model.allPaths.filter(p => p.tag === 'CUT');
        const creasePaths = model.allPaths.filter(p => p.tag === 'CREASE');
        expect(cutPaths.length).toBeGreaterThan(0);
        expect(creasePaths.length).toBeGreaterThan(0);
    });

    it('bounding box scales with dimensions', () => {
        const small = generatePaperBag(make({ boxType: 'paper_bag', L: 50, W: 30, D: 100 }));
        const large = generatePaperBag(make({ boxType: 'paper_bag', L: 200, W: 100, D: 300 }));
        expect(large.boundingBox.width).toBeGreaterThan(small.boundingBox.width);
        expect(large.boundingBox.height).toBeGreaterThan(small.boundingBox.height);
    });

    it('handles LWLW panel order', () => {
        const model = generatePaperBag(make({
            boxType: 'paper_bag', panelOrder: 'LWLW'
        }));
        assertValidDieline(model);
    });

    it('generates with right glue side', () => {
        const model = generatePaperBag(make({
            boxType: 'paper_bag', glueSide: 'right'
        }));
        assertValidDieline(model);
    });

    it('handles minimum dimensions', () => {
        const model = generatePaperBag(make({
            boxType: 'paper_bag', L: 50, W: 30, D: 80, T: 0.5
        }));
        assertValidDieline(model);
    });

    it('stores params in output model', () => {
        const params = make({ boxType: 'paper_bag', L: 150, W: 80, D: 250 });
        const model = generatePaperBag(params);
        expect(model.params.L).toBe(150);
        expect(model.params.W).toBe(80);
        expect(model.params.D).toBe(250);
    });
});

// ─── Cup Sleeve (Bọc ly) ────────────────────────────────────

import { generateCupSleeve } from './CupSleeve';

describe('generateCupSleeve', () => {
    it('generates valid dieline with default params', () => {
        const model = generateCupSleeve(make({ boxType: 'cup_sleeve' }));
        assertValidDieline(model);
    });

    it('has bezier arc segments', () => {
        const model = generateCupSleeve(make({ boxType: 'cup_sleeve' }));
        const bezierPaths = model.allPaths.filter(p => p.type === 'bezier');
        expect(bezierPaths.length).toBeGreaterThan(0);
    });

    it('has matching CUT and CREASE paths', () => {
        const model = generateCupSleeve(make({ boxType: 'cup_sleeve' }));
        const cutPaths = model.allPaths.filter(p => p.tag === 'CUT');
        const creasePaths = model.allPaths.filter(p => p.tag === 'CREASE');
        expect(cutPaths.length).toBeGreaterThan(0);
        expect(creasePaths.length).toBeGreaterThan(0);
    });

    it('bounding box scales with cup dimensions', () => {
        const small = generateCupSleeve(make({ boxType: 'cup_sleeve', cupD1: 60, cupD2: 70, cupH: 80 }));
        const large = generateCupSleeve(make({ boxType: 'cup_sleeve', cupD1: 100, cupD2: 120, cupH: 150 }));
        expect(large.boundingBox.width).toBeGreaterThan(small.boundingBox.width);
        expect(large.boundingBox.height).toBeGreaterThan(small.boundingBox.height);
    });

    it('handles different flap positions', () => {
        for (const pos of ['left', 'right', 'none'] as const) {
            const model = generateCupSleeve(make({
                boxType: 'cup_sleeve', cupFlapPosition: pos
            }));
            assertValidDieline(model);
        }
    });

    it('handles slant vs vertical height type', () => {
        const slant = generateCupSleeve(make({ boxType: 'cup_sleeve', cupHeightType: 'slant' }));
        const vert = generateCupSleeve(make({ boxType: 'cup_sleeve', cupHeightType: 'vertical' }));
        assertValidDieline(slant);
        assertValidDieline(vert);
    });

    it('stores params in output model', () => {
        const params = make({ boxType: 'cup_sleeve', cupD1: 75, cupD2: 85, cupH: 100 });
        const model = generateCupSleeve(params);
        expect(model.params.cupD1).toBe(75);
        expect(model.params.cupD2).toBe(85);
        expect(model.params.cupH).toBe(100);
    });
});

// ─── Matchbox Tray (Hộp Diêm / Khay) ────────────────────────

import { generateMatchboxTray } from './MatchboxTray';

describe('generateMatchboxTray', () => {
    it('generates valid dieline with default params', () => {
        const model = generateMatchboxTray(make({ boxType: 'tray', L: 200, W: 150, D: 40, G: 10, TH: 15 }));
        assertValidDieline(model);
        expect(model.standardCode).toContain('FEFCO');
    });

    it('generates correct panel count (bottom + 4×4 zones + 4 corner gussets + 4 lock tabs + 5 sleeve = 30)', () => {
        const model = generateMatchboxTray(make({ boxType: 'tray', L: 200, W: 150, D: 40, G: 10, TH: 15 }));
        expect(model.panels.length).toBe(30);
    });

    it('has matching CUT and CREASE paths', () => {
        const model = generateMatchboxTray(make({ boxType: 'tray', L: 200, W: 150, D: 40, G: 10, TH: 15 }));
        const cutPaths = model.allPaths.filter(p => p.tag === 'CUT');
        const creasePaths = model.allPaths.filter(p => p.tag === 'CREASE');
        expect(cutPaths.length).toBeGreaterThan(0);
        expect(creasePaths.length).toBeGreaterThan(0);
    });

    it('has bezier segments from tab fillets', () => {
        const model = generateMatchboxTray(make({ boxType: 'tray', L: 200, W: 150, D: 40, G: 10, TH: 15 }));
        const bezierPaths = model.allPaths.filter(p => p.type === 'bezier');
        expect(bezierPaths.length).toBeGreaterThan(0);
    });

    it('bounding box scales with dimensions', () => {
        const small = generateMatchboxTray(make({ boxType: 'tray', L: 100, W: 80, D: 20, G: 10, TH: 15 }));
        const large = generateMatchboxTray(make({ boxType: 'tray', L: 300, W: 200, D: 60, G: 10, TH: 15 }));
        expect(large.boundingBox.width).toBeGreaterThan(small.boundingBox.width);
        expect(large.boundingBox.height).toBeGreaterThan(small.boundingBox.height);
    });

    it('handles L === W edge case (square tray)', () => {
        const model = generateMatchboxTray(make({ boxType: 'tray', L: 100, W: 100, D: 30, G: 10, TH: 15 }));
        assertValidDieline(model);
    });

    it('handles W > L (rectangular tray, wide orientation)', () => {
        const model = generateMatchboxTray(make({ boxType: 'tray', L: 100, W: 200, D: 30, G: 10, TH: 15 }));
        assertValidDieline(model);
    });

    it('handles minimum dimensions', () => {
        const model = generateMatchboxTray(make({
            boxType: 'tray', L: 30, W: 15, D: 10, T: 0.2, G: 5, TH: 5
        }));
        assertValidDieline(model);
    });

    it('has correct 5-layer panel hierarchy per strip', () => {
        const model = generateMatchboxTray(make({ boxType: 'tray', L: 200, W: 150, D: 40, G: 10, TH: 15 }));
        const bottom = model.panels.find(p => p.name === 'bottom');
        expect(bottom).toBeDefined();
        expect(bottom!.parent).toBeNull();

        // Each strip: wall→beam→sec→tab chain
        for (const prefix of ['front', 'back', 'left', 'right']) {
            expect(model.panels.find(p => p.name === `${prefix}_wall`)!.parent).toBe('bottom');
            expect(model.panels.find(p => p.name === `${prefix}_beam`)!.parent).toBe(`${prefix}_wall`);
            expect(model.panels.find(p => p.name === `${prefix}_sec`)!.parent).toBe(`${prefix}_beam`);
            expect(model.panels.find(p => p.name === `${prefix}_tab`)!.parent).toBe(`${prefix}_sec`);
        }
    });

    it('stores params in output model', () => {
        const params = make({ boxType: 'tray', L: 250, W: 180, D: 50, G: 12, TH: 18 });
        const model = generateMatchboxTray(params);
        expect(model.params.L).toBe(250);
        expect(model.params.W).toBe(180);
        expect(model.params.D).toBe(50);
        expect(model.params.G).toBe(12);
        expect(model.params.TH).toBe(18);
    });
});

// ─── Auto-Bottom Box (Hộp đáy dán tự động) ──────────────────
// [AUTO-BOTTOM FIX 2026-07-26] Bổ sung lưới test cấu trúc cho generator
// đáy dán (trước đây generator này KHÔNG có describe nào ở file này).

import { generateAutoBottomBox } from './AutoBottomBox';

describe('generateAutoBottomBox', () => {
    it('generates valid dieline with default params', () => {
        const model = generateAutoBottomBox(make({ boxType: 'auto_bottom', L: 120, W: 80, D: 180 }));
        assertValidDieline(model);
        expect(model.standardCode).toContain('AUTO-BOTTOM');
    });

    it('generates 16 panels (thân + nắp + 4 flap đáy + 2 tam giác dán)', () => {
        // glue_flap + 4 thân + 2 tai bụi + closure_top + tuck_top + lock_tab
        // + 2 tai đáy hông + 2 mảnh đáy chính + 2 tam giác dán = 16
        const model = generateAutoBottomBox(make({ boxType: 'auto_bottom', L: 120, W: 80, D: 180 }));
        expect(model.panels.length).toBe(16);
        // Không bật lockTab → 15
        const noLock = generateAutoBottomBox(make({ boxType: 'auto_bottom', L: 120, W: 80, D: 180, lockTab: false }));
        expect(noLock.panels.length).toBe(15);
    });

    it('có đủ 6 panel đáy với parent/pivot đúng cấu trúc dán chéo', () => {
        for (const panelOrder of ['WLWL', 'LWLW'] as const) {
            const model = generateAutoBottomBox(make({ boxType: 'auto_bottom', L: 120, W: 80, D: 180, panelOrder }));
            const names = model.panels.map(p => p.name);
            for (const expected of [
                'bottom_wing_left', 'bottom_wing_right',
                'bottom_main_front', 'bottom_main_back',
                'bottom_tab_front', 'bottom_tab_back',
            ]) {
                expect(names, `${panelOrder} thiếu ${expected}`).toContain(expected);
            }
            const by = (n: string) => model.panels.find(p => p.name === n)!;
            expect(by('bottom_main_front').parent).toBe('front');
            expect(by('bottom_main_back').parent).toBe('back');
            expect(by('bottom_wing_left').parent).toBe('left');
            expect(by('bottom_wing_right').parent).toBe('right');
            expect(by('bottom_tab_front').parent).toBe('bottom_main_front');
            expect(by('bottom_tab_back').parent).toBe('bottom_main_back');

            // Tam giác dán: gập 180° quanh nếp chéo 45°, renderZShift âm.
            for (const side of ['front', 'back'] as const) {
                const tab = by(`bottom_tab_${side}`);
                expect(tab.foldAngle).toBe(180);
                expect(tab.renderZShift ?? 0).toBeLessThan(0);
                const [b, e] = tab.pivotEdge!;
                expect(Math.abs(Math.abs(b.x - e.x) - Math.abs(b.y - e.y))).toBeLessThan(0.01);
                // 2 đầu pivot nằm trên đường CREASE 45° của panel thân (biên chung).
                const crease = by(`bottom_main_${side}`).paths.find(s => s.tag === 'CREASE')!;
                expect(Math.hypot(crease.points[0].x - b.x, crease.points[0].y - b.y)).toBeLessThan(0.001);
                expect(Math.hypot(crease.points[1].x - e.x, crease.points[1].y - e.y)).toBeLessThan(0.001);
            }
        }
    });

    it('đuôi CREASE 45° chạm đúng đỉnh kệ E của free-edge (kể cả góc qua đường may WLWL)', () => {
        for (const panelOrder of ['WLWL', 'LWLW'] as const) {
            const model = generateAutoBottomBox(make({ boxType: 'auto_bottom', L: 120, W: 80, D: 180, panelOrder }));
            for (const side of ['front', 'back'] as const) {
                const main = model.panels.find(p => p.name === `bottom_main_${side}`)!;
                const crease = main.paths.find(s => s.tag === 'CREASE')!;
                const E = crease.points[1];
                // E phải trùng một đỉnh CUT của free-edge thân (không còn lơ lửng).
                let best = Infinity;
                for (const seg of main.paths.filter(s => s.tag === 'CUT')) {
                    for (const p of seg.points) {
                        best = Math.min(best, Math.hypot(p.x - E.x, p.y - E.y));
                    }
                }
                expect(best, `${panelOrder}/${side}: đuôi CREASE lơ lửng ${best.toFixed(3)}mm`).toBeLessThan(0.01);
            }
        }
    });

    it('khe foldGap tại góc dán trong được đóng bằng nét CUT trên đường gấp', () => {
        // WLWL: 1 khe trong (góc dán front↔right); LWLW: 2 khe trong.
        const cases: Array<['WLWL' | 'LWLW', number]> = [['WLWL', 1], ['LWLW', 2]];
        for (const [panelOrder, expectedNicks] of cases) {
            const model = generateAutoBottomBox(make({ boxType: 'auto_bottom', L: 120, W: 80, D: 180, panelOrder }));
            const nicks = model.allPaths.filter(s =>
                s.tag === 'CUT' && s.type === 'line' && s.points.length === 2
                && Math.abs(s.points[0].y) < 0.001 && Math.abs(s.points[1].y) < 0.001
                && Math.abs(s.points[1].x - s.points[0].x) < 5);
            expect(nicks.length, panelOrder).toBe(expectedNicks);
        }
    });

    it('bounding box scales with dimensions', () => {
        const small = generateAutoBottomBox(make({ boxType: 'auto_bottom', L: 60, W: 40, D: 100 }));
        const large = generateAutoBottomBox(make({ boxType: 'auto_bottom', L: 200, W: 100, D: 300 }));
        expect(large.boundingBox.width).toBeGreaterThan(small.boundingBox.width);
        expect(large.boundingBox.height).toBeGreaterThan(small.boundingBox.height);
    });

    it('handles glue side right + ABD tùy chỉnh + kích thước nhỏ', () => {
        assertValidDieline(generateAutoBottomBox(make({ boxType: 'auto_bottom', glueSide: 'right', L: 120, W: 80, D: 180 })));
        const abd = generateAutoBottomBox(make({ boxType: 'auto_bottom', L: 120, W: 80, D: 180, ABD: 55 }));
        assertValidDieline(abd);
        const smallBox = generateAutoBottomBox(make({ boxType: 'auto_bottom', L: 40, W: 20, D: 60 }));
        assertValidDieline(smallBox);
    });

    it('cảnh báo sản xuất khi ABD = W/2 (hai mảnh đáy không chồng mí)', () => {
        const model = generateAutoBottomBox(make({ boxType: 'auto_bottom', L: 120, W: 80, D: 180, ABD: 40 }));
        expect(model.warnings?.some(w => w.includes('không chồng mí'))).toBe(true);
        // hDeep = hWing → tam giác dán suy biến: KHÔNG tách panel (14 thay vì 16)
        expect(model.panels.length).toBe(14);
        expect(model.panels.some(p => p.name.startsWith('bottom_tab_'))).toBe(false);
        const ok = generateAutoBottomBox(make({ boxType: 'auto_bottom', L: 120, W: 80, D: 180 }));
        expect(ok.warnings?.some(w => w.includes('không chồng mí')) ?? false).toBe(false);
    });

    it('stores params in output model', () => {
        const params = make({ boxType: 'auto_bottom', L: 130, W: 70, D: 190 });
        const model = generateAutoBottomBox(params);
        expect(model.params.L).toBe(130);
        expect(model.params.W).toBe(70);
        expect(model.params.D).toBe(190);
    });
});

