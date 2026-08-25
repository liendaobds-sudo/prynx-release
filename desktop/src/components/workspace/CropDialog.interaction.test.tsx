// @vitest-environment jsdom
import type { ComponentProps } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { authenticatedFetch } from '../../lib/api';
import { createWorkspaceStore, WorkspaceContext } from '../../stores/useWorkspaceStore';
import CropDialogComponent from './CropDialog';

vi.mock('../../lib/api', () => ({
    authenticatedFetch: vi.fn(),
    getApiUrl: () => 'http://api',
}));

vi.mock('react-i18next', () => {
    const t = (key: string) => key.split(':').pop() || key;
    return {
        useTranslation: () => ({ t }),
    };
});

const pageBoxes = {
    page: 1,
    total_pages: 3,
    mediabox: { x0: 0, y0: 0, x1: 210, y1: 297, width: 210, height: 297 },
    cropbox: { x0: 0, y0: 0, x1: 210, y1: 297, width: 210, height: 297 },
    trimbox: { x0: 0, y0: 0, x1: 210, y1: 297, width: 210, height: 297 },
    bleedbox: { x0: 0, y0: 0, x1: 210, y1: 297, width: 210, height: 297 },
    artbox: { x0: 0, y0: 0, x1: 210, y1: 297, width: 210, height: 297 },
    rotation: 0,
};

const fakeJsonResponse = (data: unknown, ok = true) => ({
    ok,
    status: ok ? 200 : 500,
    json: async () => data,
    blob: async () => new Blob(['pdf'], { type: 'application/pdf' }),
}) as Response;

let workspaceStore = createWorkspaceStore();

function CropDialog(props: ComponentProps<typeof CropDialogComponent>) {
    return (
        <WorkspaceContext.Provider value={workspaceStore}>
            <CropDialogComponent {...props} />
        </WorkspaceContext.Provider>
    );
}

function openCropDialog(overrides: Record<string, unknown> = {}) {
    act(() => {
        window.dispatchEvent(new CustomEvent('prynx-crop-open', {
            detail: {
                tabId: 'legacy',
                pageNum: 1,
                ownerId: 'page-1',
                fracs: [{ x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.9 }],
                ...overrides,
            },
        }));
    });
}

