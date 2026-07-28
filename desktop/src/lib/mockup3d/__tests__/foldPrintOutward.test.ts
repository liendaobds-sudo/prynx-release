// ============================================================
// foldPrintOutward.test.ts — Print-side outward after full fold
//
// Invariant mockup 3D: ảnh in gán local +Z. Sau foldProgress=1, pháp
// tuyến +Z phải hướng RA NGOÀI hộp (dot với vector từ tâm → panel > 0.2)
// trên các mặt cấu trúc. Bắt regression «áp ngược mặt» (pizza/tray).
// ============================================================

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { generateReverseTuckEnd } from '../../dieline/ReverseTuckEnd';
import { generateSnapLockBottom } from '../../dieline/SnapLockBottom';
import { generateAutoBottomBox } from '../../dieline/AutoBottomBox';
import { generateGableBox } from '../../dieline/GableBox';
import { generatePaperBag } from '../../dieline/PaperBag';
import { generatePizzaBox } from '../../dieline/PizzaBox';
import { generateMatchboxTray } from '../../dieline/MatchboxTray';
import { generateDoubleTray } from '../../dieline/DoubleTray';
import { DEFAULT_PARAMS, type BoxParams, type DielineModel, type Panel } from '../../dieline/types';
import { applyFoldCompensation } from '../foldCompensation';

const OUTWARD_DOT_MIN = 0.2;

function buildDepthMap(panels: Panel[]): { depthMap: Map<string, number>; maxD: number } {
    const depthMap = new Map<string, number>();
    const nameMap = new Map(panels.map((p) => [p.name, p]));
    function getDepth(name: string): number {
        if (depthMap.has(name)) return depthMap.get(name)!;
        const panel = nameMap.get(name);
        if (!panel || !panel.parent) {
            depthMap.set(name, 0);
            return 0;
        }
        const d = getDepth(panel.parent) + 1;
        depthMap.set(name, d);
        return d;
    }
    panels.forEach((p) => getDepth(p.name));
    let maxD = 0;
    depthMap.forEach((d) => {
        if (d > maxD) maxD = d;
    });
    return { depthMap, maxD };
}

/** Các panel cấu trúc phải in ra ngoài (bỏ flap gập-vào cố ý / gusset / lock). */
function structuralPanels(model: DielineModel): Panel[] {
    const exclude = /^(dust_|tuck_|glue|lock_|thumb|lip_|secondary_|front_lock|sec_tab|corner|gusset)/i;
    return model.panels.filter((p) => {
        if (p.gusset) return false;
        if (exclude.test(p.name)) return false;
        // Pizza rolls/rims: mép mỏng — heuristic tâm dễ SIDEWAYS; kiểm wall chính.
        if (p.name.endsWith('_roll') || p.name.endsWith('_rim')) return false;
        // Tray: chỉ wall + bottom + sleeve faces chính (không beam/sec/tab)
        if (model.params.boxType === 'tray') {
            if (/_(beam|sec|tab)$/.test(p.name)) return false;
        }
        // [AUTO-BOTTOM FIX 2026-07-27] Tam giác dán gập 180° vào trong để
        // áp lên tai hông; đây không phải mặt cấu trúc phải hướng ảnh in ra ngoài.
        if (model.params.boxType === 'auto_bottom' && p.name.startsWith('bottom_tab_')) return false;
        return true;
    });
}

function evaluateOutward(model: DielineModel): { inverted: string[]; sideways: string[]; ok: string[] } {
    const { depthMap, maxD } = buildDepthMap(model.panels);
    const T = model.params.T || 0.5;
    const panels = structuralPanels(model);
    const placed: { name: string; pos: THREE.Vector3; n: THREE.Vector3 }[] = [];

    for (const panel of panels) {
        const fold = applyFoldCompensation(panel, model.panels, 1, depthMap, maxD, T);
        const ring = panel.outline && panel.outline.length >= 3 ? panel.outline : null;
        let cx = 0;
        let cy = 0;
        let n = 0;
        if (ring) {
            for (const q of ring) {
                cx += q.x;
                cy += q.y;
                n++;
            }
            cx /= n;
            cy /= n;
        }
        const localC = new THREE.Vector3(cx, cy, 0).applyMatrix4(fold.matrix);
        // Pizza gấp thể tích về +Z: mặt vật lý bên ngoài là cap local −Z.
        // Renderer đổi material/UV sang cap này, không được đảo cơ cấu foldDirection.
        const printNormalZ = model.params.boxType === 'pizza' || model.params.boxType === 'tray' ? -1 : 1;
        const worldN = new THREE.Vector3(0, 0, printNormalZ).transformDirection(fold.matrix);
        placed.push({ name: panel.name, pos: localC, n: worldN });
    }

    const center = new THREE.Vector3();
    for (const p of placed) center.add(p.pos);
    if (placed.length > 0) center.multiplyScalar(1 / placed.length);

    const inverted: string[] = [];
    const sideways: string[] = [];
    const ok: string[] = [];

    for (const p of placed) {
        const away = new THREE.Vector3().subVectors(p.pos, center);
        if (away.length() < 1e-3) {
            sideways.push(p.name);
            continue;
        }
        away.normalize();
        const dot = p.n.dot(away);
        if (dot > OUTWARD_DOT_MIN) ok.push(p.name);
        else if (dot < -OUTWARD_DOT_MIN) inverted.push(`${p.name}(dot=${dot.toFixed(2)})`);
        else sideways.push(`${p.name}(dot=${dot.toFixed(2)})`);
    }

    return { inverted, sideways, ok };
}

