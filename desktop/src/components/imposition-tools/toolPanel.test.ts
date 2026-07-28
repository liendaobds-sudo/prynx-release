import { describe, it, expect } from 'vitest';
import { WORKSPACE_TOOL_PANEL, resolveRightPanel, type WorkspacePanelKind } from './types';
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

describe('resolveRightPanel — routing panel-phải ImpositionTab (lưới an toàn refactor)', () => {
    it('isObjectEditMode = true mở Edit PDF ở các ngữ cảnh thông thường', () => {
        for (const t of ['none', 'nup', 'datamerge', 'numbering', 'merge', 'sticker_imposer']) {
            expect(resolveRightPanel(t, true)).toBe('edit');
        }
    });

    it('các tool VDP/đóng dấu → đúng component riêng', () => {
        expect(resolveRightPanel('datamerge', false)).toBe('datamerge');
        expect(resolveRightPanel('numbering', false)).toBe('numbering');
        expect(resolveRightPanel('cover_numbering', false)).toBe('cover_numbering');
        expect(resolveRightPanel('stick_text_number', false)).toBe('stick_text_number');
    });

    it('mọi tool còn lại (bình bài + tiền xử lý + none) → "dashboard"', () => {
        for (const t of ['none', 'booklet', 'nup', 'sticker_imposer', 'cnc_imposer',
            'merge', 'shuffle', 'resize', 'split', 'pages', 'sticker', 'preflight', 'font_tools',
            'hairlines', 'convertcolors', 'trapping', 'pdfx', 'ocr', 'optimize',
            'bgremover', 'watermark', 'upscale', 'encrypt', 'metadata', 'office_convert']) {
            expect(resolveRightPanel(t, false)).toBe('dashboard');
        }
    });

    it('nhất quán với map: tool "external" ↔ có panel-phải riêng (không phải dashboard)', () => {
        for (const [tool, kind] of Object.entries(WORKSPACE_TOOL_PANEL)) {
            const rp = resolveRightPanel(tool, false);
            if (kind === 'external') {
                expect(rp).not.toBe('dashboard');
            } else {
                expect(rp).toBe('dashboard');
            }
        }
    });
});


describe('Sticker object-selection panel routing', () => {
    it('keeps the Bleed/Cutline panel mounted while Edit PDF selects objects', () => {
        expect(resolveRightPanel('sticker', true)).toBe('dashboard');
        expect(resolveRightPanel('sticker', false)).toBe('dashboard');
    });

    it('keeps the normal Edit PDF panel for other workspace contexts', () => {
        expect(resolveRightPanel('none', true)).toBe('edit');
        expect(resolveRightPanel('preflight', true)).toBe('edit');
    });
});
