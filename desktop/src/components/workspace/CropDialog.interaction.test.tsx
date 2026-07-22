// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { authenticatedFetch } from '../../lib/api';
import CropDialog from './CropDialog';

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
};

const fakeJsonResponse = (data: unknown, ok = true) => ({
    ok,
    status: ok ? 200 : 500,
    json: async () => data,
    blob: async () => new Blob(['pdf'], { type: 'application/pdf' }),
}) as Response;

function openCropDialog() {
    act(() => {
        window.dispatchEvent(new CustomEvent('prynx-crop-open', {
            detail: {
                pageNum: 1,
                fracs: [{ x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.9 }],
            },
        }));
    });
}

describe('CropDialog interaction safety', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        cleanup();
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

    it('opens as an accessible modal, keeps the document by default, and closes on Escape', async () => {
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
        expect(dialog.getAttribute('aria-modal')).toBe('true');
        const keepDocument = screen.getByRole('radio', { name: /keep_document/ }) as HTMLInputElement;
        expect(keepDocument.checked).toBe(true);

        fireEvent.keyDown(window, { key: 'Escape' });
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('processes edges by default but never applies an unsafe pixel-only suggestion', async () => {
        let detectedMaxTrimMm: number | undefined;
        let cropBody: { rects_mm: Array<{ x0: number; y0: number; x1: number; y1: number }> } | undefined;
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
        expect(checkbox.checked).toBe(true);
        await waitFor(() => expect(detectedMaxTrimMm).toBe(10));
        await screen.findByText('pixel_edge_preserved');
        const applyButton = screen.getByRole('button', { name: 'apply_crop' });
        await waitFor(() => expect((applyButton as HTMLButtonElement).disabled).toBe(false));
        fireEvent.click(applyButton);
        await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));

        expect(cropBody?.rects_mm[0]).toEqual({
            x0: 21,
            y0: 29.7,
            x1: 189,
            y1: 267.3,
        });
    });
});
