import { describe, expect, it } from 'vitest';
import { DEFAULT_BOOK_REPORT_CONFIG } from '../components/imposition-tools/types';
import { buildBookReportText, toBookReportRenderConfig } from './bookReport';

const previewData = {
    pageCount: 96,
    finishedWidthMm: 210,
    finishedHeightMm: 297,
    bindingLabel: 'Khâu chỉ',
    paperSizeLabel: '320 × 450 mm',
};

function enabledConfig(overrides: Record<string, unknown> = {}) {
    return {
        ...DEFAULT_BOOK_REPORT_CONFIG,
        fieldOrder: [...DEFAULT_BOOK_REPORT_CONFIG.fieldOrder],
        enabled: true,
        orderCode: 'DH-001',
        titleText: 'Tạp chí tháng 7',
        quantity: 2_000,
        bodyPaper: 'Fort 80 gsm',
        coverPaper: 'C300 gsm',
        coverFinish: 'Cán mờ 1 mặt',
        notes: 'Đóng gói 20 cuốn',
        ...overrides,
    };
}

describe('book product report', () => {
    it('keeps the booklet report disabled by default', () => {
        expect(buildBookReportText(DEFAULT_BOOK_REPORT_CONFIG, previewData)).toBe('');
    });

    it('builds a compact two-line report from product and derived job data', () => {
        const text = buildBookReportText(enabledConfig(), previewData);
        const lines = text.split('\n');

        expect(lines).toHaveLength(2);
        expect(lines[0]).toContain('DH-001');
        expect(lines[0]).toContain('96 trang');
        expect(lines[0]).toContain('2.000 cuốn');
        expect(lines[1]).toContain('Khâu chỉ');
        expect(lines[1]).toContain('Fort 80 gsm');
        expect(lines[1]).toContain('320 × 450 mm');
        expect(text.toLowerCase()).not.toContain('kẽm');
        expect(text.toLowerCase()).not.toContain('offset');
    });

    it('respects hidden fields and optional Vietnamese diacritic removal', () => {
        const text = buildBookReportText(enabledConfig({
            showBodyPaper: false,
            removeDiacritics: true,
        }), previewData);

        expect(text).not.toContain('Fort 80 gsm');
        expect(text).toContain('Tap chi thang 7');
        expect(text).not.toContain('Tạp chí tháng 7');
    });

    it('creates only render-ready settings with non-empty text', () => {
        const render = toBookReportRenderConfig(enabledConfig({ fontSize: 2, offsetX: -4 }), previewData);
        expect(render?.fontSize).toBe(4);
        expect(render?.offsetX).toBe(0);
        expect(render?.text).toContain('DH-001');
    });
});
