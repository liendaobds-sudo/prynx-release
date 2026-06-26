// ============================================================
// Property test — dimensionFormat.roundToTenthMm / formatDimensions
//
// Feature: mockup-3d-realism, Property 21: Làm tròn kích thước overlay đến 0.1 mm
// **Validates: Requirements 7.7**
//
// For any giá trị kích thước thực (dài/rộng/cao), giá trị hiển thị trong
// overlay bằng giá trị thực làm tròn đến 0.1 mm:
//   - roundToTenthMm(x) luôn là bội số của 0.1 (trong dung sai float),
//   - roundToTenthMm(x) cách x không quá 0.05 mm,
//   - formatDimensions(...).label có đúng 1 chữ số thập phân cho mỗi giá trị,
//   - đầu vào không hữu hạn (NaN/undefined/±Infinity) → 0.
//
// Mỗi property chạy tối thiểu 100 iteration.
// ============================================================

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
    roundToTenthMm,
    formatDimensions,
    DIMENSION_ROUND_STEP_MM,
} from '../dimensionFormat';

const NUM_RUNS = 200;

// Dung sai float cho phép sai số tích lũy khi nhân/chia 0.1.
const EPS = 1e-9;

// Giá trị kích thước hữu hạn, miền hợp lý cho hộp (mm), bao gồm cả số âm
// để kiểm hành vi làm tròn quanh 0.
const finiteDim = fc.double({ min: -1e6, max: 1e6, noNaN: true }).filter((d) => Number.isFinite(d));

describe('roundToTenthMm — Property 21: Làm tròn kích thước overlay đến 0.1 mm', () => {
    it('đầu ra luôn là bội số của 0.1 mm (trong dung sai float)', () => {
        fc.assert(
            fc.property(finiteDim, (value) => {
                const rounded = roundToTenthMm(value);
                // rounded / 0.1 phải gần một số nguyên.
                const steps = rounded / DIMENSION_ROUND_STEP_MM;
                const nearestInt = Math.round(steps);
                expect(Math.abs(steps - nearestInt)).toBeLessThanOrEqual(1e-6);
            }),
            { numRuns: NUM_RUNS },
        );
    });

    it('đầu ra cách đầu vào không quá 0.05 mm (làm tròn về bội số 0.1 gần nhất)', () => {
        fc.assert(
            fc.property(finiteDim, (value) => {
                const rounded = roundToTenthMm(value);
                expect(Math.abs(rounded - value)).toBeLessThanOrEqual(DIMENSION_ROUND_STEP_MM / 2 + EPS);
            }),
            { numRuns: NUM_RUNS },
        );
    });

    it('đầu vào không hữu hạn (NaN / undefined / ±Infinity) → 0', () => {
        const nonFinite = fc.oneof(
            fc.constant(NaN),
            fc.constant(undefined),
            fc.constant(Number.POSITIVE_INFINITY),
            fc.constant(Number.NEGATIVE_INFINITY),
        );
        fc.assert(
            fc.property(nonFinite, (value) => {
                expect(roundToTenthMm(value as number | undefined)).toBe(0);
            }),
            { numRuns: NUM_RUNS },
        );
    });
});

describe('formatDimensions — Property 21: Làm tròn kích thước overlay đến 0.1 mm', () => {
    it('label có đúng 1 chữ số thập phân cho mỗi giá trị L×W×H', () => {
        fc.assert(
            fc.property(finiteDim, finiteDim, finiteDim, (length, width, height) => {
                const result = formatDimensions({ length, width, height });
                // Tách nhãn "L × W × H mm" thành ba phần số.
                const numeric = result.label.replace(/\s*mm\s*$/, '');
                const parts = numeric.split('×').map((p) => p.trim());
                expect(parts).toHaveLength(3);
                for (const part of parts) {
                    // Đúng 1 chữ số thập phân: chuỗi dạng "-?digits.d".
                    expect(part).toMatch(/^-?\d+\.\d$/);
                }
            }),
            { numRuns: NUM_RUNS },
        );
    });

    it('giá trị số trong label khớp với giá trị đã làm tròn (toFixed(1))', () => {
        fc.assert(
            fc.property(finiteDim, finiteDim, finiteDim, (length, width, height) => {
                const result = formatDimensions({ length, width, height });
                const expectedLabel = `${result.length.toFixed(1)} × ${result.width.toFixed(1)} × ${result.height.toFixed(1)} mm`;
                // toFixed có thể tạo "-0.0"; formatDimensions chuẩn hóa -0 → 0.
                const normalizedExpected = expectedLabel.replace(/-0\.0/g, '0.0');
                expect(result.label).toBe(normalizedExpected);
            }),
            { numRuns: NUM_RUNS },
        );
    });
});
