import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProcessContext } from '../processHandlers';

// Mock api trước khi import registry.
vi.mock('../api', () => ({
    getApiUrl: () => 'http://x/api',
    uploadPDF: vi.fn(async () => ({ id: 'fid-123' })),
    authenticatedFetch: vi.fn(),
    prepareFileForUpload: vi.fn(async (f: any) => f),
}));
// Mock processHandlers để tránh kéo theo pdf-lib trong test registry.
vi.mock('../processHandlers', () => ({
    runProcessEngine: vi.fn(),
    runShuffle: vi.fn(),
    runResize: vi.fn(),
    runSplit: vi.fn(),
    runMerge: vi.fn(),
}));

import { RECIPE_RUNNERS, isPlayableOp } from './recipeRunners';
import { uploadPDF, authenticatedFetch } from '../api';
import { runProcessEngine, runMerge } from '../processHandlers';

function makeCtx(over: Partial<ProcessContext> = {}): ProcessContext {
    return {
        file: new File([new Uint8Array([1])], 'in.pdf', { type: 'application/pdf' }),
        commitWorkingFile: vi.fn(),
        setError: vi.fn(),
        setIsProcessing: vi.fn(),
        setProcessStatus: vi.fn(),
        setReportMsg: vi.fn(),
        setBatchOutput: vi.fn(),
        getWorkingBytes: async () => new Uint8Array([1, 2, 3]),
        ...over,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe('recipeRunners — registry', () => {
    it('isPlayableOp đúng cho op đã nối / chưa nối', () => {
        expect(isPlayableOp('booklet')).toBe(true);
        expect(isPlayableOp('convertcolors')).toBe(true);
        expect(isPlayableOp('merge')).toBe(true);
        expect(isPlayableOp('optimize')).toBe(true);
        // Tem bế phát lại được nhờ dò lại hình mỗi file:
        expect(isPlayableOp('sticker_imposer')).toBe(true);
        expect(isPlayableOp('cnc_imposer')).toBe(true);
        expect(isPlayableOp('sticker_dieline')).toBe(true);
        // Chưa nối / ngoài phạm vi chuỗi PDF ở v1:
        expect(isPlayableOp('ocr')).toBe(false);
        expect(isPlayableOp('bgremover')).toBe(false);
        expect(isPlayableOp('watermark')).toBe(false);
    });

    it('imposition runner ép spawnNewTab=false', async () => {
        await RECIPE_RUNNERS.booklet!(makeCtx(), { sheetWidth: 320 }, null);
        expect(runProcessEngine).toHaveBeenCalledWith(expect.anything(), { sheetWidth: 320 }, false);
    });

    it('merge runner truyền file ngoài vào filesToMerge + spawnNewTab=false', async () => {
        const f = new File([new Uint8Array([9])], 'b.pdf');
        await RECIPE_RUNNERS.merge!(makeCtx(), { mode: 'merge_files' }, { files: [f] });
        expect(runMerge).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ mode: 'merge_files', spawnNewTab: false, filesToMerge: [f] }),
        );
    });
});

describe('recipeRunners — prepress JSON (convertcolors)', () => {
    it('upload → POST {file_id,...params} → download → commit', async () => {
        const post = { json: async () => ({ success: true, output_filename: 'out.pdf' }) };
        const dl = { blob: async () => new Blob([new Uint8Array([5])], { type: 'application/pdf' }) };
        (authenticatedFetch as any)
            .mockResolvedValueOnce(post)   // POST convert-colors
            .mockResolvedValueOnce(dl);    // download

        const commit = vi.fn();
        await RECIPE_RUNNERS.convertcolors!(makeCtx({ commitWorkingFile: commit }), { conversions: ['rgb_to_cmyk'] }, null);

        expect(uploadPDF).toHaveBeenCalledTimes(1);
        const postCall = (authenticatedFetch as any).mock.calls[0];
        expect(postCall[0]).toBe('http://x/api/preflight/convert-colors');
        const body = JSON.parse(postCall[1].body);
        expect(body).toEqual({ file_id: 'fid-123', conversions: ['rgb_to_cmyk'] });
        expect(commit).toHaveBeenCalledWith(expect.any(Blob), 'out.pdf');
    });

    it('backend báo lỗi → setError, không commit', async () => {
        const post = { json: async () => ({ success: false, error: 'hỏng' }) };
        (authenticatedFetch as any).mockResolvedValueOnce(post);
        const setError = vi.fn();
        const commit = vi.fn();
        await RECIPE_RUNNERS.pdfx!(makeCtx({ setError, commitWorkingFile: commit }), { standard: 'x1a' }, null);
        expect(setError).toHaveBeenCalledWith('hỏng');
        expect(commit).not.toHaveBeenCalled();
    });
});

