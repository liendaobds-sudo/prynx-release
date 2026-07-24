import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImpositionMode } from './pdfImposer';
import { runProcessEngine, type ProcessContext } from './processHandlers';

const api = vi.hoisted(() => ({
    uploadFileForNup: vi.fn(),
    startNupJobBackend: vi.fn(),
    getNupJobStatus: vi.fn(),
    downloadNupJob: vi.fn(),
    cancelNupJobBackend: vi.fn(),
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
        expect(commitWorkingFile).toHaveBeenCalledWith(
            expect.any(Blob),
            'Imposed_input_.pdf',
            'D:\\results\\nup_job-1.pdf',
        );
    });
});
