import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiMocks = vi.hoisted(() => ({
    authenticatedFetch: vi.fn(),
    getApiUrl: vi.fn(() => 'http://127.0.0.1:8321/api'),
    formatApiErrorDetail: vi.fn((_detail: unknown, fallback: string) => fallback),
}));

vi.mock('./api', () => apiMocks);

import {
    confirmStickerSource,
    detectStickerSource,
    exportStickerSheet,
    previewStickerCutline,
    refineStickerSource,
    type StickerSourceDetection,
} from './stickerSheetApi';


function detectionManifest(pageNumber: number, revision = 1): StickerSourceDetection {
    const query = `v=${revision}&page=${pageNumber}`;
    return {
        session_id: '0123456789abcdef0123456789abcdef',
        stage: 'mask-review',
        original_name: 'batch.pdf',
        source_kind: 'pdf',
        boundary_source: 'ai',
        strategy_confidence: 0.9,
        needs_review: true,
        page_count: 3,
        source_page: pageNumber,
        original_width_px: 120,
        original_height_px: 80,
        analysis_width_px: 120,
        analysis_height_px: 80,
        preview_width_px: 120,
        preview_height_px: 80,
        dpi: [300, 300],
        model: 'birefnet-lite',
        model_seconds: 0.1,
        postprocess_seconds: 0.2,
        mask_revision: revision,
        refinement_available: true,
        alpha_threshold: 128,
        shadow_cleanup: 'auto',
        instances: [{
            id: 1, x: 1, y: 1, width: 10, height: 10,
            area_px: 100, confidence: 0.9, uncertain_ratio: 0,
        }],
        warnings: [],
        vector_geometry_ref: null,
        preview_url: `/api/sticker-sheet/session/assets/preview?${query}`,
        labels_url: `/api/sticker-sheet/session/assets/labels?${query}`,
        uncertainty_url: `/api/sticker-sheet/session/assets/uncertainty?${query}`,
    };
}

function responseJson(payload: unknown): Response {
    return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
}

