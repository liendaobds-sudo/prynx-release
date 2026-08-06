// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import PageResizerTool, { allowedScaleModes, applyPageSizeMode, shouldShowBackgroundFill } from './PageResizerTool';
import { DEFAULT_RESIZE_SETTINGS } from '../imposition-tools/store/slices/preprocSlice';

const api = vi.hoisted(() => ({
    inspectResizeTransparency: vi.fn(),
}));

vi.mock('../../lib/api', () => api);


const baseSettings = {
    sizePresetId: 'A4',
    targetW: 210,
    targetH: 297,
    pageSizeMode: 'fixed' as const,
    scaleMode: 'fit' as const,
    applyTo: 'all' as const,
    applyToStr: 'all',
    resizeByContent: false,
};


describe('PageResizerTool background-fill visibility', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('keeps full transparent page size by default', () => {
        expect(DEFAULT_RESIZE_SETTINGS.resizeByContent).toBe(false);
    });

    it('uses the exact Letter dimensions for resize output', () => {
        const onChange = vi.fn();
        render(React.createElement(PageResizerTool, {
            settings: baseSettings,
            onChange,
        }));

        fireEvent.click(screen.getByText('A4').closest('button') as HTMLButtonElement);
        fireEvent.click(screen.getByRole('button', {
            name: /Letter 215\.9 × 279\.4 mm/,
        }));

        expect(onChange).toHaveBeenCalledWith({
            ...baseSettings,
            sizePresetId: 'Letter',
            targetW: 215.9,
            targetH: 279.4,
        });
    });

    it.each([true, false, undefined])(
        'shows gap background independently from legacy auto-trim=%s',
        (autoTrimBefore) => {
            expect(shouldShowBackgroundFill(autoTrimBefore, 'fit')).toBe(true);
            expect(shouldShowBackgroundFill(autoTrimBefore, 'center_no_scale')).toBe(true);
        },
    );

    it.each([true, false, undefined])(
        'hides background for fill/stretch with legacy auto-trim=%s',
        (autoTrimBefore) => {
            expect(shouldShowBackgroundFill(autoTrimBefore, 'fill')).toBe(false);
            expect(shouldShowBackgroundFill(autoTrimBefore, 'stretch')).toBe(false);
        },
    );

    it.each(['fixed_width', 'fixed_height'] as const)(
        'hides gap background for locked-axis fit (%s) but keeps it for center_no_scale',
        (pageSizeMode) => {
            expect(shouldShowBackgroundFill(undefined, 'fit', pageSizeMode)).toBe(false);
            // RESIZE (audit 2026-08-06 §G.11): tem 5×10 → trang 7.5×15 CÓ vùng trống.
            expect(
                shouldShowBackgroundFill(undefined, 'center_no_scale', pageSizeMode),
            ).toBe(true);
        },
    );

    it('forces fit and custom preset while preserving entered dimensions', () => {
        const base = {
            sizePresetId: 'A4',
            targetW: 210,
            targetH: 297,
            pageSizeMode: 'fixed' as const,
            scaleMode: 'stretch' as const,
            applyTo: 'all' as const,
            applyToStr: 'all',
        };

        const locked = applyPageSizeMode(base, 'fixed_width');
        expect(locked).toMatchObject({
            pageSizeMode: 'fixed_width',
            sizePresetId: 'custom',
            scaleMode: 'fit',
            targetW: 210,
            targetH: 297,
        });
    });

    // RESIZE (audit 2026-08-06 §G.11): giữ nguyên ở giữa là ca thật của khổ khóa
    // một chiều (tem 5×10 → chiều cao 15 → trang 7.5×15, tem vẫn 5×10), không
    // được hạ về 'fit' khi chuyển chế độ.
    it('keeps center_no_scale when switching to a locked-axis mode', () => {
        const locked = applyPageSizeMode(
            { ...baseSettings, scaleMode: 'center_no_scale' as const },
            'fixed_height',
        );
        expect(locked.scaleMode).toBe('center_no_scale');
        expect(locked.pageSizeMode).toBe('fixed_height');
    });

    // RESIZE (audit 2026-08-06 §G.10): khổ khóa một chiều KHÔNG được ẩn mất khối
    // "Kiểu tỷ lệ" — chỉ thu hẹp còn lựa chọn engine chấp nhận.
    it('keeps every scale mode for the fixed page-size mode', () => {
        expect(allowedScaleModes('fixed')).toEqual(['fit', 'fill', 'stretch', 'center_no_scale']);
        expect(allowedScaleModes()).toEqual(['fit', 'fill', 'stretch', 'center_no_scale']);
    });

    it.each(['fixed_width', 'fixed_height'] as const)(
        'narrows the scale mode to fit + center_no_scale for %s',
        (pageSizeMode) => {
            expect(allowedScaleModes(pageSizeMode)).toEqual(['fit', 'center_no_scale']);
        },
    );

    it.each(['fixed_width', 'fixed_height'] as const)(
        'still renders the scale-mode section for %s',
        (pageSizeMode) => {
            render(React.createElement(PageResizerTool, {
                settings: { ...baseSettings, pageSizeMode, sizePresetId: 'custom' },
                onChange: vi.fn(),
            }));

            expect(screen.getByText(/Kiểu tỷ lệ|Scaling mode/i)).toBeTruthy();
            expect(screen.getAllByText(/Thu vừa khít|^Fit$/i).length).toBeGreaterThan(0);
            expect(screen.getAllByText(/Giữ nguyên ở giữa|^Keep centred$/i).length).toBeGreaterThan(0);
            expect(screen.queryByText(/Ép bóp méo|^Stretch$/i)).toBeNull();
        },
    );

    it('only shows resize-by-content after the current PDF reports transparency', async () => {
        api.inspectResizeTransparency.mockResolvedValue({
            has_transparency: true,
            transparent_pages: [1, 3],
        });
        const onChange = vi.fn();
        const pdfFile = new File(['pdf'], 'alpha.pdf', { type: 'application/pdf' });

        render(React.createElement(PageResizerTool, {
            settings: baseSettings,
            onChange,
            pdfFile,
        }));

        const toggle = await screen.findByRole('button', {
            name: /Resize (theo|by) (nội dung|content)/i,
        });
        fireEvent.click(toggle);
        expect(onChange).toHaveBeenCalledWith({
            ...baseSettings,
            resizeByContent: true,
        });
    });

    it('hides resize-by-content for an opaque PDF', async () => {
        api.inspectResizeTransparency.mockResolvedValue({
            has_transparency: false,
            transparent_pages: [],
        });
        const pdfFile = new File(['pdf'], 'opaque.pdf', { type: 'application/pdf' });

        render(React.createElement(PageResizerTool, {
            settings: baseSettings,
            onChange: vi.fn(),
            pdfFile,
        }));
        await waitFor(() => expect(api.inspectResizeTransparency).toHaveBeenCalled());

        expect(screen.queryByRole('button', {
            name: /Resize (theo|by) (nội dung|content)/i,
        })).toBeNull();
    });
});