describe('recipeRunners — optimize (multipart → blob)', () => {
    it('POST formData /pdf-tools/optimize → commit blob', async () => {
        const blob = new Blob([new Uint8Array([7])], { type: 'application/pdf' });
        (authenticatedFetch as any).mockResolvedValueOnce({ ok: true, blob: async () => blob });
        const commit = vi.fn();
        await RECIPE_RUNNERS.optimize!(makeCtx({ commitWorkingFile: commit }), { preset: 'printer', image_dpi: 300, strip_metadata: true, grayscale: false }, null);

        const call = (authenticatedFetch as any).mock.calls[0];
        expect(call[0]).toBe('http://x/api/pdf-tools/optimize');
        expect(call[1].method).toBe('POST');
        const fd = call[1].body as FormData;
        expect(fd.get('preset')).toBe('printer');
        expect(fd.get('image_dpi')).toBe('300');
        expect(fd.get('strip_metadata')).toBe('true');
        expect(fd.get('grayscale')).toBe('false');
        expect(commit).toHaveBeenCalledWith(blob, 'optimized_in.pdf');
    });

    it('response không ok → setError, không commit', async () => {
        (authenticatedFetch as any).mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ detail: 'server lỗi' }) });
        const setError = vi.fn();
        const commit = vi.fn();
        await RECIPE_RUNNERS.optimize!(makeCtx({ setError, commitWorkingFile: commit }), { preset: 'ebook' }, null);
        expect(setError).toHaveBeenCalledWith('server lỗi');
        expect(commit).not.toHaveBeenCalled();
    });
});

describe('recipeRunners — bình tem dò lại hình (sticker_imposer)', () => {
    it('gọi /imposition/detect-shape rồi ghép shape MỚI vào params trước khi bình', async () => {
        // detect-shape trả shapes/shapeParams cho file MỚI
        (authenticatedFetch as any).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ shapes: ['CIRCLE', 'CIRCLE'], shapeParams: [{ d: 10 }, { d: 10 }] }),
        });
        await RECIPE_RUNNERS.sticker_imposer!(
            makeCtx(),
            { sheetWidth: 320, sheetHeight: 450, imposerMode: 'diecut' }, // KHÔNG có detectedShapesByPage
            null,
        );
        // detect-shape gọi đúng endpoint
        expect((authenticatedFetch as any).mock.calls[0][0]).toBe('http://x/api/imposition/detect-shape');
        // runProcessEngine nhận params đã GHÉP shape mới
        const passed = (runProcessEngine as any).mock.calls[0][1];
        expect(passed.detectedShapesByPage).toEqual({ 0: 'CIRCLE', 1: 'CIRCLE' });
        expect(passed.detectedShapeParamsByPage).toEqual({ 0: { d: 10 }, 1: { d: 10 } });
        expect((runProcessEngine as any).mock.calls[0][2]).toBe(false); // spawnNewTab=false
    });
});

describe('recipeRunners — tạo đường cắt (sticker_dieline)', () => {
    it('POST /pdf-tools/sticker-dieline (multipart) → commit kết quả', async () => {
        const blob = new Blob([new Uint8Array([3])], { type: 'application/pdf' });
        (authenticatedFetch as any).mockResolvedValueOnce({ ok: true, blob: async () => blob });
        const commit = vi.fn();
        await RECIPE_RUNNERS.sticker_dieline!(
            makeCtx({ commitWorkingFile: commit, file: new File([new Uint8Array([1])], 'tem.pdf', { type: 'application/pdf' }) }),
            { productType: 'sticker', cutMode: 'original', offsetMm: 0, cornerStyle: 'preserve', shapeMode: 'auto_safe', fillHoles: true, bleedMm: 2, removeWhiteBg: true, bleedColorType: 'image', bleedColorHex: '#FFFFFF', cutFirstPageOnly: true, edgeBiteMm: 0.3 },
            null,
        );
        const call = (authenticatedFetch as any).mock.calls[0];
        expect(call[0]).toBe('http://x/api/pdf-tools/sticker-dieline');
        const fd = call[1].body as FormData;
        expect(fd.get('cut_mode')).toBe('original');
        expect(fd.get('bleed_mm')).toBe('2');
        expect(fd.get('corner_style')).toBe('preserve');
        expect(fd.get('shape_mode')).toBe('contour');
        expect(fd.get('file_id')).toBe('fid-123');
        // Parity: "tạo đường cắt cho trang đầu" phải được phát lại (không bị đánh mất).
        expect(fd.get('cut_first_page_only')).toBe('true');
        // Bế tem: không dùng edge_bite (trùng “Bỏ nền trắng”) — luôn 0 dù recipe có field.
        expect(fd.get('edge_bite_mm')).toBe('0');
        expect(commit).toHaveBeenCalledWith(blob, 'sticker_tem.pdf');
    });

    it('phát lại XÉN VUÔNG (rectangle) → gửi edge_bite_mm, KHÔNG bật cut_first_page_only', async () => {
        const blob = new Blob([new Uint8Array([3])], { type: 'application/pdf' });
        (authenticatedFetch as any).mockResolvedValueOnce({ ok: true, blob: async () => blob });
        const commit = vi.fn();
        await RECIPE_RUNNERS.sticker_dieline!(
            makeCtx({ commitWorkingFile: commit, file: new File([new Uint8Array([1])], 'tem.pdf', { type: 'application/pdf' }) }),
            { productType: 'rectangle', bleedMm: 3, bleedColorType: 'image', edgeBiteMm: 1.5, cutFirstPageOnly: true, removeWhiteBg: true, trimWhiteEdge: true },
            null,
        );
        const fd = (authenticatedFetch as any).mock.calls[0][1].body as FormData;
        // Cả removeWhiteBg/trimWhiteEdge kiểu cũ đều không được auto-trim đổi khổ.
        expect((authenticatedFetch as any).mock.calls).toHaveLength(1);
        expect((authenticatedFetch as any).mock.calls[0][0]).toBe('http://x/api/pdf-tools/sticker-dieline');
        expect(fd.get('edge_bite_mm')).toBe('1.5');
        // rectangle không dùng "trang đầu" dù params có cờ.
        expect(fd.get('cut_first_page_only')).toBe('false');
    });
});
