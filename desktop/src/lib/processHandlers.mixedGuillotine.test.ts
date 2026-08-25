import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImpositionMode, type GuillotineSettings } from './pdfImposer';
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

describe('payload Dàn nhiều kích thước', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
        api.startNupJobBackend.mockResolvedValue('job-mixed');
        api.getNupJobStatus.mockResolvedValue({
            status: 'completed',
            progress: '1/1',
            report: 'ok',
            output_path: 'D:\\results\\mixed.pdf',
        });
        api.downloadNupJob.mockResolvedValue(
            new Blob(['downloaded'], { type: 'application/pdf' }),
        );
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('gửi mode, cạnh lật và giữ quyền xuất tờ mẫu duy nhất', async () => {
        const context: ProcessContext = {
            file: new File(['source'], 'mixed.pdf', { type: 'application/pdf' }),
            commitWorkingFile: vi.fn().mockResolvedValue(undefined),
            setError: vi.fn(),
            setIsProcessing: vi.fn(),
            setProcessStatus: vi.fn(),
            setReportMsg: vi.fn(),
            setBatchOutput: vi.fn(),
            getWorkingBytes: vi.fn(),
            getWorkingSourcePath: vi.fn().mockResolvedValue('D:\\mixed.pdf'),
        };

        const settings: GuillotineSettings & { exportUniqueSheets: boolean } = {
            impositionMode: ImpositionMode.NUp,
            imposerMode: 'guillotine',
            layoutType: 'mixed_guillotine',
            sheetWidth: 320,
            sheetHeight: 450,
            paperThickness: 0,
            bleed: 3,
            alternateRotation: 'column',
            gapX: 2,
            gapY: 2,
            duplexFlow: 'double',
            duplexFlipEdge: 'short',
            exportUniqueSheets: true,
        };

        await runProcessEngine(
            context,
            settings,
            false,
        );

        expect(api.startNupJobBackend).toHaveBeenCalledWith(
            'D:\\mixed.pdf',
            expect.objectContaining({
                layoutType: 'mixed_guillotine',
                alternateRotation: 'none',
                duplexFlow: 'double',
                duplexFlipEdge: 'short',
                exportUniqueSheets: true,
                isDieCutMode: false,
            }),
        );
    });
});
