// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    createImposerSettingsStore,
    ImposerSettingsContext,
} from './imposition-tools/useImposerSettingsStore';
import { createWorkspaceStore, WorkspaceContext } from '../stores/useWorkspaceStore';
import { useAppSettingsStore } from '../stores/appSettingsStore';
import { useAuthStore } from '../stores/useAuthStore';

const apiMocks = vi.hoisted(() => ({
    authenticatedFetch: vi.fn(),
}));

vi.mock('../lib/api', () => ({
    authenticatedFetch: apiMocks.authenticatedFetch,
    getApiUrl: () => 'http://localhost:8321/api',
}));

import OutputPreviewTab from './OutputPreviewTab';

class OutputPreviewWorkerMock {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;

    postMessage(request: {
        type: string;
        requestId: number;
        width?: number;
        height?: number;
        plates?: Array<{ name: string; color: number[]; isSpot?: boolean }>;
    }) {
        if (request.type !== 'reconstruct') return;
        queueMicrotask(() => this.onmessage?.({
            data: {
                type: 'reconstructed',
                requestId: request.requestId,
                width: request.width,
                height: request.height,
                plates: (request.plates || []).map(plate => ({
                    ...plate,
                    png: new Blob(['plate'], { type: 'image/png' }),
                    alphaBuffer: new Uint8Array([255]).buffer,
                })),
            },
        } as MessageEvent));
    }

    terminate() {}
}

function jsonResponse(data: unknown) {
    return {
        ok: true,
        status: 200,
        json: async () => data,
    } as Response;
}

