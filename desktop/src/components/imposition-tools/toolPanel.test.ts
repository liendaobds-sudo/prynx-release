import { describe, it, expect } from 'vitest';
import { WORKSPACE_TOOL_PANEL, isWorkspaceTool, resolveRightPanel, type WorkspacePanelKind } from './types';
import { canToolRunWithoutPdf, isLogoRebuildEnabled, LOGO_REBUILD_ENABLED, PREPROCESS_ROUTER_TOOLS, resolveDedicatedInitialTool } from './sections/preprocessRouterTools';
import { findToolByUniqueKey } from '../../lib/toolRegistry';

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
            'hairlines', 'inkmanager', 'convertcolors', 'trapping', 'pdfx', 'ocr', 'optimize',
            'bgremover', 'watermark', 'upscale', 'logo_rebuild', 'encrypt', 'metadata', 'office_convert']) {
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

describe('điều hướng tab công cụ độc lập', () => {
    it('giữ đúng công cụ gốc thay vì rơi về workspace PDF trống', () => {
        expect(resolveDedicatedInitialTool('upscale')).toBe('upscale');
        expect(resolveDedicatedInitialTool('bgremover')).toBe('bgremover');
        expect(isLogoRebuildEnabled(true)).toBe(true);
        expect(isLogoRebuildEnabled(false)).toBe(false);
        expect(isLogoRebuildEnabled(false, true)).toBe(true);
        expect(isLogoRebuildEnabled(true, false)).toBe(true);
        expect(LOGO_REBUILD_ENABLED).toBe(
            import.meta.env.DEV || import.meta.env.VITE_LOGO_REBUILD_ENABLED === 'true',
        );
        expect(resolveDedicatedInitialTool('logo_rebuild')).toBe(
            LOGO_REBUILD_ENABLED ? 'logo_rebuild' : null,
        );
        expect(resolveDedicatedInitialTool('office_convert')).toBe('office_convert');
        expect(resolveDedicatedInitialTool('font_tools')).toBeNull();
        expect(resolveDedicatedInitialTool()).toBeNull();
    });
});

describe('capability điều hướng workspace', () => {
    it('chỉ ba công cụ tự nhận nguồn được phép chạy không cần PDF', () => {
        expect(canToolRunWithoutPdf('bgremover')).toBe(true);
        expect(canToolRunWithoutPdf('upscale')).toBe(true);
        expect(canToolRunWithoutPdf('logo_rebuild')).toBe(LOGO_REBUILD_ENABLED);
        expect(canToolRunWithoutPdf('office_convert')).toBe(true);
        expect(canToolRunWithoutPdf('encrypt')).toBe(false);
        expect(canToolRunWithoutPdf('metadata')).toBe(false);
    });

    it('nhận diện tool từ đúng map routing duy nhất', () => {
        expect(isWorkspaceTool('crop')).toBe(true);
        expect(isWorkspaceTool('inkmanager')).toBe(true);
        expect(findToolByUniqueKey('inkmanager')?.featureId).toBe('prepress.convert_colors');
        expect(isWorkspaceTool('cover_numbering')).toBe(true);
        expect(isWorkspaceTool('khong-ton-tai')).toBe(false);
    });
});
