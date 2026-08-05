import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { ImpositionMode } from './pdfImposer';
import { runProcessEngine, runResize, type ProcessContext } from './processHandlers';
import i18n from '../i18n';

const api = vi.hoisted(() => ({
    uploadFileForNup: vi.fn(),
    startNupJobBackend: vi.fn(),
    getNupJobStatus: vi.fn(),
    downloadNupJob: vi.fn(),
    cancelNupJobBackend: vi.fn(),
    uploadPDF: vi.fn(),
    getApiUrl: vi.fn(),
    authenticatedFetch: vi.fn(),
    backendResizePages: vi.fn(),
}));

vi.mock('./api', () => api);
vi.mock('@tauri-apps/plugin-fs', () => ({
    stat: vi.fn().mockResolvedValue({ size: 4096 }),
}));

describe('runProcessEngine N-Up native fast path', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
        api.startNupJobBackend.mockResolvedValue('job-1');
        api.getNupJobStatus.mockResolvedValue({
            status: 'completed',
            progress: '1/1',
            report: 'ok',
            output_path: 'D:\\results\\nup_job-1.pdf',
        });
        api.downloadNupJob.mockResolvedValue(
            new Blob(['downloaded'], { type: 'application/pdf' }),
        );
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('serializes whole-sheet decal as guillotine with marks and no die fields', async () => {
        const context: ProcessContext = {
            file: new File(['source'], 'sheet.pdf', { type: 'application/pdf' }),
            commitWorkingFile: vi.fn().mockResolvedValue(undefined),
            setError: vi.fn(),
            setIsProcessing: vi.fn(),
            setProcessStatus: vi.fn(),
            setReportMsg: vi.fn(),
            setBatchOutput: vi.fn(),
            getWorkingBytes: vi.fn(),
            getWorkingSourcePath: vi.fn().mockResolvedValue('D:\\sheet.pdf'),
        };

        await runProcessEngine(
            context,
            {
                impositionMode: ImpositionMode.NUp,
                imposerMode: 'guillotine',
                pageSheetMode: true,
                sheetWidth: 320,
                sheetHeight: 450,
                bleed: 3,
                markType: 'guillotine',
                cutType: 'one_dao',
                pontType: 'corner',
                pontConfig: { shape: 'l_corner', size: 5 },
                pontsOnCutFile: true,
                separateCutPage: false,
                exportUniqueSheets: true,
                cutBorderEnabled: true,
                cutBorderPosition: 'bleed',
                cutBorderColor: '#FF0000',
                cutBorderThickness: 0.6,
            } as any,
            false,
        );

        const payload = api.startNupJobBackend.mock.calls[0][1];
        expect(payload).toMatchObject({
            page_sheet_mode: true,
            isDieCutMode: false,
            markType: 'guillotine',
            duplexFlow: 'normal',
            exportUniqueSheets: true,
            separateCutPage: true,
            pontType: 'corner',
            pontConfig: { shape: 'l_corner', size: 5 },
            pontsOnCutFile: true,
        });
        expect(payload.cutType).toBeUndefined();
        expect(payload.detectedShapesByPage).toBeUndefined();
        expect(payload).not.toHaveProperty('impositionUnit');
        expect(payload).not.toHaveProperty('cutBorderEnabled');
        expect(payload).not.toHaveProperty('cutBorderPosition');
        expect(payload).not.toHaveProperty('cutBorderColor');
        expect(payload).not.toHaveProperty('cutBorderThickness');
    });

    it('does not serialize the Sticker cut-page toggle for CNC', async () => {
        const context: ProcessContext = {
            file: new File(['source'], 'cnc.pdf', { type: 'application/pdf' }),
            commitWorkingFile: vi.fn().mockResolvedValue(undefined),
            setError: vi.fn(),
            setIsProcessing: vi.fn(),
            setProcessStatus: vi.fn(),
            setReportMsg: vi.fn(),
            setBatchOutput: vi.fn(),
            getWorkingBytes: vi.fn(),
            getWorkingSourcePath: vi.fn().mockResolvedValue('D:\\cnc.pdf'),
        };

        await runProcessEngine(
            context,
            {
                impositionMode: ImpositionMode.NUp,
                imposerMode: 'cnc',
                sheetWidth: 320,
                sheetHeight: 450,
                pontType: 'custom',
                pontConfig: {
                    shape: 'circle',
                    size: 5,
                    thickness: 0.5,
                    layerName: 'Marks_Model_',
                    groupName: 'MarkLine',
                    itemName: 'MKLINE',
                },
                pontsOnCutFile: false,
                cncTwoSided: false,
            } as any,
            false,
        );

        const payload = api.startNupJobBackend.mock.calls[0][1];
        expect(payload.imposerMode).toBe('cnc');
        expect(payload.pontConfig.itemName).toBe('MKLINE');
        expect(payload).not.toHaveProperty('pontsOnCutFile');
    });

    it('skips source upload and result download for clean desktop files', async () => {
        const commitWorkingFile = vi.fn().mockResolvedValue(undefined);
        const getWorkingBytes = vi.fn();
        const context: ProcessContext = {
            file: new File(['source'], 'input.pdf', { type: 'application/pdf' }),
            commitWorkingFile,
            setError: vi.fn(),
            setIsProcessing: vi.fn(),
            setProcessStatus: vi.fn(),
            setReportMsg: vi.fn(),
            setBatchOutput: vi.fn(),
            getWorkingBytes,
            getWorkingSourcePath: vi.fn().mockResolvedValue('D:\\input.pdf'),
        };

        await runProcessEngine(
            context,
            {
                impositionMode: ImpositionMode.NUp,
                imposerMode: 'guillotine',
                sheetWidth: 320,
                sheetHeight: 450,
                bleed: 0,
                cols: 2,
                rows: 2,
                cutBorderEnabled: true,
                cutBorderPosition: 'bleed',
                cutBorderColor: '#12A34B',
                cutBorderThickness: 0.6,
            } as unknown as import('./pdfImposer').ProcessingSettings,
            false,
        );

        expect(api.startNupJobBackend).toHaveBeenCalledWith(
            'D:\\input.pdf',
            expect.any(Object),
        );
        expect(api.uploadFileForNup).not.toHaveBeenCalled();
        expect(getWorkingBytes).not.toHaveBeenCalled();
        expect(api.downloadNupJob).not.toHaveBeenCalled();
        expect(api.startNupJobBackend.mock.calls[0][1]).toMatchObject({
            cutBorderEnabled: true,
            cutBorderPosition: 'bleed',
            cutBorderColor: '#12A34B',
            cutBorderThickness: 0.6,
        });
        expect(commitWorkingFile).toHaveBeenCalledWith(
            expect.any(Blob),
            'Imposed_input_.pdf',
            'D:\\results\\nup_job-1.pdf',
        );
    });

    it.each([
        [
            'vi',
            'khổ giấy tổng quát',
            'Sheet too small for source pages. Cannot fit any items.',
            'Không bình được trang: Vùng giấy sử dụng quá nhỏ, không xếp được trang nguồn nào. Hãy tăng khổ giấy, giảm lề hoặc kiểm tra TrimBox của file nguồn.',
        ],
        [
            'en',
            'khổ giấy tổng quát',
            'Sheet too small for source pages. Cannot fit any items.',
            'Could not impose pages: The usable sheet area is too small to fit any source page. Increase the sheet size, reduce margins, or check the source TrimBox.',
        ],
        [
            'vi',
            'trang cụ thể',
            'Trang 7 không thể xếp vào vùng giấy sử dụng.',
            'Không bình được trang: Trang 7 không thể xếp vào vùng giấy sử dụng. Hãy tăng khổ giấy, giảm lề hoặc kiểm tra TrimBox của file nguồn.',
        ],
        [
            'en',
            'trang cụ thể',
            'Trang 7 không thể xếp vào vùng giấy sử dụng.',
            'Could not impose pages: Page 7 cannot fit within the usable sheet area. Increase the sheet size, reduce margins, or check the source TrimBox.',
        ],
    ] as const)(
        'localizes the N-Up %s capacity error (%s)',
        async (language, _caseName, backendError, expectedError) => {
            await i18n.changeLanguage(language);
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
            const context: ProcessContext = {
                file: new File(['source'], 'input.pdf', { type: 'application/pdf' }),
                commitWorkingFile: vi.fn().mockResolvedValue(undefined),
                setError: vi.fn(),
                setIsProcessing: vi.fn(),
                setProcessStatus: vi.fn(),
                setReportMsg: vi.fn(),
                setBatchOutput: vi.fn(),
                getWorkingBytes: vi.fn(),
                getWorkingSourcePath: vi.fn().mockResolvedValue('D:\\input.pdf'),
            };
            api.getNupJobStatus.mockResolvedValueOnce({
                status: 'failed',
                error: backendError,
            });

            try {
                await runProcessEngine(
                    context,
                    {
                        impositionMode: ImpositionMode.NUp,
                        imposerMode: 'guillotine',
                        sheetWidth: 320,
                        sheetHeight: 450,
                        bleed: 0,
                        cols: 2,
                        rows: 2,
                    } as unknown as import('./pdfImposer').ProcessingSettings,
                    false,
                );

                expect(context.setError).toHaveBeenLastCalledWith(expectedError);
                expect(warnSpy).toHaveBeenCalledWith(
                    '[N-Up] Lỗi sức chứa từ backend:',
                    expect.objectContaining({ message: backendError }),
                );
            } finally {
                warnSpy.mockRestore();
                await i18n.changeLanguage('vi');
            }
        },
    );
});


