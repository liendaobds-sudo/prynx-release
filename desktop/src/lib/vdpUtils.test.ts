import { describe, it, expect } from 'vitest';
import { buildMultiUpJobInput } from './vdpUtils';

// Regression cho F1 (audit VDP rule 2026-07-04): multi-up phải namespace MỌI cột
// theo slot và remap TẤT CẢ tham chiếu cột (placeholder, conditions, rules), không
// chỉ tên field. Bug cũ: điều kiện/rule tham chiếu cột gốc → cột không tồn tại
// trong record trang → ConditionError/MISSING trên mọi bản ghi.

// Hai field, mỗi field một slot riêng (không group), đặt ở hai hàng khác nhau để
// sortFieldsGeometrically('rows') giữ thứ tự slot0 (trên) → slot1 (dưới).
const twoSlotFields = () => [
    {
        id: 'f1', name: 'Ten', type: 'text', x: 10, y: 10, width: 40, height: 10,
        textContent: 'Xin chào {Ten}',
        conditions: [{ column: 'Hang', operator: 'eq', value: 'VIP', action: 'show_if' }],
        rules: [{ column: 'Nuoc', operator: 'eq', value: 'VN', result: 'co_{Nuoc}.png' }],
    },
    {
        id: 'f2', name: 'Ten', type: 'text', x: 10, y: 60, width: 40, height: 10,
        textContent: 'Xin chào {Ten}',
        conditions: [{ column: 'Hang', operator: 'eq', value: 'VIP', action: 'show_if' }],
        rules: [{ column: 'Nuoc', operator: 'eq', value: 'VN', result: 'co_{Nuoc}.png' }],
    },
];

describe('buildMultiUpJobInput (F1: multi-up namespaces all columns)', () => {
    it('namespaces condition/rule columns and placeholders per slot', () => {
        const headers = ['Ten', 'Hang', 'Nuoc'];
        const source = [
            { Ten: 'An', Hang: 'VIP', Nuoc: 'VN' },
            { Ten: 'Binh', Hang: 'Thuong', Nuoc: 'US' },
        ];
        const { fields, data } = buildMultiUpJobInput(twoSlotFields(), headers, source);

        // Hai record nhồi vào hai slot của MỘT trang.
        expect(fields).toHaveLength(2);
        expect(data).toHaveLength(1);

        const slot0 = fields.find(f => f.name === 'Ten_slot0')!;
        const slot1 = fields.find(f => f.name === 'Ten_slot1')!;
        expect(slot0).toBeDefined();
        expect(slot1).toBeDefined();

        // Placeholder trong textContent remap sang khoá slot.
        expect(slot0.textContent).toBe('Xin chào {Ten_slot0}');
        expect(slot1.textContent).toBe('Xin chào {Ten_slot1}');

        // Cột điều kiện remap sang khoá slot.
        expect(slot0.conditions[0].column).toBe('Hang_slot0');
        expect(slot1.conditions[0].column).toBe('Hang_slot1');

        // Cột rule + placeholder trong rule.result remap sang khoá slot.
        expect(slot0.rules[0].column).toBe('Nuoc_slot0');
        expect(slot0.rules[0].result).toBe('co_{Nuoc_slot0}.png');
        expect(slot1.rules[0].column).toBe('Nuoc_slot1');
        expect(slot1.rules[0].result).toBe('co_{Nuoc_slot1}.png');
    });

    it('copies every referenced column into per-slot page-row keys', () => {
        const headers = ['Ten', 'Hang', 'Nuoc'];
        const source = [
            { Ten: 'An', Hang: 'VIP', Nuoc: 'VN' },
            { Ten: 'Binh', Hang: 'Thuong', Nuoc: 'US' },
        ];
        const { data } = buildMultiUpJobInput(twoSlotFields(), headers, source);
        const row = data[0];

        // Slot0 lấy record 0, slot1 lấy record 1 — mọi cột (kể cả cột chỉ dùng
        // trong điều kiện/rule) đều có mặt dưới khoá slot, không giẫm nhau.
        expect(row['Ten_slot0']).toBe('An');
        expect(row['Hang_slot0']).toBe('VIP');
        expect(row['Nuoc_slot0']).toBe('VN');
        expect(row['Ten_slot1']).toBe('Binh');
        expect(row['Hang_slot1']).toBe('Thuong');
        expect(row['Nuoc_slot1']).toBe('US');
    });

    it('every referenced column key exists so no condition points at a missing column', () => {
        const headers = ['Ten', 'Hang', 'Nuoc'];
        const source = [
            { Ten: 'An', Hang: 'VIP', Nuoc: 'VN' },
            { Ten: 'Binh', Hang: 'Thuong', Nuoc: 'US' },
        ];
        const { fields, data } = buildMultiUpJobInput(twoSlotFields(), headers, source);
        const row = data[0];

        // Mọi cột được tham chiếu bởi condition/rule phải tồn tại trong page-row
        // (đây chính là điều bug cũ vi phạm → ConditionError trên backend).
        for (const f of fields) {
            for (const c of f.conditions || []) {
                expect(row).toHaveProperty(c.column);
            }
            for (const r of f.rules || []) {
                expect(row).toHaveProperty(r.column);
            }
        }
    });

    it('derives source columns from data when csvHeaders is empty', () => {
        const source = [
            { Ten: 'An', Hang: 'VIP' },
            { Ten: 'Binh', Hang: 'Thuong' },
        ];
        const { data } = buildMultiUpJobInput(twoSlotFields(), [], source);
        const row = data[0];
        expect(row['Hang_slot0']).toBe('VIP');
        expect(row['Hang_slot1']).toBe('Thuong');
    });

    it('does not remap a column that is a prefix of another column name', () => {
        // Cột 'Ma' là tiền tố của 'MaVach' — remap dài-trước-ngắn + lookahead phải
        // giữ nguyên ranh giới token, không biến {MaVach} thành {Ma_slot0Vach}.
        const fields = [{
            id: 'f1', name: 'Ma', type: 'text', x: 10, y: 10, width: 40, height: 10,
            textContent: '{Ma} - {MaVach}',
            conditions: [], rules: [],
        }];
        const headers = ['Ma', 'MaVach'];
        const source = [{ Ma: 'A1', MaVach: '8930001' }];
        const { fields: out } = buildMultiUpJobInput(fields, headers, source);
        expect(out[0].textContent).toBe('{Ma_slot0} - {MaVach_slot0}');
    });
});
