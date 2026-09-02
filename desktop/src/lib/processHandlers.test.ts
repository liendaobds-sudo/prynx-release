import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { ImpositionMode, type DieCutSettings, type GuillotineSettings } from './pdfImposer';
import type { PdfPathMetadata } from './api';
import type { PontConfig } from '../components/imposition-tools/types';
import { readArtifactLeaseToken } from './artifactLease';
import {
    runProcessEngine,
    runResize,
    runShuffle,
    runSplit,
    runTrimShift,
    type ProcessContext,
} from './processHandlers';
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
    backendShufflePages: vi.fn(),
    backendSplitPdf: vi.fn(),
    getPdfPathMetadata: vi.fn(),
    backendTrimShift: vi.fn(),
}));
const saveBlobMock = vi.hoisted(() => vi.fn());
const savePrintFiles = vi.hoisted(() => ({
    savePrintFilesToFolder: vi.fn(),
    pagesPerTypeFor: vi.fn(() => 2),
}));
const ARTIFACT_LEASE_TOKEN = 'a'.repeat(64);

vi.mock('./api', () => api);
vi.mock('./saveBlob', () => ({ saveBlob: saveBlobMock }));
vi.mock('./savePrintFiles', () => savePrintFiles);
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
            artifact_lease: ARTIFACT_LEASE_TOKEN,
        });
        api.downloadNupJob.mockResolvedValue(
            new Blob(['downloaded'], { type: 'application/pdf' }),
        );
        savePrintFiles.savePrintFilesToFolder.mockResolvedValue({ ok: 2 });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    const makeNupContext = (): ProcessContext => ({
        file: new File(['source'], 'sticker.pdf', { type: 'application/pdf' }),
        commitWorkingFile: vi.fn().mockResolvedValue(undefined),
        setError: vi.fn(),
        setIsProcessing: vi.fn(),
        setProcessStatus: vi.fn(),
        setReportMsg: vi.fn(),
        setBatchOutput: vi.fn(),
        getWorkingBytes: vi.fn(),
        getWorkingSourcePath: vi.fn().mockResolvedValue('D:\\sticker.pdf'),
    });

    const makeNupSettings = (extra: Record<string, unknown> = {}) => ({
        impositionMode: ImpositionMode.NUp,
        imposerMode: 'diecut',
        isDieCutMode: true,
        sheetWidth: 320,
        sheetHeight: 450,
        paperThickness: 0,
        bleed: 0,
        ...extra,
    }) as unknown as import('./pdfImposer').ProcessingSettings;

    it('dùng savePrintConfig canonical để tự lưu mà không gửi config local sang backend', async () => {
        const context = makeNupContext();
        await runProcessEngine(context, makeNupSettings({
            savePrintConfig: {
                autoSave: true,
                folder: 'D:\\print',
                nameMode: 'report',
                folderMode: 'per_order',
                includeOrderCode: true,
                includeDate: false,
                orderCode: 'DH-001',
                labelName: 'Tem A',
            },
        }), false);

        expect(api.downloadNupJob).toHaveBeenCalledOnce();
        expect(savePrintFiles.savePrintFilesToFolder).toHaveBeenCalledWith(
            expect.any(Blob),
            'D:\\print',
            expect.objectContaining({ nameMode: 'report', orderCode: 'DH-001' }),
            expect.objectContaining({ labelName: 'Tem A' }),
        );
        const payload = api.startNupJobBackend.mock.calls[0][1];
        expect(payload).not.toHaveProperty('saveByReport');
        expect(payload).not.toHaveProperty('autoSavePrint');
        expect(payload).not.toHaveProperty('savePrintConfig');
    });

    it('canonical autoSave=false thắng alias autoSavePrint=true', async () => {
        await runProcessEngine(makeNupContext(), makeNupSettings({
            autoSavePrint: true,
            savePrintConfig: {
                autoSave: false,
                folder: 'D:\\print',
                nameMode: 'number',
                folderMode: 'flat',
                includeOrderCode: false,
                includeDate: false,
            },
        }), false);

        expect(api.downloadNupJob).not.toHaveBeenCalled();
        expect(savePrintFiles.savePrintFilesToFolder).not.toHaveBeenCalled();
    });

    it('giữ fallback autoSavePrint cho caller legacy thiếu autoSave trong config', async () => {
        await runProcessEngine(makeNupContext(), makeNupSettings({
            autoSavePrint: true,
            savePrintConfig: {
                folder: 'D:\\legacy-print',
                nameMode: 'original',
                folderMode: 'flat',
                includeOrderCode: false,
                includeDate: true,
            },
        }), false);

        expect(savePrintFiles.savePrintFilesToFolder).toHaveBeenCalledWith(
            expect.any(Blob),
            'D:\\legacy-print',
            expect.any(Object),
            expect.any(Object),
        );
    });

    it('saveByReport stale không bật lưu và không đi vào backend', async () => {
        await runProcessEngine(makeNupContext(), makeNupSettings({
            saveByReport: true,
        }), false);

        expect(savePrintFiles.savePrintFilesToFolder).not.toHaveBeenCalled();
        expect(api.startNupJobBackend.mock.calls[0][1]).not.toHaveProperty('saveByReport');
    });

    it('autoSave canonical với folder chỉ có khoảng trắng vẫn không ghi file', async () => {
        await runProcessEngine(makeNupContext(), makeNupSettings({
            savePrintConfig: {
                autoSave: true,
                folder: '   ',
                nameMode: 'report',
                folderMode: 'per_order',
                includeOrderCode: true,
                includeDate: false,
            },
        }), false);

        expect(api.downloadNupJob).not.toHaveBeenCalled();
        expect(savePrintFiles.savePrintFilesToFolder).not.toHaveBeenCalled();
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

        const settings = {
                impositionMode: ImpositionMode.NUp,
                imposerMode: 'guillotine',
                pageSheetMode: true,
                sheetWidth: 320,
                sheetHeight: 450,
                paperThickness: 0,
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
            } satisfies GuillotineSettings & {
                cutType: 'one_dao';
                pontType: 'corner';
                pontConfig: { shape: 'l_corner'; size: number };
                pontsOnCutFile: boolean;
                separateCutPage: boolean;
                exportUniqueSheets: boolean;
        };
        await runProcessEngine(context, settings, false);

        const payload = api.startNupJobBackend.mock.calls[0][1];
        expect(payload).toMatchObject({
            page_sheet_mode: true,
            isDieCutMode: false,
            alternateRotation: 'none',
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

        const settings = {
                impositionMode: ImpositionMode.NUp,
                imposerMode: 'cnc',
                isDieCutMode: true,
                sheetWidth: 320,
                sheetHeight: 450,
                paperThickness: 0,
                bleed: 0,
                pontType: 'custom',
                pontConfig: {
                    shape: 'circle',
                    size: 5,
                    thickness: 0.5,
                    layerName: 'Marks_Model_',
                    groupName: 'MarkLine',
                    itemName: 'MKLINE',
                    marginTop: 0,
                    marginBottom: 0,
                    marginLeft: 0,
                    marginRight: 0,
                    guide1Enabled: false,
                    guide1Pos: 'TL',
                    guide1Length: 10,
                    guide1Thickness: 0.3,
                    guide1OffX: 0,
                    guide1OffY: 0,
                    guide2Enabled: false,
                    guide2Pos: 'BR',
                    guide2Length: 10,
                    guide2Thickness: 0.3,
                    guide2OffX: 0,
                    guide2OffY: 0,
                    disableCollision: false,
                },
                pontsOnCutFile: false,
                cncTwoSided: false,
                groupingStrategy: 'free_gang',
        } satisfies Omit<DieCutSettings, 'pontConfig'> & { pontConfig: PontConfig };
        await runProcessEngine(context, settings, false);

        const payload = api.startNupJobBackend.mock.calls[0][1];
        expect(payload.imposerMode).toBe('cnc');
        expect(payload.groupingStrategy).toBe('free_gang');
        expect(payload.pontConfig.itemName).toBe('MKLINE');
        expect(payload.exportUniqueSheets).toBe(true);
        expect(payload).not.toHaveProperty('pontsOnCutFile');
    });

    it.each([
        ['tem chữ nhật', { 0: 'RECTANGLE', 1: 'RECTANGLE' }, 'row'],
        ['tem có hình khác', { 0: 'RECTANGLE', 1: 'CIRCLE_ELLIPSE' }, 'none'],
    ] as const)('khóa Inking đúng cho %s khi xuất PDF', async (_label, detectedShapesByPage, expected) => {
        const context: ProcessContext = {
            file: new File(['source'], 'sticker.pdf', { type: 'application/pdf' }),
            commitWorkingFile: vi.fn().mockResolvedValue(undefined),
            setError: vi.fn(),
            setIsProcessing: vi.fn(),
            setProcessStatus: vi.fn(),
            setReportMsg: vi.fn(),
            setBatchOutput: vi.fn(),
            getWorkingBytes: vi.fn(),
            getWorkingSourcePath: vi.fn().mockResolvedValue('D:\\sticker.pdf'),
        };

        await runProcessEngine(
            context,
            {
                impositionMode: ImpositionMode.NUp,
                imposerMode: 'diecut',
                isDieCutMode: true,
                sheetWidth: 320,
                sheetHeight: 450,
                paperThickness: 0,
                bleed: 0,
                alternateRotation: 'row',
                detectedShapesByPage,
            } satisfies DieCutSettings,
            false,
        );

        expect(api.startNupJobBackend.mock.calls[0][1]).toMatchObject({
            alternateRotation: expected,
            detectedShapesByPage,
        });
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
                alternateRotation: 'row',
                cutBorderEnabled: true,
                cutBorderPosition: 'bleed',
                cutBorderColor: '#12A34B',
                cutBorderThickness: 0.6,
                diagnosticTraceId: 'sr-test-ui',
                diagnosticPreviewRequestId: 'sr-test-ui-p3',
                diagnosticPendingRequestId: 'sr-test-ui-p4',
                diagnosticPreviewCapacity: 16,
                diagnosticPreviewState: 'pending',
                forceLegacyGrid: true,
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
            alternateRotation: 'row',
            cutBorderEnabled: true,
            cutBorderPosition: 'bleed',
            cutBorderColor: '#12A34B',
            cutBorderThickness: 0.6,
            diagnosticTraceId: 'sr-test-ui',
            diagnosticPreviewRequestId: 'sr-test-ui-p3',
            diagnosticPendingRequestId: 'sr-test-ui-p4',
            diagnosticPreviewCapacity: 16,
            diagnosticPreviewState: 'pending',
            forceLegacyGrid: true,
        });
        expect(commitWorkingFile).toHaveBeenCalledWith(
            expect.any(Blob),
            'Imposed_input_.pdf',
            'D:\\results\\nup_job-1.pdf',
        );
        const committedBlob = commitWorkingFile.mock.calls[0]?.[0] as Blob;
        expect(readArtifactLeaseToken(committedBlob)).toBe(ARTIFACT_LEASE_TOKEN);
    });

    it('gắn lease token lên File khi Bình tem bế mở tab mới', async () => {
        const onSpawnTab = vi.fn();
        const context: ProcessContext = {
            file: new File(['source'], 'sticker.pdf', { type: 'application/pdf' }),
            onSpawnTab,
            commitWorkingFile: vi.fn().mockResolvedValue(undefined),
            setError: vi.fn(),
            setIsProcessing: vi.fn(),
            setProcessStatus: vi.fn(),
            setReportMsg: vi.fn(),
            setBatchOutput: vi.fn(),
            getWorkingBytes: vi.fn(),
            getWorkingSourcePath: vi.fn().mockResolvedValue('D:\\sticker.pdf'),
        };

        await runProcessEngine(
            context,
            {
                impositionMode: ImpositionMode.NUp,
                imposerMode: 'diecut',
                isDieCutMode: true,
                sheetWidth: 320,
                sheetHeight: 450,
                paperThickness: 0,
                bleed: 0,
            } satisfies DieCutSettings,
            true,
        );

        expect(context.commitWorkingFile).not.toHaveBeenCalled();
        expect(onSpawnTab).toHaveBeenCalledOnce();
        const outputFile = onSpawnTab.mock.calls[0]?.[0] as File;
        expect(readArtifactLeaseToken(outputFile)).toBe(ARTIFACT_LEASE_TOKEN);
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

    it('trả canceled, không commit và không báo lỗi khi backend xác nhận đã hủy', async () => {
        api.getNupJobStatus.mockResolvedValueOnce({
            status: 'cancelled',
            progress: '0/1',
        });
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

        const outcome = await runProcessEngine(
            context,
            {
                impositionMode: ImpositionMode.NUp,
                imposerMode: 'guillotine',
                sheetWidth: 320,
                sheetHeight: 450,
                bleed: 0,
            } as unknown as import('./pdfImposer').ProcessingSettings,
            false,
        );

        expect(outcome).toEqual({ status: 'canceled' });
        expect(context.commitWorkingFile).not.toHaveBeenCalled();
        expect(context.setError).toHaveBeenCalledTimes(1);
        expect(context.setError).toHaveBeenCalledWith('');
    });
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

    it('commits a native Resize result by path without materializing its bytes', async () => {
        const file = new File(['source'], 'clean.pdf', { type: 'application/pdf' });
        const context = makeContext(file, vi.fn(async () => new Uint8Array()));
        context.getWorkingSourcePath = vi.fn().mockResolvedValue('D:\\clean.pdf');
        const result = new Blob([], { type: 'application/pdf' });
        Object.defineProperties(result, {
            path: { value: 'D:\\results\\resized.pdf' },
            nativeSize: { value: 8_900_000 },
        });
        api.backendResizePages.mockResolvedValueOnce(result);

        await runResize(context, resizeSettings);

        expect(context.commitWorkingFile).toHaveBeenCalledWith(
            result,
            'Resized_clean.pdf',
            'D:\\results\\resized.pdf',
        );
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

    it('fail-closed khi không materialize được Working PDF, không fallback file gốc', async () => {
        const file = new File(['source'], 'stale-backing.pdf', { type: 'application/pdf' });
        const getWorkingBytes = vi.fn(async () => {
            throw new Error('materialize revision failed');
        });
        const context = makeContext(file, getWorkingBytes);
        context.getWorkingSourcePath = vi.fn().mockResolvedValue(undefined);

        const outcome = await runResize(context, {
            ...resizeSettings,
            bgFillMode: 'white',
            targetDpi: 0,
        });

        expect(outcome).toMatchObject({ status: 'error' });
        expect(getWorkingBytes).toHaveBeenCalledTimes(1);
        expect(api.backendResizePages).not.toHaveBeenCalled();
        expect(context.commitWorkingFile).not.toHaveBeenCalled();
        expect(context.setError).toHaveBeenLastCalledWith(
            expect.stringContaining('Không thể tạo PDF làm việc từ thứ tự hoặc góc xoay trang hiện tại.'),
        );
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
                // State cũ có thể còn bật dù khối nền không hiển thị với Fill/Stretch.
                resizeByContent: true,
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

    // RESIZE (audit 2026-08-06 §G.3): nhánh nền động/khóa trục/theo nội dung phải
    // dùng chung heuristic downsample với nhánh thường, nếu không A1→A5 vẫn ~300MB.
    it('applies the 300 DPI auto downsample heuristic on the unified backend job', async () => {
        const sourceDoc = await PDFDocument.create();
        sourceDoc.addPage([1684, 2384]);   // A1 pt — thu về A4 là thu nhỏ rõ rệt
        const sourceBytes = await sourceDoc.save();
        const file = new File([sourceBytes as BlobPart], 'a1.pdf', { type: 'application/pdf' });
        const getWorkingBytes = vi.fn(async () => sourceBytes);
        const context = makeContext(file, getWorkingBytes);

        await runResize(context, {
            ...resizeSettings,
            applyToStr: 'all',
            targetDpi: undefined,        // 'auto'
            bgFillMode: 'mirror',
        });

        expect(api.backendResizePages).toHaveBeenCalledTimes(1);
        expect(api.backendResizePages.mock.calls[0][5]).toBe(300);
        expect(getWorkingBytes).toHaveBeenCalledTimes(1);
    });

    it('does not parse a backend-upload PDF above the frontend probe limit', async () => {
        const sourceDoc = await PDFDocument.create();
        sourceDoc.addPage([1684, 2384]);
        const sourceBytes = await sourceDoc.save();
        const file = new File([sourceBytes as BlobPart], 'large-a1.pdf', {
            type: 'application/pdf',
        });
        Object.defineProperty(file, 'size', { value: 51 * 1024 * 1024 });
        const getWorkingBytes = vi.fn(async () => sourceBytes);
        const context = makeContext(file, getWorkingBytes);

        await runResize(context, {
            ...resizeSettings,
            applyToStr: 'all',
            targetDpi: undefined,
            bgFillMode: 'mirror',
        });

        expect(api.backendResizePages).toHaveBeenCalledTimes(1);
        expect(api.backendResizePages.mock.calls[0][5]).toBe(0);
        expect(getWorkingBytes).toHaveBeenCalledTimes(1);
    });

    it('keeps auto downsample off when the target is not smaller', async () => {
        const sourceDoc = await PDFDocument.create();
        sourceDoc.addPage([595, 842]);    // A4 → A4: không thu nhỏ
        const sourceBytes = await sourceDoc.save();
        const file = new File([sourceBytes as BlobPart], 'a4.pdf', { type: 'application/pdf' });
        const context = makeContext(file, vi.fn(async () => sourceBytes));

        await runResize(context, {
            ...resizeSettings,
            applyToStr: 'all',
            targetDpi: undefined,
            bgFillMode: 'mirror',
        });

        expect(api.backendResizePages.mock.calls[0][5]).toBe(0);
    });

    it('respects an explicit DPI choice over the heuristic', async () => {
        const sourceDoc = await PDFDocument.create();
        sourceDoc.addPage([1684, 2384]);
        const sourceBytes = await sourceDoc.save();
        const file = new File([sourceBytes as BlobPart], 'a1.pdf', { type: 'application/pdf' });
        const context = makeContext(file, vi.fn(async () => sourceBytes));

        await runResize(context, {
            ...resizeSettings,
            applyToStr: 'all',
            targetDpi: 150,
            bgFillMode: 'mirror',
        });

        expect(api.backendResizePages.mock.calls[0][5]).toBe(150);
    });

    // RESIZE (audit 2026-08-06 §G.4): màu nền trơn người dùng chọn phải sang backend.
    it('forwards the chosen solid colour on the resize-by-content branch', async () => {
        const sourceDoc = await PDFDocument.create();
        sourceDoc.addPage([595, 842]);
        const sourceBytes = await sourceDoc.save();
        const file = new File([sourceBytes as BlobPart], 'solid.pdf', { type: 'application/pdf' });
        const context = makeContext(file, vi.fn(async () => sourceBytes));

        await runResize(context, {
            ...resizeSettings,
            applyToStr: 'all',
            bgFillMode: 'solid',
            bgFillColor: '#ff8800',
            resizeByContent: true,
        });

        expect(api.backendResizePages).toHaveBeenCalledTimes(1);
        expect(api.backendResizePages.mock.calls[0][7]).toBe('solid');
        expect(api.backendResizePages.mock.calls[0][8]).toBe('#ff8800');
    });

    it('still forces white on the locked-axis branch even with a solid colour in state', async () => {
        const file = new File(['source'], 'locked.pdf', { type: 'application/pdf' });
        const context = makeContext(file, vi.fn(async () => new Uint8Array([1, 2, 3])));
        context.getWorkingSourcePath = vi.fn().mockResolvedValue('D:\\locked.pdf');

        await runResize(context, {
            ...resizeSettings,
            pageSizeMode: 'fixed_width',
            bgFillMode: 'solid',
            bgFillColor: '#ff8800',
        });

        expect(api.backendResizePages.mock.calls[0][7]).toBe('white');
        expect(api.backendResizePages.mock.calls[0][8]).toBe('#ffffff');
    });
});

describe('processHandlers — chỉ hoàn tất sau khi working file đã commit', () => {
    function deferredCommitContext(bytes: Uint8Array) {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const context: ProcessContext = {
            file: new File([bytes as BlobPart], 'input.pdf', { type: 'application/pdf' }),
            commitWorkingFile: vi.fn(() => gate),
            setError: vi.fn(),
            setIsProcessing: vi.fn(),
            setProcessStatus: vi.fn(),
            setReportMsg: vi.fn(),
            setBatchOutput: vi.fn(),
            getWorkingBytes: vi.fn(async () => bytes),
        };
        return { context, release };
    }

    it('TrimShift chờ commit resolve rồi mới trả completed', async () => {
        const doc = await PDFDocument.create();
        doc.addPage([100, 100]);
        const bytes = await doc.save();
        api.backendTrimShift.mockResolvedValueOnce(
            new Blob([bytes as BlobPart], { type: 'application/pdf' }),
        );
        const { context, release } = deferredCommitContext(bytes);

        const pending = runTrimShift(context, {
            unit: 'mm',
            applyToStr: 'all',
            spawnNewTab: false,
        });
        await vi.waitFor(() => expect(context.commitWorkingFile).toHaveBeenCalledOnce());
        let settled = false;
        void pending.then(() => { settled = true; });
        await Promise.resolve();
        expect(settled).toBe(false);

        release();
        await expect(pending).resolves.toEqual({ status: 'completed' });
    });

    it('Split nhỏ chờ commit resolve rồi mới trả completed', async () => {
        const doc = await PDFDocument.create();
        doc.addPage([100, 100]);
        doc.addPage([100, 100]);
        const bytes = await doc.save();
        const { context, release } = deferredCommitContext(bytes);

        const pending = runSplit(context, {
            mode: 'extract_pages',
            pageListStr: '1',
            spawnNewTab: false,
        });
        await vi.waitFor(() => expect(context.commitWorkingFile).toHaveBeenCalledOnce());
        let settled = false;
        void pending.then(() => { settled = true; });
        await Promise.resolve();
        expect(settled).toBe(false);

        release();
        await expect(pending).resolves.toEqual({ status: 'completed' });
    });

    it('TrimShift chuẩn hóa AbortError thành canceled và không commit', async () => {
        const doc = await PDFDocument.create();
        doc.addPage([100, 100]);
        const bytes = await doc.save();
        api.backendTrimShift.mockRejectedValueOnce(
            new DOMException('Đã hủy', 'AbortError'),
        );
        const context: ProcessContext = {
            file: new File([bytes as BlobPart], 'input.pdf', { type: 'application/pdf' }),
            commitWorkingFile: vi.fn(),
            setError: vi.fn(),
            setIsProcessing: vi.fn(),
            setProcessStatus: vi.fn(),
            setReportMsg: vi.fn(),
            setBatchOutput: vi.fn(),
            getWorkingBytes: vi.fn(async () => bytes),
        };

        const outcome = await runTrimShift(context, {
            unit: 'mm',
            applyToStr: 'all',
            spawnNewTab: false,
        });

        expect(outcome).toEqual({ status: 'canceled' });
        expect(context.commitWorkingFile).not.toHaveBeenCalled();
        expect(context.setError).toHaveBeenCalledTimes(1);
        expect(context.setError).toHaveBeenCalledWith('');
    });
});

describe('processHandlers — native path PDF lớn không nạp vào WebView', () => {
    const nativePath = 'D:\\jobs\\large.pdf';

    function largePathContext(): ProcessContext {
        const file = new File([], 'large.pdf', { type: 'application/pdf' });
        Object.defineProperty(file, 'path', { value: nativePath, configurable: true });
        Object.defineProperty(file, 'size', {
            value: 500 * 1024 * 1024,
            configurable: true,
        });
        return {
            file,
            commitWorkingFile: vi.fn().mockResolvedValue(undefined),
            setError: vi.fn(),
            setIsProcessing: vi.fn(),
            setProcessStatus: vi.fn(),
            setReportMsg: vi.fn(),
            setBatchOutput: vi.fn(),
            getWorkingBytes: vi.fn(async () => {
                throw new Error('Không được đọc PDF path lớn vào V8');
            }),
            getWorkingSourcePath: vi.fn().mockResolvedValue(nativePath),
        };
    }

    beforeEach(() => {
        vi.clearAllMocks();
        api.getPdfPathMetadata.mockResolvedValue({
            page_count: 8,
            pages: [{ width_pt: 1684, height_pt: 2384, rotation: 0 }],
        });
        api.backendResizePages.mockResolvedValue(
            new Blob(['resized'], { type: 'application/pdf' }),
        );
        api.backendShufflePages.mockResolvedValue(
            new Blob(['shuffled'], { type: 'application/pdf' }),
        );
        api.backendSplitPdf.mockResolvedValue(
            {
                kind: 'pdf',
                filename: 'large_extracted.pdf',
                blob: new Blob(['split'], { type: 'application/pdf' }),
            },
        );
        saveBlobMock.mockResolvedValue({ kind: 'saved' });
    });

    it('Resize thường lấy metadata nhẹ rồi chuyển native path thẳng sang backend', async () => {
        const context = largePathContext();

        const outcome = await runResize(context, {
            targetW: 210,
            targetH: 297,
            targetDpi: undefined,
            pageSizeMode: 'fixed',
            resizeMode: 'auto',
            scaleMode: 'fit',
            bgFillMode: 'white',
            applyToStr: 'all',
            spawnNewTab: false,
        });

        expect(outcome).toEqual({ status: 'completed' });
        expect(context.getWorkingBytes).not.toHaveBeenCalled();
        expect(api.getPdfPathMetadata).toHaveBeenCalledWith(nativePath);
        expect(api.backendResizePages).toHaveBeenCalledWith(
            context.file,
            210,
            297,
            'fit',
            'all',
            300,
            'auto',
            'white',
            '#ffffff',
            nativePath,
            'fixed',
            false,
        );
    });

    it('Shuffle reverse file lớn dùng native path mà không quét metadata', async () => {
        const context = largePathContext();

        const outcome = await runShuffle(context, {
            presetId: 'special',
            specialAction: 'reverse',
            spawnNewTab: false,
        });

        expect(outcome).toEqual({ status: 'completed' });
        expect(context.getWorkingBytes).not.toHaveBeenCalled();
        expect(api.getPdfPathMetadata).not.toHaveBeenCalled();
        expect(api.backendShufflePages).toHaveBeenCalledWith(
            context.file,
            'reverse',
            [],
            nativePath,
        );
    });

    it('Shuffle tách lẻ/chẵn tạo hai output qua path mà không đọc input bytes', async () => {
        const context = largePathContext();
        context.onSpawnTab = vi.fn();

        const outcome = await runShuffle(context, {
            presetId: 'special',
            specialAction: 'split_odd_even',
            spawnNewTab: false,
        });

        expect(outcome).toEqual({ status: 'completed' });
        expect(context.getWorkingBytes).not.toHaveBeenCalled();
        expect(api.backendShufflePages).toHaveBeenNthCalledWith(
            1,
            context.file,
            'custom',
            [1, 3, 5, 7],
            nativePath,
        );
        expect(api.backendShufflePages).toHaveBeenNthCalledWith(
            2,
            context.file,
            'custom',
            [2, 4, 6, 8],
            nativePath,
        );
        expect(context.onSpawnTab).toHaveBeenCalledTimes(2);
    });

    it('metadata path lỗi thì fail-closed, tuyệt đối không fallback đọc bytes', async () => {
        const context = largePathContext();
        api.getPdfPathMetadata.mockRejectedValueOnce(new Error('metadata unavailable'));

        const outcome = await runShuffle(context, {
            presetId: 'custom',
            rule: '1-N',
            groupSize: 1,
            spawnNewTab: false,
        });

        expect(outcome).toMatchObject({ status: 'error' });
        expect(context.getWorkingBytes).not.toHaveBeenCalled();
        expect(api.backendShufflePages).not.toHaveBeenCalled();
    });

    it('Resize path nhỏ nhưng DPI dương vẫn đi backend trước khi đọc bytes', async () => {
        const context = largePathContext();
        Object.defineProperty(context.file, 'size', {
            value: 10 * 1024 * 1024,
            configurable: true,
        });

        await runResize(context, {
            targetW: 210,
            targetH: 297,
            targetDpi: 300,
            pageSizeMode: 'fixed',
            resizeMode: 'auto',
            scaleMode: 'fit',
            bgFillMode: 'white',
            applyToStr: 'all',
            spawnNewTab: false,
        });

        expect(context.getWorkingBytes).not.toHaveBeenCalled();
        expect(api.backendResizePages.mock.calls[0][9]).toBe(nativePath);
        expect(api.getPdfPathMetadata).not.toHaveBeenCalled();
    });

    it('Shuffle path nhỏ nhưng trên 1.000 trang vẫn không nạp bytes', async () => {
        const context = largePathContext();
        Object.defineProperty(context.file, 'size', {
            value: 10 * 1024 * 1024,
            configurable: true,
        });
        api.getPdfPathMetadata.mockResolvedValueOnce({ page_count: 1001, pages: [] });

        await runShuffle(context, {
            presetId: 'special',
            specialAction: 'reverse',
            spawnNewTab: false,
        });

        expect(context.getWorkingBytes).not.toHaveBeenCalled();
        expect(api.backendShufflePages.mock.calls[0][3]).toBe(nativePath);
    });

    it('Split path nhỏ nhưng trên 1.000 trang vẫn không nạp bytes', async () => {
        const context = largePathContext();
        Object.defineProperty(context.file, 'size', {
            value: 10 * 1024 * 1024,
            configurable: true,
        });
        api.getPdfPathMetadata.mockResolvedValueOnce({ page_count: 1001, pages: [] });

        await runSplit(context, {
            mode: 'extract_pages',
            pageListStr: '1',
            spawnNewTab: false,
        });

        expect(context.getWorkingBytes).not.toHaveBeenCalled();
        expect(api.backendSplitPdf.mock.calls[0][3]).toBe(nativePath);
    });

    it('Split chuyển native path thẳng sang backend mà không mở pdf-lib', async () => {
        const context = largePathContext();

        const outcome = await runSplit(context, {
            mode: 'by_count',
            pagesPerFile: 4,
            spawnNewTab: false,
        });

        expect(outcome).toEqual({ status: 'completed' });
        expect(context.getWorkingBytes).not.toHaveBeenCalled();
        expect(api.backendSplitPdf).toHaveBeenCalledWith(
            context.file,
            'by_count',
            expect.objectContaining({ pagesPerFile: 4 }),
            nativePath,
        );
    });

    it('Split nhiều output lưu ZIP, tuyệt đối không commit hoặc mở ZIP như PDF', async () => {
        const context = largePathContext();
        context.onSpawnTab = vi.fn();
        const zipBlob = new Blob(['zip'], { type: 'application/zip' });
        api.backendSplitPdf.mockResolvedValueOnce({
            kind: 'zip',
            filename: 'large_split.zip',
            blob: zipBlob,
        });

        const outcome = await runSplit(context, {
            mode: 'by_count',
            pagesPerFile: 4,
            spawnNewTab: true,
        });

        expect(outcome).toEqual({ status: 'completed' });
        expect(saveBlobMock).toHaveBeenCalledWith(zipBlob, 'large_split.zip', {
            title: expect.any(String),
            filterName: 'ZIP',
            extensions: ['zip'],
        });
        expect(context.commitWorkingFile).not.toHaveBeenCalled();
        expect(context.onSpawnTab).not.toHaveBeenCalled();
    });

    it('Split nhỏ nhiều output không còn âm thầm chỉ commit file đầu', async () => {
        const source = await PDFDocument.create();
        source.addPage([100, 100]);
        source.addPage([100, 100]);
        const bytes = await source.save();
        const context: ProcessContext = {
            file: new File([bytes as BlobPart], 'small.pdf', { type: 'application/pdf' }),
            commitWorkingFile: vi.fn().mockResolvedValue(undefined),
            setError: vi.fn(),
            setIsProcessing: vi.fn(),
            setProcessStatus: vi.fn(),
            setReportMsg: vi.fn(),
            setBatchOutput: vi.fn(),
            getWorkingBytes: vi.fn(async () => bytes),
        };
        const zipBlob = new Blob(['zip'], { type: 'application/zip' });
        api.backendSplitPdf.mockResolvedValueOnce({
            kind: 'zip',
            filename: 'small_split.zip',
            blob: zipBlob,
        });

        const outcome = await runSplit(context, {
            mode: 'by_count',
            pagesPerFile: 1,
            spawnNewTab: false,
        });

        expect(outcome).toEqual({ status: 'completed' });
        expect(api.backendSplitPdf).toHaveBeenCalledOnce();
        expect(saveBlobMock).toHaveBeenCalledWith(zipBlob, 'small_split.zip', expect.any(Object));
        expect(context.commitWorkingFile).not.toHaveBeenCalled();
    });

    it('Split native path nhỏ lưu nhiều output không đọc input vào WebView', async () => {
        const context = largePathContext();
        Object.defineProperty(context.file, 'size', {
            value: 10 * 1024 * 1024,
            configurable: true,
        });
        api.backendSplitPdf.mockResolvedValueOnce({
            kind: 'zip',
            filename: 'small_path_split.zip',
            blob: new Blob(['zip'], { type: 'application/zip' }),
        });

        const outcome = await runSplit(context, {
            mode: 'by_count',
            pagesPerFile: 3.8,
            spawnNewTab: false,
        });

        expect(outcome).toEqual({ status: 'completed' });
        expect(context.getWorkingBytes).not.toHaveBeenCalled();
        expect(api.getPdfPathMetadata).not.toHaveBeenCalled();
        expect(api.backendSplitPdf).toHaveBeenCalledWith(
            context.file,
            'by_count',
            expect.objectContaining({ pagesPerFile: 3 }),
            nativePath,
        );
    });

    it('Split nhỏ nhiều output vẫn mở đủ tab khi người dùng chọn mở tab mới', async () => {
        const source = await PDFDocument.create();
        source.addPage([100, 100]);
        source.addPage([100, 100]);
        const bytes = await source.save();
        const context: ProcessContext = {
            file: new File([bytes as BlobPart], 'small.pdf', { type: 'application/pdf' }),
            onSpawnTab: vi.fn(),
            commitWorkingFile: vi.fn().mockResolvedValue(undefined),
            setError: vi.fn(),
            setIsProcessing: vi.fn(),
            setProcessStatus: vi.fn(),
            setReportMsg: vi.fn(),
            setBatchOutput: vi.fn(),
            getWorkingBytes: vi.fn(async () => bytes),
        };

        const outcome = await runSplit(context, {
            mode: 'by_count',
            pagesPerFile: 1,
            spawnNewTab: true,
        });

        expect(outcome).toEqual({ status: 'completed' });
        expect(api.backendSplitPdf).not.toHaveBeenCalled();
        expect(context.onSpawnTab).toHaveBeenCalledTimes(2);
        expect(context.commitWorkingFile).not.toHaveBeenCalled();
    });

    it('hủy hộp thoại lưu ZIP trả canceled và không thay working file', async () => {
        const context = largePathContext();
        api.backendSplitPdf.mockResolvedValueOnce({
            kind: 'zip',
            filename: 'large_split.zip',
            blob: new Blob(['zip'], { type: 'application/zip' }),
        });
        saveBlobMock.mockResolvedValueOnce({ kind: 'cancelled' });

        const outcome = await runSplit(context, {
            mode: 'by_count',
            pagesPerFile: 4,
            spawnNewTab: false,
        });

        expect(outcome).toEqual({ status: 'canceled' });
        expect(context.commitWorkingFile).not.toHaveBeenCalled();
    });

    it('extract_pages nhận ZIP trái hợp đồng thì fail-closed, không lưu rồi đi tiếp', async () => {
        const context = largePathContext();
        api.backendSplitPdf.mockResolvedValueOnce({
            kind: 'zip',
            filename: 'unexpected.zip',
            blob: new Blob(['zip'], { type: 'application/zip' }),
        });

        const outcome = await runSplit(context, {
            mode: 'extract_pages',
            pageListStr: '1',
            spawnNewTab: false,
        });

        expect(outcome).toMatchObject({ status: 'error' });
        expect(saveBlobMock).not.toHaveBeenCalled();
        expect(context.commitWorkingFile).not.toHaveBeenCalled();
        expect(context.setError).toHaveBeenLastCalledWith(expect.stringContaining('ZIP'));
    });

    it('carrier native path size=0 vẫn giữ Resize/Shuffle/Split ngoài V8', async () => {
        api.getPdfPathMetadata.mockResolvedValue({
            page_count: 8,
            pages: [{
                width_pt: 595.28,
                height_pt: 841.89,
                media_width_pt: 1684,
                media_height_pt: 2384,
                rotation: 0,
            }],
        } satisfies PdfPathMetadata);
        const unknownSize = () => {
            const context = largePathContext();
            Object.defineProperty(context.file, 'size', { value: 0, configurable: true });
            return context;
        };

        const resize = unknownSize();
        const resizeOutcome = await runResize(resize, {
            targetW: 210,
            targetH: 297,
            targetDpi: undefined,
            pageSizeMode: 'fixed',
            resizeMode: 'auto',
            scaleMode: 'fit',
            bgFillMode: 'white',
            applyToStr: 'all',
            spawnNewTab: false,
        });
        expect(resizeOutcome).toEqual({ status: 'completed' });
        expect(resize.getWorkingBytes).not.toHaveBeenCalled();
        expect(api.backendResizePages.mock.calls.at(-1)?.[5]).toBe(300);

        const shuffle = unknownSize();
        const shuffleOutcome = await runShuffle(shuffle, {
            presetId: 'special',
            specialAction: 'reverse',
            spawnNewTab: false,
        });
        expect(shuffleOutcome).toEqual({ status: 'completed' });
        expect(shuffle.getWorkingBytes).not.toHaveBeenCalled();

        const split = unknownSize();
        const splitOutcome = await runSplit(split, {
            mode: 'extract_pages',
            pageListStr: '1',
            spawnNewTab: false,
        });
        expect(splitOutcome).toEqual({ status: 'completed' });
        expect(split.getWorkingBytes).not.toHaveBeenCalled();
    });

    it('tách lẻ/chẵn giao đồng thời hai job cho scheduler tự điều tiết', async () => {
        const context = largePathContext();
        context.onSpawnTab = vi.fn();
        let releaseFirst!: (blob: Blob) => void;
        const firstGate = new Promise<Blob>((resolve) => { releaseFirst = resolve; });
        api.backendShufflePages
            .mockImplementationOnce(() => firstGate)
            .mockResolvedValueOnce(new Blob(['even'], { type: 'application/pdf' }));

        const pending = runShuffle(context, {
            presetId: 'special',
            specialAction: 'split_odd_even',
            spawnNewTab: false,
        });
        await vi.waitFor(() => expect(api.backendShufflePages).toHaveBeenCalled());

        let assertionError: unknown;
        try {
            expect(api.backendShufflePages).toHaveBeenCalledTimes(2);
        } catch (error) {
            assertionError = error;
        }
        releaseFirst(new Blob(['odd'], { type: 'application/pdf' }));
        await pending;
        if (assertionError) throw assertionError;
    });
});