describe('stickerSheetApi — hợp đồng theo trang', () => {
    beforeEach(() => {
        apiMocks.authenticatedFetch.mockReset();
        apiMocks.getApiUrl.mockReturnValue('http://127.0.0.1:8321/api');
    });

    it('detect gửi page_number và tải asset có định danh đúng trang', async () => {
        const manifest = detectionManifest(2);
        apiMocks.authenticatedFetch.mockImplementation(async (url: string) => {
            if (url.endsWith('/detect')) return responseJson(manifest);
            return new Response(new Blob(['png'], { type: 'image/png' }), { status: 200 });
        });

        const payload = await detectStickerSource(manifest.session_id, { pageNumber: 2 });

        const detectInit = apiMocks.authenticatedFetch.mock.calls[0][1] as RequestInit;
        expect(JSON.parse(String(detectInit.body))).toMatchObject({ page_number: 2 });
        expect(payload.manifest.source_page).toBe(2);
        expect(apiMocks.authenticatedFetch.mock.calls.slice(1).map(call => call[0])).toEqual([
            'http://127.0.0.1:8321/api/sticker-sheet/session/assets/preview?v=1&page=2',
            'http://127.0.0.1:8321/api/sticker-sheet/session/assets/labels?v=1&page=2',
            'http://127.0.0.1:8321/api/sticker-sheet/session/assets/uncertainty?v=1&page=2',
        ]);
    });

    it('refine và confirm luôn gửi trang nguồn rõ ràng', async () => {
        const manifest = detectionManifest(3, 2);
        apiMocks.authenticatedFetch.mockImplementation(async (url: string) => {
            if (url.endsWith('/refine')) return responseJson(manifest);
            if (url.endsWith('/confirm')) {
                return responseJson({
                    stage: 'mask-ready', mask_confirmed: true, source_page: 3,
                });
            }
            return new Response(new Blob(['png'], { type: 'image/png' }), { status: 200 });
        });

        await refineStickerSource(manifest.session_id, {
            alphaThreshold: 144,
            shadowCleanup: 'auto',
            baseRevision: 1,
            pageNumber: 3,
        });
        const refineInit = apiMocks.authenticatedFetch.mock.calls[0][1] as RequestInit;
        expect(JSON.parse(String(refineInit.body))).toMatchObject({
            page_number: 3,
            alpha_threshold: 144,
            base_revision: 1,
        });

        apiMocks.authenticatedFetch.mockClear();
        const confirmed = await confirmStickerSource(manifest.session_id, { pageNumber: 3 });
        const confirmInit = apiMocks.authenticatedFetch.mock.calls[0][1] as RequestInit;
        expect(confirmed).toBe(true);
        expect(JSON.parse(String(confirmInit.body))).toEqual({ page_number: 3 });
    });

    it('export gửi revision, edit và thứ tự thumbnail theo từng trang', async () => {
        apiMocks.authenticatedFetch.mockResolvedValue(new Response(new Blob(['pdf']), {
            status: 200,
            headers: {
                'Content-Disposition': 'attachment; filename="tem.pdf"',
                'X-Sticker-Sheet-Count': '2',
            },
        }));

        await exportStickerSheet('0123456789abcdef0123456789abcdef', {
            edits: [],
            pages: [{
                sourcePage: 2,
                expectedRevision: 4,
                dpi: 300,
                dpiY: 150,
                edits: [{
                    kind: 'merge', id: 'merge-1', sourceId: 4, targetId: 2,
                }],
            }],
            pageOrder: [2, 2],
            dpi: 300,
            offsetMm: 0,
            bleedMm: 2,
        });

        const init = apiMocks.authenticatedFetch.mock.calls[0][1] as RequestInit;
        expect(JSON.parse(String(init.body))).toMatchObject({
            page_order: [2, 2],
            pages: [{
                source_page: 2,
                expected_revision: 4,
                dpi: 300,
                dpi_y: 150,
                cutline_smoothness: 50,
                cutline_fidelity: 50,
                curve_tension: 50,
                min_detail_area_mm2: 1,
                edits: [{
                    kind: 'merge', id: 'merge-1', source_id: 4, target_id: 2,
                }],
            }],
        });
    });

    it('preview CutContour gửi đủ tuning và edit đang hiển thị', async () => {
        apiMocks.authenticatedFetch.mockResolvedValue(responseJson({
            page_number: 2,
            mask_revision: 4,
            preview_width_px: 120,
            preview_height_px: 80,
            paths: [{ instance_id: 1, d: 'M 1 1 C 2 2 3 3 4 4 Z', segment_count: 1 }],
            fingerprint: 'a'.repeat(64),
            segment_count: 1,
        }));

        await previewStickerCutline('0123456789abcdef0123456789abcdef', {
            baseRevision: 4,
            pageNumber: 2,
            edits: [{
                kind: 'stroke', id: 'stroke-1', tool: 'erase', instanceId: 1,
                radius: 0.01, points: [{ x: 0.2, y: 0.3 }],
            }],
            dpi: 300,
            dpiY: 150,
            offsetMm: -0.2,
            bleedMm: 2,
            cutlineSmoothness: 72,
            cutlineFidelity: 84,
            curveTension: 36,
            minDetailAreaMm2: 1.4,
        });

        const init = apiMocks.authenticatedFetch.mock.calls[0][1] as RequestInit;
        expect(JSON.parse(String(init.body))).toMatchObject({
            base_revision: 4,
            page_number: 2,
            dpi: 300,
            dpi_y: 150,
            offset_mm: -0.2,
            cutline_smoothness: 72,
            cutline_fidelity: 84,
            curve_tension: 36,
            min_detail_area_mm2: 1.4,
            edits: [{
                kind: 'stroke', id: 'stroke-1', tool: 'erase', instance_id: 1,
            }],
        });
    });
});
