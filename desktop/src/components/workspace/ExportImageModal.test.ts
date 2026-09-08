// @vitest-environment jsdom

import { createElement } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ExportImageModal from './ExportImageModal';
import { buildExportJobs, parsePageRange } from './exportImagePlan';
import { exportImagesBatch } from '../../lib/api';

vi.mock('../../lib/api', () => ({
    exportImagesBatch: vi.fn(),
    uploadPDF: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
    open: vi.fn().mockResolvedValue('C:\\exports'),
}));

vi.mock('@tauri-apps/plugin-shell', () => ({
    open: vi.fn().mockResolvedValue(undefined),
}));

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function getExportButton() {
    const buttons = screen.getAllByRole('button', { name: /Xuất ảnh|Đang xuất/ });
    return buttons[buttons.length - 1];
}

describe('parsePageRange', () => {
    it('đảo range, khử trùng và giữ trang hợp lệ', () => {
        expect(parsePageRange('3-1, 2, 5, 99', 5)).toEqual([1, 2, 3, 5]);
    });

    it('clamp range rất lớn trước vòng lặp', () => {
        expect(parsePageRange('4-999999999', 6)).toEqual([4, 5, 6]);
    });
});

describe('buildExportJobs', () => {
    it('từ chối effective DPI vượt 1200 trước khi xuất', () => {
        expect(() => buildExportJobs({
            dpi: 600,
            format: 'png',
            colorMode: 'rgb',
            multiScaleEnabled: true,
            scaleRows: [{ scale: 3, suffix: '@3x', format: 'png' }],
            subFolderMode: 'scale',
        })).toThrow('1200');
    });

    it('từ chối PNG/WebP trong mọi hàng CMYK', () => {
        expect(() => buildExportJobs({
            dpi: 300,
            format: 'tiff',
            colorMode: 'cmyk',
            multiScaleEnabled: true,
            scaleRows: [{ scale: 1, suffix: '', format: 'webp' }],
            subFolderMode: 'none',
        })).toThrow('PNG/WebP');
    });

    it('lập đầy đủ batch hợp lệ và thư mục con trước request', () => {
        expect(buildExportJobs({
            dpi: 300,
            format: 'tiff',
            colorMode: 'cmyk',
            multiScaleEnabled: true,
            scaleRows: [
                { scale: 1, suffix: '', format: 'tiff' },
                { scale: 2, suffix: '@2x', format: 'jpeg' },
            ],
            subFolderMode: 'format',
        })).toEqual([
            { dpi: 300, format: 'tiff', suffix: '', subDir: 'TIFF' },
            { dpi: 600, format: 'jpeg', suffix: '@2x', subDir: 'JPEG' },
        ]);
    });
});

describe('menu Tệp → ExportImageModal', () => {
    it('mở thẳng Export for Screens khi initialTab=screens', () => {
        render(createElement(ExportImageModal, {
            open: true,
            onClose: () => undefined,
            initialTab: 'screens',
            numPages: 3,
            currentPage: 1,
            baseName: 'tai-lieu',
            getWorkingFile: async () => null,
            pageWidthPt: 595,
            pageHeightPt: 842,
        }));

        const tabs = screen.getAllByRole('tab');
        expect(tabs).toHaveLength(2);
        expect(tabs[0].getAttribute('aria-selected')).toBe('false');
        expect(tabs[1].getAttribute('aria-selected')).toBe('true');
    });

    it('mở tab Export thường khi initialTab=export', () => {
        render(createElement(ExportImageModal, {
            open: true,
            onClose: () => undefined,
            initialTab: 'export',
            numPages: 1,
            currentPage: 1,
            baseName: 'tai-lieu',
            getWorkingFile: async () => null,
            pageWidthPt: 595,
            pageHeightPt: 842,
        }));

        const tabs = screen.getAllByRole('tab');
        expect(tabs).toHaveLength(2);
        expect(tabs[0].getAttribute('aria-selected')).toBe('true');
        expect(tabs[1].getAttribute('aria-selected')).toBe('false');
    });
});

describe('lifecycle và ước lượng export', () => {
    it('giữ busy sau Hủy và chặn lượt mới cho tới khi promise cũ settle', async () => {
        const pending = deferred<{ ok: boolean; count: number; output_dir: string; files: string[] }>();
        vi.mocked(exportImagesBatch).mockReturnValueOnce(pending.promise);
        const onClose = vi.fn();

        render(createElement(ExportImageModal, {
            open: true,
            onClose,
            filePath: 'source.pdf',
            numPages: 1,
            currentPage: 1,
            baseName: 'tai-lieu',
            getWorkingFile: async () => null,
            pageWidthPt: 100,
            pageHeightPt: 50,
        }));

        fireEvent.click(screen.getByRole('button', { name: 'Chọn...' }));
        await waitFor(() => expect(screen.getByDisplayValue('C:\\exports')).toBeTruthy());

        fireEvent.click(getExportButton());
        await waitFor(() => expect(exportImagesBatch).toHaveBeenCalledTimes(1));

        fireEvent.click(screen.getByRole('button', { name: 'Hủy xuất' }));
        expect(screen.getByRole('button', { name: 'Hủy xuất' })).toBeTruthy();
        expect((getExportButton() as HTMLButtonElement).disabled).toBe(true);

        // Click giả lập lần xuất lại trong lúc request cũ còn pending — không tạo request thứ hai.
        fireEvent.click(getExportButton());
        expect(exportImagesBatch).toHaveBeenCalledTimes(1);

        pending.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        await waitFor(() => expect((getExportButton() as HTMLButtonElement).disabled).toBe(false));

        fireEvent.click(getExportButton());
        await waitFor(() => expect(exportImagesBatch).toHaveBeenCalledTimes(2));
    });

    it('đổi Include Bleed tính lại kích thước và ghi chú khi chỉ có khổ active', () => {
        render(createElement(ExportImageModal, {
            open: true,
            onClose: () => undefined,
            numPages: 1,
            currentPage: 1,
            getWorkingFile: async () => null,
            pageWidthPt: 200,
            pageHeightPt: 100,
        }));

        expect(screen.getByText(/417×208/)).toBeTruthy();
        expect(screen.getByText(/Ước lượng theo khổ trang đang xem/)).toBeTruthy();

        fireEvent.click(screen.getByRole('checkbox', { name: 'Xuất cả vùng bleed' }));
        // Không có Media/Trim dimensions riêng nên số không bịa; chỉ xác nhận dependency chạy lại
        // và vẫn công bố rằng đây là estimate theo khổ active.
        expect(screen.getByText(/417×208/)).toBeTruthy();
        expect(screen.getByText(/Ước lượng theo khổ trang đang xem/)).toBeTruthy();
    });

    it('ưu tiên kích thước MediaBox/TrimBox khi caller cung cấp', () => {
        render(createElement(ExportImageModal, {
            open: true,
            onClose: () => undefined,
            numPages: 1,
            currentPage: 1,
            getWorkingFile: async () => null,
            pageWidthPt: 200,
            pageHeightPt: 100,
            pageBoxDimensions: {
                media: { widthPt: 300, heightPt: 150 },
                trim: { widthPt: 200, heightPt: 100 },
            },
        }));

        expect(screen.getByText(/625×313/)).toBeTruthy();
        fireEvent.click(screen.getByRole('checkbox', { name: 'Xuất cả vùng bleed' }));
        expect(screen.getByText(/417×208/)).toBeTruthy();
    });
});
