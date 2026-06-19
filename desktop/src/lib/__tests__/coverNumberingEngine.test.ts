import { describe, it, expect } from 'vitest';
import {
    deriveJob, innerRange, generateCoverData, distributionIndex, assignBooklets,
    MAX_NUMBERS, type NumberingJob, type Distribution, type InnerMode, type SortMethod,
} from '../coverNumberingEngine';

function mkJob(p: Partial<NumberingJob> = {}): NumberingJob {
    return {
        startNum: 1, endNum: 1000, padding: 4, bookletCount: 20, bookletOffset: 1,
        innerMode: 'continuous', distribution: 'stack', sortMethod: 'rows', ...p,
    };
}

// ───────────────── deriveJob / validation ─────────────────
describe('deriveJob', () => {
    it('hợp lệ → perBooklet đúng', () => {
        const d = deriveJob(mkJob());
        expect(d.valid).toBe(true);
        expect(d.totalNumbers).toBe(1000);
        expect(d.perBooklet).toBe(50);
    });
    it('start>end → bad_range', () => {
        expect(deriveJob(mkJob({ startNum: 100, endNum: 1 })).error).toBe('bad_range');
    });
    it('bookletCount<=0 → bad_range', () => {
        expect(deriveJob(mkJob({ bookletCount: 0 })).error).toBe('bad_range');
        expect(deriveJob(mkJob({ bookletCount: -5 })).error).toBe('bad_range');
    });
    it('không chia hết → not_divisible + gợi ý là ƯỚC SỐ gần nhất', () => {
        const d = deriveJob(mkJob({ endNum: 1000, bookletCount: 30 })); // 1000 % 30 != 0
        expect(d.error).toBe('not_divisible');
        expect(d.suggestion).toBeDefined();
        expect(1000 % (d.suggestion as number)).toBe(0);          // gợi ý phải chia hết
        // gần 30 nhất trong các ước của 1000: 25 (|25-30|=5) vs 40 (|40-30|=10) → 25
        expect(d.suggestion).toBe(25);
    });
    it('quá lớn → too_large (không treo)', () => {
        expect(deriveJob(mkJob({ startNum: 1, endNum: MAX_NUMBERS + 10, bookletCount: 1 })).error)
            .toBe('too_large');
    });
});

// ───────────────── innerRange / cover data ─────────────────
describe('generateCoverData + innerRange', () => {
    it('continuous: dải nối tiếp, Z(i)+1 = Y(i+1) [Property 2]', () => {
        const job = mkJob({ innerMode: 'continuous' });
        const rows = generateCoverData(job);
        expect(rows.length).toBe(20);
        expect(rows[0]).toMatchObject({ X: '1', Y: '0001', Z: '0050' });
        expect(rows[1]).toMatchObject({ X: '2', Y: '0051', Z: '0100' });
        expect(rows[19]).toMatchObject({ X: '20', Y: '0951', Z: '1000' });
        for (let i = 0; i < rows.length - 1; i++) {
            expect(Number(rows[i].Z) + 1).toBe(Number(rows[i + 1].Y));
        }
    });
    it('reset: Y/Z hằng mọi cuốn, chỉ X đổi [Property 2]', () => {
        const rows = generateCoverData(mkJob({ innerMode: 'reset' }));
        for (const r of rows) { expect(r.Y).toBe('0001'); expect(r.Z).toBe('0050'); }
        expect(rows.map(r => r.X)).toEqual(Array.from({ length: 20 }, (_, i) => String(i + 1)));
    });
    it('bookletOffset dịch X', () => {
        const rows = generateCoverData(mkJob({ bookletOffset: 101 }));
        expect(rows[0].X).toBe('101');
        expect(rows[19].X).toBe('120');
    });
    it('padding=0 → không đệm; prefix/suffix áp dụng', () => {
        const rows = generateCoverData(mkJob({ padding: 0, prefix: 'No.', suffix: 'A' }));
        expect(rows[0].Y).toBe('No.1A');
        expect(rows[0].Z).toBe('No.50A');
    });
    it('innerRange khớp dữ liệu cover (Property 1 — đồng bộ)', () => {
        const job = mkJob();
        const rows = generateCoverData(job);
        rows.forEach((r, i) => {
            const ir = innerRange(job, i);
            expect(ir.start).toBe(Number(r.Y));
            expect(ir.end).toBe(Number(r.Z));
        });
    });
    it('job không hợp lệ → cover rỗng', () => {
        expect(generateCoverData(mkJob({ bookletCount: 0 }))).toEqual([]);
    });
});

