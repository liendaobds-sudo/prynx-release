// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import PageResizerTool from './PageResizerTool';
import { allowedScaleModes, applyPageSizeMode, shouldShowBackgroundFill } from './pageResizerViewLogic';
import { DEFAULT_RESIZE_SETTINGS } from '../imposition-tools/store/slices/preprocSlice';

const api = vi.hoisted(() => ({
    inspectResizeTransparency: vi.fn(),
}));
const imageReader = vi.hoisted(() => ({ getFileArrayBuffer: vi.fn() }));

vi.mock('../../lib/api', () => api);
vi.mock('../../lib/utils', async (importOriginal) => ({
    ...await importOriginal<typeof import('../../lib/utils')>(),
    getFileArrayBuffer: imageReader.getFileArrayBuffer,
}));

function jpegDpi(x: number, y: number): ArrayBuffer {
    return new Uint8Array([
        0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 1,
        x >>> 8, x & 0xff, y >>> 8, y & 0xff, 0, 0, 0xff, 0xd9,
    ]).buffer;
}


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

    it('shows the real output pixel budget and quality warning for 600 DPI', () => {
        render(React.createElement(PageResizerTool, {
            settings: {
                ...baseSettings,
                targetW: 50,
                targetH: 50,
                targetDpi: 600,
                resizeMode: 'vector',
            },
            onChange: vi.fn(),
        }));

        expect(screen.getByText((content) => content.includes('1181') && content.includes('600 DPI'))).toBeTruthy();
        expect(screen.getByText((content) => content.includes('Giảm mẫu sẽ bỏ bớt pixel nguồn'))).toBeTruthy();
    });

    it.each(['fixed', 'fixed_width', 'fixed_height'] as const)(
        'hiển thị DPI EXIF của ảnh nguồn thay cho ước lượng ở %s',
        async (pageSizeMode) => {
            const bytes = await readFile(resolve(process.cwd(), '..', 'test', 'Tem thuc pham sach Duc An.jpg'));
            imageReader.getFileArrayBuffer.mockResolvedValue(Uint8Array.from(bytes).buffer);
            const imageFile = new File([], 'Tem thuc pham sach Duc An.jpg', { type: 'image/jpeg' });
            Object.defineProperty(imageFile, 'path', { value: 'D:\\jobs\\Tem thuc pham sach Duc An.jpg' });
            const settings = { ...baseSettings, targetW: 50, targetH: 50, targetDpi: 600, pageSizeMode };
            const { rerender } = render(React.createElement(PageResizerTool, {
                settings,
                sourceImageFile: imageFile,
                onChange: vi.fn(),
            }));

            expect(await screen.findByText('Độ phân giải hiện tại: 288 DPI.')).toBeTruthy();
            expect(screen.queryByText(/Khi giảm mẫu:|Trục .*khi giảm mẫu:/)).toBeNull();
            expect(imageReader.getFileArrayBuffer).toHaveBeenCalledWith(imageFile);

            // Khổ/DPI đích không phải độ phân giải của ảnh đang mở.
            rerender(React.createElement(PageResizerTool, {
                settings: { ...settings, targetW: 20, targetH: 20, targetDpi: 0 },
                sourceImageFile: imageFile,
                onChange: vi.fn(),
            }));
            expect(screen.getByText('Độ phân giải hiện tại: 288 DPI.')).toBeTruthy();
            expect(imageReader.getFileArrayBuffer).toHaveBeenCalledTimes(1);
        },
    );

    it('giữ hai trục DPI khi metadata X/Y khác nhau', async () => {
        imageReader.getFileArrayBuffer.mockResolvedValue(jpegDpi(300, 150));
        render(React.createElement(PageResizerTool, {
            settings: baseSettings,
            sourceImageFile: new File([], 'anisotropic.jpg'),
            onChange: vi.fn(),
        }));

        expect(await screen.findByText('Độ phân giải hiện tại: 300 × 150 DPI.')).toBeTruthy();
    });

    it('không giả định 72 hoặc DPI đích khi ảnh thiếu metadata', async () => {
        imageReader.getFileArrayBuffer.mockResolvedValue(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer);
        render(React.createElement(PageResizerTool, {
            settings: { ...baseSettings, targetDpi: 600 },
            sourceImageFile: new File([], 'unknown.jpg'),
            onChange: vi.fn(),
        }));

        expect(await screen.findByText('Độ phân giải hiện tại: không xác định (ảnh không có metadata DPI).')).toBeTruthy();
        expect(screen.queryByText(/Độ phân giải hiện tại: (72|600) DPI/)).toBeNull();
    });

    it('báo không đọc được metadata nếu đọc ảnh nguồn thất bại', async () => {
        imageReader.getFileArrayBuffer.mockRejectedValue(new Error('Không đọc được file'));
        render(React.createElement(PageResizerTool, {
            settings: baseSettings,
            sourceImageFile: new File([], 'unreadable.jpg'),
            onChange: vi.fn(),
        }));

        expect(await screen.findByText('Độ phân giải hiện tại: không đọc được metadata ảnh.')).toBeTruthy();
        expect(screen.queryByText(/Khi giảm mẫu:|Trục .*khi giảm mẫu:/)).toBeNull();
    });

    it('không rò DPI cũ khi đổi ảnh hoặc chuyển sang PDF', async () => {
        let resolveOld!: (bytes: ArrayBuffer) => void;
        imageReader.getFileArrayBuffer
            .mockImplementationOnce(() => new Promise<ArrayBuffer>(resolvePromise => { resolveOld = resolvePromise; }))
            .mockResolvedValueOnce(jpegDpi(300, 300));
        const firstFile = new File([], 'image.jpg');
        const secondFile = new File([], 'image.jpg');
        const settings = { ...baseSettings, targetW: 50, targetH: 50, targetDpi: 300 };
        const { rerender } = render(React.createElement(PageResizerTool, {
            settings, sourceImageFile: firstFile, onChange: vi.fn(),
        }));
        expect(screen.getByText('Độ phân giải hiện tại: đang đọc…')).toBeTruthy();

        rerender(React.createElement(PageResizerTool, {
            settings, sourceImageFile: secondFile, onChange: vi.fn(),
        }));
        expect(await screen.findByText('Độ phân giải hiện tại: 300 DPI.')).toBeTruthy();
        await act(async () => { resolveOld(jpegDpi(288, 288)); });
        expect(screen.getByText('Độ phân giải hiện tại: 300 DPI.')).toBeTruthy();

        rerender(React.createElement(PageResizerTool, {
            settings, sourceImageFile: null, onChange: vi.fn(),
        }));
        expect(screen.queryByText(/Độ phân giải hiện tại:/)).toBeNull();
        expect(screen.getByText(/591 × 591 px.*300 DPI/)).toBeTruthy();
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

    it('does not leak transparency pages from the previous PDF while inspecting a new one', async () => {
        let resolveFirst: ((value: { has_transparency: boolean; transparent_pages: number[] }) => void) | undefined;
        api.inspectResizeTransparency
            .mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }))
            .mockResolvedValueOnce({ has_transparency: false, transparent_pages: [] });
        const firstFile = new File(['pdf-a'], 'alpha.pdf', { type: 'application/pdf' });
        const secondFile = new File(['pdf-b'], 'opaque.pdf', { type: 'application/pdf' });
        const { rerender } = render(React.createElement(PageResizerTool, {
            settings: baseSettings,
            onChange: vi.fn(),
            pdfFile: firstFile,
        }));

        rerender(React.createElement(PageResizerTool, {
            settings: baseSettings,
            onChange: vi.fn(),
            pdfFile: secondFile,
        }));

        await waitFor(() => expect(api.inspectResizeTransparency).toHaveBeenCalledTimes(2));
        expect(screen.queryByRole('button', {
            name: /Resize (theo|by) (nội dung|content)/i,
        })).toBeNull();

        resolveFirst?.({ has_transparency: true, transparent_pages: [1] });
        await waitFor(() => expect(screen.queryByRole('button', {
            name: /Resize (theo|by) (nội dung|content)/i,
        })).toBeNull());
    });

    it('inspects the latest Working PDF after the page revision changes', async () => {
        api.inspectResizeTransparency.mockResolvedValue({
            has_transparency: false,
            transparent_pages: [],
        });
        const pdfFile = new File(['backing'], 'backing.pdf', { type: 'application/pdf' });
        const firstWorking = new File(['working-a'], 'working-a.pdf', { type: 'application/pdf' });
        const secondWorking = new File(['working-b'], 'working-b.pdf', { type: 'application/pdf' });
        let currentWorking = firstWorking;
        const getWorkingFile = vi.fn(async () => currentWorking);
        const firstOrder = [1, 2];
        const firstRotations = [0, 0];

        const { rerender } = render(React.createElement(PageResizerTool, {
            settings: baseSettings,
            onChange: vi.fn(),
            pdfFile,
            getWorkingFile,
            viewerPageOrder: firstOrder,
            viewerPageRotations: firstRotations,
        }));
        await waitFor(() => expect(api.inspectResizeTransparency).toHaveBeenCalledWith(
            firstWorking,
            undefined,
            expect.any(AbortSignal),
        ));

        currentWorking = secondWorking;
        rerender(React.createElement(PageResizerTool, {
            settings: baseSettings,
            onChange: vi.fn(),
            pdfFile,
            getWorkingFile,
            viewerPageOrder: [2, 1],
            viewerPageRotations: [90, 0],
        }));

        await waitFor(() => expect(api.inspectResizeTransparency).toHaveBeenCalledWith(
            secondWorking,
            undefined,
            expect.any(AbortSignal),
        ));
        expect(getWorkingFile).toHaveBeenCalledTimes(2);
    });
});
