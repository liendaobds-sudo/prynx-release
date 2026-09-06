import { beforeEach, describe, it, expect, vi } from 'vitest';
import {
    inspectStickerSourceManifest, detectStickerSourceManifest, previewStickerCutline,
    confirmStickerSource, exportStickerSheet, closeStickerSheetSession,
    type StickerSourceDetection, type StickerSourceInspection,
} from '../stickerSheetApi';
import type { ProcessContext } from '../processHandlers';
import { makeUnifiedStickerRecipe, runUnifiedStickerRecipe } from './unifiedStickerRecipe';
import { useStickerSheetStore } from '../../components/preprocess-tools/stickerSheetStore';

vi.mock('../stickerSheetApi', async original => ({
    ...await original<typeof import('../stickerSheetApi')>(),
    inspectStickerSourceManifest: vi.fn(), detectStickerSourceManifest: vi.fn(),
    previewStickerCutline: vi.fn(), confirmStickerSource: vi.fn(), exportStickerSheet: vi.fn(), closeStickerSheetSession: vi.fn(),
}));
const fingerprint = 'b'.repeat(64);
const detection = { session_id: 'a'.repeat(32), source_page: 1, page_count: 1,
    boundary_source: 'alpha', strategy_confidence: 0.98, mask_revision: 1,
    warnings: [], dpi: [150, 300], vector_geometry_ref: null,
} as unknown as StickerSourceDetection;

const context = (): ProcessContext => ({
    file: new File(['pdf'], 'input.pdf'), getWorkingBytes: vi.fn(async () => new Uint8Array([1, 2])),
    setError: vi.fn(), setIsProcessing: vi.fn(), setProcessStatus: vi.fn(), setReportMsg: vi.fn(),
    setBatchOutput: vi.fn(), setCancelHandler: vi.fn(), commitWorkingFile: vi.fn(),
});
beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(inspectStickerSourceManifest).mockResolvedValue({ session_id: 'a'.repeat(32), page_count: 1 } as StickerSourceInspection);
    vi.mocked(detectStickerSourceManifest).mockResolvedValue(detection);
    vi.mocked(confirmStickerSource).mockResolvedValue(true);
    vi.mocked(previewStickerCutline).mockResolvedValue({ page_number: 1, mask_revision: 1,
        preview_width_px: 100, preview_height_px: 100, paths: [], segment_count: 1, fingerprint });
    vi.mocked(exportStickerSheet).mockResolvedValue({ blob: new Blob(['out']), filename: 'out.pdf', outputPath: 'temp/session/out.pdf', stickerCount: 1 });
});
describe('recipe workspace tem', () => {
    it('dò file mới, giữ denoise/fingerprint và chỉ commit bytes trước khi đóng session', async () => {
        const ctx = context();
        const result = await runUnifiedStickerRecipe(ctx, { workflow: 'unified-v2', cutlineDenoise: 70, bleedMm: 2, cropToSticker: false }, null);
        expect(result.status).toBe('completed');
        expect(exportStickerSheet).toHaveBeenCalledWith('a'.repeat(32), expect.objectContaining({
            cropToSticker: false, bleedMm: 2, cutlineDenoise: 70,
            pages: [expect.objectContaining({ expectedFingerprint: fingerprint, cutlineDenoise: 70, dpi: 150, dpiY: 300 })],
        }));
        expect(ctx.commitWorkingFile).toHaveBeenCalledWith(expect.any(Blob), 'out.pdf');
        expect(closeStickerSheetSession).toHaveBeenCalledWith('a'.repeat(32));
        expect(vi.mocked(ctx.commitWorkingFile).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(closeStickerSheetSession).mock.invocationCallOrder[0]);
    });
    it('nhận diện mơ hồ dừng recipe, không xuất và vẫn dọn session', async () => {
        vi.mocked(detectStickerSourceManifest).mockResolvedValue({ ...detection, strategy_confidence: 0.2 });
        const ctx = context();
        expect((await runUnifiedStickerRecipe(ctx, {}, null)).status).toBe('error');
        expect(exportStickerSheet).not.toHaveBeenCalled();
        expect(ctx.commitWorkingFile).not.toHaveBeenCalled();
        expect(closeStickerSheetSession).toHaveBeenCalledTimes(1);
    });
    it('hủy lúc inspect không commit file về muộn', async () => {
        const ctx = context();
        vi.mocked(inspectStickerSourceManifest).mockImplementation(async () => {
            const callback = vi.mocked(ctx.setCancelHandler!).mock.calls[0][0];
            await callback?.();
            return { session_id: 'a'.repeat(32), page_count: 1 } as StickerSourceInspection;
        });
        expect((await runUnifiedStickerRecipe(ctx, {}, null)).status).toBe('canceled');
        expect(ctx.commitWorkingFile).not.toHaveBeenCalled();
        expect(closeStickerSheetSession).toHaveBeenCalledTimes(1);
    });
    it('không ghi ID/cọ theo file như một bước phát lại được', () => {
        const tab = { ...useStickerSheetStore.getState().getTab('fixture'), sourceOrigin: 'explicit' as const,
            manifest: detection, status: 'mask-ready' as const };
        expect(makeUnifiedStickerRecipe(tab)).toMatchObject({ workflow: 'unified-v2' });
        expect(makeUnifiedStickerRecipe({ ...tab, edits: [{ kind: 'stroke', id: '1', tool: 'erase', instanceId: 1, radius: .02, points: [] }] })).toBeNull();
        expect(makeUnifiedStickerRecipe(tab, [2])).toBeNull();
    });
});