// ───────────────── distributionIndex ─────────────────
describe('distributionIndex', () => {
    // 6 cuốn, 2 ô/tờ, 3 tờ
    const sheets = 3, slots = 2;
    it('stack = pos*sheets + sheet', () => {
        expect(distributionIndex(0, 0, sheets, slots, 'stack')).toBe(0);
        expect(distributionIndex(0, 1, sheets, slots, 'stack')).toBe(1);
        expect(distributionIndex(0, 2, sheets, slots, 'stack')).toBe(2);
        expect(distributionIndex(1, 0, sheets, slots, 'stack')).toBe(3);
        expect(distributionIndex(1, 2, sheets, slots, 'stack')).toBe(5);
    });
    it('sequential = sheet*slots + pos', () => {
        expect(distributionIndex(0, 0, sheets, slots, 'sequential')).toBe(0);
        expect(distributionIndex(1, 0, sheets, slots, 'sequential')).toBe(1);
        expect(distributionIndex(0, 1, sheets, slots, 'sequential')).toBe(2);
        expect(distributionIndex(1, 2, sheets, slots, 'sequential')).toBe(5);
    });
});

// ───────────────── assignBooklets — permutation + cut-stack ─────────────────
describe('assignBooklets', () => {
    it('mỗi cuốn xuất hiện đúng 1 lần (chia hết ô/tờ)', () => {
        const job = mkJob({ bookletCount: 6, endNum: 600 }); // 600 % 6 == 0
        for (const dist of ['stack', 'sequential'] as Distribution[]) {
            const a = assignBooklets({ ...job, distribution: dist }, 2);
            const idxs = a.map(s => s.bookletIndex).filter(i => i >= 0).sort((x, y) => x - y);
            expect(idxs).toEqual([0, 1, 2, 3, 4, 5]);
        }
    });
    it('ô trống = -1 khi bookletCount không chia hết slotsPerSheet', () => {
        const a = assignBooklets(mkJob({ bookletCount: 5 }), 2); // 1000%5==0; 3 tờ × 2 ô = 6 ô, 1 trống
        expect(a.filter(s => s.bookletIndex === -1).length).toBe(1);
        expect(a.filter(s => s.bookletIndex >= 0).map(s => s.bookletIndex).sort((x, y) => x - y))
            .toEqual([0, 1, 2, 3, 4]);
    });
    it('[Property 3] stack: chồng tờ + cắt theo vị trí → dải LIÊN TIẾP đúng cuốn', () => {
        const job = mkJob({ bookletCount: 6, endNum: 600, distribution: 'stack' }); // 600%6==0
        const a = assignBooklets(job, 2);
        const sheets = 3;
        for (let pos = 0; pos < 2; pos++) {
            const pile = a.filter(s => s.pos === pos).sort((x, y) => x.sheet - y.sheet)
                .map(s => s.bookletIndex);
            // chồng vị trí pos qua các tờ phải là dải liên tiếp
            expect(pile).toEqual([pos * sheets, pos * sheets + 1, pos * sheets + 2]);
        }
    });
});

// ───────────────── 16 tổ hợp: bất biến đồng bộ luôn đúng ─────────────────
describe('Đồng bộ ruột↔bìa giữ vững qua mọi tổ hợp (Req 6.2)', () => {
    const inners: InnerMode[] = ['continuous', 'reset'];
    const dists: Distribution[] = ['stack', 'sequential'];
    const sorts: SortMethod[] = ['rows', 'cols', 'snake', 'clockwise'];
    for (const innerMode of inners)
        for (const distribution of dists)
            for (const sortMethod of sorts) {
                it(`${innerMode}/${distribution}/${sortMethod}: cover Y/Z == innerRange`, () => {
                    const job = mkJob({ innerMode, distribution, sortMethod, bookletCount: 25, endNum: 1000 });
                    const d = deriveJob(job);
                    expect(d.valid).toBe(true);
                    const rows = generateCoverData(job);
                    expect(rows.length).toBe(25);
                    rows.forEach((r, i) => {
                        const ir = innerRange(job, i);
                        expect(Number(r.Y)).toBe(ir.start);
                        expect(Number(r.Z)).toBe(ir.end);
                    });
                    // assignBooklets phủ đủ cuốn (permutation) bất kể tổ hợp
                    const a = assignBooklets(job, 5);
                    const idxs = a.map(s => s.bookletIndex).filter(i => i >= 0).sort((x, y) => x - y);
                    expect(idxs).toEqual(Array.from({ length: 25 }, (_, i) => i));
                });
            }
});
