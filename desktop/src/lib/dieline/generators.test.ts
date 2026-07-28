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

// ─── Double Tray (Hộp âm dương — khay đáy + nắp chụp) ───────
// [DOUBLE-TRAY 2026-07-26] Theo pattern describe của AutoBottom.
import { generateDoubleTray } from './DoubleTray';

describe('generateDoubleTray', () => {
    // Params = mẫu chuẩn 100010-01: thân đáy 361×261, thành 52, T=1.5, C=1.
    const P = {
        boxType: 'double_tray' as const,
        L: 361, W: 261, D: 52, T: 1.5, C: 1, G: 5, TH: 15, lidD: 0, lidGap: 1,
    };

    it('generates valid dieline with default params', () => {
        const model = generateDoubleTray(make(P));
        assertValidDieline(model);
        expect(model.standardCode).toBe('FEFCO-0330');
        expect(model.nesting).toBeDefined();
    });

    it('đủ 50 panel: 2 mảnh × (thân + 4 phía × 4 dải + 4 vạt góc + 4 tai khóa)', () => {
        const model = generateDoubleTray(make(P));
        expect(model.panels.length).toBe(50);
        const names = model.panels.map(p => p.name);
        for (const prefix of ['base', 'lid'] as const) {
            for (const expected of [
                `${prefix}_bottom`,
                `${prefix}_front_wall`, `${prefix}_front_beam`, `${prefix}_front_inner`, `${prefix}_front_hem`,
                `${prefix}_back_wall`, `${prefix}_left_wall`, `${prefix}_right_wall`,
                `${prefix}_corner_fl`, `${prefix}_corner_fr`, `${prefix}_corner_bl`, `${prefix}_corner_br`,
                `${prefix}_dust_fl`, `${prefix}_dust_fr`, `${prefix}_dust_bl`, `${prefix}_dust_br`,
            ]) {
                expect(names, `thiếu ${expected}`).toContain(expected);
            }
        }
    });

    it('hai root rời: base_bottom và lid_bottom (parent null, không pivot)', () => {
        const model = generateDoubleTray(make(P));
        const roots = model.panels.filter(p => p.parent === null);
        expect(roots.map(p => p.name).sort()).toEqual(['base_bottom', 'lid_bottom']);
        for (const r of roots) expect(r.pivotEdge).toBeNull();
    });

    it('cây động học: vạt góc gắn vách bên, tai khóa gắn thành trong trước/sau', () => {
        const model = generateDoubleTray(make(P));
        const by = (n: string) => model.panels.find(p => p.name === n)!;
        expect(by('base_corner_fr').parent).toBe('base_right_wall');
        expect(by('base_corner_bl').parent).toBe('base_left_wall');
        expect(by('base_dust_fl').parent).toBe('base_front_inner');
        expect(by('base_dust_br').parent).toBe('base_back_inner');
        expect(by('lid_front_hem').parent).toBe('lid_front_inner');
        expect(by('lid_front_inner').parent).toBe('lid_front_beam');
        expect(by('lid_front_beam').parent).toBe('lid_front_wall');
        expect(by('lid_front_wall').parent).toBe('lid_bottom');
        // Vạt góc + tai khóa là CUT rời có bản lề CREASE riêng (không gusset)
        expect(by('base_corner_fr').gusset).toBeUndefined();
        expect(by('base_corner_fr').paths.some(s => s.tag === 'CREASE')).toBe(true);
        expect(by('base_dust_fl').paths.some(s => s.tag === 'CREASE')).toBe(true);
    });

    it('thân nắp = thân đáy + 8T + 2·lidGap; thành nắp auto = D + 2T (mẫu đo +14/+3)', () => {
        const model = generateDoubleTray(make(P));
        const span = (n: string, axis: 'x' | 'y') => {
            const o = model.panels.find(p => p.name === n)!.outline!;
            const vals = o.map(q => q[axis]);
            return Math.max(...vals) - Math.min(...vals);
        };
        expect(span('lid_bottom', 'x') - span('base_bottom', 'x')).toBeCloseTo(8 * 1.5 + 2 * 1, 3);
        expect(span('lid_bottom', 'y') - span('base_bottom', 'y')).toBeCloseTo(8 * 1.5 + 2 * 1, 3);
        expect(span('lid_front_wall', 'y')).toBeCloseTo(52 + 2 * 1.5, 3);
        // lidD tùy chỉnh thay thế auto
        const custom = generateDoubleTray(make({ ...P, lidD: 30 }));
        const wall = custom.panels.find(p => p.name === 'lid_front_wall')!.outline!;
        const ys = wall.map(q => q.y);
        expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(30, 3);
    });

    it('mỗi mảnh đủ 24 nét cấn (kể cả 2 nét mẫu SVG gốc vẽ sót)', () => {
        const model = generateDoubleTray(make(P));
        for (const prefix of ['base_', 'lid_'] as const) {
            const creases = model.panels
                .filter(p => p.name.startsWith(prefix))
                .flatMap(p => p.paths)
                .filter(s => s.tag === 'CREASE');
            expect(creases.length, prefix).toBe(24);
        }
    });

    it('notch U chống rách: 16 bezier (2 × 4 góc × 2 mảnh), points ↔ controlPoints nhất quán', () => {
        const model = generateDoubleTray(make(P));
        const bez = model.allPaths.filter(s => s.type === 'bezier');
        expect(bez.length).toBe(16);
        for (const s of bez) {
            expect(s.controlPoints).toBeDefined();
            const first = s.points[0];
            const last = s.points[s.points.length - 1];
            expect(Math.hypot(first.x - s.controlPoints![0].x, first.y - s.controlPoints![0].y)).toBeLessThan(1e-6);
            expect(Math.hypot(last.x - s.controlPoints![3].x, last.y - s.controlPoints![3].y)).toBeLessThan(1e-6);
        }
    });

    it('bounding box scales with dimensions', () => {
        const small = generateDoubleTray(make({ ...P, L: 100, W: 80, D: 20 }));
        const large = generateDoubleTray(make({ ...P, L: 400, W: 300, D: 60 }));
        expect(large.boundingBox.width).toBeGreaterThan(small.boundingBox.width);
        expect(large.boundingBox.height).toBeGreaterThan(small.boundingBox.height);
    });

    it('handles L === W và W > L (khay ngang)', () => {
        assertValidDieline(generateDoubleTray(make({ ...P, L: 150, W: 150, D: 30 })));
        assertValidDieline(generateDoubleTray(make({ ...P, L: 100, W: 380, D: 40 })));
    });

    it('stores params in output model', () => {
        const params = make({ ...P, L: 130, W: 70, D: 30 });
        const model = generateDoubleTray(params);
        expect(model.params.L).toBe(130);
        expect(model.params.lidGap).toBe(1);
    });
});

