// @vitest-environment jsdom

import { createElement } from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ExportImageModal, { buildExportJobs, parsePageRange } from './ExportImageModal';

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
