import { describe, it, expect } from 'vitest';
import { sortedClusterOrder, planCoverLayout, buildCoverRecords, resolveCoverPageIndices, type Cluster } from '../coverNumberingPlanner';
import type { NumberingJob } from '../coverNumberingEngine';

// Lưới 2×2 (gốc trên-trái): A trên-trái, B trên-phải, C dưới-trái, D dưới-phải.
const GRID: Cluster[] = [
    { id: 'A', x: 0, y: 0 },
    { id: 'B', x: 100, y: 0 },
    { id: 'C', x: 0, y: 100 },
    { id: 'D', x: 100, y: 100 },
];

function mkJob(p: Partial<NumberingJob> = {}): NumberingJob {
    return {
        startNum: 1, endNum: 800, padding: 4, bookletCount: 8, bookletOffset: 1,
        innerMode: 'continuous', distribution: 'stack', sortMethod: 'rows', ...p,
    };
}

describe('sortedClusterOrder — 4 kiểu quét trên lưới 2×2', () => {
    it('rows (Z): trên L→R rồi dưới L→R', () => {
        expect(sortedClusterOrder(GRID, 'rows')).toEqual(['A', 'B', 'C', 'D']);
    });
    it('cols (N ngược): cột trái trên→dưới rồi cột phải', () => {
        expect(sortedClusterOrder(GRID, 'cols')).toEqual(['A', 'C', 'B', 'D']);
    });
    it('snake (U): xuống trái → ngang đáy → lên phải', () => {
        expect(sortedClusterOrder(GRID, 'snake')).toEqual(['A', 'C', 'D', 'B']);
    });
    it('clockwise (C): trên L→R → dưới R→L (theo chu vi)', () => {
        expect(sortedClusterOrder(GRID, 'clockwise')).toEqual(['A', 'B', 'D', 'C']);
    });
});

describe('planCoverLayout', () => {
    it('phủ đủ cuốn, mỗi cuốn đúng 1 lần (8 cuốn, 4 ô/tờ → 2 tờ)', () => {
        const plan = planCoverLayout(mkJob(), GRID);
        expect(plan.length).toBe(8); // 2 tờ × 4 ô
        const idxs = plan.map(p => p.bookletIndex).filter(i => i >= 0).sort((a, b) => a - b);
        expect(idxs).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    });

    it('stack: chồng 2 tờ + cắt theo từng vị trí cụm → 2 cuốn liên tiếp', () => {
        const plan = planCoverLayout(mkJob({ distribution: 'stack' }), GRID);
        // gom theo clusterId, sắp theo sheet → dải bookletIndex của vị trí đó
        const byCluster: Record<string, number[]> = {};
        for (const p of plan) {
            (byCluster[p.clusterId] ||= []);
        }
        for (const c of Object.keys(byCluster)) {
            byCluster[c] = plan.filter(p => p.clusterId === c)
                .sort((a, b) => a.sheet - b.sheet).map(p => p.bookletIndex);
        }
        // mỗi vị trí (pos 0..3) qua 2 tờ → 2 cuốn liên tiếp: pos*2, pos*2+1
        const order = sortedClusterOrder(GRID, 'rows'); // A,B,C,D
        order.forEach((id, pos) => {
            expect(byCluster[id]).toEqual([pos * 2, pos * 2 + 1]);
        });
    });

    it('cover data khớp bookletIndex (continuous Y/Z)', () => {
        const plan = planCoverLayout(mkJob(), GRID);
        for (const p of plan) {
            if (p.bookletIndex < 0) continue;
            const i = p.bookletIndex;
            expect(p.cover).toMatchObject({
                X: String(1 + i),
                Y: String(1 + i * 100).padStart(4, '0'),    // perBooklet = 800/8 = 100
                Z: String(i * 100 + 100).padStart(4, '0'),
            });
        }
    });

    it('job không hợp lệ / không có cụm → kế hoạch rỗng', () => {
        expect(planCoverLayout(mkJob({ bookletCount: 0 }), GRID)).toEqual([]);
        expect(planCoverLayout(mkJob(), [])).toEqual([]);
    });
});

describe('buildCoverRecords — 1 tờ in = 1 record, token theo clusterId', () => {
    it('8 cuốn, 4 ô/tờ → 2 record, mỗi record đủ token X/Y/Z của 4 cụm', () => {
        const recs = buildCoverRecords(planCoverLayout(mkJob(), GRID));
        expect(recs.length).toBe(2); // 2 tờ in
        for (const r of recs) {
            for (const id of ['A', 'B', 'C', 'D']) {
                expect(r).toHaveProperty(`${id}.X`);
                expect(r).toHaveProperty(`${id}.Y`);
                expect(r).toHaveProperty(`${id}.Z`);
            }
        }
    });
    it('giá trị token khớp cover data (stack, rows): tờ 0 ô A = cuốn 1', () => {
        const plan = planCoverLayout(mkJob({ distribution: 'stack' }), GRID);
        const recs = buildCoverRecords(plan);
        // rows order A,B,C,D → pos A=0; stack: tờ0 posA → booklet 0 → X='1', Y='0001', Z='0100'
        expect(recs[0]['A.X']).toBe('1');
        expect(recs[0]['A.Y']).toBe('0001');
        expect(recs[0]['A.Z']).toBe('0100');
        // tờ1 posA → booklet 1 → X='2', Y='0101'
        expect(recs[1]['A.X']).toBe('2');
        expect(recs[1]['A.Y']).toBe('0101');
    });
    it('ô trống → token rỗng', () => {
        // 7 cuốn, 4 ô/tờ → 2 tờ, tờ 2 thiếu 1 ô (stack: kiểm có token rỗng)
        const plan = planCoverLayout(mkJob({ bookletCount: 7, endNum: 700 }), GRID);
        const recs = buildCoverRecords(plan);
        const allVals = recs.flatMap(r => Object.values(r));
        expect(allVals.some(v => v === '')).toBe(true);
    });
});

describe('resolveCoverPageIndices — PA2 gán trang bìa (1 file)', () => {
    it('trang đơn → 0-based', () => {
        expect(resolveCoverPageIndices('3', 10)).toEqual([2]);
    });
    it('dải + trang lẻ, loại trùng + sắp tăng', () => {
        expect(resolveCoverPageIndices('1-2,5,2', 10)).toEqual([0, 1, 4]);
    });
    it('kẹp trong [1..totalPages]', () => {
        expect(resolveCoverPageIndices('8-20', 10)).toEqual([7, 8, 9]);
    });
    it('rỗng/không hợp lệ → []', () => {
        expect(resolveCoverPageIndices('', 10)).toEqual([]);
        expect(resolveCoverPageIndices('abc', 10)).toEqual([]);
        expect(resolveCoverPageIndices('5', 0)).toEqual([]);
    });
});