describe('Output Preview — thứ tự workflow Acrobat', () => {
    beforeEach(() => {
        // TEST (audit 2026-08-11 §REL.QA.ENTITLEMENT): Output Preview là luồng Pro.
        // Khai báo quyền tường minh để test không phụ thuộc feature gate dev/release.
        useAuthStore.setState({ licensePlan: 'pro', licenseFeatures: null });
        useAppSettingsStore.setState({ isWorkspaceSidebarOpen: false, toolMenuWidth: 240 });
        vi.stubGlobal('Worker', OutputPreviewWorkerMock);
        const OriginalUrl = globalThis.URL;
        class UrlWithObjectUrls extends OriginalUrl {
            static createObjectURL = vi.fn(() => 'blob:plate');
            static revokeObjectURL = vi.fn();
        }
        vi.stubGlobal('URL', UrlWithObjectUrls);
        apiMocks.authenticatedFetch.mockImplementation((input: RequestInfo | URL) => {
            const url = String(input);
            if (url.includes('/icc-profiles')) {
                return Promise.resolve(jsonResponse({
                    profiles: [
                        { id: 'fogra39', name: 'FOGRA39', description: '', available: true },
                        { id: 'swop', name: 'SWOP', description: '', available: true },
                    ],
                }));
            }
            if (url.includes('/separations/')) {
                return Promise.resolve(jsonResponse({
                    width: 1,
                    height: 1,
                    render_dpi: 150,
                    plates: [
                        { name: 'Cyan', color: [0, 174, 239], alpha_data: 'eA==', is_spot: false },
                        { name: 'Black', color: [30, 30, 30], alpha_data: 'eA==', is_spot: false },
                        {
                            name: 'Dark Blue',
                            color: [20, 42, 110],
                            alpha_data: 'eA==',
                            is_spot: true,
                            alternate_cmyk_lut: Array.from({ length: 33 }, () => [1, 0.45, 0, 0.3]),
                        },
                    ],
                    spot_inks: [{ name: 'Dark Blue', rgb: [20, 42, 110], coverage_pct: 12.5, is_pantone: false }],
                    detected_spots: ['Dark Blue'],
                    page_has_transparency: true,
                    blending_color_space: 'DeviceCMYK',
                    engine: 'ppe',
                    accuracy: 'rip_separations',
                }));
            }
            if (url.includes('/separation-composite')) {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    headers: new Headers({ 'X-PrynX-Missing-Spot-Alternates': '0' }),
                    blob: async () => new Blob(['subset'], { type: 'image/png' }),
                } as Response);
            }
            if (url.includes('/softproof')) {
                return Promise.resolve(jsonResponse({
                    softproof_b64: 'cHJvb2Y=',
                    gamut_b64: 'Z2FtdXQ=',
                    out_of_gamut_pct: 4.2,
                    profile_name: 'FOGRA39',
                    engine: 'ppe',
                    accuracy: 'rip_softproof',
                }));
            }
            if (url.includes('/page-boxes/')) {
                return Promise.resolve(jsonResponse({
                    page: 1,
                    total_pages: 3,
                    mediabox: { x0: 0, y0: 0, x1: 210, y1: 297, width: 210, height: 297 },
                    cropbox: { x0: 0, y0: 0, x1: 210, y1: 297, width: 210, height: 297 },
                    trimbox: { x0: 3, y0: 3, x1: 207, y1: 294, width: 204, height: 291 },
                    bleedbox: { x0: 0, y0: 0, x1: 210, y1: 297, width: 210, height: 297 },
                    artbox: { x0: 5, y0: 5, x1: 205, y1: 292, width: 200, height: 287 },
                    has_trimbox: true,
                    has_bleedbox: true,
                    has_artbox: false,
                    has_cropbox: true,
                    rotation: 0,
                }));
            }
            throw new Error(`Unexpected request: ${url}`);
        });
    });

    afterEach(() => {
        useAuthStore.setState({ licensePlan: 'free', licenseFeatures: null });
        vi.unstubAllGlobals();
    });

    it('khóa thứ tự section, trạng thái mở và nhóm Process/Spot độc lập', async () => {
        const workspaceStore = createWorkspaceStore();
        const imposerStore = createImposerSettingsStore();
        const onClose = vi.fn();
        const { container } = render(
            <ImposerSettingsContext.Provider value={imposerStore}>
                <WorkspaceContext.Provider value={workspaceStore}>
                    <OutputPreviewTab
                        fileId="file-a"
                        totalPages={3}
                        onClose={onClose}
                        onPlatesChange={workspaceStore.getState().setSeparationPlates}
                    />
                </WorkspaceContext.Provider>
            </ImposerSettingsContext.Provider>,
        );

        await waitFor(() => expect(container.querySelector('[data-plate-group="spot"]')).toBeTruthy());
        await waitFor(() => expect(workspaceStore.getState().outputPreviewActiveViewerPage).toBe(1));

        const sectionOrder = Array.from(
            container.querySelectorAll('[data-output-preview-section]'),
            section => section.getAttribute('data-output-preview-section'),
        );
        expect(sectionOrder).toEqual([
            'simulation',
            'display',
            'separations',
            'sampling',
            'metadata',
            'advanced',
            'actions',
        ]);
        for (const section of container.querySelectorAll('[data-output-preview-section]')) {
            expect(section.classList.contains('shrink-0')).toBe(true);
        }

        expect(screen.getByRole('button', { name: 'Mô phỏng' }).getAttribute('aria-expanded')).toBe('true');
        expect(screen.getByRole('button', { name: 'Bản kẽm' }).getAttribute('aria-expanded')).toBe('true');
        expect(screen.getByRole('button', { name: 'Hiển thị' }).getAttribute('aria-expanded')).toBe('false');
        expect(screen.getByRole('button', { name: 'Sửa file' }).getAttribute('aria-expanded')).toBe('false');
        expect(screen.getByText('Trang 1 / 3')).toBeTruthy();

        const processGroup = container.querySelector('[data-plate-group="process"]') as HTMLElement;
        const spotGroup = container.querySelector('[data-plate-group="spot"]') as HTMLElement;
        expect(within(processGroup).getByText(/Process \(CMYK\)/)).toBeTruthy();
        expect(within(spotGroup).getByText(/Spot/)).toBeTruthy();

        fireEvent.click(within(processGroup).getByRole('button', { name: 'Bỏ chọn tất cả' }));
        expect((within(processGroup).getByRole('checkbox', { name: /Chọn Cyan/ }) as HTMLInputElement).checked).toBe(false);
        expect((within(spotGroup).getByRole('checkbox', { name: /Bỏ chọn Dark Blue/ }) as HTMLInputElement).checked).toBe(true);
        await waitFor(() => expect(workspaceStore.getState().separationPlates).toEqual([
            expect.objectContaining({
                displayMode: 'color-managed-composite',
                pageNum: 1,
                sourcePageNum: 1,
            }),
        ]));
        const compositeCall = apiMocks.authenticatedFetch.mock.calls.find(
            ([request]) => String(request).includes('/separation-composite'),
        );
        expect(compositeCall).toBeTruthy();
        expect(JSON.parse(String(compositeCall?.[1]?.body))).toMatchObject({
            enabled_names: ['Dark Blue'],
            profile_id: 'fogra39',
            intent: 'relative',
        });
        const compositeSignal = compositeCall?.[1]?.signal as AbortSignal;
        fireEvent.click(within(processGroup).getByRole('button', { name: 'Chọn tất cả' }));
        await waitFor(() => expect(workspaceStore.getState().separationPlates).toEqual([]));
        expect(compositeSignal.aborted).toBe(true);

        expect(within(processGroup).queryByText(/CMYK.*→|→.*CMYK/)).toBeNull();
        expect(within(spotGroup).queryByText(/CMYK.*→|→.*CMYK/)).toBeNull();

        fireEvent.click(screen.getByRole('button', { name: 'Lấy mẫu & TAC' }));
        act(() => workspaceStore.getState().setHoveredPdfPosition({
            pageNum: 1,
            x: 0.5,
            y: 0.5,
        }));
        const samplingSection = container.querySelector('[data-output-preview-section="sampling"]') as HTMLElement;
        expect(within(samplingSection).getByText('300%')).toBeTruthy();
        expect(within(samplingSection).getByText('Vùng mẫu: 1 px tại 150 DPI')).toBeTruthy();

        fireEvent.click(screen.getByRole('button', { name: 'Sửa file' }));
        expect(screen.getByRole('button', { name: /Chuyển Dark Blue → CMYK/ })).toBeTruthy();

        fireEvent.click(screen.getByRole('button', { name: 'Quản lý mực' }));
        expect(imposerStore.getState().activeDashboardTool).toBe('inkmanager');
        expect(useAppSettingsStore.getState().isWorkspaceSidebarOpen).toBe(true);
        expect(useAppSettingsStore.getState().toolMenuWidth).toBe(390);
        expect(onClose).toHaveBeenCalledTimes(1);

        fireEvent.click(screen.getByRole('button', { name: 'Hiển thị' }));
        const showSelect = screen.getByRole('combobox', { name: 'Hiển thị (Show)' });
        const previewSelect = screen.getByRole('combobox', { name: 'Xem trước (Preview)' });
        expect(within(showSelect).getAllByRole('option')).toHaveLength(9);
        expect(within(previewSelect).getAllByRole('option')).toHaveLength(2);
        fireEvent.change(showSelect, { target: { value: 'text' } });
        expect(workspaceStore.getState().outputPreviewShowFilter).toBe('text');

        fireEvent.click(screen.getByRole('checkbox', { name: 'Mô phỏng màu giấy (Paper Color)' }));
        fireEvent.click(screen.getByRole('checkbox', { name: 'Mô phỏng mực đen (Black Ink)' }));
        fireEvent.click(screen.getByRole('checkbox', { name: 'Màu vật liệu nền (Background Color)' }));
        fireEvent.change(screen.getByLabelText('Chọn màu vật liệu nền'), {
            target: { value: '#f5f0eb' },
        });
        expect(workspaceStore.getState().outputPreviewSimulatePaperColor).toBe(true);
        expect(workspaceStore.getState().outputPreviewSimulateBlackInk).toBe(true);
        expect(workspaceStore.getState().outputPreviewPageBackgroundRgb).toEqual([245, 240, 235]);

        fireEvent.click(within(processGroup).getByRole('button', { name: 'Bỏ chọn tất cả' }));
        await waitFor(() => expect(workspaceStore.getState().separationPlates).toHaveLength(1));
        fireEvent.change(previewSelect, { target: { value: 'color-warnings' } });
        expect(workspaceStore.getState().outputPreviewMode).toBe('color-warnings');
        await waitFor(() => expect(workspaceStore.getState().separationPlates).toEqual([]));
        await waitFor(() => expect(apiMocks.authenticatedFetch.mock.calls.some(
            ([request]) => String(request).includes('/softproof'),
        )).toBe(true));
        const softProofCall = apiMocks.authenticatedFetch.mock.calls.find(
            ([request]) => String(request).includes('/softproof'),
        );
        expect(JSON.parse(String(softProofCall?.[1]?.body))).toMatchObject({
            page: 1,
            profile_id: 'fogra39',
            intent: 'relative',
            show_gamut_warning: true,
            output_preview_filter: 'text',
            simulate_paper_color: true,
            simulate_black_ink: true,
            page_background_rgb: [245, 240, 235],
        });
        expect(within(container.querySelector('[data-output-preview-section="separations"]') as HTMLElement)
            .getByText(/Bản kẽm tạm ẩn/)).toBeTruthy();

        fireEvent.change(screen.getByRole('slider', { name: 'Độ mờ cảnh báo' }), {
            target: { value: '40' },
        });
        expect(workspaceStore.getState().outputPreviewWarningOpacity).toBe(0.4);
        await waitFor(() => expect(workspaceStore.getState().outputPreviewPageBoxes).toMatchObject({
            viewerPageNum: 1,
            sourcePageNum: 1,
            has_trimbox: true,
            has_bleedbox: true,
            has_artbox: false,
        }));
        const simulationProfile = screen.getAllByRole('combobox')[0];
        fireEvent.change(simulationProfile, { target: { value: 'swop' } });
        await waitFor(() => expect(apiMocks.authenticatedFetch.mock.calls.some(
            ([request]) => String(request).includes('profile_id=swop'),
        )).toBe(true));
        expect(workspaceStore.getState().outputPreviewPageBoxes).toMatchObject({
            viewerPageNum: 1,
            sourcePageNum: 1,
            has_trimbox: true,
            has_bleedbox: true,
        });
        const pageBoxToggle = screen.getByRole('checkbox', { name: 'Hiện khung Art/Trim/Bleed' });
        expect((pageBoxToggle as HTMLInputElement).disabled).toBe(false);
        fireEvent.click(pageBoxToggle);
        expect(workspaceStore.getState().outputPreviewShowPageBoxes).toBe(true);
        expect(within(container.querySelector('[data-output-preview-section="display"]') as HTMLElement)
            .getByText(/TrimBox/)).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'Đặt hộp trang' }));
        expect(imposerStore.getState().activeDashboardTool).toBe('crop');
        expect(onClose).toHaveBeenCalledTimes(2);
    });
});
