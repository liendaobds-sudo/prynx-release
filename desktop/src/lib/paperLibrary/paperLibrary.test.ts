import { describe, expect, it } from 'vitest';

import {
    findStockById,
    findStockByName,
    listStocksByFamily,
    lookupThickness,
    PAPER_STOCKS,
    stackThicknessMm,
} from './index';
import type { PaperFamily } from './types';

describe('Bảng tra định lượng giấy — toàn vẹn dữ liệu', () => {
    it('có đúng 208 dòng như 9 bảng tra gốc', () => {
        expect(PAPER_STOCKS).toHaveLength(208);
    });

    it('số dòng từng họ giấy khớp bảng gốc', () => {
        const counts: Record<PaperFamily, number> = {
            couche: 24,
            couche_matt: 25,
            duplex: 24,
            bristol: 14,
            ivory: 25,
            fort: 23,
            art: 21,
            kraft: 28,
            other: 24,
        };
        for (const [family, expected] of Object.entries(counts)) {
            expect(listStocksByFamily(family as PaperFamily)).toHaveLength(expected);
        }
    });

    it('id không trùng nhau', () => {
        const ids = PAPER_STOCKS.map(s => s.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('tên không trùng nhau', () => {
        const names = PAPER_STOCKS.map(s => s.name);
        expect(new Set(names).size).toBe(names.length);
    });

    it('mọi dòng có định lượng và độ dày dương, hợp lý', () => {
        for (const s of PAPER_STOCKS) {
            expect(s.gsm, s.name).toBeGreaterThan(0);
            expect(s.thicknessMm, s.name).toBeGreaterThan(0);
            // Giấy in mỏng nhất ~0.045mm (Pelure 30), dày nhất ~0.8mm (Ivory 500)
            expect(s.thicknessMm, s.name).toBeLessThanOrEqual(1);
        }
    });

    it('trong cùng họ + cùng tráng phủ, định lượng tăng thì độ dày không giảm', () => {
        const families = [...new Set(PAPER_STOCKS.map(s => s.family))];
        for (const family of families) {
            // Art gộp 4 dòng sản phẩm khác nhau (EK/Econo/Natural/Elica), Fort và
            // Kraft gộp nhiều xuất xứ — so sánh phải tách theo origin mới có nghĩa.
            const groups = new Map<string, typeof PAPER_STOCKS>();
            for (const s of listStocksByFamily(family)) {
                const key = `${s.coating ?? '-'}|${s.origin ?? '-'}|${s.note ?? '-'}`;
                const arr = groups.get(key) ?? [];
                arr.push(s);
                groups.set(key, arr);
            }
            for (const rows of groups.values()) {
                for (let i = 1; i < rows.length; i++) {
                    expect(
                        rows[i].thicknessMm,
                        `${family}: ${rows[i - 1].name} → ${rows[i].name}`,
                    ).toBeGreaterThanOrEqual(rows[i - 1].thicknessMm);
                }
            }
        }
    });
});

describe('Bảng tra định lượng giấy — đối chiếu số đo bảng gốc', () => {
    // Mỗi dòng dưới đây soi lại một ô trong ảnh bảng tra: đầu bảng,
    // cuối bảng, và các ô dễ nhập sai (định lượng thập phân, 1S/2S).
    const spotChecks: Array<[string, number]> = [
        ['Couche 60.2', 0.050],
        ['Couche 350', 0.330],
        ['Couche Matt 52.3', 0.055],
        ['C160 (1S)', 0.160],
        ['Duplex 230(2S)', 0.260],
        ['Duplex 230 (1S)', 0.280],
        ['Duplex 550 (1S)', 0.700],
        ['Bristol 300(2S)', 0.315],
        ['Ivory 420', 0.660],
        ['Ivory 444_Lưng Kraft', 0.600],
        ['Fort 58 BB', 0.080],
        ['Fort 170', 0.225],
        ['EK 75 - 02', 0.140],
        ['Kraft (Trắng) 80 Nhật', 0.110],
        ['Kraft 50 Nhật', 0.070],
        ['Kraft 440 Châu Âu', 0.560],
        ['Pelure 30 VN', 0.045],
        ['Carbonless_Giữa 50', 0.050],
    ];

    it.each(spotChecks)('%s dày %s mm', (name, mm) => {
        const stock = findStockByName(name);
        expect(stock, name).toBeDefined();
        expect(stock!.thicknessMm).toBe(mm);
    });
});

describe('findStockById / findStockByName', () => {
    it('tra được theo id', () => {
        expect(findStockById('couche-300')?.name).toBe('Couche 300');
    });

    it('bỏ qua hoa thường và khoảng trắng thừa', () => {
        expect(findStockByName('  couche   300 ')?.id).toBe('couche-300');
    });

    it('trả undefined khi không có', () => {
        expect(findStockById('khong-ton-tai')).toBeUndefined();
        expect(findStockByName('Giấy tưởng tượng 999')).toBeUndefined();
    });
});

describe('lookupThickness', () => {
    it('khớp đúng định lượng thì lấy số bảng tra, không nội suy', () => {
        const r = lookupThickness('couche', 300);
        expect(r).not.toBeNull();
        expect(r!.thicknessMm).toBe(0.280);
        expect(r!.interpolated).toBe(false);
        expect(r!.stock?.name).toBe('Couche 300');
    });

    it('phân biệt được 1S và 2S ở cùng định lượng', () => {
        expect(lookupThickness('duplex', 230, '2S')!.thicknessMm).toBe(0.260);
        expect(lookupThickness('duplex', 230, '1S')!.thicknessMm).toBe(0.280);
    });

    it('nội suy tuyến tính giữa hai định lượng kề và bật cờ', () => {
        // Couche 300 = 0.280, Couche 350 = 0.330 → 325 nằm giữa = 0.305
        const r = lookupThickness('couche', 325);
        expect(r!.interpolated).toBe(true);
        expect(r!.thicknessMm).toBe(0.305);
        expect(r!.between?.map(s => s.name)).toEqual(['Couche 300', 'Couche 350']);
    });

    it('kẹp về đầu/cuối bảng khi định lượng ngoài khoảng', () => {
        const low = lookupThickness('couche', 10);
        expect(low!.thicknessMm).toBe(0.050);
        expect(low!.interpolated).toBe(true);

        const high = lookupThickness('couche', 999);
        expect(high!.thicknessMm).toBe(0.330);
        expect(high!.interpolated).toBe(true);
    });
});

describe('stackThicknessMm', () => {
    it('nhân số tờ với độ dày một tờ', () => {
        // 200 tờ Fort 80 Indo (0.100mm) = 20mm
        expect(stackThicknessMm(200, 0.100)).toBe(20);
    });

    it('trả 0 với đầu vào không hợp lệ', () => {
        expect(stackThicknessMm(0, 0.1)).toBe(0);
        expect(stackThicknessMm(-5, 0.1)).toBe(0);
        expect(stackThicknessMm(10, 0)).toBe(0);
    });
});
