import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    closeStickerSheetSession,
    confirmStickerSource,
    detectStickerSource,
    exportStickerSheet,
    inspectStickerSource,
    loadStickerSourcePreview,
    previewStickerCutline,
    refineStickerSource,
    type StickerSourceDetectionPayload,
    type StickerSourceInspectPayload,
} from '../../lib/stickerSheetApi';
import { useStickerSheetStore } from './stickerSheetStore';


vi.mock('../../lib/stickerSheetApi', () => ({
    closeStickerSheetSession: vi.fn(async () => undefined),
    confirmStickerSource: vi.fn(async () => true),
    detectStickerSource: vi.fn(),
    exportStickerSheet: vi.fn(),
    inspectStickerSource: vi.fn(),
    loadStickerSourcePreview: vi.fn(),
    previewStickerCutline: vi.fn(),
    refineStickerSource: vi.fn(),
}));

function inspection(sessionId = 'a'.repeat(32), dpi: [number, number] | null = [300, 300]): StickerSourceInspectPayload {
    return {
        inspection: {
            session_id: sessionId,
            stage: 'inspected',
            original_name: 'sheet.png',
            source_kind: 'raster',
            mime_type: 'image/png',
            boundary_source: 'alpha',
            strategy_confidence: 0.98,
            needs_review: false,
            page_count: 1,
            source_width_px: 120,
            source_height_px: 80,
            dpi,
            physical_width_mm: dpi ? 10.16 : null,
            physical_height_mm: dpi ? 6.77 : null,
            preview_width_px: 120,
            preview_height_px: 80,
            has_existing_cut: false,
            has_vector: false,
            has_raster: true,
            has_alpha: true,
            cut_contour_count: 0,
            pages: [{
                page_number: 1,
                width_mm: dpi ? 10.16 : null,
                height_mm: dpi ? 6.77 : null,
                has_existing_cut: false,
                has_vector: false,
                has_raster: true,
                has_alpha: true,
                cut_contour_count: 0,
            }],
            warnings: [],
            preview_url: '/source-preview',
        },
        previewBlob: new Blob(['source-preview']),
    };
}

function detection(sessionId = 'a'.repeat(32), dpi: [number, number] | null = [300, 300]): StickerSourceDetectionPayload {
    return {
        manifest: {
            session_id: sessionId,
            stage: 'mask-review',
            original_name: 'sheet.png',
            source_kind: 'raster',
            boundary_source: 'alpha',
            strategy_confidence: 0.98,
            needs_review: false,
            page_count: 1,
            source_page: 1,
            vector_geometry_ref: null,
            original_width_px: 120,
            original_height_px: 80,
            analysis_width_px: 120,
            analysis_height_px: 80,
            preview_width_px: 120,
            preview_height_px: 80,
            dpi,
            model: 'birefnet-lite',
            model_seconds: 0,
            postprocess_seconds: 0.1,
            mask_revision: 1,
            refinement_available: false,
            alpha_threshold: 128,
            shadow_cleanup: 'auto',
            instances: [
                { id: 1, x: 1, y: 2, width: 30, height: 20, area_px: 500, confidence: 0.9, uncertain_ratio: 0.1 },
            ],
            warnings: [],
            preview_url: '/preview',
            labels_url: '/labels',
            uncertainty_url: '/uncertainty',
        },
        previewBlob: new Blob(['preview']),
        labelsBlob: new Blob(['labels']),
        uncertaintyBlob: new Blob(['uncertainty']),
    };
}

function aiDetection(
    revision = 1,
    alphaThreshold = 128,
    sessionId = 'a'.repeat(32),
): StickerSourceDetectionPayload {
    const payload = detection(sessionId);
    payload.manifest.boundary_source = 'ai';
    payload.manifest.needs_review = true;
    payload.manifest.refinement_available = true;
    payload.manifest.mask_revision = revision;
    payload.manifest.alpha_threshold = alphaThreshold;
    payload.manifest.shadow_cleanup = 'auto';
    payload.manifest.preview_url = `/preview?v=${revision}`;
    payload.manifest.labels_url = `/labels?v=${revision}`;
    payload.manifest.uncertainty_url = `/uncertainty?v=${revision}`;
    payload.previewBlob = new Blob([`preview-${revision}`]);
    payload.labelsBlob = new Blob([`labels-${revision}`]);
    payload.uncertaintyBlob = new Blob([`uncertainty-${revision}`]);
    return payload;
}

function multiPageInspection(
    pageCount = 2,
    sessionId = 'd'.repeat(32),
): StickerSourceInspectPayload {
    const payload = inspection(sessionId);
    payload.inspection.original_name = 'batch.pdf';
    payload.inspection.source_kind = 'pdf';
    payload.inspection.mime_type = 'application/pdf';
    payload.inspection.page_count = pageCount;
    payload.inspection.pages = Array.from({ length: pageCount }, (_unused, index) => ({
        page_number: index + 1,
        width_mm: 20 + index,
        height_mm: 30 + index,
        has_existing_cut: false,
        has_vector: false,
        has_raster: true,
        has_alpha: false,
        cut_contour_count: 0,
    }));
    return payload;
}

function detectionForPage(
    pageNumber: number,
    sessionId = 'd'.repeat(32),
): StickerSourceDetectionPayload {
    const payload = aiDetection(1, 128, sessionId);
    payload.manifest.page_count = 2;
    payload.manifest.source_page = pageNumber;
    payload.manifest.original_name = 'batch.pdf';
    payload.manifest.preview_url = `/preview?page=${pageNumber}`;
    payload.manifest.labels_url = `/labels?page=${pageNumber}`;
    payload.manifest.uncertainty_url = `/uncertainty?page=${pageNumber}`;
    return payload;
}

function prepareSuccessfulFlow(sessionId = 'a'.repeat(32), dpi: [number, number] | null = [300, 300]): void {
    vi.mocked(inspectStickerSource).mockResolvedValue(inspection(sessionId, dpi));
    vi.mocked(detectStickerSource).mockResolvedValue(detection(sessionId, dpi));
}