// ─── Hanging Window Box (Hộp treo có cửa sổ) ────────────────
// [HANGING-WINDOW 2026-07-27] Tầng test CẤU TRÚC của loại hộp mới: đếm panel
// theo từng nhánh công tắc cửa sổ / lỗ euro, chuỗi cha–con của cụm tai treo,
// renderZShift tách lớp giấy và `holes` của mặt trước.
import { generateHangingWindowBox, hangingWindowDims } from './HangingWindowBox';

describe('generateHangingWindowBox', () => {
    // Preset mẫu Dacdora — hộp treo hàng điện tử L80 × W30 × D140.
    const P = {
        boxType: 'hanging_window' as const,
        L: 80, W: 30, D: 140, T: 0.5, C: 0.5, G: 15, TH: 15,
        WNW: 0, WNH: 0, HTH: 0, hgbWindow: true,
    };

    it('generates valid dieline with default params', () => {
        const model = generateHangingWindowBox(make(P));
        assertValidDieline(model);
        expect(model.standardCode).toBe('HANGING-WINDOW');
        expect(model.warnings).toEqual([]);
    });

    it('đủ 16 panel: thân RTE (13) + tai treo 2 lớp + lưỡi khoá', () => {
        const model = generateHangingWindowBox(make(P));
        expect(model.panels.length).toBe(16);
        const names = model.panels.map(p => p.name);
        for (const expected of [
            'glue_flap', 'front', 'back', 'left', 'right',
            'dust_top_left', 'dust_top_right', 'dust_bot_left', 'dust_bot_right',
            'closure_top', 'tuck_top', 'closure_bot', 'tuck_bot',
            'hang_tab_1', 'hang_tab_2', 'hang_tab_lip',
        ]) {
            expect(names, `thiếu ${expected}`).toContain(expected);
        }
        // Đúng một gốc (mặt trước) — phần còn lại treo vào cây gập
        expect(model.panels.filter(p => p.parent === null).map(p => p.name)).toEqual(['front']);
    });

    it('tắt công tắc cửa sổ: vẫn 16 panel, mặt trước không có holes, bớt đúng 8 đoạn CUT', () => {
        const on = generateHangingWindowBox(make(P));
        const off = generateHangingWindowBox(make({ ...P, hgbWindow: false }));

        expect(off.panels.length).toBe(on.panels.length);
        expect(on.panels.find(p => p.name === 'front')!.holes).toHaveLength(1);
        expect(off.panels.find(p => p.name === 'front')!.holes ?? []).toHaveLength(0);

        // Cửa sổ bo góc = 8 đoạn CUT (4 cạnh + 4 bo góc bezier)
        expect(on.allPaths.length - off.allPaths.length).toBe(8);
        expect(off.warnings).toEqual([]);
    });

    it('cửa sổ mặt trước: vòng holes khép kín, căn giữa mặt trước', () => {
        const model = generateHangingWindowBox(make(P));
        const dims = hangingWindowDims(make(P));
        const front = model.panels.find(p => p.name === 'front')!;
        const ring = front.holes![0];

        // 4 cạnh (1 điểm/đoạn) + 4 cung bezier chia 12 đoạn = 52 điểm
        expect(ring.length).toBe(52);
        const xs = ring.map(q => q.x);
        const ys = ring.map(q => q.y);
        expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(dims.winW, 2);
        expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(dims.winH, 2);

        const fxs = front.outline!.map(q => q.x);
        expect((Math.min(...xs) + Math.max(...xs)) / 2)
            .toBeCloseTo((Math.min(...fxs) + Math.max(...fxs)) / 2, 2);
        expect((Math.min(...ys) + Math.max(...ys)) / 2).toBeCloseTo(P.D / 2, 2);
    });

    it('chuỗi tai treo: parent/pivotEdge nối tiếp back → lớp 1 → lớp 2 → lưỡi khoá', () => {
        const model = generateHangingWindowBox(make(P));
        const dims = hangingWindowDims(make(P));
        const by = (n: string) => model.panels.find(p => p.name === n)!;

        const tab1 = by('hang_tab_1');
        const tab2 = by('hang_tab_2');
        const lip = by('hang_tab_lip');

        expect(tab1.parent).toBe('back');
        expect(tab2.parent).toBe('hang_tab_1');
        expect(lip.parent).toBe('hang_tab_2');

        // pivotEdge nằm đúng trên ba nếp gấp ngang: D, D + tabH, D + tabH + tab2H
        const yTabMid = P.D + dims.tabH;
        const yTabTop = yTabMid + dims.tab2H;
        for (const [panel, y] of [[tab1, P.D], [tab2, yTabMid], [lip, yTabTop]] as const) {
            expect(panel.pivotEdge).toHaveLength(2);
            expect(panel.pivotEdge![0].y, panel.name).toBeCloseTo(y, 3);
            expect(panel.pivotEdge![1].y, panel.name).toBeCloseTo(y, 3);
        }
        // pivotEdge lớp 2 chính là mép trên lớp 1 (biên chung THẬT với parent)
        const tab1Top = Math.max(...tab1.outline!.map(q => q.y));
        expect(tab2.pivotEdge![0].y).toBeCloseTo(tab1Top, 3);

        // Lớp 1 đồng phẳng mặt sau, lớp 2 gập úp 180°.
        // [HANGING-WINDOW 2026-07-27] Lưỡi khoá foldAngle = 0: nó KHÔNG gập mà nối
        // thẳng, đồng phẳng lớp 2 ⇒ sau khi lớp 2 úp 180° thì lưỡi đâm thẳng xuống
        // lòng hộp. Bản trước để 90° làm lưỡi bật ngược ra ngoài vỏ hộp trong 3D.
        expect(tab1.foldAngle).toBe(0);
        expect(tab2.foldAngle).toBe(180);
        expect(lip.foldAngle).toBe(0);

        // Gập tai treo TRƯỚC nắp gài (nắp/lưỡi gài lùi về 0,60–0,95)
        expect(tab1.foldPhase![1]).toBeLessThanOrEqual(by('closure_top').foldPhase![0]);
    });

    it('renderZShift âm cho lớp 2 (tách lớp giấy chồng nhau), lưỡi khoá đi theo lớp 2', () => {
        const model = generateHangingWindowBox(make(P));
        const by = (n: string) => model.panels.find(p => p.name === n)!;
        expect(by('hang_tab_2').renderZShift).toBeCloseTo(-(P.T + 0.1), 6);
        expect(by('hang_tab_2').renderZShift!).toBeLessThan(0);
        // [HANGING-WINDOW 2026-07-27] Lưỡi khoá đồng phẳng lớp 2 ⇒ KHÔNG dịch z
        // thêm; nó đã nằm sẵn đúng lớp giấy của lớp 2 (đã dịch −(T+0,1)).
        expect(by('hang_tab_lip').renderZShift).toBeUndefined();
        // Lớp 1 đồng phẳng mặt sau ⇒ không dịch trục z
        expect(by('hang_tab_1').renderZShift).toBeUndefined();
    });

    it('[HANGING-WINDOW 2026-07-27] cổ thu ở nếp gấp: cung lượn R + nút bo 2T', () => {
        const model = generateHangingWindowBox(make(P));
        const dims = hangingWindowDims(make(P));
        const yTabMid = P.D + dims.tabH;
        const h = P.T / 2;
        const back = model.panels.find(p => p.name === 'back')!.outline!;
        const xTabL = Math.min(...back.map(q => q.x)) + h;
        const xTabR = Math.max(...back.map(q => q.x)) - h;

        // Nút bo = 2·T như mẫu (kẹp theo chiều cao tai treo).
        expect(dims.nubR).toBeCloseTo(2 * P.T, 3);
        expect(dims.neckR).toBeGreaterThan(dims.nubR);

        const tab1 = model.panels.find(p => p.name === 'hang_tab_1')!;
        const tab2 = model.panels.find(p => p.name === 'hang_tab_2')!;
        const crease = tab1.paths.filter(s => s.tag === 'CREASE'
            && Math.abs(s.points[0].y - yTabMid) < 0.01);
        expect(crease, 'đúng một nét cấn giữa hai lớp').toHaveLength(1);

        // Nét cấn chạy giữa hai ĐỈNH nút bo: thụt vào (neckR + nubR) mỗi bên.
        expect(crease[0].points[0].x).toBeCloseTo(xTabL + dims.neckR + dims.nubR, 2);
        expect(crease[0].points[1].x).toBeCloseTo(xTabR - dims.neckR - dims.nubR, 2);
        // pivotEdge lớp 2 trùng đúng nét cấn đã thu.
        expect(tab2.pivotEdge![0].x).toBeCloseTo(crease[0].points[0].x, 3);
        expect(tab2.pivotEdge![1].x).toBeCloseTo(crease[0].points[1].x, 3);

        // Mỗi nửa cổ thu: 2 cung lượn R + 2 cung 1/4 nút bo = 4 bezier ngoài lỗ euro.
        const necks = (panel: typeof tab1) => panel.paths.filter(s => s.type === 'bezier'
            && s.points.every(q => Math.abs(q.y - yTabMid) <= dims.neckR + dims.nubR + 0.01));
        expect(necks(tab1).length, 'lớp 1: 2 cung R + 2 nút bo').toBeGreaterThanOrEqual(4);
        expect(necks(tab2).length, 'lớp 2: 2 cung R + 2 nút bo').toBeGreaterThanOrEqual(4);

        // Cạnh bên thẳng chỉ chạy tới điểm tiếp tuyến, KHÔNG chạm nếp gấp nữa.
        const yTan = yTabMid - dims.nubR - dims.neckR;
        const sideCuts = tab1.paths.filter(s => s.tag === 'CUT' && s.type === 'line'
            && Math.abs(s.points[0].x - s.points[1].x) < 0.01);
        expect(sideCuts).toHaveLength(2);
        for (const s of sideCuts) {
            const ys = [s.points[0].y, s.points[1].y];
            expect(Math.max(...ys)).toBeCloseTo(yTan, 2);
        }
    });

    it('mỗi lớp tai treo đúng một lỗ euro: 4 cung bán nguyệt + gờ nửa vòng tròn', () => {
        const model = generateHangingWindowBox(make(P));
        const dims = hangingWindowDims(make(P));
        expect(dims.hasSlot).toBe(true);

        for (const name of ['hang_tab_1', 'hang_tab_2'] as const) {
            const panel = model.panels.find(p => p.name === name)!;
            expect(panel.holes, name).toHaveLength(1);
            // 2 cạnh bên của lớp + các đoạn lỗ euro đều là nét CUT
            const cuts = panel.paths.filter(s => s.tag === 'CUT');
            // [HANGING-WINDOW 2026-07-27] Panel còn chứa các cung của CỔ THU ở nếp
            // gấp — lọc theo dải y của lỗ euro để chỉ đếm cung của chính cái lỗ.
            const yTabMid = P.D + dims.tabH;
            const cySlot = name === 'hang_tab_1'
                ? yTabMid - dims.slotPos : yTabMid + dims.slotPos;
            const reach = dims.slotH / 2 + dims.nibD + 0.5;
            const bez = panel.paths.filter(s => s.type === 'bezier'
                && s.points.every(q => Math.abs(q.y - cySlot) <= reach));
            // [HANGING-WINDOW 2026-07-27] 4 cung bo bán nguyệt hai đầu khe + 4 góc
            // gờ chống trượt là NỬA VÒNG TRÒN = 2 cung 90° ⇒ 6 bezier. Trước đây gờ
            // là chữ nhật góc vuông (4 bezier), rồi chữ nhật bo góc (8 bezier) —
            // mẫu khuôn thật là nửa vòng tròn.
            expect(bez.length, `${name}: 4 cung bán nguyệt + 2 cung gờ`).toBe(6);
            // 2 cạnh bên lớp tai treo + 9 đoạn lỗ euro (1 cạnh phẳng + 4 cung bán
            // nguyệt + 2 đoạn chân gờ + 2 cung nửa vòng tròn của gờ) = 11.
            expect(cuts.length, name).toBeGreaterThanOrEqual(11);
            // Bezier đồng bộ points ↔ controlPoints (bất biến 3)
            for (const s of bez) {
                const first = s.points[0];
                const last = s.points[s.points.length - 1];
                expect(Math.hypot(first.x - s.controlPoints![0].x, first.y - s.controlPoints![0].y)).toBeLessThan(1e-6);
                expect(Math.hypot(last.x - s.controlPoints![3].x, last.y - s.controlPoints![3].y)).toBeLessThan(1e-6);
            }
        }
    });

    it('hộp quá nhỏ: bỏ cửa sổ + bỏ lỗ euro, vẫn 16 panel và có cảnh báo', () => {
        // L = 18mm nằm dưới miền của validateParams — gọi generator trực tiếp để
        // khoá hai guard suy biến (hasWindow = false, hasSlot = false).
        const tiny = make({ ...P, L: 18, W: 20, D: 100 });
        const dims = hangingWindowDims(tiny);
        expect(dims.hasWindow).toBe(false);
        expect(dims.hasSlot).toBe(false);

        const model = generateHangingWindowBox(tiny);
        expect(model.panels.length).toBe(16);
        expect(model.panels.find(p => p.name === 'front')!.holes ?? []).toHaveLength(0);
        for (const name of ['hang_tab_1', 'hang_tab_2'] as const) {
            expect(model.panels.find(p => p.name === name)!.holes, name).toBeUndefined();
        }
        // [HANGING-WINDOW 2026-07-27] `warnings` là trường tuỳ chọn của DielineModel
        // nên phải chốt tồn tại trước khi đọc độ dài (TS strict).
        const warnings = model.warnings ?? [];
        expect(warnings.length).toBe(2);
        expect(warnings.join(' ')).toContain('cửa sổ');
        expect(warnings.join(' ')).toContain('lỗ euro');
    });

    it('bounding box scales with dimensions', () => {
        const small = generateHangingWindowBox(make({ ...P, L: 50, W: 20, D: 80 }));
        const large = generateHangingWindowBox(make({ ...P, L: 160, W: 60, D: 260 }));
        expect(large.boundingBox.width).toBeGreaterThan(small.boundingBox.width);
        expect(large.boundingBox.height).toBeGreaterThan(small.boundingBox.height);
    });

    it('stores params in output model', () => {
        const params = make({ ...P, L: 90, D: 150 });
        const model = generateHangingWindowBox(params);
        expect(model.params.L).toBe(90);
        expect(model.params.D).toBe(150);
        expect(model.params.hgbWindow).toBe(true);
    });
});
