import { describe, it, expect } from 'vitest';
import { WORKSPACE_TOOL_PANEL, type WorkspacePanelKind } from './types';
import { PREPROCESS_ROUTER_TOOLS } from './sections/preprocessRouterTools';

/**
 * Chốt routing workspace bình bài (Bước C — refactor).
 * Các test này sẽ BẮT được đúng lớp lỗi đã gặp:
 *   - merge lòi panel bình (merge bị xếp nhầm 'preprocess'/'imposition')
 *   - pageboxes/tool render panel trống (preprocess set lệch router)
 */
describe('WORKSPACE_TOOL_PANEL — nguồn chân lý routing', () => {
    it('tập "preprocess" KHỚP CHÍNH XÁC PreprocessingRouter (không drift)', () => {
        const mapPreprocess = Object.entries(WORKSPACE_TOOL_PANEL)
            .filter(([, kind]) => kind === 'preprocess')
            .map(([tool]) => tool)
            .sort();
        const router = [...PREPROCESS_ROUTER_TOOLS].sort();
        expect(mapPreprocess).toEqual(router);
    });

    it('mọi kind đều hợp lệ', () => {
        const valid: WorkspacePanelKind[] = ['none', 'imposition', 'merge', 'preprocess', 'external'];
        for (const kind of Object.values(WORKSPACE_TOOL_PANEL)) {
            expect(valid).toContain(kind);
        }
    });

    it('4 chế độ bình bài thật là kind "imposition"', () => {
        for (const t of ['booklet', 'nup', 'sticker_imposer', 'cnc_imposer'] as const) {
            expect(WORKSPACE_TOOL_PANEL[t]).toBe('imposition');
        }
    });

    it('merge là block riêng (kind "merge"), KHÔNG phải preprocess/imposition', () => {
        expect(WORKSPACE_TOOL_PANEL.merge).toBe('merge');
    });

    it('các tool VDP/đóng dấu được định tuyến ngoài (kind "external")', () => {
        for (const t of ['datamerge', 'numbering', 'cover_numbering', 'stick_text_number'] as const) {
            expect(WORKSPACE_TOOL_PANEL[t]).toBe('external');
        }
    });

    it('none → "none" (hiện menu công cụ)', () => {
        expect(WORKSPACE_TOOL_PANEL.none).toBe('none');
    });
});
