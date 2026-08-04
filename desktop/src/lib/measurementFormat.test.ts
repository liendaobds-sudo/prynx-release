import { describe, expect, it } from 'vitest';
import { formatMeasurement, formatSizeMm, roundMeasurement } from './measurementFormat';

describe('measurementFormat', () => {
    it('giữ kích thước thật đến 0,1 mm và bỏ .0 thừa', () => {
        expect(formatMeasurement(147.1215)).toBe('147.1');
        expect(formatMeasurement(147.1215, 2)).toBe('147.12');
        expect(formatMeasurement(51.3327)).toBe('51.3');
        expect(formatMeasurement(210)).toBe('210');
        expect(formatSizeMm(147.1215, 51.3327)).toBe('147.1 × 51.3 mm');
    });

    it('làm tròn nửa lên nhất quán cho cả số dương và âm', () => {
        expect(roundMeasurement(148.55)).toBe(148.6);
        expect(roundMeasurement(-1.25)).toBe(-1.3);
        expect(formatMeasurement(148.55)).toBe('148.6');
    });

    it('không biến dữ liệu không hợp lệ thành kích thước giả', () => {
        expect(formatMeasurement(Number.NaN)).toBe('');
        expect(formatSizeMm(Number.POSITIVE_INFINITY, 20)).toBe('');
    });
});
