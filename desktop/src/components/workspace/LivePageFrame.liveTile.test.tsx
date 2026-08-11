// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LiveTile } from './LivePageFrame';
import { cacheTileUrl, clearTileUrlCache } from '../../lib/tileUrlCache';
import { CancelledTileRenderError } from '../../hooks/viewer/tileRenderScheduler';

afterEach(() => {
    cleanup();
    clearTileUrlCache();
    vi.restoreAllMocks();
});

function makeProps(overrides: Record<string, unknown> = {}) {
    return {
        fileKey: 'D:\\jobs\\gradient.pdf|revision:r1|color:accurate',
        pageNum: 1,
        pageInstanceId: 'cold-open',
        zoom: 1,
        coarseZoom: undefined,
        rot: 0,
        clipX: 0,
        clipY: 0,
        clipW: 0,
        clipH: 0,
        cssLeft: 0,
        cssTop: 0,
        cssW: 640,
        cssH: 480,
        eager: true,
        onVisible: vi.fn(),
        ...overrides,
    };
}

describe('LiveTile — cold-open màu chính xác', () => {
    it('giữ PDFium cho trang compatibility chưa được đánh dấu màu rủi ro', async () => {
        const getTileUrl = vi.fn((..._args: unknown[]) => new Promise<never>(() => {}));
        render(
            <LiveTile
                {...makeProps({ getTileUrl, showLoadStatus: true })}
            />,
        );

        await waitFor(() => expect(getTileUrl).toHaveBeenCalledTimes(1));
        expect(getTileUrl).toHaveBeenCalledWith(
            1,
            0,
            1,
            0,
            0,
            0,
            0,
            expect.objectContaining({ colorStage: undefined }),
        );
    });

    it('chỉ yêu cầu PPE accurate khi trang rủi ro còn đang chờ', async () => {
        const getTileUrl = vi.fn((..._args: unknown[]) => new Promise<never>(() => {}));
        const view = render(
            <LiveTile
                {...makeProps({ getTileUrl, accurateOnly: true, showLoadStatus: true })}
            />,
        );

        await waitFor(() => expect(getTileUrl).toHaveBeenCalledTimes(1));
        expect(getTileUrl).toHaveBeenCalledWith(
            1,
            0,
            1,
            0,
            0,
            0,
            0,
            expect.objectContaining({ colorStage: 'accurate' }),
        );
        const requestedStages = getTileUrl.mock.calls.map(call => (
            (call[7] as { colorStage?: string } | undefined)?.colorStage
        ));
        expect(requestedStages)
            .not.toContain('display');

        const image = view.container.querySelector('img');
        expect(image?.getAttribute('src')).toMatch(/^data:image\/gif/);
        expect(image?.src).not.toContain('pdfium');
        expect(image?.src).not.toContain('display');
    });

    it('dùng ngay bitmap PPE từ cache mà không gọi lại PDFium', async () => {
        const getTileUrl = vi.fn();
        const onTileReady = vi.fn();
        const cachedUrl = 'blob:http://localhost/accurate-cache';

        // Cache được tiêm qua module thật bằng key giống LiveTile tạo ra.
        cacheTileUrl(
            'D:\\jobs\\gradient.pdf|revision:r1|color:accurate_1_1_0_0_0_0_0',
            { url: cachedUrl, byteLength: 64, cacheable: true },
            'D:\\jobs\\gradient.pdf|revision:r1|color:accurate',
        );

        const view = render(
            <LiveTile {...makeProps({
                getTileUrl,
                accurateOnly: true,
                onTileReady,
                presentationFadeMs: 140,
            })} />,
        );

        await act(async () => {
            await Promise.resolve();
        });
        const image = view.container.querySelector('img');
        const tile = view.container.querySelector('.tile-container') as HTMLElement | null;
        expect(getTileUrl).not.toHaveBeenCalled();
        expect(image?.src).toBe(cachedUrl);
        expect(tile?.style.transition).toContain('opacity 140ms');
        expect(tile?.style.filter).toBe('');
        fireEvent.load(image!);
        expect(onTileReady).toHaveBeenCalledTimes(1);
        expect(onTileReady).toHaveBeenCalledWith({ scale: 1 });
    });

    it('không hủy và dựng lại base đang chạy khi trang prefetch trở thành active', async () => {
        const getTileUrl = vi.fn(() => new Promise<never>(() => {}));
        const onRenderReady = vi.fn();
        const baseProps = makeProps({
            getTileUrl,
            accurateOnly: true,
        });
        const view = render(
            <LiveTile {...baseProps}
                renderPriority={100}
                showLoadStatus={false}
            />,
        );
        await waitFor(() => expect(getTileUrl).toHaveBeenCalledTimes(1));

        view.rerender(
            <LiveTile {...baseProps}
                renderPriority={10}
                showLoadStatus={true}
                onRenderReady={onRenderReady}
            />,
        );
        await act(async () => {
            await Promise.resolve();
        });

        expect(getTileUrl).toHaveBeenCalledTimes(1);
        expect(onRenderReady).not.toHaveBeenCalled();
    });

    it('cold-open xin thẳng PPE target nét, không phát coarse 24 DPI', async () => {
        const getTileUrl = vi.fn(async (..._args: unknown[]) => ({
            url: `blob:http://localhost/accurate-${getTileUrl.mock.calls.length}`,
            byteLength: 64,
            cacheable: true,
        }));
        render(
            <LiveTile {...makeProps({
                getTileUrl,
                accurateOnly: true,
                zoom: 1,
                coarseZoom: 0.25,
            })} />,
        );

        await waitFor(() => expect(getTileUrl).toHaveBeenCalledTimes(1));
        const calls = getTileUrl.mock.calls as unknown[][];
        expect(calls.map(call => call[2])).toEqual([1]);
        expect(calls.map(call => (
            call[7] as { colorStage?: string } | undefined
        )?.colorStage))
            .toEqual(['accurate']);
    });

    it('tự nối lại cancellation nội bộ thay vì hiện lỗi cuối cho người dùng', async () => {
        const getTileUrl = vi.fn()
            .mockRejectedValueOnce(new CancelledTileRenderError())
            .mockReturnValue(new Promise<never>(() => {}));
        const view = render(
            <LiveTile {...makeProps({
                getTileUrl,
                accurateOnly: true,
                showLoadStatus: true,
                loadLabels: {
                    loading: 'Đang dựng hình…',
                    slow: 'Đang dựng trang lâu hơn bình thường…',
                    error: 'Không dựng được trang này.',
                    cancelled: 'Đã hủy dựng trang.',
                    retry: 'Thử lại',
                    cancel: 'Hủy',
                },
            })} />,
        );

        await waitFor(() => expect(getTileUrl).toHaveBeenCalledTimes(2));
        expect(view.queryByText('Đã hủy dựng trang.')).toBeNull();
        expect(view.queryByText('Thử lại')).toBeNull();
        expect(view.getByText('Đang dựng hình…')).toBeTruthy();
    });
});