describe('stickerSheetStore — state machine nguồn tem theo tab', () => {
    it('Undo nhận diện về nguồn và Redo khôi phục đúng kết quả không chạy AI lại', async () => {
        prepareSuccessfulFlow();
        const store = useStickerSheetStore.getState();
        store.initTab('recognition-undo');
        store.enableUnified('recognition-undo');
        const source = new File(['png'], 'tem.png', { type: 'image/png' });
        store.selectSource('recognition-undo', source);
        store.setOutputSettings('recognition-undo', { bleedMm: 2.25 });
        await store.detectStickers('recognition-undo');
        await store.confirmMask('recognition-undo');
        await vi.waitFor(() => expect(store.getTab('recognition-undo').cutlinePreview).not.toBeNull());
        const detected = store.getTab('recognition-undo');
        expect(store.undoDetection('recognition-undo')).toBe(true);
        const undone = store.getTab('recognition-undo');
        expect(undone.status).toBe('source-ready');
        expect(undone.manifest).toBeNull();
        expect(undone.sourceFile).toBe(source);
        expect(undone.outputSettings.bleedMm).toBe(2.25);
        expect(undone.inspection).toBe(detected.inspection);
        expect(closeStickerSheetSession).not.toHaveBeenCalled();
        expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(detected.previewUrl);
        expect(store.redoDetection('recognition-undo')).toBe(true);
        expect(store.getTab('recognition-undo').manifest).toBe(detected.manifest);
        expect(store.getTab('recognition-undo').cutlinePreview?.fingerprint).toBe(detected.cutlinePreview?.fingerprint);
        expect(store.getTab('recognition-undo').status).toBe('mask-ready');
        expect(detectStickerSource).toHaveBeenCalledTimes(1);
    });

    it('nhận diện mới sau Undo dùng revision backend đang giữ và bỏ Redo cũ', async () => {
        prepareSuccessfulFlow();
        const store = useStickerSheetStore.getState();
        store.initTab('recognition-branch'); store.enableUnified('recognition-branch');
        store.selectSource('recognition-branch', new File(['png'], 'tem.png'));
        await store.detectStickers('recognition-branch');
        const before = store.getTab('recognition-branch');
        expect(store.undoDetection('recognition-branch')).toBe(true);
        const next = detection(); next.manifest.mask_revision = 2;
        vi.mocked(detectStickerSource).mockResolvedValue(next);
        await store.detectStickers('recognition-branch');
        expect(detectStickerSource).toHaveBeenLastCalledWith('a'.repeat(32), expect.objectContaining({ baseRevision: 1 }));
        expect(store.getTab('recognition-branch').manifest?.mask_revision).toBe(2);
        expect(store.getTab('recognition-branch').detectionRedo).toBeUndefined();
        expect(URL.revokeObjectURL).toHaveBeenCalledWith(before.previewUrl);
        expect(store.redoDetection('recognition-branch')).toBe(false);
    });

    it('đổi nguồn sau Undo nhả asset và không Redo nhận diện của file cũ', async () => {
        prepareSuccessfulFlow();
        const store = useStickerSheetStore.getState();
        store.initTab('recognition-source'); store.enableUnified('recognition-source');
        store.selectSource('recognition-source', new File(['first'], 'tem.png'));
        await store.detectStickers('recognition-source');
        const before = store.getTab('recognition-source');
        store.undoDetection('recognition-source');
        store.selectSource('recognition-source', new File(['second'], 'tem.png'));
        expect(store.redoDetection('recognition-source')).toBe(false);
        expect(URL.revokeObjectURL).toHaveBeenCalledWith(before.previewUrl);
        expect(URL.revokeObjectURL).toHaveBeenCalledWith(before.labelsUrl);
        expect(closeStickerSheetSession).toHaveBeenCalledWith(before.manifest?.session_id);
    });

    it('nét cọ được Undo trước nhận diện; Redo giữ hàng đợi nét cọ đã hoàn tác', async () => {
        prepareSuccessfulFlow();
        const store = useStickerSheetStore.getState();
        store.initTab('recognition-brush'); store.enableUnified('recognition-brush');
        store.selectSource('recognition-brush', new File(['png'], 'tem.png'));
        await store.detectStickers('recognition-brush');
        store.addStroke('recognition-brush', { tool: 'erase', instanceId: 1, radius: .01, points: [{ x: .1, y: .1 }] });
        expect(store.undoDetection('recognition-brush')).toBe(false);
        store.undo('recognition-brush');
        expect(store.undoDetection('recognition-brush')).toBe(true);
        expect(store.redoDetection('recognition-brush')).toBe(true);
        expect(store.getTab('recognition-brush').edits).toHaveLength(0);
        store.redo('recognition-brush');
        expect(store.getTab('recognition-brush').edits).toHaveLength(1);
    });

    it('đổi nền trong lúc Undo không cho Redo xuất mask trái với lựa chọn mới', async () => {
        prepareSuccessfulFlow();
        const store = useStickerSheetStore.getState();
        store.initTab('recognition-background'); store.enableUnified('recognition-background');
        store.selectSource('recognition-background', new File(['png'], 'tem.png'));
        await store.detectStickers('recognition-background');
        await store.confirmMask('recognition-background');
        store.undoDetection('recognition-background');
        store.setRemoveWhiteBg('recognition-background', false);
        expect(store.redoDetection('recognition-background')).toBe(true);
        expect(store.getTab('recognition-background').whiteBackgroundStale).toBe(true);
        expect(await store.exportFile('recognition-background', 'png_zip')).toBeNull();
        expect(exportStickerSheet).not.toHaveBeenCalled();
    });

    it('khôi phục nền false vào tab unified cũ và giữ lựa chọn mới khi mở lại', () => {
        window.localStorage.setItem('ps_sticker_removeWhiteBg', 'false');
        const store = useStickerSheetStore.getState();
        store.initTab('background-migrate');
        useStickerSheetStore.setState({ tabs: { 'background-migrate': {
            ...store.getTab('background-migrate'), unifiedInitialized: true,
        } } });
        store.enableUnified('background-migrate');
        expect(store.getTab('background-migrate').removeWhiteBg).toBe(false);
        expect(store.setRemoveWhiteBg('background-migrate', true)).toBe(true);
        store.enableUnified('background-migrate');
        expect(store.getTab('background-migrate').removeWhiteBg).toBe(true);
        expect(store.getTab('background-migrate').whiteBackgroundStale).toBe(false);
        expect(detectStickerSource).not.toHaveBeenCalled();

        store.initTab('old-page-box');
        useStickerSheetStore.setState(state => ({ tabs: { ...state.tabs, 'old-page-box': {
            ...store.getTab('old-page-box'), unifiedInitialized: true, detectionStrategy: 'page-box',
        } } }));
        store.enableUnified('old-page-box');
        expect(store.getTab('old-page-box').removeWhiteBg).toBe(false);

        // Auto có thể trả khung trang do artwork phủ kín; không suy thành lựa chọn false của user.
        store.initTab('auto-page-box');
        const automatic = detection().manifest;
        useStickerSheetStore.setState(state => ({ tabs: { ...state.tabs, 'auto-page-box': {
            ...store.getTab('auto-page-box'), unifiedInitialized: true, detectionStrategy: 'auto',
            manifest: { ...automatic, boundary_source: 'page-box' },
        } } }));
        store.enableUnified('auto-page-box');
        expect(store.getTab('auto-page-box').removeWhiteBg).toBe(true);
    });

    it('tắt bỏ nền gửi page-box, Alpha ưu tiên và lựa chọn PDF không bị đổi detector', async () => {
        prepareSuccessfulFlow();
        const store = useStickerSheetStore.getState();
        store.initTab('background-policy');
        store.enableUnified('background-policy');
        store.setRemoveWhiteBg('background-policy', false);
        store.selectSource('background-policy', new File(['pdf'], 'tem.pdf', { type: 'application/pdf' }));
        await store.detectStickers('background-policy', 'ai');
        expect(detectStickerSource).toHaveBeenLastCalledWith('a'.repeat(32), expect.objectContaining({ strategy: 'page-box' }));
        store.setOutputSettings('background-policy', { cutMode: 'alpha' });
        expect(store.getTab('background-policy').whiteBackgroundStale).toBe(true);
        await store.detectStickers('background-policy', 'ai');
        expect(detectStickerSource).toHaveBeenLastCalledWith('a'.repeat(32), expect.objectContaining({ strategy: 'alpha' }));
        expect(store.getTab('background-policy').whiteBackgroundStale).toBe(false);
        await store.detectStickers('background-policy', 'auto', 1, undefined, ['image-1']);
        expect(detectStickerSource).toHaveBeenLastCalledWith('a'.repeat(32), expect.objectContaining({
            strategy: 'auto', objectIds: ['image-1'],
        }));
    });

    it('đổi nền đánh dấu mọi trang, chặn mọi đầu ra và nhận diện lại đúng revision', async () => {
        const store = useStickerSheetStore.getState();
        store.initTab('background-pages');
        store.enableUnified('background-pages');
        store.selectSource('background-pages', new File(['pdf'], 'batch.pdf', { type: 'application/pdf' }));
        vi.mocked(inspectStickerSource).mockResolvedValue(multiPageInspection());
        vi.mocked(detectStickerSource).mockImplementation(async (_session, options) => {
            const payload = detectionForPage(options?.pageNumber ?? 1);
            payload.manifest.boundary_source = options?.strategy === 'page-box' ? 'page-box' : 'ai';
            payload.manifest.mask_revision = (options?.baseRevision ?? 0) + 1;
            return payload;
        });
        await store.detectAllStickers('background-pages');
        await store.confirmMask('background-pages', 1);
        await store.confirmMask('background-pages', 2);
        const before = store.getTab('background-pages');
        expect(store.setRemoveWhiteBg('background-pages', false)).toBe(true);
        const stale = store.getTab('background-pages');
        expect(Object.values(stale.pages).map(page => page.whiteBackgroundStale)).toEqual([true, true]);
        expect(stale.pages[1].manifest).toBe(before.pages[1].manifest);
        expect(stale.pages[2].manifest).toBe(before.pages[2].manifest);
        expect(stale.whiteBackgroundStale).toBe(true);
        store.setOutputSettings('background-pages', { cutMode: 'none' });
        expect(await store.exportFile('background-pages', 'pdf')).toBeNull();
        expect(await store.exportFile('background-pages', 'png_zip')).toBeNull();
        expect(exportStickerSheet).not.toHaveBeenCalled();
        expect(store.getTab('background-pages').error).toContain('Tùy chọn nền đã đổi');

        vi.mocked(detectStickerSource).mockClear();
        await store.detectAllStickers('background-pages');
        expect(detectStickerSource).toHaveBeenCalledTimes(2);
        for (const pageNumber of [1, 2]) {
            expect(detectStickerSource).toHaveBeenCalledWith('d'.repeat(32), expect.objectContaining({
                strategy: 'page-box', pageNumber, baseRevision: 1,
            }));
            await store.confirmMask('background-pages', pageNumber);
        }
        expect(Object.values(store.getTab('background-pages').pages).map(page => page.whiteBackgroundStale)).toEqual([false, false]);
        vi.mocked(exportStickerSheet).mockResolvedValue({ blob: new Blob(['png']), filename: 'tem.zip', outputPath: '', stickerCount: 2 });
        expect(await store.exportFile('background-pages', 'png_zip')).not.toBeNull();
        expect(closeStickerSheetSession).not.toHaveBeenCalled();
        store.finishExport('background-pages');
    });

    it('dò nền mới lỗi giữ mask/nét sửa nhưng không cho xuất artifact cũ', async () => {
        prepareSuccessfulFlow();
        const store = useStickerSheetStore.getState();
        store.initTab('background-fail');
        store.enableUnified('background-fail');
        store.selectSource('background-fail', new File(['png'], 'tem.png'));
        await store.detectStickers('background-fail');
        store.addStroke('background-fail', { tool: 'restore', instanceId: 1, radius: 0.01, points: [{ x: 0.1, y: 0.1 }] });
        await store.confirmMask('background-fail');
        const before = store.getTab('background-fail');
        store.setRemoveWhiteBg('background-fail', false);
        vi.mocked(detectStickerSource).mockRejectedValueOnce(new Error('Không nhận diện được nền mới.'));
        await store.detectStickers('background-fail');
        const after = store.getTab('background-fail');
        expect(after.whiteBackgroundStale).toBe(true);
        expect(after.manifest).toBe(before.manifest);
        expect(after.edits).toEqual(before.edits);
        expect(after.status).toBe('mask-ready');
        expect(await store.exportFile('background-fail', 'png_zip')).toBeNull();
        expect(exportStickerSheet).not.toHaveBeenCalled();
        store.restartDetection('background-fail');
        expect(store.getTab('background-fail').whiteBackgroundStale).toBe(false);
        expect(store.getTab('background-fail').removeWhiteBg).toBe(false);
    });

    it('hủy dò nền phục hồi stale, không cho đổi lựa chọn trong lúc đang dò', async () => {
        prepareSuccessfulFlow();
        const store = useStickerSheetStore.getState();
        store.initTab('background-cancel');
        store.enableUnified('background-cancel');
        store.selectSource('background-cancel', new File(['png'], 'tem.png'));
        await store.detectStickers('background-cancel');
        store.setRemoveWhiteBg('background-cancel', false);
        const before = store.getTab('background-cancel');
        vi.mocked(detectStickerSource).mockImplementationOnce(async (_session, options) => new Promise((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => reject(new DOMException('Hủy', 'AbortError')), { once: true });
        }));
        const pending = store.detectStickers('background-cancel');
        await vi.waitFor(() => expect(store.getTab('background-cancel').status).toBe('detecting'));
        expect(store.setRemoveWhiteBg('background-cancel', true)).toBe(false);
        store.cancelDetection('background-cancel');
        await pending;
        expect(store.getTab('background-cancel').whiteBackgroundStale).toBe(true);
        expect(store.getTab('background-cancel').manifest).toBe(before.manifest);
        expect(store.getTab('background-cancel').removeWhiteBg).toBe(false);
    });

    it('không thay mask custom/dao gốc, còn đổi vào-ra Alpha bắt buộc dò lại nguồn tự động', async () => {
        prepareSuccessfulFlow();
        const store = useStickerSheetStore.getState();
        store.initTab('background-custom');
        store.enableUnified('background-custom');
        store.selectSource('background-custom', new File(['png'], 'tem.png'));
        const custom = detection();
        custom.manifest.boundary_source = 'manual';
        custom.manifest.vector_geometry_ref = { kind: 'pdf-object-selection', object_ids: ['image-1'] };
        vi.mocked(detectStickerSource).mockResolvedValueOnce(custom);
        await store.detectStickers('background-custom', 'auto', 1, undefined, ['image-1']);
        store.setRemoveWhiteBg('background-custom', false);
        expect(store.getTab('background-custom').whiteBackgroundStale).toBe(false);
        store.setOutputSettings('background-custom', { cutMode: 'alpha' });
        expect(store.getTab('background-custom').whiteBackgroundStale).toBe(false);

        store.initTab('background-alpha');
        store.enableUnified('background-alpha');
        store.setOutputSettings('background-alpha', { cutMode: 'original' });
        store.setRemoveWhiteBg('background-alpha', true);
        store.selectSource('background-alpha', new File(['png'], 'tem.png'));
        await store.detectStickers('background-alpha');
        store.setOutputSettings('background-alpha', { cutMode: 'alpha' });
        expect(store.getTab('background-alpha').whiteBackgroundStale).toBe(true);
        await store.detectStickers('background-alpha');
        store.setRemoveWhiteBg('background-alpha', false);
        expect(store.getTab('background-alpha').whiteBackgroundStale).toBe(false);
        store.setOutputSettings('background-alpha', { cutMode: 'original' });
        expect(store.getTab('background-alpha').whiteBackgroundStale).toBe(true);

        store.initTab('background-cut');
        store.enableUnified('background-cut');
        store.setRemoveWhiteBg('background-cut', true);
        store.selectSource('background-cut', new File(['pdf'], 'tem.pdf', { type: 'application/pdf' }));
        const existing = detection();
        existing.manifest.boundary_source = 'existing-cut';
        vi.mocked(detectStickerSource).mockResolvedValueOnce(existing);
        await store.detectStickers('background-cut');
        expect(store.getTab('background-cut').preserveExistingCut).toBe(true);
        store.setRemoveWhiteBg('background-cut', false);
        expect(store.getTab('background-cut').whiteBackgroundStale).toBe(false);
        store.setPreserveExistingCut('background-cut', false);
        expect(store.getTab('background-cut').whiteBackgroundStale).toBe(true);
        store.setPreserveExistingCut('background-cut', true);
        expect(store.getTab('background-cut').whiteBackgroundStale).toBe(false);
    });

    it('đổi vào Alpha lúc dò lại đang chạy vẫn chặn mask cũ nếu request thất bại', async () => {
        prepareSuccessfulFlow();
        const store = useStickerSheetStore.getState();
        store.initTab('background-midflight');
        store.enableUnified('background-midflight');
        store.selectSource('background-midflight', new File(['png'], 'tem.png'));
        await store.detectStickers('background-midflight');
        await store.confirmMask('background-midflight');
        let rejectDetection: (error: Error) => void = () => undefined;
        vi.mocked(detectStickerSource).mockImplementationOnce(() => new Promise((_resolve, reject) => {
            rejectDetection = reject;
        }));
        const pending = store.detectStickers('background-midflight');
        await vi.waitFor(() => expect(store.getTab('background-midflight').status).toBe('detecting'));
        store.setOutputSettings('background-midflight', { cutMode: 'alpha' });
        rejectDetection(new Error('Không dò được.'));
        await pending;
        expect(store.getTab('background-midflight').whiteBackgroundStale).toBe(true);
        expect(await store.exportFile('background-midflight', 'png_zip')).toBeNull();
        expect(exportStickerSheet).not.toHaveBeenCalled();
    });

    it('custom thay vùng đúng trang, giữ tuning và kết quả trang còn lại', async () => {
        const store = useStickerSheetStore.getState();
        store.selectSource('custom', new File(['pdf'], 'batch.pdf', { type: 'application/pdf' }));
        vi.mocked(inspectStickerSource).mockResolvedValue(multiPageInspection());
        vi.mocked(detectStickerSource).mockResolvedValue(detectionForPage(1));
        await store.detectStickers('custom', 'auto', 1);
        vi.mocked(detectStickerSource).mockResolvedValue(detectionForPage(2));
        await store.detectStickers('custom', 'auto', 2);
        await vi.waitFor(() => expect(store.getTab('custom').pages[2].isCutlinePreviewing).toBe(false));
        store.setActivePage('custom', 1);
        store.setOutputSettings('custom', { bleedMm: 3.25 });
        const sibling = store.getTab('custom').pages[2];
        const selected = detectionForPage(1);
        selected.manifest.mask_revision = 2;
        selected.manifest.boundary_source = 'manual';
        selected.manifest.vector_geometry_ref = { kind: 'pdf-object-selection', object_ids: ['vector-2'] };
        vi.mocked(detectStickerSource).mockResolvedValue(selected);
        await store.detectStickers('custom', 'auto', 1, undefined, ['vector-2']);
        expect(detectStickerSource).toHaveBeenLastCalledWith('d'.repeat(32), expect.objectContaining({
            pageNumber: 1, baseRevision: 1, objectIds: ['vector-2'],
        }));
        expect(store.getTab('custom').pages[1].manifest?.mask_revision).toBe(2);
        expect(store.getTab('custom').pages[2].manifest).toBe(sibling.manifest);
        expect(store.getTab('custom').outputSettings.bleedMm).toBe(3.25);
        expect(closeStickerSheetSession).not.toHaveBeenCalled();
    });

    it('custom thất bại giữ mask và nét sửa đã duyệt trên trang', async () => {
        prepareSuccessfulFlow();
        const store = useStickerSheetStore.getState();
        store.selectSource('custom-fail', new File(['pdf'], 'tem.pdf', { type: 'application/pdf' }));
        await store.detectStickers('custom-fail');
        store.addStroke('custom-fail', { tool: 'erase', instanceId: 1, radius: 0.01, points: [{ x: 0.1, y: 0.1 }] });
        await vi.waitFor(() => expect(store.getTab('custom-fail').isCutlinePreviewing).toBe(false));
        const before = store.getTab('custom-fail');
        vi.mocked(detectStickerSource).mockRejectedValue(new Error('Đối tượng đã thay đổi.'));
        await store.detectStickers('custom-fail', 'auto', 1, undefined, ['vector-9']);
        const after = store.getTab('custom-fail');
        expect(after.manifest).toBe(before.manifest);
        expect(after.previewUrl).toBe(before.previewUrl);
        expect(after.edits).toEqual(before.edits);
        expect(after.status).toBe('mask-review');
        expect(after.error).toBe('Đối tượng đã thay đổi.');
    });

    it('lỗi tải mask custom retry đúng selection đã commit, không gửi revision cũ', async () => {
        prepareSuccessfulFlow();
        const store = useStickerSheetStore.getState();
        store.selectSource('custom-retry', new File(['pdf'], 'tem.pdf', { type: 'application/pdf' }));
        await store.detectStickers('custom-retry');
        const committed = detection();
        committed.manifest.mask_revision = 2;
        committed.manifest.vector_geometry_ref = { kind: 'pdf-object-selection', object_ids: ['vector-2'] };
        const failed = Object.assign(new Error('Chưa tải được vùng tem mới. Bấm Thử lại.'), {
            name: 'StickerDetectAssetSyncError', manifest: committed.manifest,
        });
        vi.mocked(detectStickerSource).mockRejectedValueOnce(failed);
        await store.detectStickers('custom-retry', 'auto', 1, undefined, ['vector-2']);
        expect(store.getTab('custom-retry').status).toBe('error');
        vi.mocked(detectStickerSource).mockResolvedValue(committed);
        await store.detectStickers('custom-retry', 'auto', 1);
        const options = vi.mocked(detectStickerSource).mock.calls.at(-1)?.[1];
        expect(options?.objectIds).toEqual(['vector-2']);
        expect(options?.baseRevision).toBeUndefined();
        expect(store.getTab('custom-retry').manifest?.mask_revision).toBe(2);
        expect(store.getTab('custom-retry').detectionRetry).toBeUndefined();
    });

    it('hủy custom phục hồi trang hiện tại mà không đóng session', async () => {
        prepareSuccessfulFlow();
        const store = useStickerSheetStore.getState();
        store.selectSource('custom-cancel', new File(['pdf'], 'tem.pdf', { type: 'application/pdf' }));
        await store.detectStickers('custom-cancel');
        const before = store.getTab('custom-cancel');
        vi.mocked(detectStickerSource).mockImplementationOnce(async (_session, options) => new Promise((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => reject(new DOMException('Hủy', 'AbortError')), { once: true });
        }));
        const pending = store.detectStickers('custom-cancel', 'auto', 1, undefined, ['vector-2']);
        await vi.waitFor(() => expect(store.getTab('custom-cancel').status).toBe('detecting'));
        store.cancelDetection('custom-cancel');
        await pending;
        expect(store.getTab('custom-cancel').manifest).toBe(before.manifest);
        expect(store.getTab('custom-cancel').status).toBe(before.status);
        expect(closeStickerSheetSession).not.toHaveBeenCalled();
    });

    it('workspace hợp nhất giữ thông số khi chuẩn bị nhận diện lại nguồn', () => {
        const store = useStickerSheetStore.getState();
        store.initTab('restart-unified');
        store.enableUnified('restart-unified');
        store.selectSource('restart-unified', new File(['png'], 'tem.png'), 'explicit');
        store.setOutputSettings('restart-unified', { bleedMm: 3.25, offsetMm: -0.2 });
        expect(store.restartDetection('restart-unified')).toBe(true);
        const state = store.getTab('restart-unified');
        expect(state.sourceFile?.name).toBe('tem.png');
        expect(state.outputSettings.bleedMm).toBe(3.25);
        expect(state.outputSettings.offsetMm).toBe(-0.2);
        expect(state.status).toBe('source-ready');
        expect(state.inspection).toBeNull();
    });
    beforeEach(() => {
        useStickerSheetStore.setState({ tabs: {} });
        const preferences = new Map<string, string>();
        vi.stubGlobal('window', { localStorage: {
            getItem: (key: string) => preferences.get(key) ?? null,
            setItem: (key: string, value: string) => { preferences.set(key, value); },
        } });
        vi.clearAllMocks();
        vi.mocked(confirmStickerSource).mockResolvedValue(true);
        vi.mocked(loadStickerSourcePreview).mockResolvedValue(new Blob(['source-preview']));
        vi.mocked(previewStickerCutline).mockResolvedValue({
            page_number: 1,
            mask_revision: 1,
            preview_width_px: 120,
            preview_height_px: 80,
            paths: [{ instance_id: 1, d: 'M 1 1 C 2 1 3 2 4 4 Z', segment_count: 1 }],
            fingerprint: 'f'.repeat(64),
            segment_count: 1,
        });
        let index = 0;
        Object.defineProperty(URL, 'createObjectURL', {
            configurable: true,
            value: vi.fn(() => `blob:asset-${++index}`),
        });
        Object.defineProperty(URL, 'revokeObjectURL', {
            configurable: true,
            value: vi.fn(),
        });
    });


    it('mặc định dùng nguồn có biên và giữ lựa chọn AI khi reset phiên nhận diện', () => {
        useStickerSheetStore.getState().initTab('tab-mode');
        const initial = useStickerSheetStore.getState().getTab('tab-mode');
        expect(initial.mode).toBe('existing');
        expect(initial.outputSettings.offsetMm).toBe(0);
        expect(initial.outputSettings.bleedMm).toBe(2);

        useStickerSheetStore.getState().setMode('tab-mode', 'ai-sheet');
        useStickerSheetStore.getState().selectSource(
            'tab-mode',
            new File(['image'], 'sheet.png', { type: 'image/png' }),
        );
        useStickerSheetStore.getState().resetAnalysis('tab-mode');

        expect(useStickerSheetStore.getState().getTab('tab-mode').mode).toBe('ai-sheet');
        expect(useStickerSheetStore.getState().getTab('tab-mode').status).toBe('idle');
    });

    it('chọn file chỉ tạo preview; detect giữ một session và confirm mới mở export', async () => {
        prepareSuccessfulFlow();
        vi.mocked(exportStickerSheet).mockResolvedValue({
            blob: new Blob(['pdf']), filename: 'tem.pdf', outputPath: 'D:\\results\\tem.pdf', stickerCount: 1,
        });
        const file = new File(['image'], 'sheet.png', { type: 'image/png' });

        useStickerSheetStore.getState().selectSource('tab-a', file);
        expect(useStickerSheetStore.getState().getTab('tab-a').status).toBe('source-ready');
        expect(inspectStickerSource).not.toHaveBeenCalled();
        expect(detectStickerSource).not.toHaveBeenCalled();
        useStickerSheetStore.getState().setOutputSettings('tab-a', {
            offsetMm: 1.2,
            bleedMm: 2.4,
            bleedColorType: 'solid',
            solidBleedCmyk: [12, 23, 34, 45],
        });

        await useStickerSheetStore.getState().detectStickers('tab-a');
        const reviewed = useStickerSheetStore.getState().getTab('tab-a');
        expect(reviewed.status).toBe('mask-review');
        expect(reviewed.inspection?.session_id).toBe('a'.repeat(32));
        expect(reviewed.manifest?.session_id).toBe('a'.repeat(32));
        expect(reviewed.selectedInstanceId).toBe(1);
        expect(await useStickerSheetStore.getState().exportFile('tab-a')).toBeNull();
        expect(exportStickerSheet).not.toHaveBeenCalled();

        useStickerSheetStore.getState().addStroke('tab-a', {
            tool: 'erase', instanceId: 1, radius: 0.01, points: [{ x: 0.1, y: 0.2 }],
        });
        await useStickerSheetStore.getState().confirmMask('tab-a');
        expect(useStickerSheetStore.getState().getTab('tab-a').status).toBe('mask-ready');

        const result = await useStickerSheetStore.getState().exportFile('tab-a');
        expect(result?.filename).toBe('tem.pdf');
        expect(exportStickerSheet).toHaveBeenCalledWith(
            'a'.repeat(32),
            expect.objectContaining({
                outputFormat: 'pdf',
                cutMode: 'original',
                offsetMm: 1.2,
                bleedMm: 2.4,
                bleedColorType: 'solid',
                solidBleedCmyk: [12, 23, 34, 45],
                preserveExistingCut: false,
                signal: expect.any(AbortSignal),
            }),
        );
        expect(useStickerSheetStore.getState().getTab('tab-a').status).toBe('exporting');
        useStickerSheetStore.getState().finishExport('tab-a');
        expect(useStickerSheetStore.getState().getTab('tab-a').status).toBe('mask-ready');
    });


    it('không chờ preview PDF trước khi gửi request nhận diện', async () => {
        const sessionId = 'p'.repeat(32);
        const source = inspection(sessionId);
        source.inspection.source_kind = 'pdf';
        source.inspection.mime_type = 'application/pdf';
        source.inspection.original_name = 'sheet.pdf';
        source.previewBlob = new Blob();
        vi.mocked(inspectStickerSource).mockResolvedValue(source);

        let resolvePreview!: (blob: Blob) => void;
        vi.mocked(loadStickerSourcePreview).mockImplementationOnce(() => new Promise(resolve => {
            resolvePreview = resolve;
        }));
        let resolveDetect!: (payload: StickerSourceDetectionPayload) => void;
        vi.mocked(detectStickerSource).mockImplementationOnce(() => new Promise(resolve => {
            resolveDetect = resolve;
        }));

        const file = new File(['pdf'], 'sheet.pdf', { type: 'application/pdf' });
        useStickerSheetStore.getState().selectSource('tab-deferred', file);
        const pending = useStickerSheetStore.getState().detectStickers('tab-deferred');

        await vi.waitFor(() => expect(detectStickerSource).toHaveBeenCalledTimes(1));
        expect(loadStickerSourcePreview).toHaveBeenCalledTimes(1);
        expect(useStickerSheetStore.getState().getTab('tab-deferred').status).toBe('detecting');

        resolveDetect(detection(sessionId));
        await pending;
        expect(useStickerSheetStore.getState().getTab('tab-deferred').status).toBe('mask-review');
        expect(useStickerSheetStore.getState().getTab('tab-deferred').sourcePreviewReady).toBe(false);

        resolvePreview(new Blob(['preview-pdf']));
        await vi.waitFor(() => expect(
            useStickerSheetStore.getState().getTab('tab-deferred').sourcePreviewReady,
        ).toBe(true));
    });

    it('xếp hàng tinh chỉnh và luôn áp dụng lựa chọn slider mới nhất', async () => {
        const sessionId = 'a'.repeat(32);
        vi.mocked(inspectStickerSource).mockResolvedValue(inspection(sessionId));
        vi.mocked(detectStickerSource).mockResolvedValue(aiDetection(1, 128, sessionId));
        let resolveFirst!: (payload: StickerSourceDetectionPayload) => void;
        vi.mocked(refineStickerSource)
            .mockImplementationOnce(() => new Promise(resolve => {
                resolveFirst = resolve;
            }))
            .mockResolvedValueOnce(aiDetection(3, 160, sessionId));

        useStickerSheetStore.getState().selectSource(
            'tab-refine',
            new File(['image'], 'sheet.png', { type: 'image/png' }),
        );
        await useStickerSheetStore.getState().detectStickers('tab-refine', 'ai');
        useStickerSheetStore.getState().addStroke('tab-refine', {
            tool: 'erase', instanceId: 1, radius: 0.01, points: [{ x: 0.1, y: 0.2 }],
        });
        useStickerSheetStore.getState().setMaskTuning('tab-refine', { alphaThreshold: 140 });

        expect(useStickerSheetStore.getState().getTab('tab-refine').isRefining).toBe(true);
        expect(useStickerSheetStore.getState().getTab('tab-refine').edits).toHaveLength(1);
        await useStickerSheetStore.getState().confirmMask('tab-refine');
        expect(confirmStickerSource).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(refineStickerSource).toHaveBeenCalledTimes(1));
        expect(refineStickerSource).toHaveBeenNthCalledWith(1, sessionId, {
            alphaThreshold: 140,
            shadowCleanup: 'auto',
            baseRevision: 1,
            pageNumber: 1,
        });

        useStickerSheetStore.getState().setMaskTuning('tab-refine', { alphaThreshold: 160 });
        expect(refineStickerSource).toHaveBeenCalledTimes(1);
        resolveFirst(aiDetection(2, 140, sessionId));

        await vi.waitFor(() => expect(refineStickerSource).toHaveBeenCalledTimes(2));
        expect(refineStickerSource).toHaveBeenNthCalledWith(2, sessionId, {
            alphaThreshold: 160,
            shadowCleanup: 'auto',
            baseRevision: 2,
            pageNumber: 1,
        });
        await vi.waitFor(() => {
            const current = useStickerSheetStore.getState().getTab('tab-refine');
            expect(current.isRefining).toBe(false);
            expect(current.alphaThreshold).toBe(160);
            expect(current.manifest?.mask_revision).toBe(3);
            expect(current.edits).toEqual([]);
        });
        expect(URL.revokeObjectURL).toHaveBeenCalled();
    });

    it('kéo liên tục công bố frame trung gian rồi chốt CutContour mới nhất', async () => {
        const sessionId = '9'.repeat(32);
        vi.mocked(inspectStickerSource).mockResolvedValue(inspection(sessionId));
        vi.mocked(detectStickerSource).mockResolvedValue(aiDetection(1, 128, sessionId));
        useStickerSheetStore.getState().selectSource(
            'tab-cutline-live',
            new File(['image'], 'sheet.png', { type: 'image/png' }),
        );
        await useStickerSheetStore.getState().detectStickers('tab-cutline-live', 'ai');
        await vi.waitFor(() => expect(previewStickerCutline).toHaveBeenCalledTimes(1));
        await vi.waitFor(() => expect(
            useStickerSheetStore.getState().getTab('tab-cutline-live').isCutlinePreviewing,
        ).toBe(false));

        vi.mocked(previewStickerCutline).mockClear();
        let resolveFirst!: (payload: Awaited<ReturnType<typeof previewStickerCutline>>) => void;
        let resolveSecond!: (payload: Awaited<ReturnType<typeof previewStickerCutline>>) => void;
        vi.mocked(previewStickerCutline)
            .mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }))
            .mockImplementationOnce(() => new Promise(resolve => { resolveSecond = resolve; }));

        useStickerSheetStore.getState().setCutlineTuning(
            'tab-cutline-live',
            { smoothness: 15 },
        );
        await vi.waitFor(() => expect(previewStickerCutline).toHaveBeenCalledTimes(1));
        useStickerSheetStore.getState().setCutlineTuning(
            'tab-cutline-live',
            { smoothness: 90, tension: 80 },
        );
        resolveFirst({
            page_number: 1, mask_revision: 1,
            preview_width_px: 120, preview_height_px: 80,
            paths: [{ instance_id: 1, d: 'M 1 1 C 2 2 3 3 4 4 Z', segment_count: 1 }],
            fingerprint: 'a'.repeat(64), segment_count: 1,
        });

        await vi.waitFor(() => expect(previewStickerCutline).toHaveBeenCalledTimes(2));
        expect(vi.mocked(previewStickerCutline).mock.calls[1][1]).toMatchObject({
            cutlineSmoothness: 90,
            curveTension: 80,
        });
        await vi.waitFor(() => {
            const current = useStickerSheetStore.getState().getTab('tab-cutline-live');
            expect(current.isCutlinePreviewing).toBe(true);
            expect(current.cutlinePreview?.fingerprint).toBe('a'.repeat(64));
        });
        resolveSecond({
            page_number: 1, mask_revision: 1,
            preview_width_px: 120, preview_height_px: 80,
            paths: [{ instance_id: 1, d: 'M 9 9 C 8 8 7 7 6 6 Z', segment_count: 1 }],
            fingerprint: 'b'.repeat(64), segment_count: 1,
        });
        await vi.waitFor(() => {
            const current = useStickerSheetStore.getState().getTab('tab-cutline-live');
            expect(current.isCutlinePreviewing).toBe(false);
            expect(current.cutlinePreview?.fingerprint).toBe('b'.repeat(64));
            expect(current.cutlineSmoothness).toBe(90);
            expect(current.curveTension).toBe(80);
        });
    });

    it('dựng preview đường bế ngay cho nguồn vector, không hiển thị biên mask pixel', async () => {
        const sessionId = 'v'.repeat(32);
        const payload = detection(sessionId);
        payload.manifest.boundary_source = 'vector';
        payload.manifest.vector_geometry_ref = {
            kind: 'pdf-vector-source',
            exact_shapes: [{ instance_id: 1, kind: 'circle' }],
        };
        vi.mocked(inspectStickerSource).mockResolvedValue(inspection(sessionId));
        vi.mocked(detectStickerSource).mockResolvedValue(payload);

        useStickerSheetStore.getState().selectSource(
            'tab-vector-preview',
            new File(['pdf'], 'sheet.pdf', { type: 'application/pdf' }),
        );
        await useStickerSheetStore.getState().detectStickers('tab-vector-preview', 'auto');

        await vi.waitFor(() => expect(previewStickerCutline).toHaveBeenCalledTimes(1));
        await vi.waitFor(() => expect(
            useStickerSheetStore.getState().getTab('tab-vector-preview').isCutlinePreviewing,
        ).toBe(false));
    });

    it('không dựng lại CutContour khi chỉ đổi màu, cách tách trang hoặc tràn lề không dời dao', async () => {
        const sessionId = '8'.repeat(32);
        vi.mocked(inspectStickerSource).mockResolvedValue(inspection(sessionId));
        vi.mocked(detectStickerSource).mockResolvedValue(aiDetection(1, 128, sessionId));
        useStickerSheetStore.getState().selectSource(
            'tab-cutline-output-only',
            new File(['image'], 'sheet.png', { type: 'image/png' }),
        );
        await useStickerSheetStore.getState().detectStickers('tab-cutline-output-only', 'ai');
        await vi.waitFor(() => expect(previewStickerCutline).toHaveBeenCalledTimes(1));
        await vi.waitFor(() => expect(
            useStickerSheetStore.getState().getTab('tab-cutline-output-only').isCutlinePreviewing,
        ).toBe(false));

        vi.mocked(previewStickerCutline).mockClear();
        const before = useStickerSheetStore.getState().getTab('tab-cutline-output-only');
        useStickerSheetStore.getState().setOutputSettings('tab-cutline-output-only', {
            ...before.outputSettings,
            bleedColorType: 'solid',
            solidBleedCmyk: [35, 0, 0, 0],
            cropToSticker: !before.outputSettings.cropToSticker,
        });
        useStickerSheetStore.getState().setOutputSettings('tab-cutline-output-only', {
            bleedMm: before.outputSettings.bleedMm + 1,
        });

        const outputOnly = useStickerSheetStore.getState().getTab('tab-cutline-output-only');
        expect(outputOnly.isCutlinePreviewing).toBe(false);
        expect(outputOnly.cutlinePreview).toBe(before.cutlinePreview);
        expect(previewStickerCutline).not.toHaveBeenCalled();

        useStickerSheetStore.getState().setOutputSettings('tab-cutline-output-only', {
            cutMode: 'bleed',
        });
        expect(useStickerSheetStore.getState().getTab('tab-cutline-output-only').isCutlinePreviewing)
            .toBe(true);
        await vi.waitFor(() => expect(previewStickerCutline).toHaveBeenCalledTimes(1));
    });

    it('trả slider về preview đã áp dụng khi backend từ chối topology mới', async () => {
        const sessionId = 'b'.repeat(32);
        vi.mocked(inspectStickerSource).mockResolvedValue(inspection(sessionId));
        vi.mocked(detectStickerSource).mockResolvedValue(aiDetection(1, 128, sessionId));
        vi.mocked(refineStickerSource).mockRejectedValue(
            new Error('Mức bám biên này làm thay đổi số lượng tem.'),
        );
        useStickerSheetStore.getState().selectSource(
            'tab-reject',
            new File(['image'], 'sheet.png', { type: 'image/png' }),
        );
        await useStickerSheetStore.getState().detectStickers('tab-reject', 'ai');
        useStickerSheetStore.getState().addStroke('tab-reject', {
            tool: 'erase', instanceId: 1, radius: 0.01, points: [{ x: 0.2, y: 0.3 }],
        });
        useStickerSheetStore.getState().setMaskTuning('tab-reject', { alphaThreshold: 176 });

        await vi.waitFor(() => {
            const current = useStickerSheetStore.getState().getTab('tab-reject');
            expect(current.isRefining).toBe(false);
            expect(current.alphaThreshold).toBe(128);
            expect(current.manifest?.mask_revision).toBe(1);
            expect(current.error).toContain('thay đổi số lượng tem');
            expect(current.edits).toHaveLength(1);
        });
    });

    it('chỉ đánh dấu trang lỗi khi revision mới không tải đủ asset', async () => {
        const sessionId = 'c'.repeat(32);
        vi.mocked(inspectStickerSource).mockResolvedValue(inspection(sessionId));
        vi.mocked(detectStickerSource).mockResolvedValue(aiDetection(1, 128, sessionId));
        const syncError = Object.assign(
            new Error('Không đồng bộ được ảnh xem trước mới. Hãy phân tích lại ảnh.'),
            {
                name: 'StickerRefineAssetSyncError',
                manifest: aiDetection(2, 150, sessionId).manifest,
            },
        );
        vi.mocked(refineStickerSource).mockRejectedValue(syncError);
        const source = new File(['image'], 'sheet.png', { type: 'image/png' });
        useStickerSheetStore.getState().selectSource('tab-sync', source);
        await useStickerSheetStore.getState().detectStickers('tab-sync', 'ai');
        useStickerSheetStore.getState().setMaskTuning('tab-sync', { alphaThreshold: 150 });

        await vi.waitFor(() => {
            const current = useStickerSheetStore.getState().getTab('tab-sync');
            expect(current.status).toBe('error');
            expect(current.isRefining).toBe(false);
            expect(current.sourceFile).toBe(source);
            expect(current.inspection?.session_id).toBe(sessionId);
            expect(current.manifest).toBeNull();
            expect(current.error).toContain('phân tích lại');
        });
        expect(closeStickerSheetSession).not.toHaveBeenCalledWith(sessionId);
    });

    it('nhận diện tất cả nhưng giữ mask, edit và export contract riêng từng trang', async () => {
        const sessionId = 'd'.repeat(32);
        vi.mocked(inspectStickerSource).mockResolvedValue(multiPageInspection(2, sessionId));
        vi.mocked(detectStickerSource).mockImplementation(async (_sessionId, options) => (
            detectionForPage(options?.pageNumber || 1, sessionId)
        ));
        vi.mocked(exportStickerSheet).mockResolvedValue({
            blob: new Blob(['pdf']), filename: 'batch.pdf', stickerCount: 2,
        });
        useStickerSheetStore.getState().selectSource(
            'tab-multi',
            new File(['pdf'], 'batch.pdf', { type: 'application/pdf' }),
        );

        await useStickerSheetStore.getState().detectAllStickers('tab-multi', 'ai');

        const detected = useStickerSheetStore.getState().getTab('tab-multi');
        expect(detected.pages[1].status).toBe('mask-review');
        expect(detected.pages[2].status).toBe('mask-review');
        expect(vi.mocked(detectStickerSource).mock.calls.map(call => call[1]?.pageNumber).sort()).toEqual([1, 2]);

        useStickerSheetStore.getState().setActivePage('tab-multi', 1);
        useStickerSheetStore.getState().addStroke('tab-multi', {
            tool: 'erase', instanceId: 1, radius: 0.01, points: [{ x: 0.2, y: 0.3 }],
        });
        useStickerSheetStore.getState().setActivePage('tab-multi', 2);
        const pageTwoActive = useStickerSheetStore.getState().getTab('tab-multi');
        expect(pageTwoActive.edits).toEqual([]);
        expect(pageTwoActive.pages[1].edits).toHaveLength(1);

        await useStickerSheetStore.getState().confirmMask('tab-multi', 1);
        await useStickerSheetStore.getState().confirmMask('tab-multi', 2);
        await useStickerSheetStore.getState().exportFile('tab-multi', 'pdf', [2, 1]);

        expect(exportStickerSheet).toHaveBeenCalledWith(
            sessionId,
            expect.objectContaining({
                pageOrder: [2, 1],
                pages: [
                    expect.objectContaining({ sourcePage: 2, edits: [] }),
                    expect.objectContaining({ sourcePage: 1, edits: [expect.objectContaining({ kind: 'stroke' })] }),
                ],
            }),
        );
    });

    it('workspace materialize hai trang và export theo vị trí Working PDF', async () => {
        const sessionId = '7'.repeat(32);
        const rawSource = new File(['raw'], 'raw.pdf', { type: 'application/pdf' });
        const materialized = new File(['working'], 'working.pdf', { type: 'application/pdf' });
        const revision = { id: 'revision-rotated-duplicate' };
        let revisionCurrent = true;
        const prepareWorkspaceSource = vi.fn(async () => ({
            file: materialized,
            revision,
            isCurrent: () => revisionCurrent,
        }));
        vi.mocked(inspectStickerSource).mockResolvedValue(multiPageInspection(2, sessionId));
        vi.mocked(detectStickerSource).mockImplementation(async (_sessionId, options) => (
            detectionForPage(options?.pageNumber || 1, sessionId)
        ));
        vi.mocked(exportStickerSheet).mockResolvedValue({
            blob: new Blob(['pdf']), filename: 'working-output.pdf', stickerCount: 2,
        });
        useStickerSheetStore.getState().selectSource(
            'tab-working',
            rawSource,
            'workspace',
        );

        await useStickerSheetStore.getState().detectAllStickers(
            'tab-working',
            'ai',
            prepareWorkspaceSource,
        );

        const detected = useStickerSheetStore.getState().getTab('tab-working');
        expect(detected.sourceFile).toBe(materialized);
        expect(detected.sourceRevision).toBe(revision);
        expect(inspectStickerSource).toHaveBeenCalledWith(
            materialized,
            expect.any(AbortSignal),
            { preview: 'defer' },
        );
        expect(vi.mocked(detectStickerSource).mock.calls.map(
            call => call[1]?.pageNumber,
        ).sort()).toEqual([1, 2]);
        await useStickerSheetStore.getState().confirmMask('tab-working', 1);
        await useStickerSheetStore.getState().confirmMask('tab-working', 2);
        await useStickerSheetStore.getState().exportFile(
            'tab-working',
            'pdf',
            [1, 2],
            prepareWorkspaceSource,
        );

        expect(exportStickerSheet).toHaveBeenCalledWith(
            sessionId,
            expect.objectContaining({
                pageOrder: [1, 2],
                pages: [
                    expect.objectContaining({ sourcePage: 1 }),
                    expect.objectContaining({ sourcePage: 2 }),
                ],
            }),
        );
        revisionCurrent = false;
    });

    it('revision đổi khi detect đang chạy thì không publish mask stale', async () => {
        const sessionId = '8'.repeat(32);
        const materialized = new File(['working'], 'working.pdf', { type: 'application/pdf' });
        const revision = { id: 'revision-before-edit' };
        let revisionCurrent = true;
        const prepareWorkspaceSource = vi.fn(async () => ({
            file: materialized,
            revision,
            isCurrent: () => revisionCurrent,
        }));
        vi.mocked(inspectStickerSource).mockResolvedValue(inspection(sessionId));
        let resolveDetect!: (value: StickerSourceDetectionPayload) => void;
        vi.mocked(detectStickerSource).mockImplementationOnce(() => new Promise(resolve => {
            resolveDetect = resolve;
        }));
        useStickerSheetStore.getState().selectSource(
            'tab-revision-stale',
            new File(['raw'], 'raw.pdf', { type: 'application/pdf' }),
            'workspace',
        );

        const pending = useStickerSheetStore.getState().detectStickers(
            'tab-revision-stale',
            'ai',
            1,
            prepareWorkspaceSource,
        );
        await vi.waitFor(() => expect(detectStickerSource).toHaveBeenCalledTimes(1));
        revisionCurrent = false;
        resolveDetect(detection(sessionId));
        await pending;

        const tab = useStickerSheetStore.getState().getTab('tab-revision-stale');
        expect(tab.sourceFile).toBe(materialized);
        expect(tab.sourceRevision).toBeNull();
        expect(tab.inspection).toBeNull();
        expect(tab.manifest).toBeNull();
        expect(tab.status).toBe('source-ready');
        expect(tab.error).toContain('Tài liệu đã thay đổi');
    });

    it('nguồn explicit không gọi preparer workspace và không bị thay thế', async () => {
        prepareSuccessfulFlow();
        const explicit = new File(['image'], 'explicit.png', { type: 'image/png' });
        const prepareWorkspaceSource = vi.fn(async () => {
            throw new Error('Không được gọi preparer cho nguồn explicit');
        });
        useStickerSheetStore.getState().selectSource('tab-explicit-owner', explicit);

        await useStickerSheetStore.getState().detectStickers(
            'tab-explicit-owner',
            'auto',
            1,
            prepareWorkspaceSource,
        );

        const tab = useStickerSheetStore.getState().getTab('tab-explicit-owner');
        expect(prepareWorkspaceSource).not.toHaveBeenCalled();
        expect(tab.sourceFile).toBe(explicit);
        expect(tab.sourceOrigin).toBe('explicit');
        expect(tab.manifest).not.toBeNull();
    });

    it('một trang detect lỗi không xóa kết quả sibling hoặc đóng session tài liệu', async () => {
        const sessionId = 'e'.repeat(32);
        vi.mocked(inspectStickerSource).mockResolvedValue(multiPageInspection(2, sessionId));
        vi.mocked(detectStickerSource).mockImplementation(async (_sessionId, options) => {
            if (options?.pageNumber === 2) throw new Error('Trang 2 hỏng');
            return detectionForPage(1, sessionId);
        });
        useStickerSheetStore.getState().selectSource(
            'tab-partial',
            new File(['pdf'], 'batch.pdf', { type: 'application/pdf' }),
        );

        await useStickerSheetStore.getState().detectAllStickers('tab-partial', 'ai');

        const tab = useStickerSheetStore.getState().getTab('tab-partial');
        expect(tab.inspection?.session_id).toBe(sessionId);
        expect(tab.pages[1].status).toBe('mask-review');
        expect(tab.pages[1].manifest?.source_page).toBe(1);
        expect(tab.pages[2].status).toBe('error');
        expect(tab.pages[2].error).toContain('Trang 2 hỏng');
        expect(closeStickerSheetSession).not.toHaveBeenCalledWith(sessionId);
    });

    it('giữ CutContour gốc bằng payload trung tính cho tới khi người dùng đổi thiết lập', async () => {
        const source = inspection('f'.repeat(32));
        source.inspection.source_kind = 'pdf';
        source.inspection.boundary_source = 'existing-cut';
        source.inspection.has_existing_cut = true;
        source.inspection.cut_contour_count = 1;
        const detected = detection('f'.repeat(32));
        detected.manifest.source_kind = 'pdf';
        detected.manifest.boundary_source = 'existing-cut';
        detected.manifest.vector_geometry_ref = {
            kind: 'pdf-cut-contours',
            preserve_original: true,
        };
        vi.mocked(inspectStickerSource).mockResolvedValue(source);
        vi.mocked(detectStickerSource).mockResolvedValue(detected);
        vi.mocked(exportStickerSheet).mockResolvedValue({
            blob: new Blob(['pdf']), filename: 'giu-nguyen.pdf', stickerCount: 1,
        });

        useStickerSheetStore.getState().selectSource(
            'tab-vector', new File(['pdf'], 'cut.pdf', { type: 'application/pdf' }),
        );
        await useStickerSheetStore.getState().detectStickers('tab-vector');
        await useStickerSheetStore.getState().confirmMask('tab-vector');
        await useStickerSheetStore.getState().exportFile('tab-vector');

        expect(exportStickerSheet).toHaveBeenLastCalledWith(
            'f'.repeat(32),
            expect.objectContaining({
                cutMode: 'original',
                offsetMm: 0,
                bleedMm: 0,
                cornerStyle: 'preserve',
                cropToSticker: false,
                preserveExistingCut: true,
            }),
        );
        useStickerSheetStore.getState().finishExport('tab-vector');

        useStickerSheetStore.getState().setOutputSettings('tab-vector', { offsetMm: 1 });
        await useStickerSheetStore.getState().exportFile('tab-vector');
        expect(exportStickerSheet).toHaveBeenLastCalledWith(
            'f'.repeat(32),
            expect.objectContaining({
                offsetMm: 1,
                cropToSticker: true,
                preserveExistingCut: false,
            }),
        );
        useStickerSheetStore.getState().finishExport('tab-vector');
    });

    it('thiếu DPI giữ quy ước 72 DPI của cửa mở ảnh', async () => {
        prepareSuccessfulFlow('b'.repeat(32), null);
        useStickerSheetStore.getState().selectSource(
            'tab-no-dpi', new File(['image'], 'sheet.png', { type: 'image/png' }),
        );
        await useStickerSheetStore.getState().detectStickers('tab-no-dpi');
        const tab = useStickerSheetStore.getState().getTab('tab-no-dpi');
        expect(tab.outputDpi).toBe(72);
        expect(tab.outputDpiY).toBe(72);
    });

    it('đổi nguồn trong lúc inspect loại kết quả stale và đóng session cũ', async () => {
        let resolveInspect!: (value: StickerSourceInspectPayload) => void;
        vi.mocked(inspectStickerSource).mockImplementationOnce(() => new Promise(resolve => {
            resolveInspect = resolve;
        }));
        const first = new File(['first'], 'first.png', { type: 'image/png' });
        const second = new File(['second'], 'second.pdf', { type: 'application/pdf' });
        useStickerSheetStore.getState().selectSource('tab-stale', first);

        const pending = useStickerSheetStore.getState().inspectSource('tab-stale');
        useStickerSheetStore.getState().selectSource('tab-stale', second);
        resolveInspect(inspection('c'.repeat(32)));
        await pending;

        const tab = useStickerSheetStore.getState().getTab('tab-stale');
        expect(tab.sourceFile).toBe(second);
        expect(tab.inspection).toBeNull();
        expect(closeStickerSheetSession).toHaveBeenCalledWith('c'.repeat(32));
    });

    it('đổi nguồn trong lúc detect không ghi đè tab mới', async () => {
        vi.mocked(inspectStickerSource).mockResolvedValue(inspection('d'.repeat(32)));
        let resolveDetect!: (value: StickerSourceDetectionPayload) => void;
        vi.mocked(detectStickerSource).mockImplementationOnce(() => new Promise(resolve => {
            resolveDetect = resolve;
        }));
        const first = new File(['first'], 'first.png', { type: 'image/png' });
        const second = new File(['second'], 'second.png', { type: 'image/png' });
        useStickerSheetStore.getState().selectSource('tab-stale', first);

        const pending = useStickerSheetStore.getState().detectStickers('tab-stale');
        await vi.waitFor(() => expect(detectStickerSource).toHaveBeenCalledTimes(1));
        useStickerSheetStore.getState().selectSource('tab-stale', second);
        resolveDetect(detection('d'.repeat(32)));
        await pending;

        const tab = useStickerSheetStore.getState().getTab('tab-stale');
        expect(tab.sourceFile).toBe(second);
        expect(tab.manifest).toBeNull();
        expect(closeStickerSheetSession).toHaveBeenCalledWith('d'.repeat(32));
    });

    it('chặn click detect lặp khi request đầu còn chạy', async () => {
        vi.mocked(inspectStickerSource).mockResolvedValue(inspection());
        let resolveDetect!: (value: StickerSourceDetectionPayload) => void;
        vi.mocked(detectStickerSource).mockImplementationOnce(() => new Promise(resolve => {
            resolveDetect = resolve;
        }));
        useStickerSheetStore.getState().selectSource(
            'tab-once', new File(['image'], 'sheet.png', { type: 'image/png' }),
        );

        const first = useStickerSheetStore.getState().detectStickers('tab-once');
        await vi.waitFor(() => expect(detectStickerSource).toHaveBeenCalledTimes(1));
        const second = useStickerSheetStore.getState().detectStickers('tab-once');
        resolveDetect(detection());
        await Promise.all([first, second]);
        expect(detectStickerSource).toHaveBeenCalledTimes(1);
    });

    it('hai tab giữ nguồn, session và kết quả độc lập', async () => {
        vi.mocked(inspectStickerSource)
            .mockResolvedValueOnce(inspection('1'.repeat(32)))
            .mockResolvedValueOnce(inspection('2'.repeat(32)));
        vi.mocked(detectStickerSource)
            .mockResolvedValueOnce(detection('1'.repeat(32)))
            .mockResolvedValueOnce(detection('2'.repeat(32)));
        useStickerSheetStore.getState().selectSource('tab-1', new File(['1'], 'one.png'));
        useStickerSheetStore.getState().selectSource('tab-2', new File(['2'], 'two.pdf'));

        await Promise.all([
            useStickerSheetStore.getState().detectStickers('tab-1'),
            useStickerSheetStore.getState().detectStickers('tab-2'),
        ]);

        expect(useStickerSheetStore.getState().getTab('tab-1').manifest?.session_id).toBe('1'.repeat(32));
        expect(useStickerSheetStore.getState().getTab('tab-2').manifest?.session_id).toBe('2'.repeat(32));
    });

    it('sửa mask sau xác nhận buộc xác nhận lại', async () => {
        prepareSuccessfulFlow();
        useStickerSheetStore.getState().selectSource('tab', new File(['image'], 'sheet.png'));
        await useStickerSheetStore.getState().detectStickers('tab');
        await useStickerSheetStore.getState().confirmMask('tab');

        useStickerSheetStore.getState().addStroke('tab', {
            tool: 'erase', instanceId: 1, radius: 0.02, points: [{ x: 0.2, y: 0.3 }],
        });
        expect(useStickerSheetStore.getState().getTab('tab').status).toBe('mask-review');
    });

    it('khóa sửa mask và reset trong lúc backend đang xác nhận', async () => {
        prepareSuccessfulFlow();
        let resolveConfirm!: (value: boolean) => void;
        vi.mocked(confirmStickerSource).mockImplementationOnce(() => new Promise(resolve => {
            resolveConfirm = resolve;
        }));
        useStickerSheetStore.getState().selectSource('tab-confirming', new File(['image'], 'sheet.png'));
        await useStickerSheetStore.getState().detectStickers('tab-confirming');
        useStickerSheetStore.getState().addStroke('tab-confirming', {
            tool: 'erase', instanceId: 1, radius: 0.02, points: [{ x: 0.2, y: 0.3 }],
        });
        const before = useStickerSheetStore.getState().getTab('tab-confirming');

        const pending = useStickerSheetStore.getState().confirmMask('tab-confirming');
        useStickerSheetStore.getState().undo('tab-confirming');
        useStickerSheetStore.getState().addStroke('tab-confirming', {
            tool: 'restore', instanceId: 1, radius: 0.01, points: [{ x: 0.4, y: 0.5 }],
        });
        useStickerSheetStore.getState().resetAnalysis('tab-confirming');

        const locked = useStickerSheetStore.getState().getTab('tab-confirming');
        expect(locked.status).toBe('confirming');
        expect(locked.sourceFile).toBe(before.sourceFile);
        expect(locked.edits).toEqual(before.edits);

        resolveConfirm(true);
        await pending;
        expect(useStickerSheetStore.getState().getTab('tab-confirming').status).toBe('mask-ready');
    });

    it('khóa sửa mask và reset trong lúc đang xuất artifact', async () => {
        prepareSuccessfulFlow();
        let resolveExport!: (value: {
            blob: Blob;
            filename: string;
            stickerCount: number;
        }) => void;
        vi.mocked(exportStickerSheet).mockImplementationOnce(() => new Promise(resolve => {
            resolveExport = resolve;
        }));
        useStickerSheetStore.getState().selectSource('tab-exporting', new File(['image'], 'sheet.png'));
        await useStickerSheetStore.getState().detectStickers('tab-exporting');
        await useStickerSheetStore.getState().confirmMask('tab-exporting');
        const before = useStickerSheetStore.getState().getTab('tab-exporting');

        const pending = useStickerSheetStore.getState().exportFile('tab-exporting');
        useStickerSheetStore.getState().addStroke('tab-exporting', {
            tool: 'erase', instanceId: 1, radius: 0.02, points: [{ x: 0.2, y: 0.3 }],
        });
        useStickerSheetStore.getState().resetAnalysis('tab-exporting');

        const locked = useStickerSheetStore.getState().getTab('tab-exporting');
        expect(locked.status).toBe('exporting');
        expect(locked.sourceFile).toBe(before.sourceFile);
        expect(locked.edits).toEqual(before.edits);

        resolveExport({ blob: new Blob(['pdf']), filename: 'tem.pdf', stickerCount: 1 });
        await pending;
        expect(useStickerSheetStore.getState().getTab('tab-exporting').status).toBe('exporting');
        useStickerSheetStore.getState().selectSource(
            'tab-exporting',
            new File(['new'], 'new-sheet.png'),
        );
        useStickerSheetStore.getState().setOutputSettings('tab-exporting', { offsetMm: 2 });
        const waitingForCommit = useStickerSheetStore.getState().getTab('tab-exporting');
        expect(waitingForCommit.sourceFile).toBe(before.sourceFile);
        expect(waitingForCommit.outputSettings.offsetMm).toBe(before.outputSettings.offsetMm);
        useStickerSheetStore.getState().finishExport('tab-exporting');
        expect(useStickerSheetStore.getState().getTab('tab-exporting').status).toBe('mask-ready');
    });

    it('preview native path-backed dùng protocol localfile thay vì Blob rỗng', () => {
        const file = new File([], 'sheet.png', { type: 'image/png' });
        Object.defineProperty(file, 'path', { value: 'D:\\jobs\\sheet.png' });

        useStickerSheetStore.getState().selectSource('tab-native', file);

        expect(useStickerSheetStore.getState().getTab('tab-native').sourcePreviewUrl)
            .toBe('http://localfile.localhost/D%3A%5Cjobs%5Csheet.png');
        expect(URL.createObjectURL).not.toHaveBeenCalled();
    });

    it('reset thu hồi URL và đóng đúng session backend một lần', async () => {
        prepareSuccessfulFlow();
        useStickerSheetStore.getState().selectSource('tab', new File(['image'], 'sheet.png'));
        await useStickerSheetStore.getState().detectStickers('tab');

        useStickerSheetStore.getState().resetAnalysis('tab');

        expect(closeStickerSheetSession).toHaveBeenCalledWith('a'.repeat(32));
        expect(closeStickerSheetSession).toHaveBeenCalledTimes(1);
        expect(useStickerSheetStore.getState().getTab('tab').status).toBe('idle');
    });

    it('export lỗi sau dispose không hồi sinh tab đã đóng', async () => {
        prepareSuccessfulFlow();
        let rejectExport!: (reason?: unknown) => void;
        vi.mocked(exportStickerSheet).mockImplementationOnce(() => new Promise((_resolve, reject) => {
            rejectExport = reject;
        }));
        useStickerSheetStore.getState().selectSource('tab-disposed', new File(['image'], 'sheet.png'));
        await useStickerSheetStore.getState().detectStickers('tab-disposed');
        await useStickerSheetStore.getState().confirmMask('tab-disposed');

        const pending = useStickerSheetStore.getState().exportFile('tab-disposed');
        useStickerSheetStore.getState().disposeTab('tab-disposed');
        rejectExport(new Error('export failed'));
        await pending;

        expect(useStickerSheetStore.getState().tabs['tab-disposed']).toBeUndefined();
    });
});