function makeParams(partial: Partial<BoxParams> & { boxType: BoxParams['boxType'] }): BoxParams {
    return { ...DEFAULT_PARAMS, ...partial } as BoxParams;
}

describe('foldPrintOutward — physical print face points outside after full fold', () => {
    it('RTE structural panels: print outward', () => {
        const model = generateReverseTuckEnd(makeParams({ boxType: 'rte' }));
        const r = evaluateOutward(model);
        expect(r.inverted, `inverted: ${r.inverted.join(', ')}`).toEqual([]);
        expect(r.ok.length).toBeGreaterThan(0);
    });

    it('Auto-bottom structural panels: print outward', () => {
        const model = generateAutoBottomBox(makeParams({ boxType: 'auto_bottom' }));
        const r = evaluateOutward(model);
        expect(r.inverted, `inverted: ${r.inverted.join(', ')}`).toEqual([]);
    });

    it('Auto-bottom glue tabs intentionally turn inward 180° against their parent panel', () => {
        const model = generateAutoBottomBox(makeParams({ boxType: 'auto_bottom' }));
        const { depthMap, maxD } = buildDepthMap(model.panels);

        for (const side of ['front', 'back'] as const) {
            const main = model.panels.find((panel) => panel.name === `bottom_main_${side}`)!;
            const tab = model.panels.find((panel) => panel.name === `bottom_tab_${side}`)!;
            const mainFold = applyFoldCompensation(
                main,
                model.panels,
                1,
                depthMap,
                maxD,
                model.params.T,
            );
            const tabFold = applyFoldCompensation(
                tab,
                model.panels,
                1,
                depthMap,
                maxD,
                model.params.T,
            );
            const mainNormal = new THREE.Vector3(0, 0, 1).transformDirection(mainFold.matrix);
            const tabNormal = new THREE.Vector3(0, 0, 1).transformDirection(tabFold.matrix);

            expect(
                tabNormal.dot(mainNormal),
                `${tab.name} phải úp mặt in vào panel cha để tạo vùng dán`,
            ).toBeLessThan(-0.999);
        }
    });

    it('SLB structural panels: print outward', () => {
        const model = generateSnapLockBottom(makeParams({ boxType: 'slb' }));
        const r = evaluateOutward(model);
        expect(r.inverted, `inverted: ${r.inverted.join(', ')}`).toEqual([]);
        expect(r.ok.length).toBeGreaterThan(0);
    });

    it('Gable structural panels: print outward', () => {
        const model = generateGableBox(makeParams({ boxType: 'gable' }));
        const r = evaluateOutward(model);
        expect(r.inverted, `inverted: ${r.inverted.join(', ')}`).toEqual([]);
        expect(r.ok.length).toBeGreaterThan(0);
    });

    it('Paper bag body panels: print outward', () => {
        const model = generatePaperBag(makeParams({ boxType: 'paper_bag', TH: 30 }));
        // Chỉ thân (front/back/side*) — lip gập 180° vào trong là intentional
        const body = {
            ...model,
            panels: model.panels.filter((p) => !p.name.startsWith('lip_') && !p.name.startsWith('bottom_')),
        };
        const r = evaluateOutward(body);
        expect(r.inverted, `inverted: ${r.inverted.join(', ')}`).toEqual([]);
        expect(r.ok.length).toBeGreaterThan(0);
    });

    it('Pizza box keeps original fold kinematics and reaches its final pose', () => {
        const model = generatePizzaBox(
            makeParams({ boxType: 'pizza', L: 300, W: 300, D: 40, T: 1.5, C: 1, TH: 15 }),
        );
        const byName = new Map(model.panels.map((panel) => [panel.name, panel]));

        expect(byName.get('front')).toMatchObject({ foldAngle: -90, foldDirection: 1 });
        expect(byName.get('back')).toMatchObject({ foldAngle: 90, foldDirection: 1 });
        expect(byName.get('side_left')).toMatchObject({ foldAngle: 90, foldDirection: 1 });
        expect(byName.get('side_right')).toMatchObject({ foldAngle: -90, foldDirection: 1 });
        expect(byName.get('side_left_rim')).toMatchObject({ foldAngle: 90, foldDirection: 1 });
        expect(byName.get('side_left_roll')).toMatchObject({ foldAngle: 90, foldDirection: 1 });
        expect(byName.get('side_right_rim')).toMatchObject({ foldAngle: 90, foldDirection: -1 });
        expect(byName.get('side_right_roll')).toMatchObject({ foldAngle: 90, foldDirection: -1 });

        const { depthMap, maxD } = buildDepthMap(model.panels);
        for (const panel of model.panels) {
            const atFinalPhase = applyFoldCompensation(panel, model.panels, 0.96, depthMap, maxD, model.params.T);
            const atOne = applyFoldCompensation(panel, model.panels, 1, depthMap, maxD, model.params.T);
            expect(atFinalPhase.matrix.elements, panel.name).toEqual(atOne.matrix.elements);
        }
    });

    it('Pizza box structural panels: print outward (regression áp ngược mặt)', () => {
        const model = generatePizzaBox(
            makeParams({ boxType: 'pizza', L: 300, W: 300, D: 40, T: 1.5, C: 1, TH: 15 }),
        );
        const r = evaluateOutward(model);
        expect(r.inverted, `inverted: ${r.inverted.join(', ')}`).toEqual([]);
        // bottom + 4 walls + lid at minimum
        expect(r.ok.length).toBeGreaterThanOrEqual(5);
    });

    it('Matchbox tray and sleeve keep original fold kinematics', () => {
        const model = generateMatchboxTray(
            makeParams({ boxType: 'tray', L: 200, W: 150, D: 40, T: 1, G: 10, TH: 15, sleeveGlue: 15 }),
        );
        const byName = new Map(model.panels.map((panel) => [panel.name, panel]));

        expect(byName.get('front_wall')).toMatchObject({ foldAngle: 90, foldDirection: 1 });
        expect(byName.get('back_wall')).toMatchObject({ foldAngle: 90, foldDirection: -1 });
        expect(byName.get('right_wall')).toMatchObject({ foldAngle: 90, foldDirection: -1 });
        expect(byName.get('left_wall')).toMatchObject({ foldAngle: 90, foldDirection: 1 });
        expect(byName.get('sleeve_front')).toMatchObject({ foldAngle: 90, foldDirection: 1 });
        expect(byName.get('sleeve_side1')).toMatchObject({ foldAngle: 90, foldDirection: 1 });
        expect(byName.get('sleeve_glue')).toMatchObject({ foldAngle: 90, foldDirection: -1 });
    });
    it('Matchbox tray body structural panels: print outward', () => {
        const model = generateMatchboxTray(
            makeParams({
                boxType: 'tray',
                L: 200,
                W: 150,
                D: 40,
                T: 1,
                G: 10,
                TH: 15,
                sleeveGlue: 15,
            }),
        );
        // Khay + vỏ hiển thị cạnh nhau (không phải 1 khối) → đánh giá riêng.
        const trayOnly = {
            ...model,
            panels: model.panels.filter((p) => !p.name.startsWith('sleeve_')),
        };
        const r = evaluateOutward(trayOnly);
        expect(r.inverted, `inverted: ${r.inverted.join(', ')}`).toEqual([]);
        expect(r.ok.length).toBeGreaterThan(0);
    });

    it('Matchbox sleeve structural panels: print outward', () => {
        const model = generateMatchboxTray(
            makeParams({
                boxType: 'tray',
                L: 200,
                W: 150,
                D: 40,
                T: 1,
                G: 10,
                TH: 15,
                sleeveGlue: 15,
            }),
        );
        const sleeveOnly = {
            ...model,
            panels: model.panels.filter((p) => p.name.startsWith('sleeve_')),
        };
        const r = evaluateOutward(sleeveOnly);
        expect(r.inverted, `inverted: ${r.inverted.join(', ')}`).toEqual([]);
        expect(r.ok.length).toBeGreaterThan(0);
    });

    it('Double Tray lid flips 180 degrees around its root center and closes over the base', () => {
        const model = generateDoubleTray(
            makeParams({
                boxType: 'double_tray',
                L: 361,
                W: 261,
                D: 52,
                T: 1.5,
                C: 1,
                G: 5,
                TH: 15,
                lidD: 0,
                lidGap: 1,
            }),
        );
        const nesting = model.nesting!;
        const base = model.panels.find((panel) => panel.name === 'base_bottom')!;
        const lid = model.panels.find((panel) => panel.name === 'lid_bottom')!;
        const centerOf = (panel: Panel) => {
            const outline = panel.outline!;
            return new THREE.Vector3(
                outline.reduce((sum, point) => sum + point.x, 0) / outline.length,
                outline.reduce((sum, point) => sum + point.y, 0) / outline.length,
                0,
            );
        };
        const baseCenter = centerOf(base);
        const lidCenter = centerOf(lid);
        const pivot = nesting.pivot!;
        const rotationDeg = nesting.rotationDeg!;
        const choreography = nesting.choreography!;
        // Nắp lật một lần quanh trục ngang tại tâm; không xoay phẳng như cái đĩa.
        expect(rotationDeg.y).toBe(0);
        expect(choreography.preRotationDeg.y).toBe(-180);
        expect(choreography.preRotationDeg.z).toBe(0);
        expect(choreography.liftZ).toBeGreaterThan(nesting.z);
        expect(choreography.preRotateEnd).toBeLessThan(choreography.liftEnd);
        expect(choreography.liftEnd).toBeLessThan(choreography.translateEnd);
        const flipQuaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(
            THREE.MathUtils.degToRad(rotationDeg.x),
            THREE.MathUtils.degToRad(rotationDeg.y),
            THREE.MathUtils.degToRad(rotationDeg.z),
        ));
        const preQuaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(
            THREE.MathUtils.degToRad(choreography.preRotationDeg.x),
            THREE.MathUtils.degToRad(choreography.preRotationDeg.y),
            THREE.MathUtils.degToRad(choreography.preRotationDeg.z),
        ));
        const pose = new THREE.Matrix4()
            .makeTranslation(
                pivot.x + nesting.x,
                pivot.y + nesting.y,
                pivot.z + nesting.z,
            )
            .multiply(new THREE.Matrix4().makeRotationFromQuaternion(preQuaternion.multiply(flipQuaternion)))
            .multiply(new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z));

        const closedLidCenter = lidCenter.clone().applyMatrix4(pose);
        expect(closedLidCenter.x).toBeCloseTo(baseCenter.x, 6);
        expect(closedLidCenter.y).toBeCloseTo(baseCenter.y, 6);
        expect(closedLidCenter.z).toBeCloseTo(nesting.z, 6);

        const lidRootNormal = new THREE.Vector3(0, 0, 1).transformDirection(pose);
        expect(lidRootNormal.z).toBeLessThan(-0.999);
    });

    it('Double Tray base and lid walls both fold outward before the lid pose is applied', () => {
        const model = generateDoubleTray(
            makeParams({
                boxType: 'double_tray',
                L: 361,
                W: 261,
                D: 52,
                T: 1.5,
                C: 1,
                G: 5,
                TH: 15,
                lidD: 0,
                lidGap: 1,
            }),
        );
        const { depthMap, maxD } = buildDepthMap(model.panels);

        for (const prefix of ['base', 'lid'] as const) {
            const root = model.panels.find((panel) => panel.name === `${prefix}_bottom`)!;
            const rootOutline = root.outline!;
            const rootCenter = new THREE.Vector3(
                rootOutline.reduce((sum, point) => sum + point.x, 0) / rootOutline.length,
                rootOutline.reduce((sum, point) => sum + point.y, 0) / rootOutline.length,
                0,
            );

            for (const side of ['front', 'back', 'left', 'right'] as const) {
                const panel = model.panels.find(
                    (candidate) => candidate.name === `${prefix}_${side}_wall`,
                )!;
                const outline = panel.outline!;
                const localCenter = new THREE.Vector3(
                    outline.reduce((sum, point) => sum + point.x, 0) / outline.length,
                    outline.reduce((sum, point) => sum + point.y, 0) / outline.length,
                    0,
                );
                const fold = applyFoldCompensation(
                    panel,
                    model.panels,
                    1,
                    depthMap,
                    maxD,
                    model.params.T,
                );
                const wallCenter = localCenter.applyMatrix4(fold.matrix);
                const radial = wallCenter.clone().sub(rootCenter).setZ(0).normalize();
                const outerNormal = new THREE.Vector3(0, 0, -1).transformDirection(fold.matrix);
                expect(
                    outerNormal.dot(radial),
                    `${panel.name} phải hướng mặt ngoài ra khỏi lòng khay`,
                ).toBeGreaterThan(0.99);
            }
        }
    });
});
