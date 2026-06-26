// ============================================================
// Property test — normalizeEdgeColor (lib/mockup3d/panelSolid)
//
// Feature: mockup-3d-realism, Property 3: Chuẩn hóa màu cạnh giấy
//
// *For any* giá trị đầu vào, `normalizeEdgeColor` trả về chính giá trị đó
// nếu thuộc {kraft, white}, ngược lại luôn trả về kraft.
//
// Validates: Requirements 1.2, 1.3
// ============================================================

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { normalizeEdgeColor, DEFAULT_EDGE_COLOR } from '../panelSolid';
import type { EdgeColor } from '../types';

const VALID_EDGE_COLORS: readonly EdgeColor[] = ['kraft', 'white'];

describe('normalizeEdgeColor — Property 3: Chuẩn hóa màu cạnh giấy', () => {
    it('giữ nguyên giá trị hợp lệ thuộc {kraft, white}', () => {
        fc.assert(
            fc.property(fc.constantFrom<EdgeColor>('kraft', 'white'), (valid) => {
                expect(normalizeEdgeColor(valid)).toBe(valid);
            }),
            { numRuns: 100 },
        );
    });

    it('mọi chuỗi ngoài tập hợp lệ → kraft', () => {
        fc.assert(
            fc.property(
                fc.string().filter((s) => !(VALID_EDGE_COLORS as readonly string[]).includes(s)),
                (other) => {
                    expect(normalizeEdgeColor(other)).toBe('kraft');
                },
            ),
            { numRuns: 100 },
        );
    });

    it('mọi đầu vào không phải chuỗi (số, boolean, object, null, undefined, ...) → kraft', () => {
        fc.assert(
            fc.property(
                fc.anything().filter((v) => typeof v !== 'string'),
                (nonString) => {
                    expect(normalizeEdgeColor(nonString)).toBe('kraft');
                },
            ),
            { numRuns: 100 },
        );
    });

    it('undefined → kraft (giá trị mặc định)', () => {
        fc.assert(
            fc.property(fc.constant(undefined), (u) => {
                expect(normalizeEdgeColor(u)).toBe(DEFAULT_EDGE_COLOR);
                expect(normalizeEdgeColor(u)).toBe('kraft');
            }),
            { numRuns: 100 },
        );
    });

    it('đầu ra LUÔN thuộc {kraft, white} với bất kỳ đầu vào nào', () => {
        fc.assert(
            fc.property(fc.anything(), (anyInput) => {
                const result = normalizeEdgeColor(anyInput);
                expect(VALID_EDGE_COLORS).toContain(result);
            }),
            { numRuns: 100 },
        );
    });
});
