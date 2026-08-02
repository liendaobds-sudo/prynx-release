import { describe, expect, it } from 'vitest';

import {
    FILM_MECHANICAL_PROPERTIES,
    FILM_SURFACE_TENSION,
    filmThicknessMm,
    findFilm,
    LAMINATION_FILMS,
    listHeatSealableFilms,
} from './laminationFilm';

describe('Bảng màng cán — toàn vẹn dữ liệu', () => {
    it('có 15 loại màng từ 3 bảng con của sheet', () => {
        expect(LAMINATION_FILMS).toHaveLength(15);
    });

    it('mã màng không trùng nhau', () => {
        const codes = LAMINATION_FILMS.map(f => f.code);
        expect(new Set(codes).size).toBe(codes.length);
    });

    it('mọi màng có độ dày dương và min ≤ max', () => {
        for (const f of LAMINATION_FILMS) {
            expect(f.thicknessMinUm, f.code).toBeGreaterThan(0);
            expect(f.thicknessMaxUm, f.code).toBeGreaterThanOrEqual(f.thicknessMinUm);
        }
    });

    it('độ dày nằm trong khoảng thực tế của màng gia công (12–120 µm)', () => {
        for (const f of LAMINATION_FILMS) {
            expect(f.thicknessMinUm, f.code).toBeGreaterThanOrEqual(12);
            expect(f.thicknessMaxUm, f.code).toBeLessThanOrEqual(120);
        }
    });

    it('4 màng mạ kim loại được đánh dấu', () => {
        const metalized = LAMINATION_FILMS.filter(f => f.metalized);
        expect(metalized.map(f => f.code)).toEqual(['MCPP', 'MPET', 'MPVC', 'Hicor']);
    });
});

describe('Đối chiếu số đo sheet gốc', () => {
    const spot: Array<[string, number, number]> = [
        ['BOPP', 20, 30],
        ['Matt OPP', 20, 20],
        ['KOPP', 22, 22],
        ['CPP', 25, 40],
        ['PCPP', 25, 80],
        ['PE', 40, 120],
        ['PET', 12, 12],
        ['Nylon', 15, 15],
        ['PVC', 35, 50],
        ['MPET', 12, 12],
    ];

    it.each(spot)('%s dày %s–%s µm', (code, min, max) => {
        const f = findFilm(code);
        expect(f, code).toBeDefined();
        expect(f!.thicknessMinUm).toBe(min);
        expect(f!.thicknessMaxUm).toBe(max);
    });
});

describe('findFilm', () => {
    it('bỏ qua hoa thường', () => {
        expect(findFilm('bopp')?.code).toBe('BOPP');
        expect(findFilm('  matt   opp ')?.code).toBe('Matt OPP');
    });

    it('trả undefined khi không có', () => {
        expect(findFilm('MÀNG-TƯỞNG-TƯỢNG')).toBeUndefined();
    });
});

describe('filmThicknessMm', () => {
    it('đổi µm sang mm', () => {
        const bopp = findFilm('BOPP')!;
        expect(filmThicknessMm(bopp, 'min')).toBeCloseTo(0.020, 10);
        expect(filmThicknessMm(bopp, 'max')).toBeCloseTo(0.030, 10);
    });

    it('mặc định lấy độ dày lớn nhất', () => {
        const pe = findFilm('PE')!;
        expect(filmThicknessMm(pe)).toBeCloseTo(0.120, 10);
    });
});

describe('listHeatSealableFilms', () => {
    it('chỉ trả màng hàn nhiệt được', () => {
        const codes = listHeatSealableFilms().map(f => f.code);
        expect(codes).toContain('CPP');
        expect(codes).toContain('PE');
        expect(codes).toContain('MCPP');
        expect(codes).not.toContain('PET');
        expect(codes).not.toContain('BOPP');
    });
});

describe('Bảng tính chất phụ', () => {
    it('sức căng bề mặt có 6 dòng', () => {
        expect(FILM_SURFACE_TENSION).toHaveLength(6);
        expect(FILM_SURFACE_TENSION[0]).toEqual({ film: 'PP, OPP, BOPP', dynesRaw: '29–31' });
    });

    it('tính chất cơ nhiệt có 4 dòng', () => {
        expect(FILM_MECHANICAL_PROPERTIES).toHaveLength(4);
        expect(FILM_MECHANICAL_PROPERTIES[0].film).toBe('LDPE');
        expect(FILM_MECHANICAL_PROPERTIES[0].sealTempC).toBe('100–110');
    });
});
