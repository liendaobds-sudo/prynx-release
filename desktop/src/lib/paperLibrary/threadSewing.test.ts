import { describe, expect, it } from 'vitest';

import {
    canThreadSew,
    findThreadSewingLimit,
    maxSheetsForThreadSewing,
    THREAD_SEWING_LIMITS,
} from './threadSewing';

describe('Bảng số tờ tối đa may chỉ — đối chiếu sheet gốc', () => {
    it('có 8 mã giấy', () => {
        expect(THREAD_SEWING_LIMITS).toHaveLength(8);
    });

    it('mã giấy không trùng nhau', () => {
        const codes = THREAD_SEWING_LIMITS.map(l => l.code);
        expect(new Set(codes).size).toBe(codes.length);
    });

    // Số lấy trực tiếp từ sheet 'May chi ': [mã, max, max khi cán màng]
    const rows: Array<[string, number, number | undefined]> = [
        ['C115', 4, 3],
        ['C150', 3, 2],
        ['C200', 2, 2],
        ['F70', 5, undefined],
        ['F80', 5, undefined],
        ['F100', 4, undefined],
        ['F120', 3, undefined],
        ['Cmatt', 2, undefined],
    ];

    it.each(rows)('%s: %s tờ (cán màng: %s)', (code, max, lam) => {
        const l = findThreadSewingLimit(code);
        expect(l, code).toBeDefined();
        expect(l!.maxSheets).toBe(max);
        expect(l!.maxSheetsLaminated).toBe(lam);
    });

    it('giấy càng dày càng khâu được ít tờ', () => {
        expect(maxSheetsForThreadSewing('C115')).toBeGreaterThan(maxSheetsForThreadSewing('C150')!);
        expect(maxSheetsForThreadSewing('C150')).toBeGreaterThan(maxSheetsForThreadSewing('C200')!);
        expect(maxSheetsForThreadSewing('F80')).toBeGreaterThan(maxSheetsForThreadSewing('F120')!);
    });

    it('cán màng thì khâu được ít tờ hơn hoặc bằng', () => {
        for (const l of THREAD_SEWING_LIMITS) {
            if (l.maxSheetsLaminated !== undefined) {
                expect(l.maxSheetsLaminated, l.code).toBeLessThanOrEqual(l.maxSheets);
            }
        }
    });
});

describe('maxSheetsForThreadSewing', () => {
    it('bỏ qua hoa thường', () => {
        expect(maxSheetsForThreadSewing('c115')).toBe(4);
        expect(maxSheetsForThreadSewing(' F80 ')).toBe(5);
    });

    it('trả null khi mã giấy không có trong bảng', () => {
        expect(maxSheetsForThreadSewing('C999')).toBeNull();
    });

    it('trả null khi sheet không ghi số cho trường hợp đã cán màng', () => {
        expect(maxSheetsForThreadSewing('F80', true)).toBeNull();
        expect(maxSheetsForThreadSewing('Cmatt', true)).toBeNull();
    });
});

describe('canThreadSew', () => {
    it('cho phép khi tay sách trong giới hạn', () => {
        expect(canThreadSew('C115', 4)).toEqual({ ok: true, max: 4 });
        expect(canThreadSew('F80', 3)).toEqual({ ok: true, max: 5 });
    });

    it('từ chối khi tay sách vượt giới hạn, kèm lý do', () => {
        const r = canThreadSew('C200', 5);
        expect(r.ok).toBe(false);
        expect(r.max).toBe(2);
        expect(r.reason).toContain('vượt giới hạn');
    });

    it('từ chối khi giấy đã cán màng mà sheet chưa có số', () => {
        const r = canThreadSew('F100', 2, true);
        expect(r.ok).toBe(false);
        expect(r.max).toBeNull();
        expect(r.reason).toContain('cán màng');
    });

    it('từ chối khi mã giấy lạ', () => {
        const r = canThreadSew('XYZ', 1);
        expect(r.ok).toBe(false);
        expect(r.reason).toContain('Không có mã giấy');
    });

    it('áp giới hạn cán màng khi có số', () => {
        expect(canThreadSew('C115', 4, true).ok).toBe(false); // max cán màng = 3
        expect(canThreadSew('C115', 3, true).ok).toBe(true);
    });
});