describe('CropDialog interaction safety', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        localStorage.clear();
        workspaceStore = createWorkspaceStore();
        const state = workspaceStore.getState();
        state.setFile(new File(['pdf'], 'source.pdf', { type: 'application/pdf' }));
        state.setViewerPageOrder([1, 2, 3]);
        state.setViewerPageInstanceIds(['page-1', 'page-2', 'page-3']);
        state.setViewerPageRotations([0, 0, 0]);
    });

    afterEach(() => {
        cleanup();
    });

    it('chỉ mở hộp thoại thuộc tab phát lệnh', async () => {
        render(<>
            <CropDialog tabId="tab-a" embedded ensureFileId={async () => 'a'} onApplied={vi.fn()} onClose={vi.fn()} />
            <CropDialog tabId="tab-b" embedded ensureFileId={async () => 'b'} onApplied={vi.fn()} onClose={vi.fn()} />
        </>);

        openCropDialog({ tabId: 'tab-b', totalPages: pageBoxes.total_pages, pageBox: pageBoxes.cropbox });

        expect(await screen.findAllByRole('dialog')).toHaveLength(1);
    });
    it('aborts an in-flight crop when the user cancels', async () => {
        let cropSignal: AbortSignal | undefined;
        vi.mocked(authenticatedFetch).mockImplementation((url, init) => {
            const target = String(url);
            if (target.includes('/page-boxes/')) return Promise.resolve(fakeJsonResponse(pageBoxes));
            if (target.includes('/preview-hide')) return Promise.resolve(fakeJsonResponse({ preview_b64: null }));
            if (target.includes('/crop-regions')) {
                cropSignal = init?.signal || undefined;
                return new Promise<Response>((_resolve, reject) => {
                    cropSignal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
                });
            }
            throw new Error(`Unexpected URL: ${target}`);
        });

        const onApplied = vi.fn();
        const onClose = vi.fn();
        render(<CropDialog ensureFileId={async () => 'fid'} onApplied={onApplied} onClose={onClose} />);
        openCropDialog();

        const applyButton = await screen.findByRole('button', { name: 'apply_crop' });
        await waitFor(() => expect((applyButton as HTMLButtonElement).disabled).toBe(false));
        fireEvent.click(applyButton);
        await waitFor(() => expect(cropSignal).toBeDefined());

        fireEvent.click(screen.getByRole('button', { name: 'huy' }));

        expect(cropSignal?.aborted).toBe(true);
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(onApplied).not.toHaveBeenCalled();
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('maps a visible /Rotate=90 selection into the raw CropBox request', async () => {
        let cropBody: { rects_mm: Array<{ x0: number; y0: number; x1: number; y1: number }> } | undefined;
        const rotatedBoxes = {
            ...pageBoxes,
            total_pages: 1,
            mediabox: { x0: 0, y0: 0, x1: 200, y1: 100, width: 200, height: 100 },
            cropbox: { x0: 0, y0: 0, x1: 200, y1: 100, width: 200, height: 100 },
            rotation: 90,
        };
        vi.mocked(authenticatedFetch).mockImplementation((url, init) => {
            const target = String(url);
            if (target.includes('/page-boxes/')) return Promise.resolve(fakeJsonResponse(rotatedBoxes));
            if (target.includes('/crop-regions')) {
                cropBody = JSON.parse(String(init?.body));
                return Promise.resolve(fakeJsonResponse({ success: true, output_filename: 'rotate90.pdf' }));
            }
            if (target.includes('/download/rotate90.pdf')) return Promise.resolve(fakeJsonResponse({}));
            throw new Error(`Unexpected URL: ${target}`);
        });

        const onApplied = vi.fn();
        render(<CropDialog ensureFileId={async () => 'fid'} onApplied={onApplied} onClose={vi.fn()} />);
        openCropDialog({
            totalPages: 1,
            pageBox: { x0: 0, y0: 0, x1: 100, y1: 200, width: 100, height: 200 },
            fracs: [{ x0: 0, y0: 0, x1: 1, y1: 0.5 }],
        });

        fireEvent.click(await screen.findByRole('button', { name: 'apply_crop' }));
        await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));

        expect(cropBody?.rects_mm).toEqual([{ x0: 0, y0: 0, x1: 100, y1: 100 }]);
    });

    it('uses the materialized viewer page and preserves a crop through custom rotation', async () => {
        let cropBody: {
            page: number;
            pages?: number[];
            rects_mm: Array<{ x0: number; y0: number; x1: number; y1: number }>;
        } | undefined;
        const materializedBoxes = {
            ...pageBoxes,
            page: 1,
            total_pages: 2,
            mediabox: { x0: 0, y0: 0, x1: 200, y1: 100, width: 200, height: 100 },
            cropbox: { x0: 0, y0: 0, x1: 200, y1: 100, width: 200, height: 100 },
            rotation: 90,
        };
        vi.mocked(authenticatedFetch).mockImplementation((url, init) => {
            const target = String(url);
            if (target.includes('/page-boxes/')) return Promise.resolve(fakeJsonResponse(materializedBoxes));
            if (target.includes('/crop-regions')) {
                cropBody = JSON.parse(String(init?.body));
                return Promise.resolve(fakeJsonResponse({ success: true, output_filename: 'working-page.pdf' }));
            }
            if (target.includes('/download/working-page.pdf')) return Promise.resolve(fakeJsonResponse({}));
            throw new Error(`Unexpected URL: ${target}`);
        });

        const onApplied = vi.fn();
        render(<CropDialog ensureFileId={async () => 'working-fid'} onApplied={onApplied} onClose={vi.fn()} />);
        openCropDialog({
            // Trang gốc có thể là 3, nhưng sau reorder [3,1] đây là trang làm việc số 1.
            pageNum: 1,
            totalPages: 2,
            viewerRotation: 90,
            pageBox: { x0: 0, y0: 0, x1: 200, y1: 100, width: 200, height: 100 },
            fracs: [{ x0: 0, y0: 0, x1: 0.5, y1: 1 }],
        });

        fireEvent.click(await screen.findByRole('button', { name: 'apply_crop' }));
        await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));

        expect(cropBody?.page).toBe(1);
        expect(cropBody?.pages).toEqual([1]);
        expect(cropBody?.rects_mm).toEqual([{ x0: 0, y0: 0, x1: 100, y1: 100 }]);
    });

    it('opens as a non-modal editing panel, keeps the document by default, and closes on Escape', async () => {
        vi.mocked(authenticatedFetch).mockImplementation((url) => {
            const target = String(url);
            if (target.includes('/page-boxes/')) return Promise.resolve(fakeJsonResponse(pageBoxes));
            if (target.includes('/preview-hide')) return Promise.resolve(fakeJsonResponse({ preview_b64: null }));

            throw new Error(`Unexpected URL: ${target}`);
        });

        const onClose = vi.fn();
        render(<CropDialog ensureFileId={async () => 'fid'} onApplied={vi.fn()} onClose={onClose} />);
        openCropDialog();

        const dialog = await screen.findByRole('dialog');
        expect(dialog.getAttribute('aria-modal')).toBe('false');
        const outputModeSelect = screen.getByRole('combobox', { name: /output_mode/ }) as HTMLSelectElement;
        expect(outputModeSelect.value).toBe('keep_document');
        expect(screen.queryByRole('button', { name: 'advanced_options' })).toBeNull();

        fireEvent.keyDown(window, { key: 'Escape' });
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('keeps drawing local when the viewer already supplies the page size', async () => {
        const ensureFileId = vi.fn(async () => 'fid');
        render(<CropDialog embedded ensureFileId={ensureFileId} onApplied={vi.fn()} onClose={vi.fn()} />);

        openCropDialog({
            totalPages: pageBoxes.total_pages,
            pageBox: pageBoxes.cropbox,
        });

        const widthInput = await screen.findByRole('spinbutton', { name: /width/ }) as HTMLInputElement;
        expect(widthInput.disabled).toBe(false);
        await act(async () => { await Promise.resolve(); });

        expect(ensureFileId).not.toHaveBeenCalled();
        expect(authenticatedFetch).not.toHaveBeenCalled();
    });

    it('broadcasts size and alignment changes to the visible crop frame', async () => {
        vi.mocked(authenticatedFetch).mockImplementation((url) => {
            const target = String(url);
            if (target.includes('/page-boxes/')) return Promise.resolve(fakeJsonResponse(pageBoxes));
            throw new Error(`Unexpected URL: ${target}`);
        });

        const visualEvents: Array<{
            ownerId?: string;
            fracs?: Array<{ x0: number; y0: number; x1: number; y1: number }>;
        }> = [];
        const onPreviewChange = (event: Event) => {
            visualEvents.push((event as CustomEvent).detail);
        };
        window.addEventListener('prynx-crop-preview-change', onPreviewChange);

        try {
            render(<CropDialog ensureFileId={async () => 'fid'} onApplied={vi.fn()} onClose={vi.fn()} />);
            openCropDialog();

            const widthInput = await screen.findByRole('spinbutton', { name: /width/ }) as HTMLInputElement;
            await waitFor(() => expect(widthInput.disabled).toBe(false));
            fireEvent.change(widthInput, { target: { value: '100' } });
            fireEvent.blur(widthInput);

            await waitFor(() => expect(visualEvents.some((detail) => {
                const frac = detail.fracs?.[0];
                return detail.ownerId === 'page-1'
                    && !!frac
                    && Math.abs((frac.x1 - frac.x0) - (100 / 210)) < 0.0001;
            })).toBe(true));

            fireEvent.click(screen.getByRole('button', { name: 'align_right' }));

            await waitFor(() => expect(visualEvents.some((detail) => {
                const frac = detail.fracs?.[0];
                return detail.ownerId === 'page-1' && !!frac
                    && Math.abs(frac.x1 - 0.9) < 0.0001;
            })).toBe(true));
        } finally {
            window.removeEventListener('prynx-crop-preview-change', onPreviewChange);
        }
    });

    it('does not request a raster preview when opened', async () => {
        vi.mocked(authenticatedFetch).mockImplementation((url) => {
            const target = String(url);
            if (target.includes('/page-boxes/')) return Promise.resolve(fakeJsonResponse(pageBoxes));
            throw new Error(`Unexpected URL: ${target}`);
        });

        render(<CropDialog ensureFileId={async () => 'fid'} onApplied={vi.fn()} onClose={vi.fn()} />);
        openCropDialog();

        const applyButton = await screen.findByRole('button', { name: 'apply_crop' });
        await waitFor(() => expect((applyButton as HTMLButtonElement).disabled).toBe(false));
        const requestedPreview = vi.mocked(authenticatedFetch).mock.calls.some(([url]) => String(url).includes('/preview-hide'));
        expect(requestedPreview).toBe(false);
    });
    it('processes edges when enabled but never applies an unsafe pixel-only suggestion', async () => {
        let detectedMaxTrimMm: number | undefined;
        let cropBody: {
            rects_mm: Array<{ x0: number; y0: number; x1: number; y1: number }>;
            display_rects_mm?: Array<{ x0: number; y0: number; x1: number; y1: number }>;
            pages?: number[];
        } | undefined;
        vi.mocked(authenticatedFetch).mockImplementation((url, init) => {
            const target = String(url);
            if (target.includes('/page-boxes/')) return Promise.resolve(fakeJsonResponse(pageBoxes));
            if (target.includes('/preview-hide')) return Promise.resolve(fakeJsonResponse({ preview_b64: null }));
            if (target.includes('/detect-crop-regions')) {
                const detectionBody = JSON.parse(String(init?.body)) as { max_trim_mm?: number };
                detectedMaxTrimMm = detectionBody.max_trim_mm;
                return Promise.resolve(fakeJsonResponse({
                    regions: [{
                        rect_mm: { x0: 30, y0: 40, x1: 180, y1: 250 },
                        suggested_rect_mm: { x0: 30, y0: 40, x1: 180, y1: 250 },
                        changed: false,
                        safe_to_apply: false,
                        method: 'pixels',
                        confidence: 'low',
                        trim_mm: { left: 0, top: 0, right: 0, bottom: 0 },
                    }],
                }));
            }
            if (target.includes('/crop-regions')) {
                cropBody = JSON.parse(String(init?.body));
                return Promise.resolve(fakeJsonResponse({ success: true, output_filename: 'safe.pdf' }));
            }
            if (target.includes('/download/safe.pdf')) return Promise.resolve(fakeJsonResponse({}));
            throw new Error(`Unexpected URL: ${target}`);
        });

        const onApplied = vi.fn();
        render(<CropDialog ensureFileId={async () => 'fid'} onApplied={onApplied} onClose={vi.fn()} />);
        openCropDialog();

        const checkbox = await screen.findByRole('checkbox', { name: /process_excess_edges/ }) as HTMLInputElement;
        await waitFor(() => expect(checkbox.disabled).toBe(false));
        expect(checkbox.checked).toBe(false);
        fireEvent.click(checkbox);

        expect(checkbox.checked).toBe(true);
        await waitFor(() => expect(detectedMaxTrimMm).toBe(10));
        await screen.findByText('pixel_edge_preserved');
        const applyButton = screen.getByRole('button', { name: 'apply_crop' });
        const pageScopeSelect = screen.getByRole('combobox', { name: /pham_vi_trang/ }) as HTMLSelectElement;
        fireEvent.change(pageScopeSelect, { target: { value: 'range' } });
        expect(pageScopeSelect.value).toBe('range');
        await waitFor(() => expect((applyButton as HTMLButtonElement).disabled).toBe(false));
        fireEvent.click(applyButton);
        await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));

        expect(cropBody?.rects_mm[0]).toEqual({
            x0: 21,
            y0: 29.7,
            x1: 189,
            y1: 267.3,
        });
        expect(cropBody?.display_rects_mm?.[0]).toEqual({
            x0: 21,
            y0: 29.7,
            x1: 189,
            y1: 267.3,
        });
        expect(cropBody?.pages).toEqual([1, 2]);
    });
    it('lets each scanned region have its own size controls', async () => {
        render(<CropDialog embedded ensureFileId={async () => 'fid'} onApplied={vi.fn()} onClose={vi.fn()} />);
        openCropDialog({
            totalPages: pageBoxes.total_pages,
            pageBox: pageBoxes.cropbox,
            fracs: [
                { x0: 0.1, y0: 0.1, x1: 0.5, y1: 0.5 },
                { x0: 0.2, y0: 0.2, x1: 0.9, y1: 0.8 },
            ],
        });

        await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(2));
        const widthInput = screen.getByRole('spinbutton', { name: /width/ }) as HTMLInputElement;
        expect(widthInput.value).toBe('84');

        fireEvent.click(screen.getAllByRole('tab')[1]);
        await waitFor(() => expect((screen.getByRole('spinbutton', { name: /width/ }) as HTMLInputElement).value).toBe('147'));
        const secondWidthInput = screen.getByRole('spinbutton', { name: /width/ }) as HTMLInputElement;
        fireEvent.change(secondWidthInput, { target: { value: '100' } });
        fireEvent.blur(secondWidthInput);
        await waitFor(() => expect((screen.getByRole('spinbutton', { name: /width/ }) as HTMLInputElement).value).toBe('100'));
        fireEvent.click(screen.getAllByRole('tab')[0]);
        await waitFor(() => expect((screen.getByRole('spinbutton', { name: /width/ }) as HTMLInputElement).value).toBe('84'));

        const echoedPreview = vi.fn();
        window.addEventListener('prynx-crop-preview-change', echoedPreview);
        act(() => window.dispatchEvent(new CustomEvent('prynx-crop-selection-change', {
            detail: {
                tabId: 'legacy',
                ownerId: 'page-1',
                pageNum: 1,
                selectedIndex: 1,
                fracs: [
                    { x0: 0.1, y0: 0.1, x1: 0.5, y1: 0.5 },
                    { x0: 0.2, y0: 0.2, x1: 0.9, y1: 0.8 },
                ],
            },
        })));
        await waitFor(() => expect(screen.getAllByRole('tab')[1].getAttribute('aria-selected')).toBe('true'));
        await act(async () => { await Promise.resolve(); });
        expect(echoedPreview).not.toHaveBeenCalled();
        window.removeEventListener('prynx-crop-preview-change', echoedPreview);
    });
    it('remembers reusable options, forwards the new-tab choice, and keeps the embedded tool open after apply', async () => {
        vi.mocked(authenticatedFetch).mockImplementation((url) => {
            const target = String(url);
            if (target.includes('/page-boxes/')) return Promise.resolve(fakeJsonResponse(pageBoxes));
            if (target.includes('/crop-regions')) return Promise.resolve(fakeJsonResponse({ success: true, output_filename: 'remembered.pdf' }));
            if (target.includes('/download/remembered.pdf')) return Promise.resolve(fakeJsonResponse({}));
            throw new Error(`Unexpected URL: ${target}`);
        });

        const onApplied = vi.fn();
        const onClose = vi.fn();
        render(<CropDialog embedded ensureFileId={async () => 'fid'} onApplied={onApplied} onClose={onClose} />);
        openCropDialog({ totalPages: pageBoxes.total_pages, pageBox: pageBoxes.cropbox });

        const scope = await screen.findByRole('combobox', { name: /pham_vi_trang/ }) as HTMLSelectElement;
        const output = screen.getByRole('combobox', { name: /output_mode/ }) as HTMLSelectElement;
        const openInNewTab = screen.getByRole('checkbox', { name: /open_result_new_tab/ }) as HTMLInputElement;
        fireEvent.change(scope, { target: { value: 'all' } });
        fireEvent.change(output, { target: { value: 'regions_only' } });
        fireEvent.click(openInNewTab);
        fireEvent.click(screen.getByRole('button', { name: 'align_right' }));

        const applyButton = screen.getByRole('button', { name: 'apply_crop' });
        await waitFor(() => expect((applyButton as HTMLButtonElement).disabled).toBe(false));
        fireEvent.click(applyButton);

        await waitFor(() => expect(onApplied).toHaveBeenCalledWith(expect.any(Blob), 'remembered.pdf', false));
        expect(onClose).not.toHaveBeenCalled();

        openCropDialog({ totalPages: pageBoxes.total_pages, pageBox: pageBoxes.cropbox });
        const reopenedScope = await screen.findByRole('combobox', { name: /pham_vi_trang/ }) as HTMLSelectElement;
        const reopenedOutput = screen.getByRole('combobox', { name: /output_mode/ }) as HTMLSelectElement;
        const reopenedNewTab = screen.getByRole('checkbox', { name: /open_result_new_tab/ }) as HTMLInputElement;

        expect(reopenedScope.value).toBe('all');
        expect(reopenedOutput.value).toBe('regions_only');
        expect(reopenedNewTab.checked).toBe(false);
        expect(screen.getByRole('button', { name: 'align_right' }).getAttribute('aria-pressed')).toBe('true');
    });

    it('rebinds the crop to the latest file ID, page position, and rotation after a workspace revision', async () => {
        const ensureFileId = vi.fn()
            .mockResolvedValueOnce('old-fid')
            .mockResolvedValue('new-fid');
        let cropBody: { file_id: string; page: number; pages: number[] } | undefined;
        vi.mocked(authenticatedFetch).mockImplementation((url, init) => {
            const target = String(url);
            if (target.includes('/page-boxes/')) {
                const page = target.endsWith('/2') ? 2 : 1;
                return Promise.resolve(fakeJsonResponse({ ...pageBoxes, page }));
            }
            if (target.includes('/crop-regions')) {
                cropBody = JSON.parse(String(init?.body));
                return Promise.resolve(fakeJsonResponse({ success: true, output_filename: 'latest.pdf' }));
            }
            if (target.includes('/download/latest.pdf')) return Promise.resolve(fakeJsonResponse({}));
            throw new Error(`Unexpected URL: ${target}`);
        });

        const onApplied = vi.fn();
        render(<CropDialog ensureFileId={ensureFileId} onApplied={onApplied} onClose={vi.fn()} />);
        openCropDialog();

        await waitFor(() => expect(vi.mocked(authenticatedFetch).mock.calls.some(([url]) =>
            String(url).includes('/page-boxes/old-fid/1'))).toBe(true));

        act(() => workspaceStore.setState({
            viewerPageOrder: [2, 1, 3],
            viewerPageInstanceIds: ['page-2', 'page-1', 'page-3'],
            viewerPageRotations: [0, 90, 0],
            editGeneration: 1,
        }));

        await waitFor(() => expect(vi.mocked(authenticatedFetch).mock.calls.some(([url]) =>
            String(url).includes('/page-boxes/new-fid/2'))).toBe(true));
        const applyButton = await screen.findByRole('button', { name: 'apply_crop' });
        await waitFor(() => expect((applyButton as HTMLButtonElement).disabled).toBe(false));
        fireEvent.click(applyButton);

        await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));
        expect(cropBody).toMatchObject({
            file_id: 'new-fid',
            page: 2,
            pages: [2],
        });
    });

    it('resets the crop instead of falling through to another page when its owner was deleted', async () => {
        render(<CropDialog ensureFileId={async () => 'fid'} onApplied={vi.fn()} onClose={vi.fn()} />);
        openCropDialog({ totalPages: pageBoxes.total_pages, pageBox: pageBoxes.cropbox });
        await screen.findByRole('dialog');

        act(() => workspaceStore.setState({
            viewerPageOrder: [2, 3],
            viewerPageInstanceIds: ['page-2', 'page-3'],
            viewerPageRotations: [0, 0],
            editGeneration: 1,
        }));

        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(screen.queryByRole('button', { name: 'apply_crop' })).toBeNull();
        expect(vi.mocked(authenticatedFetch).mock.calls.some(([url]) =>
            String(url).includes('/crop-regions'))).toBe(false);
    });

    it('ignores a late edge-detection response from an older workspace revision', async () => {
        let currentFileId = 'old-fid';
        let oldDetectSignal: AbortSignal | undefined;
        let resolveOldDetection: ((response: Response) => void) | undefined;
        let cropBody: { rects_mm: Array<{ x0: number; y0: number; x1: number; y1: number }> } | undefined;
        const oldRegion = {
            rect_mm: { x0: 5, y0: 5, x1: 50, y1: 50 },
            changed: true,
            safe_to_apply: true,
            method: 'object',
            confidence: 'high',
        };
        const newRegion = {
            rect_mm: { x0: 30, y0: 40, x1: 180, y1: 250 },
            changed: true,
            safe_to_apply: true,
            method: 'object',
            confidence: 'high',
        };
        vi.mocked(authenticatedFetch).mockImplementation((url, init) => {
            const target = String(url);
            if (target.includes('/page-boxes/')) return Promise.resolve(fakeJsonResponse(pageBoxes));
            if (target.includes('/detect-crop-regions')) {
                const body = JSON.parse(String(init?.body)) as { file_id: string };
                if (body.file_id === 'old-fid') {
                    oldDetectSignal = init?.signal || undefined;
                    return new Promise<Response>((resolve) => {
                        resolveOldDetection = resolve;
                    });
                }
                return Promise.resolve(fakeJsonResponse({ regions: [newRegion] }));
            }
            if (target.includes('/crop-regions')) {
                cropBody = JSON.parse(String(init?.body));
                return Promise.resolve(fakeJsonResponse({ success: true, output_filename: 'detected.pdf' }));
            }
            if (target.includes('/download/detected.pdf')) return Promise.resolve(fakeJsonResponse({}));
            throw new Error(`Unexpected URL: ${target}`);
        });

        const onApplied = vi.fn();
        render(<CropDialog ensureFileId={async () => currentFileId} onApplied={onApplied} onClose={vi.fn()} />);
        openCropDialog({ totalPages: pageBoxes.total_pages, pageBox: pageBoxes.cropbox });
        fireEvent.click(await screen.findByRole('checkbox', { name: /process_excess_edges/ }));
        await waitFor(() => expect(oldDetectSignal).toBeDefined());

        currentFileId = 'new-fid';
        act(() => workspaceStore.getState().advanceEditGeneration());
        await waitFor(() => expect(oldDetectSignal?.aborted).toBe(true));
        await waitFor(() => expect(vi.mocked(authenticatedFetch).mock.calls.some(([, init]) =>
            String(init?.body).includes('new-fid'))).toBe(true));

        await act(async () => {
            resolveOldDetection?.(fakeJsonResponse({ regions: [oldRegion] }));
            await Promise.resolve();
        });

        const applyButton = screen.getByRole('button', { name: 'apply_crop' });
        await waitFor(() => expect((applyButton as HTMLButtonElement).disabled).toBe(false));
        fireEvent.click(applyButton);
        await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));
        expect(cropBody?.rects_mm[0]).toEqual(newRegion.rect_mm);
    });

    it('aborts an apply from an older workspace revision and never publishes its late result', async () => {
        let currentFileId = 'old-fid';
        let cropSignal: AbortSignal | undefined;
        let resolveCrop: ((response: Response) => void) | undefined;
        vi.mocked(authenticatedFetch).mockImplementation((url, init) => {
            const target = String(url);
            if (target.includes('/page-boxes/')) return Promise.resolve(fakeJsonResponse(pageBoxes));
            if (target.includes('/crop-regions')) {
                cropSignal = init?.signal || undefined;
                return new Promise<Response>((resolve) => {
                    resolveCrop = resolve;
                });
            }
            if (target.includes('/download/')) return Promise.resolve(fakeJsonResponse({}));
            throw new Error(`Unexpected URL: ${target}`);
        });

        const onApplied = vi.fn();
        render(<CropDialog ensureFileId={async () => currentFileId} onApplied={onApplied} onClose={vi.fn()} />);
        openCropDialog({ totalPages: pageBoxes.total_pages, pageBox: pageBoxes.cropbox });
        const applyButton = await screen.findByRole('button', { name: 'apply_crop' });
        await waitFor(() => expect((applyButton as HTMLButtonElement).disabled).toBe(false));
        fireEvent.click(applyButton);
        await waitFor(() => expect(cropSignal).toBeDefined());

        currentFileId = 'new-fid';
        act(() => workspaceStore.getState().advanceEditGeneration());
        await waitFor(() => expect(cropSignal?.aborted).toBe(true));
        await act(async () => {
            resolveCrop?.(fakeJsonResponse({ success: true, output_filename: 'stale.pdf' }));
            await Promise.resolve();
        });

        await waitFor(() => expect(onApplied).not.toHaveBeenCalled());
        expect(vi.mocked(authenticatedFetch).mock.calls.some(([url]) =>
            String(url).includes('/download/stale.pdf'))).toBe(false);
    });
});