describe('runResize unified dynamic-background pipeline', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
        api.getApiUrl.mockReturnValue('http://api');
        api.uploadPDF.mockResolvedValue({ id: 'upload-1', page_count: 8 });
        api.backendResizePages.mockResolvedValue(
            new Blob(['resized'], { type: 'application/pdf' }),
        );
        api.authenticatedFetch.mockImplementation(async (url: string) => {
            if (url.endsWith('/preflight/auto-trim')) {
                return {
                    ok: true,
                    json: vi.fn().mockResolvedValue({ output_filename: 'trimmed.pdf' }),
                };
            }
            if (url.endsWith('/preflight/download/trimmed.pdf')) {
                return {
                    ok: true,
                    blob: vi.fn().mockResolvedValue(
                        new Blob(['trimmed'], { type: 'application/pdf' }),
                    ),
                };
            }
            throw new Error(`URL test không được xử lý: ${url}`);
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    const resizeSettings = {
        autoTrimBefore: true,
        autoTrimMarginMm: 0,
        applyToStr: 'even',
        targetW: 210,
        targetH: 297,
        targetDpi: 0,
        pageSizeMode: 'fixed',
        scaleMode: 'fit',
        bgFillMode: 'mirror',
        bgFillColor: '#ffffff',
        resizeByContent: false,
        spawnNewTab: false,
    };

    function makeContext(file: File, getWorkingBytes: ProcessContext['getWorkingBytes']): ProcessContext {
        return {
            file,
            commitWorkingFile: vi.fn().mockResolvedValue(undefined),
            setError: vi.fn(),
            setIsProcessing: vi.fn(),
            setProcessStatus: vi.fn(),
            setReportMsg: vi.fn(),
            setBatchOutput: vi.fn(),
            getWorkingBytes,
        };
    }

    it('registers a clean desktop file by path without reading it into V8', async () => {
        const file = new File(['source'], 'clean.pdf', { type: 'application/pdf' });
        Object.defineProperty(file, 'path', { value: 'D:\\clean.pdf' });
        const getWorkingBytes = vi.fn(async () => new Uint8Array());
        const context = makeContext(file, getWorkingBytes);
        context.getWorkingSourcePath = vi.fn().mockResolvedValue('D:\\clean.pdf');

        await runResize(context, resizeSettings);

        expect(api.backendResizePages).toHaveBeenCalledTimes(1);
        expect(api.backendResizePages).toHaveBeenCalledWith(
            file,
            210,
            297,
            'fit',
            'even',
            0,
            'auto',
            'mirror',
            '#ffffff',
            'D:\\clean.pdf',
            'fixed',
            false,
        );
        expect(getWorkingBytes).not.toHaveBeenCalled();
        expect(api.uploadPDF).not.toHaveBeenCalled();
        expect(api.authenticatedFetch).not.toHaveBeenCalled();
        expect(context.commitWorkingFile).toHaveBeenCalled();
    });

    it('keeps the baked-byte upload path when the document is dirty', async () => {
        const file = new File(['source'], 'dirty.pdf', { type: 'application/pdf' });
        const getWorkingBytes = vi.fn(async () => new Uint8Array([1, 2, 3]));
        const context = makeContext(file, getWorkingBytes);
        context.getWorkingSourcePath = vi.fn().mockResolvedValue(undefined);

        await runResize(context, resizeSettings);

        expect(getWorkingBytes).toHaveBeenCalledTimes(1);
        expect(api.backendResizePages).toHaveBeenCalledTimes(1);
        expect(api.backendResizePages).toHaveBeenCalledWith(
            expect.any(File),
            210,
            297,
            'fit',
            'even',
            0,
            'auto',
            'mirror',
            '#ffffff',
            undefined,
            'fixed',
            false,
        );
        expect(api.backendResizePages.mock.calls[0][0]).not.toBe(file);
        expect(api.uploadPDF).not.toHaveBeenCalled();
        expect(api.authenticatedFetch).not.toHaveBeenCalled();
        expect(context.commitWorkingFile).toHaveBeenCalled();
    });

    it.each(['mirror', 'inpaint', 'image'] as const)('sends %s directly to the unified backend job', async (bgFillMode) => {
        const sourceDoc = await PDFDocument.create();
        sourceDoc.addPage([100, 100]);
        const sourceBytes = await sourceDoc.save();
        const file = new File([sourceBytes as BlobPart], 'inpaint.pdf', { type: 'application/pdf' });
        const getWorkingBytes = vi.fn(async () => sourceBytes);
        const context = makeContext(file, getWorkingBytes);
        api.authenticatedFetch.mockImplementation(async (url: string) => {
            if (url.endsWith('/preflight/auto-trim')) {
                return {
                    ok: true,
                    json: vi.fn().mockResolvedValue({ output_filename: 'trimmed.pdf' }),
                };
            }
            if (url.endsWith('/preflight/download/trimmed.pdf')) {
                return {
                    ok: true,
                    blob: vi.fn().mockResolvedValue(
                        new Blob([sourceBytes as BlobPart], { type: 'application/pdf' }),
                    ),
                };
            }
            if (url.endsWith('/pdf-tools/sticker-dieline')) {
                return {
                    ok: true,
                    blob: vi.fn().mockResolvedValue(
                        new Blob(['extended'], { type: 'application/pdf' }),
                    ),
                };
            }
            throw new Error(`URL test không được xử lý: ${url}`);
        });

        await runResize(context, {
            ...resizeSettings,
            autoTrimBefore: true,
            applyToStr: 'all',
            scaleMode: 'center_no_scale',
            bgFillMode,
        });

        expect(api.backendResizePages).toHaveBeenCalledTimes(1);
        expect(api.backendResizePages).toHaveBeenCalledWith(
            expect.any(File),
            210,
            297,
            'center_no_scale',
            'all',
            0,
            'auto',
            bgFillMode,
            '#ffffff',
            undefined,
            'fixed',
            false,
        );
        expect(api.authenticatedFetch).not.toHaveBeenCalled();
        expect(api.uploadPDF).not.toHaveBeenCalled();
        expect(getWorkingBytes).toHaveBeenCalledTimes(1);
        expect(context.commitWorkingFile).toHaveBeenCalled();
    });

    it('keeps the selected background when the legacy auto-trim flag is disabled', async () => {
        const sourceDoc = await PDFDocument.create();
        sourceDoc.addPage([100, 100]);
        const sourceBytes = await sourceDoc.save();
        const file = new File([sourceBytes as BlobPart], 'no-auto-trim.pdf', { type: 'application/pdf' });
        const getWorkingBytes = vi.fn(async () => sourceBytes);
        const context = makeContext(file, getWorkingBytes);

        await runResize(context, {
            ...resizeSettings,
            autoTrimBefore: false,
            applyToStr: 'all',
            scaleMode: 'center_no_scale',
            bgFillMode: 'inpaint',
            bgFillColor: '#ff0000',
        });

        expect(api.authenticatedFetch).not.toHaveBeenCalled();
        expect(api.uploadPDF).not.toHaveBeenCalled();
        expect(api.backendResizePages).toHaveBeenCalledWith(
            expect.any(File),
            210,
            297,
            'center_no_scale',
            'all',
            0,
            'auto',
            'inpaint',
            '#ffffff',
            undefined,
            'fixed',
            false,
        );
        expect(context.setError).toHaveBeenCalledTimes(1);
        expect(context.setError).toHaveBeenCalledWith('');
        expect(context.commitWorkingFile).toHaveBeenCalled();
    });

    it.each(['fill', 'stretch'] as const)(
        'does not run a hidden dynamic background for %s',
        async (scaleMode) => {
            const sourceDoc = await PDFDocument.create();
            sourceDoc.addPage([100, 100]);
            const sourceBytes = await sourceDoc.save();
            const file = new File([sourceBytes as BlobPart], `${scaleMode}.pdf`, {
                type: 'application/pdf',
            });
            const context = makeContext(file, vi.fn(async () => sourceBytes));

            await runResize(context, {
                ...resizeSettings,
                scaleMode,
                targetDpi: 300,
                bgFillMode: 'mirror',
            });

            expect(api.backendResizePages).toHaveBeenCalledWith(
                expect.any(File),
                210,
                297,
                scaleMode,
                'even',
                300,
                'auto',
                'white',
                '#ffffff',
                undefined,
                'fixed',
                false,
            );
            expect(api.uploadPDF).not.toHaveBeenCalled();
            expect(api.authenticatedFetch).not.toHaveBeenCalled();
        },
    );

    it('keeps the selected solid color on the backend path', async () => {
        const sourceDoc = await PDFDocument.create();
        sourceDoc.addPage([100, 100]);
        const sourceBytes = await sourceDoc.save();
        const file = new File([sourceBytes as BlobPart], 'solid.pdf', {
            type: 'application/pdf',
        });
        const context = makeContext(file, vi.fn(async () => sourceBytes));

        await runResize(context, {
            ...resizeSettings,
            scaleMode: 'fit',
            targetDpi: 300,
            bgFillMode: 'solid',
            bgFillColor: '#12a34b',
        });

        expect(api.backendResizePages).toHaveBeenCalledWith(
            expect.any(File),
            210,
            297,
            'fit',
            'even',
            300,
            'auto',
            'solid',
            '#12a34b',
            undefined,
            'fixed',
            false,
        );
        expect(api.uploadPDF).not.toHaveBeenCalled();
        expect(api.authenticatedFetch).not.toHaveBeenCalled();
    });

    it.each([
        ['fixed_width', 80, 120],
        ['fixed_height', 80, 120],
    ] as const)(
        'routes %s through one content-aware backend job and forces fit',
        async (pageSizeMode, targetW, targetH) => {
            const file = new File(['source'], `${pageSizeMode}.pdf`, {
                type: 'application/pdf',
            });
            const getWorkingBytes = vi.fn(async () => new Uint8Array([1, 2, 3]));
            const context = makeContext(file, getWorkingBytes);
            context.getWorkingSourcePath = vi.fn().mockResolvedValue('D:\\ratio.pdf');

            await runResize(context, {
                ...resizeSettings,
                pageSizeMode,
                targetW,
                targetH,
                // State/preset cũ có thể còn mode mâu thuẫn; handler phải phòng thủ.
                scaleMode: 'stretch',
                bgFillMode: 'mirror',
            });

            expect(api.backendResizePages).toHaveBeenCalledTimes(1);
            expect(api.backendResizePages).toHaveBeenCalledWith(
                file,
                targetW,
                targetH,
                'fit',
                'even',
                0,
                'auto',
                'white',
                '#ffffff',
                'D:\\ratio.pdf',
                pageSizeMode,
                false,
            );
            expect(getWorkingBytes).not.toHaveBeenCalled();
            expect(context.commitWorkingFile).toHaveBeenCalled();
        },
    );

    it('routes resize-by-content through backend and forwards the explicit choice', async () => {
        const file = new File(['source'], 'alpha.pdf', { type: 'application/pdf' });
        const context = makeContext(file, vi.fn(async () => new Uint8Array([1, 2, 3])));
        context.getWorkingSourcePath = vi.fn().mockResolvedValue('D:\\alpha.pdf');

        await runResize(context, {
            ...resizeSettings,
            bgFillMode: 'white',
            resizeByContent: true,
        });

        expect(api.backendResizePages).toHaveBeenCalledWith(
            file,
            210,
            297,
            'fit',
            'even',
            0,
            'auto',
            'white',
            '#ffffff',
            'D:\\alpha.pdf',
            'fixed',
            true,
        );
        expect(context.getWorkingBytes).not.toHaveBeenCalled();
    });

    it.each([
        ['dynamic background', { bgFillMode: 'mirror' }],
        ['locked width', { pageSizeMode: 'fixed_width', bgFillMode: 'mirror' }],
        ['regular backend resize', { bgFillMode: 'white', targetDpi: 300 }],
    ] as const)('uses only one waiting message for %s', async (_label, overrides) => {
        const sourceDoc = await PDFDocument.create();
        sourceDoc.addPage([100, 100]);
        const sourceBytes = await sourceDoc.save();
        const file = new File([sourceBytes as BlobPart], 'status.pdf', {
            type: 'application/pdf',
        });
        const context = makeContext(file, vi.fn(async () => sourceBytes));

        await runResize(context, {
            ...resizeSettings,
            ...overrides,
        });

        const statuses = vi.mocked(context.setProcessStatus).mock.calls
            .map(([status]) => status);
        const waitingStatuses = statuses.filter((status) => status !== '');

        expect(waitingStatuses.length).toBeGreaterThanOrEqual(2);
        expect(waitingStatuses.every((status) => status === 'Đang xử lý...')).toBe(true);
        expect(statuses.at(-1)).toBe('');
    });
});
