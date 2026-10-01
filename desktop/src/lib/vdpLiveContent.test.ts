import { describe, expect, it } from 'vitest';
import type { VdpToolField } from '../hooks/useVdpTool';
import { resolveVdpInline, resolveVdpLiveContent, resolveVdpLiveImagePath, resolveVdpPreviewContent } from './vdpLiveContent';

const field = (overrides: Partial<VdpToolField> = {}): VdpToolField => ({
    id: 'f1', name: 'Name', type: 'text', ...overrides,
});

describe('VDP LIVE content parity', () => {
    it('ẩn hoàn toàn field khi hide_if khớp', () => {
        const result = resolveVdpPreviewContent(field({
            conditions: [{ column: 'Status', operator: 'eq', value: 'ẩn', action: 'hide_if' }],
        }), { enabled: true, currentRecord: { Status: 'Ẩn' } });
        expect(result.visible).toBe(false);
    });

    it('áp rule first-match, token điều kiện và placeholder có định dạng', () => {
        const result = resolveVdpPreviewContent(field({
            textContent: '{Status?Có:{Name|upper}}',
            rules: [
                { column: 'Kind', operator: 'eq', value: 'A', result: '{Name|upper}' },
                { column: 'Kind', operator: 'eq', value: 'A', result: 'sai' },
            ],
        }), { enabled: true, currentRecord: { Status: '', Kind: 'A', Name: 'lan' } });
        expect(result).toMatchObject({ visible: true, content: 'LAN' });
    });

    it('hỗ trợ định dạng số/ngày trong LIVE', () => {
        const result = resolveVdpPreviewContent(field({ textContent: '{Amount|number:2} / {When|date:%Y-%m-%d}' }), {
            enabled: true,
            currentRecord: { Amount: '1234.5', When: '31/12/2025' },
        });
        expect(result.content).toBe('1,234.50 / 2025-12-31');
    });

    it('giữ template khi directive ngày phụ thuộc locale chưa được hỗ trợ', () => {
        const result = resolveVdpPreviewContent(field({ textContent: '{When|date:%B %d}' }), {
            enabled: true,
            currentRecord: { When: '31/12/2025' },
        });
        expect(result.content).toBe('{When|date:%B %d}');
        expect(result.unsupportedFormat).toBe('date:%B');
    });

    it('giữ imagePath tĩnh và ghép imageBaseDir cho tên file tương đối', () => {
        const fallback = resolveVdpPreviewContent(field({ type: 'image', name: 'Photo', imagePath: 'C:\\logo.png' }), {
            enabled: true,
            currentRecord: { Photo: '' },
        });
        expect(fallback.content).toBe('C:\\logo.png');
        expect(resolveVdpLiveImagePath(field({ type: 'image', imageBaseDir: 'C:\\assets' }), 'logo.png')).toBe('C:\\assets\\logo.png');
    });

    it.each(['Số nhảy: Trang 1/3', 'Bìa: Tờ 1/3'])('ưu tiên record theo id cho nguồn %s', sourceTitle => {
        const result = resolveVdpPreviewContent(field({ textContent: '{Name}' }), {
            enabled: true,
            sourceTitle,
            currentRecord: { f1: 'Theo ID', Name: 'Theo cột' },
        });
        expect(result.content).toBe('Theo ID');
    });

    it.each(['CSV: dữ liệu.csv', 'Excel: dữ liệu.xlsx', 'Google Sheets', undefined])('giữ đúng cột Name khi nguồn %s có cột trùng ID', sourceTitle => {
        const result = resolveVdpPreviewContent(field({ textContent: '{Name}', fieldName: 'Alias' }), {
            enabled: true,
            sourceTitle,
            currentRecord: { f1: 'Theo ID', Name: 'Theo cột', Alias: 'Theo alias' },
        });
        expect(result.content).toBe('Theo cột');
    });

    // Kỳ vọng đã đối chiếu trực tiếp với resolve_field_content/_substitute Python.
    it.each([
        ['2.5', '0', '2'], ['3.5', '0', '4'], ['2.675', '2', '2.67'],
        ['-2.675', '2', '-2.67'], ['-0', '2', '-0.00'],
        ['1_000.25', '2', '1,000.25'], ['１２.５', '2', '12.50'],
        ['1e21', '0', '1,000,000,000,000,000,000,000'],
        ['1__2', '2', '1__2'], ['1_000.25', 'x', '1_000.25'],
    ])('định dạng số %s với %s chữ số thập phân như Python', (value, precision, expected) => {
        expect(resolveVdpLiveContent(field({ textContent: `{Amount|number:${precision}}` }), { Amount: value }).content).toBe(expected);
    });

    it.each([
        ['31/12/2025', '2025-12-31'], ['12/31/2025', '2025-12-31'],
        ['02/03/2025', '2025-03-02'], ['2024/2/29', '2024-02-29'],
        ['2025-2-29', '2025-2-29'], ['01/01/0001', '0001-01-01'],
        ['31/12/9999', '9999-12-31'], ['31/12/2025 1:02', '2025-12-31'],
    ])('đọc ngày %s theo thứ tự định dạng Python', (value, expected) => {
        expect(resolveVdpLiveContent(field({ textContent: '{When|date:%Y-%m-%d}' }), { When: value }).content).toBe(expected);
    });

    it.each([
        ['title', 'ß ǅ ᾲ ΟΣ ΟΣΑ', 'Ss ǅ Ὰͅ Ος Οσα'],
        ['title', "they're 123abc", "They'Re 123Abc"],
        ['trim', '\u001c abc \u001c', 'abc'],
        ['trim', '\ufeff abc \ufeff', '\ufeff abc \ufeff'],
        ['pad:9', '\u001c abc \u001c', '000000abc'],
    ])('định dạng Unicode %s như Python', (format, value, expected) => {
        expect(resolveVdpLiveContent(field({ textContent: `{Name|${format}}` }), { Name: value }).content).toBe(expected);
    });

    it('giải mã escape trong token và không phân giải đệ quy nhánh điều kiện', () => {
        expect(resolveVdpInline('{A?x\\:y\\}z\\\\:no}', { A: 'yes' })).toBe('x:y}z\\');
        expect(resolveVdpInline('{A?{B?yes\\:no\\}:other}', { A: 'yes', B: '' })).toBe('{B?yes:no}');
        expect(resolveVdpLiveContent(field({ textContent: '{A?{Name\\}:other}' }), { A: 'yes', Name: 'Lan' }).content).toBe('Lan');
    });

    it('field đã ẩn không kiểm rule, field hiện kiểm mọi cột rule trước first-match', () => {
        const rules = [
            { column: 'A', operator: 'eq', value: '', result: 'first' },
            { column: 'Missing', operator: 'empty', result: 'second' },
        ];
        expect(resolveVdpLiveContent(field({ conditions: [{ column: 'A', operator: 'empty', action: 'hide_if' }], rules }), { A: '' })).toEqual({ visible: false, content: '' });
        expect(resolveVdpLiveContent(field({ rules }), { A: '' })).toEqual({ visible: true, content: 'MISSING: Name', missingColumn: 'Missing' });
    });

    it('điều kiện so sánh không phân biệt hoa/thường và xử lý casefold Unicode', () => {
        expect(resolveVdpLiveContent(field({ conditions: [{ column: 'A', operator: 'eq', value: 'STRASSE' }] }), { A: 'Straße' }).visible).toBe(true);
        expect(resolveVdpLiveContent(field({ conditions: [{ column: 'A', operator: 'eq', value: 'σ' }] }), { A: 'ς' }).visible).toBe(true);
        expect(resolveVdpLiveContent(field({ conditions: [{ column: 'A', operator: 'eq', value: 'i' }] }), { A: 'ı' }).visible).toBe(false);
    });
});
