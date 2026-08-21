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
    runTrimShift: vi.fn(),
    runSplit: vi.fn(),
    runMerge: vi.fn(),
    PROCESS_COMPLETED: { status: 'completed' },
    PROCESS_CANCELED: { status: 'canceled' },
}));

import { RECIPE_RUNNERS, isPlayableOp } from './recipeRunners';
import { uploadPDF, authenticatedFetch } from '../api';
import { runProcessEngine, runMerge, runSplit } from '../processHandlers';

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
    (runProcessEngine as any).mockResolvedValue({ status: 'completed' });
    (runMerge as any).mockResolvedValue({ status: 'completed' });
    (runSplit as any).mockResolvedValue({ status: 'completed' });
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
        const outcome = await RECIPE_RUNNERS.booklet!(makeCtx(), { sheetWidth: 320 }, null);
        expect(runProcessEngine).toHaveBeenCalledWith(expect.anything(), { sheetWidth: 320 }, false);
        expect(outcome).toEqual({ status: 'completed' });
    });

    it('imposition runner truyền nguyên outcome canceled về PlaybackRunner', async () => {
        (runProcessEngine as any).mockResolvedValueOnce({ status: 'canceled' });

        const outcome = await RECIPE_RUNNERS.booklet!(makeCtx(), { sheetWidth: 320 }, null);

        expect(outcome).toEqual({ status: 'canceled' });
    });

    it('merge runner truyền file ngoài vào filesToMerge + spawnNewTab=false', async () => {
        const f = new File([new Uint8Array([9])], 'b.pdf');
        await RECIPE_RUNNERS.merge!(makeCtx(), { mode: 'merge_files' }, { files: [f] });
        expect(runMerge).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ mode: 'merge_files', spawnNewTab: false, filesToMerge: [f] }),
        );
    });

    it('split recipe chỉ phát chế độ extract_pages có đúng một output', async () => {
        const context = makeCtx();

        const outcome = await RECIPE_RUNNERS.split!(
            context,
            { mode: 'extract_pages', pageListStr: '1,3' },
            null,
        );

        expect(outcome).toEqual({ status: 'completed' });
        expect(runSplit).toHaveBeenCalledWith(
            context,
            expect.objectContaining({ mode: 'extract_pages', spawnNewTab: false }),
        );
    });

    it.each(['by_count', 'by_range'])('split recipe %s dừng trước khi tạo nhiều output', async (mode) => {
        const context = makeCtx();

        const outcome = await RECIPE_RUNNERS.split!(context, { mode }, null);

        expect(outcome).toMatchObject({ status: 'error' });
        expect(context.setError).toHaveBeenCalledWith(expect.stringContaining('nhiều file'));
        expect(runSplit).not.toHaveBeenCalled();
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
        await RECIPE_RUNNERS.convertcolors!(makeCtx({ commitWorkingFile: commit }), {
            conversions: ['rgb_to_cmyk'],
            file_id: 'stale-imported-id',
        }, null);

        expect(uploadPDF).toHaveBeenCalledTimes(1);
        const postCall = (authenticatedFetch as any).mock.calls[0];
        expect(postCall[0]).toBe('http://x/api/preflight/convert-colors');
        const body = JSON.parse(postCall[1].body);
        expect(body).toEqual({ file_id: 'fid-123', conversions: ['rgb_to_cmyk'] });
        expect(commit).toHaveBeenCalledWith(expect.any(Blob), 'out.pdf');
    });

    it('giữ cảnh báo và engine từ response prepress sau khi commit', async () => {
        const post = {
            json: async () => ({
                success: true,
                output_filename: 'out.pdf',
                warnings: ['Mất vector khi raster hoá'],
                engine: 'pikepdf',
                log: [{ status: 'success', message: 'RGB → CMYK. Cảnh báo: Spot được giữ nguyên' }],
            }),
        };
        const dl = { blob: async () => new Blob([new Uint8Array([5])], { type: 'application/pdf' }) };
        (authenticatedFetch as any)
            .mockResolvedValueOnce(post)
            .mockResolvedValueOnce(dl);

        const outcome = await RECIPE_RUNNERS.convertcolors!(makeCtx(), {}, null);

        expect(outcome).toMatchObject({
            status: 'completed',
            warnings: ['Mất vector khi raster hoá', 'Spot được giữ nguyên'],
            engine: 'pikepdf',
        });
    });

    it('download prepress lỗi thì không commit body lỗi như PDF', async () => {
        (authenticatedFetch as any)
            .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, output_filename: 'out.pdf' }) })
            .mockResolvedValueOnce({ ok: false, status: 500 });
        const context = makeCtx({ commitWorkingFile: vi.fn() });

        const outcome = await RECIPE_RUNNERS.convertcolors!(context, {}, null);

        expect(outcome).toMatchObject({ status: 'error' });
        expect(context.commitWorkingFile).not.toHaveBeenCalled();
    });

    it('backend báo lỗi → setError, không commit', async () => {
        const post = { json: async () => ({ success: false, error: 'hỏng' }) };
        (authenticatedFetch as any).mockResolvedValueOnce(post);
        const setError = vi.fn();
        const commit = vi.fn();
        const outcome = await RECIPE_RUNNERS.pdfx!(makeCtx({ setError, commitWorkingFile: commit }), { standard: 'x1a' }, null);
        expect(setError).toHaveBeenCalledWith('hỏng');
        expect(commit).not.toHaveBeenCalled();
        expect(outcome).toEqual({ status: 'error', error: 'hỏng' });
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
        const outcome = await RECIPE_RUNNERS.optimize!(makeCtx({ setError, commitWorkingFile: commit }), { preset: 'ebook' }, null);
        expect(setError).toHaveBeenCalledWith('server lỗi');
        expect(commit).not.toHaveBeenCalled();
        expect(outcome).toEqual({ status: 'error', error: 'server lỗi' });
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

    it('dò hình trả success=false thì dừng trước engine bình', async () => {
        (authenticatedFetch as any).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ success: false, error: 'PDF hỏng', shapes: ['CUSTOM'] }),
        });
        const context = makeCtx();

        const outcome = await RECIPE_RUNNERS.sticker_imposer!(context, {}, null);

        expect(outcome).toMatchObject({ status: 'error' });
        expect(context.setError).toHaveBeenCalledWith(expect.stringContaining('PDF hỏng'));
        expect(runProcessEngine).not.toHaveBeenCalled();
    });
});

