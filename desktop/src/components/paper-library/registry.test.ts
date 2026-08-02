import { describe, expect, it } from 'vitest';

import {
    TOOL_CATEGORIES,
    TOOL_KEYWORDS,
    TOOL_REGISTRY,
    toolMatchesQuery,
    type ToolDefinition,
} from '../../lib/toolRegistry';

/**
 * Chốt việc đăng ký công cụ "Thư viện vật tư in".
 *
 * Không có test này thì entry registry bị xoá / đổi isEnabled=false sẽ trôi qua
 * mọi cổng verify: typecheck vẫn xanh, test panel vẫn xanh (nó render component
 * trực tiếp), chỉ có người dùng mở app mới phát hiện công cụ biến mất.
 */
describe('Đăng ký công cụ Thư viện vật tư in', () => {
    const tool = TOOL_REGISTRY.find(t => t.id === 'paper_library') as ToolDefinition | undefined;

    it('có entry trong registry và đang bật', () => {
        expect(tool).toBeDefined();
        expect(tool!.isEnabled).toBe(true);
    });

    it('thuộc nhóm có thật trong TOOL_CATEGORIES', () => {
        expect(TOOL_CATEGORIES.map(c => c.id)).toContain(tool!.category);
    });

    it('giới hạn 1 tab — bảng tra cứu không cần mở nhiều bản', () => {
        expect(tool!.maxInstances).toBe(1);
    });

    it('có tiêu đề, mô tả và icon để thẻ ở Home hiển thị đủ', () => {
        expect(tool!.title).toBe('Thư viện vật tư in');
        expect(tool!.tabTitle).toBeTruthy();
        expect(tool!.description).toBeTruthy();
        expect(tool!.longDescription).toBeTruthy();
        expect(tool!.icon).toBeTruthy();
    });

    it('có component (lazy) để App render được', () => {
        expect(tool!.component).toBeTruthy();
    });
});

describe('Tìm kiếm công cụ Thư viện vật tư in', () => {
    const tool = TOOL_REGISTRY.find(t => t.id === 'paper_library') as ToolDefinition;

    it('có entry trong TOOL_KEYWORDS', () => {
        expect(TOOL_KEYWORDS.paper_library).toBeTruthy();
    });

    // Thợ chế bản gõ tiếng Việt không dấu ở ô tìm công cụ — mỗi từ dưới đây
    // phải ra được công cụ, nếu không thì coi như không tìm thấy.
    const queries = [
        'giay',
        'dinh luong',
        'do day',
        'gay sach',
        'mang can',
        'may chi',
        'vat tu',
        'thu vien',
        'gsm',
        'paper',
        'spine',
        'lamination',
        'couche',
        'bristol',
    ];

    it.each(queries)('tìm "%s" ra công cụ', q => {
        expect(toolMatchesQuery(tool, q)).toBe(true);
    });

    it('không khớp truy vấn không liên quan', () => {
        expect(toolMatchesQuery(tool, 'barcode qr')).toBe(false);
    });
});
