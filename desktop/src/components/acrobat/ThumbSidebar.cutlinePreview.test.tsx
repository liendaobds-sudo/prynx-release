// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
    ThumbnailCutlinePreviewLayer,
    sameCutlinePreview,
    type ThumbnailCutlinePreviewItem,
} from './thumbnailCutlinePreview';
import type { StickerCutlinePreview } from '../../lib/stickerSheetApi';

const samplePreview: StickerCutlinePreview = {
    page_number: 2,
    mask_revision: 1,
    preview_width_px: 600,
    preview_height_px: 800,
    fingerprint: 'fp-123',
    segment_count: 4,
    paths: [
        { instance_id: 1, d: 'M 10 10 L 100 10 L 100 100 Z', segment_count: 3 },
        { instance_id: 2, d: 'M 200 200 L 300 200 L 300 300 Z', segment_count: 3 },
    ],
};

describe('thumbnailCutlinePreview — hiển thị đường bế và preview tem trên thumbnail', () => {
    describe('sameCutlinePreview comparator', () => {
        it('trả về true khi cả 2 đều rỗng', () => {
            expect(sameCutlinePreview(undefined, undefined)).toBe(true);
            expect(sameCutlinePreview(null, null)).toBe(true);
            expect(sameCutlinePreview(undefined, null)).toBe(true);
        });

        it('trả về true khi thông tin revision, fingerprint và paths tương đương', () => {
            const item1: ThumbnailCutlinePreviewItem = {
                cutlinePreview: samplePreview,
                previewUrl: 'blob:preview-1',
            };
            const item2: ThumbnailCutlinePreviewItem = {
                cutlinePreview: { ...samplePreview },
                previewUrl: 'blob:preview-1',
            };
            expect(sameCutlinePreview(item1, item2)).toBe(true);
        });

        it('trả về false khi previewUrl đổi', () => {
            const item1: ThumbnailCutlinePreviewItem = {
                cutlinePreview: samplePreview,
                previewUrl: 'blob:preview-1',
            };
            const item2: ThumbnailCutlinePreviewItem = {
                cutlinePreview: samplePreview,
                previewUrl: 'blob:preview-2',
            };
            expect(sameCutlinePreview(item1, item2)).toBe(false);
        });

        it('trả về false khi đường bế cutlinePreview đổi fingerprint hoặc paths', () => {
            const item1: ThumbnailCutlinePreviewItem = {
                cutlinePreview: samplePreview,
                previewUrl: 'blob:preview-1',
            };
            const item2: ThumbnailCutlinePreviewItem = {
                cutlinePreview: { ...samplePreview, fingerprint: 'fp-456' },
                previewUrl: 'blob:preview-1',
            };
            expect(sameCutlinePreview(item1, item2)).toBe(false);

            const item3: ThumbnailCutlinePreviewItem = {
                cutlinePreview: { ...samplePreview, paths: [samplePreview.paths[0]] },
                previewUrl: 'blob:preview-1',
            };
            expect(sameCutlinePreview(item1, item3)).toBe(false);
        });
    });

    describe('ThumbnailCutlinePreviewLayer component', () => {
        it('không render gì khi item null hoặc không có dữ liệu preview', () => {
            const { container: c1 } = render(<ThumbnailCutlinePreviewLayer item={null} />);
            expect(c1.firstChild).toBeNull();

            const { container: c2 } = render(<ThumbnailCutlinePreviewLayer item={{ cutlinePreview: null, previewUrl: null }} />);
            expect(c2.firstChild).toBeNull();
        });

        it('render ảnh previewUrl và SVG đường bế màu tím khi có đủ dữ liệu', () => {
            render(
                <ThumbnailCutlinePreviewLayer
                    item={{
                        cutlinePreview: samplePreview,
                        previewUrl: 'blob:test-sticker-bleed-url',
                    }}
                />,
            );

            const layer = screen.getByTestId('thumbnail-cutline-preview-layer');
            expect(layer).toBeDefined();

            // Kiểm tra ảnh tem
            const img = layer.querySelector('img');
            expect(img).toBeDefined();
            expect(img?.getAttribute('src')).toBe('blob:test-sticker-bleed-url');

            // Kiểm tra SVG đường cắt màu tím
            const svg = screen.getByTestId('thumbnail-cutline-svg');
            expect(svg).toBeDefined();
            expect(svg.getAttribute('viewBox')).toBe('0 0 600 800');

            const paths = svg.querySelectorAll('path');
            expect(paths.length).toBe(2);
            expect(paths[0].getAttribute('stroke')).toBe('#7c3aed');
            expect(paths[0].getAttribute('d')).toBe('M 10 10 L 100 10 L 100 100 Z');
            expect(paths[1].getAttribute('stroke')).toBe('#7c3aed');
            expect(paths[1].getAttribute('d')).toBe('M 200 200 L 300 200 L 300 300 Z');
        });

        it('vẫn render SVG đường bế màu tím ngay cả khi chưa có previewUrl (như mode có biên classic)', () => {
            render(
                <ThumbnailCutlinePreviewLayer
                    item={{
                        cutlinePreview: samplePreview,
                        previewUrl: null,
                    }}
                />,
            );

            const svg = screen.getByTestId('thumbnail-cutline-svg');
            expect(svg).toBeDefined();
            const paths = svg.querySelectorAll('path');
            expect(paths.length).toBe(2);
            expect(paths[0].getAttribute('stroke')).toBe('#7c3aed');
        });
    });
});