describe('recipeRunners — tạo đường cắt (sticker_dieline)', () => {
    it('POST /pdf-tools/sticker-dieline (multipart) → commit kết quả', async () => {
        const blob = new Blob([new Uint8Array([3])], { type: 'application/pdf' });
        (authenticatedFetch as any).mockResolvedValueOnce({ ok: true, blob: async () => blob });
        const commit = vi.fn();
        await RECIPE_RUNNERS.sticker_dieline!(
            makeCtx({ commitWorkingFile: commit, file: new File([new Uint8Array([1])], 'tem.pdf', { type: 'application/pdf' }) }),
            { productType: 'sticker', cutMode: 'original', offsetMm: 0, cornerStyle: 'preserve', curveTension: 85, shapeMode: 'auto_safe', fillHoles: true, bleedMm: 2, removeWhiteBg: true, bleedColorType: 'image', bleedColorHex: '#FFFFFF', cutFirstPageOnly: true, edgeBiteMm: 0.3 },
            null,
        );
        const call = (authenticatedFetch as any).mock.calls[0];
        expect(call[0]).toBe('http://x/api/pdf-tools/sticker-dieline');
        const fd = call[1].body as FormData;
        expect(fd.get('cut_mode')).toBe('original');
        expect(fd.get('bleed_mm')).toBe('2');
        expect(fd.get('corner_style')).toBe('preserve');
        // Giữ nguyên góc không dùng mức bo cũ dù recipe có mang field.
        expect(fd.get('curve_tension')).toBe('50');
        // AUDIT (2026-08-16 §BX.F01): phát lại phải gửi ĐÚNG shape_mode đã ghi. Hợp đồng
        // cũ suy `preserve → contour` nên recipe ghi ở chế độ nhận dạng hình chuẩn lại
        // phát lại thành giữ mép ảnh — khuôn bế khác bản người dùng đã duyệt.
        expect(fd.get('shape_mode')).toBe('auto_safe');
        expect(fd.get('file_id')).toBe('fid-123');
        // Parity: "tạo đường cắt cho trang đầu" phải được phát lại (không bị đánh mất).
        expect(fd.get('cut_first_page_only')).toBe('true');
        // Bế tem: không dùng edge_bite (trùng “Bỏ nền trắng”) — luôn 0 dù recipe có field.
        expect(fd.get('edge_bite_mm')).toBe('0');
        // §PLAY.PATH: response không có header path → commit không kèm path (undefined).
        expect(commit).toHaveBeenCalledWith(blob, 'sticker_tem.pdf', undefined);
    });

    it('§PLAY.PATH: giữ native output path từ header X-Sticker-Output-Path', async () => {
        const blob = new Blob([new Uint8Array([4])], { type: 'application/pdf' });
        (authenticatedFetch as any).mockResolvedValueOnce({
            ok: true,
            blob: async () => blob,
            headers: { get: (k: string) => (k === 'X-Sticker-Output-Path' ? 'D:\\results\\sticker_tem.pdf' : null) },
        });
        const commit = vi.fn();
        await RECIPE_RUNNERS.sticker_dieline!(
            makeCtx({ commitWorkingFile: commit, file: new File([new Uint8Array([1])], 'tem.pdf', { type: 'application/pdf' }) }),
            { productType: 'sticker', cutMode: 'original', offsetMm: 0, cornerStyle: 'preserve', bleedMm: 2, bleedColorType: 'image' },
            null,
        );
        expect(commit).toHaveBeenCalledWith(blob, 'sticker_tem.pdf', 'D:\\results\\sticker_tem.pdf');
    });

    it('phát lại đúng Độ bo cong khi kiểu góc là Góc tròn', async () => {
        const blob = new Blob([new Uint8Array([4])], { type: 'application/pdf' });
        vi.mocked(authenticatedFetch).mockResolvedValueOnce(
            { ok: true, blob: async () => blob } as unknown as Response,
        );
        await RECIPE_RUNNERS.sticker_dieline!(
            makeCtx({ file: new File([new Uint8Array([1])], 'tem.pdf', { type: 'application/pdf' }) }),
            { productType: 'sticker', cutMode: 'original', cornerStyle: 'round', curveTension: 85 },
            null,
        );
        const request = vi.mocked(authenticatedFetch).mock.calls[0][1] as RequestInit;
        expect((request.body as FormData).get('curve_tension')).toBe('85');
    });

    it('§PLAY.BX01-LEGACY: recipe cũ shapeMode=contour KHÔNG ép contour (fail-closed)', async () => {
        const blob = new Blob([new Uint8Array([5])], { type: 'application/pdf' });
        (authenticatedFetch as any).mockResolvedValueOnce({ ok: true, blob: async () => blob });
        const commit = vi.fn();
        await RECIPE_RUNNERS.sticker_dieline!(
            makeCtx({ commitWorkingFile: commit, file: new File([new Uint8Array([1])], 'tem.pdf', { type: 'application/pdf' }) }),
            // Bản ghi cũ: có shapeMode='contour' nhưng KHÔNG có forceContour.
            { productType: 'sticker', cutMode: 'original', offsetMm: 0, cornerStyle: 'preserve', shapeMode: 'contour', bleedMm: 2, bleedColorType: 'image' },
            null,
        );
        const fd = (authenticatedFetch as any).mock.calls[0][1].body as FormData;
        // Không có forceContour tường minh → không ép contour.
        expect(fd.get('shape_mode')).not.toBe('contour');
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
        expect(fd.get('rectangle_mode')).toBe('true');
        expect(fd.get('edge_bite_mm')).toBe('1.5');
        // rectangle không dùng "trang đầu" dù params có cờ.
        expect(fd.get('cut_first_page_only')).toBe('false');
    });

    // Hai helper có kiểu để test mới không thêm `as any` vào ngân sách lint.
    function queueDielinePdfResponse(): void {
        const blob = new Blob([new Uint8Array([3])], { type: 'application/pdf' });
        vi.mocked(authenticatedFetch).mockResolvedValueOnce(
            { ok: true, blob: async () => blob } as unknown as Response,
        );
    }
    function firstRequestForm(): FormData {
        const [, init] = vi.mocked(authenticatedFetch).mock.calls[0];
        return (init as RequestInit).body as FormData;
    }

    it('van an toàn "giữ mép ảnh" đã ghi thì phát lại vẫn ép contour (§BX.F01)', async () => {
        queueDielinePdfResponse();
        await RECIPE_RUNNERS.sticker_dieline!(
            makeCtx({ file: new File([new Uint8Array([1])], 'tem.pdf', { type: 'application/pdf' }) }),
            { productType: 'sticker', cutMode: 'original', cornerStyle: 'preserve', forceContour: true, shapeMode: 'contour' },
            null,
        );
        expect(firstRequestForm().get('shape_mode')).toBe('contour');
    });

    it('biên trong suốt (alpha) giữ nguyên góc và KHÔNG bỏ nền trắng (§BX.F13)', async () => {
        queueDielinePdfResponse();
        await RECIPE_RUNNERS.sticker_dieline!(
            makeCtx({ file: new File([new Uint8Array([1])], 'tem.pdf', { type: 'application/pdf' }) }),
            { productType: 'sticker', cutMode: 'alpha', cornerStyle: 'round', curveTension: 95, removeWhiteBg: true },
            null,
        );
        const fd = firstRequestForm();
        expect(fd.get('corner_style')).toBe('preserve');
        expect(fd.get('remove_white_bg')).toBe('false');
        expect(fd.get('shape_mode')).toBe('contour');
        expect(fd.get('curve_tension')).toBe('50');
    });

    it('xén vuông + đổ màu trơn KHÔNG được gửi độ lẹm mép (§BX.F02)', async () => {
        queueDielinePdfResponse();
        await RECIPE_RUNNERS.sticker_dieline!(
            makeCtx({ file: new File([new Uint8Array([1])], 'tem.pdf', { type: 'application/pdf' }) }),
            { productType: 'rectangle', bleedMm: 3, bleedColorType: 'solid', bleedColorHex: '0,0,0,10', edgeBiteMm: 2 },
            null,
        );
        expect(firstRequestForm().get('edge_bite_mm')).toBe('0');
    });

    it('recipe mang NaN/ngoài khoảng phải bị kẹp trước khi gửi (§BX.F07)', async () => {
        queueDielinePdfResponse();
        await RECIPE_RUNNERS.sticker_dieline!(
            makeCtx({ file: new File([new Uint8Array([1])], 'tem.pdf', { type: 'application/pdf' }) }),
            { productType: 'sticker', cutMode: 'original', bleedMm: Number.NaN, offsetMm: 999 },
            null,
        );
        const fd = firstRequestForm();
        expect(fd.get('bleed_mm')).toBe('0');
        expect(fd.get('offset_mm')).toBe('10');
    });

    it('recipe CŨ không có thanh khử răng cưa phải phát lại y nguyên: tắt (§CUTJAG.3)', async () => {
        queueDielinePdfResponse();
        await RECIPE_RUNNERS.sticker_dieline!(
            makeCtx({ file: new File([new Uint8Array([1])], 'tem.pdf', { type: 'application/pdf' }) }),
            { productType: 'sticker', cutMode: 'original' },
            null,
        );
        const fd = firstRequestForm();
        expect(fd.get('cutline_denoise')).toBe('0');
        expect(fd.get('curve_tension')).toBe('50');
    });

    it('phát lại đúng mức khử răng cưa đã ghi, có kẹp 0–100 (§CUTJAG.3)', async () => {
        queueDielinePdfResponse();
        await RECIPE_RUNNERS.sticker_dieline!(
            makeCtx({ file: new File([new Uint8Array([1])], 'tem.pdf', { type: 'application/pdf' }) }),
            { productType: 'sticker', cutMode: 'original', cutlineDenoise: 45 },
            null,
        );
        expect(firstRequestForm().get('cutline_denoise')).toBe('45');
    });

    it('mức khử răng cưa ngoài khoảng bị kẹp về 100 (§CUTJAG.3)', async () => {
        queueDielinePdfResponse();
        await RECIPE_RUNNERS.sticker_dieline!(
            makeCtx({ file: new File([new Uint8Array([1])], 'tem.pdf', { type: 'application/pdf' }) }),
            { productType: 'sticker', cutMode: 'original', cutlineDenoise: 500 },
            null,
        );
        expect(firstRequestForm().get('cutline_denoise')).toBe('100');
    });

    it('độ bo cong ngoài khoảng bị kẹp về 100', async () => {
        queueDielinePdfResponse();
        await RECIPE_RUNNERS.sticker_dieline!(
            makeCtx({ file: new File([new Uint8Array([1])], 'tem.pdf', { type: 'application/pdf' }) }),
            { productType: 'sticker', cutMode: 'original', cornerStyle: 'round', curveTension: 500 },
            null,
        );
        expect(firstRequestForm().get('curve_tension')).toBe('100');
    });

    it('độ bo cong null/rỗng dùng mốc tương thích 50', async () => {
        queueDielinePdfResponse();
        await RECIPE_RUNNERS.sticker_dieline!(
            makeCtx({ file: new File([new Uint8Array([1])], 'tem.pdf', { type: 'application/pdf' }) }),
            { productType: 'sticker', cutMode: 'original', cornerStyle: 'round', curveTension: null },
            null,
        );
        expect(firstRequestForm().get('curve_tension')).toBe('50');
    });

    it('xén vuông không dò contour nên khử răng cưa phải là 0', async () => {
        queueDielinePdfResponse();
        await RECIPE_RUNNERS.sticker_dieline!(
            makeCtx({ file: new File([new Uint8Array([1])], 'tem.pdf', { type: 'application/pdf' }) }),
            { productType: 'rectangle', bleedMm: 3, cutlineDenoise: 80 },
            null,
        );
        expect(firstRequestForm().get('cutline_denoise')).toBe('0');
    });

    it('"không tạo đường cắt" cũng không dò contour nên khử răng cưa phải là 0', async () => {
        queueDielinePdfResponse();
        await RECIPE_RUNNERS.sticker_dieline!(
            makeCtx({ file: new File([new Uint8Array([1])], 'tem.pdf', { type: 'application/pdf' }) }),
            { productType: 'sticker', cutMode: 'none', cutlineDenoise: 80 },
            null,
        );
        expect(firstRequestForm().get('cutline_denoise')).toBe('0');
    });
});
