import { describe, it, expect } from 'vitest';
import { sanitizeFilename, buildSavePlan, type SavePlanConfig } from './printFileNaming';

describe('sanitizeFilename', () => {
    it('removes illegal chars', () => {
        const out = sanitizeFilename('DH1/2: A*B?"<>|C');
        expect(out).not.toMatch(/[\\/:*?"<>|]/);
    });
    it('trims dashes/spaces', () => {
        expect(sanitizeFilename('  - a - -  b - ')).toBe('a - b');
    });
});

const base: SavePlanConfig = {
    nameMode: 'report', folderMode: 'per_order', separateCut: false,
    includeOrderCode: true, includeDate: false, orderCode: 'DH-001',
};

describe('buildSavePlan', () => {
    it('1 file/type when separateCut off', () => {
        const plan = buildSavePlan([{ label: 'Tem A', sheetCount: 8 }, { label: 'Tem B', sheetCount: 3 }], base);
        expect(plan).toHaveLength(2);
        expect(plan[0].kind).toBe('print');
        expect(plan[0].pageIndex).toBe(0);
        expect(plan[1].pageIndex).toBe(1);
        expect(plan[0].filename).toContain('DH-001');
        expect(plan[0].filename).toContain('Tem A');
        expect(plan[0].filename).toContain('8 tờ');
    });

    it('2 files/type (in+bế) when separateCut on', () => {
        const plan = buildSavePlan([{ label: 'Tem A', sheetCount: 8 }], { ...base, separateCut: true });
        expect(plan).toHaveLength(2);
        expect(plan[0].kind).toBe('print');
        expect(plan[0].pageIndex).toBe(0);
        expect(plan[1].kind).toBe('cut');
        expect(plan[1].pageIndex).toBe(1);
        expect(plan[1].filename).toContain('(cut)');
        expect(plan[0].folder).toContain('In');
        expect(plan[1].folder).toContain('Bế');
    });

    it('number mode = sequential', () => {
        const plan = buildSavePlan([{ label: 'X', sheetCount: 1 }], { ...base, nameMode: 'number' });
        expect(plan[0].filename).toBe('1.pdf');
    });

    it('flat mode has no order subfolder', () => {
        const plan = buildSavePlan([{ label: 'X', sheetCount: 1 }], { ...base, folderMode: 'flat' });
        expect(plan[0].folder).toBe('');
    });
});

describe('buildSavePlan — CNC (Bình Bế Rớt)', () => {
    it('3 files/type (front/back/cut) khi 2 mặt', () => {
        const plan = buildSavePlan(
            [{ label: 'SP A', sheetCount: 5 }, { label: 'SP B', sheetCount: 2 }],
            { ...base, cncMode: true, cncTwoSided: true }
        );
        expect(plan).toHaveLength(6);
        // Đơn vị 0: trang 0,1,2
        expect(plan[0].kind).toBe('front');
        expect(plan[0].pageIndex).toBe(0);
        expect(plan[1].kind).toBe('back');
        expect(plan[1].pageIndex).toBe(1);
        expect(plan[2].kind).toBe('cut');
        expect(plan[2].pageIndex).toBe(2);
        // Đơn vị 1: trang 3,4,5
        expect(plan[3].pageIndex).toBe(3);
        expect(plan[5].pageIndex).toBe(5);
        expect(plan[0].filename).toContain('(front)');
        expect(plan[1].filename).toContain('(back)');
        expect(plan[2].filename).toContain('(cut)');
    });

    it('2 files/type (front/cut) khi 1 mặt', () => {
        const plan = buildSavePlan([{ label: 'SP A', sheetCount: 5 }], { ...base, cncMode: true, cncTwoSided: false });
        expect(plan).toHaveLength(2);
        expect(plan[0].kind).toBe('front');
        expect(plan[0].pageIndex).toBe(0);
        expect(plan[1].kind).toBe('cut');
        expect(plan[1].pageIndex).toBe(1);
    });

    it('per_order tách thư mục MatTruoc/MatSau/Khuon', () => {
        const plan = buildSavePlan([{ label: 'SP A', sheetCount: 5 }], { ...base, cncMode: true, cncTwoSided: true });
        expect(plan[0].folder).toContain('MatTruoc');
        expect(plan[1].folder).toContain('MatSau');
        expect(plan[2].folder).toContain('Khuon');
    });
});
