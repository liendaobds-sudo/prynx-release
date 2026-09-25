// @vitest-environment jsdom
// Probe chẩn đoán: xác nhận hành vi chớp hiện tại, không phải assertion nghiệm thu bản sửa.
// Chép tạm vào desktop/src/components/workspace/ZoomEngineFlash.audit.tmp.test.tsx để chạy.
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TileLayer } from './LivePageFrame';
import { shouldUseViewerDisplayLayer } from './livePageFramePolicy';
import { clearTileUrlCache, type TileUrlSource } from '../../lib/tileUrlCache';

afterEach(() => { cleanup(); clearTileUrlCache(); vi.restoreAllMocks(); });

type Pending = {
    resolve: (source: TileUrlSource) => void;
    stage: string | undefined;
    zoom: number;
    priority: number;
};
type Presented = { sourceToken: string; accurateOnly: boolean; zoom: number };

function visibleLayersAtCenter(root: HTMLElement): Presented[] {
    return Array.from(root.querySelectorAll<HTMLCanvasElement>('canvas[data-prynx-presented-tile]'))
        .filter(canvas => {
            if (canvas.style.display === 'none' || canvas.style.opacity === '0') return false;
            let parent: HTMLElement | null = canvas.parentElement;
            while (parent && parent !== root) {
                if (parent.style.opacity === '0' || parent.style.display === 'none') return false;
                parent = parent.parentElement;
            }
            const tile = canvas.closest<HTMLElement>('.tile-container');
            if (!tile) return false;
            const x = Number.parseFloat(tile.style.left) || 0;
            const y = Number.parseFloat(tile.style.top) || 0;
            return x <= 320 && x + Number.parseFloat(tile.style.width) >= 320
                && y <= 240 && y + Number.parseFloat(tile.style.height) >= 240;
        })
        .map(canvas => JSON.parse(canvas.dataset.prynxPresentedTile!) as Presented);
}

it.each([false, true])('tái hiện PPE A → display B → PPE B, stableUnderlayReady=%s', async stableUnderlayReady => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as never);
    const page = document.createElement('div');
    vi.spyOn(page, 'getBoundingClientRect').mockReturnValue({
        left: 0, top: 0, right: 640, bottom: 480, width: 640, height: 480,
    } as DOMRect);
    const pending: Pending[] = [];
    const getTileUrl = vi.fn((...args: unknown[]) => new Promise<TileUrlSource>(resolve => {
        const options = args[7] as { colorStage?: string; priority: number };
        pending.push({ resolve, stage: options.colorStage, priority: options.priority, zoom: args[2] as number });
    }));
    const source = (label: string, scale: number): TileUrlSource => ({
        url: `pxrg:flash-probe:${label}`, byteLength: 640 * 480 * scale * scale * 4,
        bitmap: { width: 640 * scale, height: 480 * scale, close: vi.fn() } as unknown as ImageBitmap,
    });
    const props = {
        fileKey: `flash-probe-${stableUnderlayReady}|color:accurate`,
        displayFileKey: `flash-probe-${stableUnderlayReady}|color:display`, pageNum: 1,
        zoom: 3, dpr: 1, rotation: 0, displayWidth: 640, displayHeight: 480,
        containerRef: { current: page }, getTileUrl: getTileUrl as never, onVisible: vi.fn(),
        accurateColor: true, accurateCommitted: true, keepDisplayUntilAccurate: false,
        stableUnderlayReady,
    };
    // Policy chung đã từ chối display sau commit; TileLayer vẫn bypass bằng hasIncomingTarget.
    expect(shouldUseViewerDisplayLayer(true, true, false)).toBe(false);
    const view = render(<TileLayer {...props} />);
    await act(async () => {
        pending.find(item => item.stage === 'accurate' && item.priority === 0)!.resolve(source('PPE-A', 3));
    });
    await waitFor(() => expect(visibleLayersAtCenter(view.container).at(-1)?.sourceToken).toContain('PPE-A'));
    const before = visibleLayersAtCenter(view.container);

    view.rerender(<TileLayer {...props} zoom={4} displayWidth={640 * 4 / 3} displayHeight={640} />);
    await waitFor(() => expect(pending.some(item => item.stage === undefined && item.zoom === 4)).toBe(true));
    await act(async () => {
        pending.find(item => item.stage === undefined && item.zoom === 4)!.resolve(source('DISPLAY-B', 4));
    });
    const between = visibleLayersAtCenter(view.container);
    expect(between.some(item => item.sourceToken.endsWith('PPE-A'))).toBe(true);
    expect(between.at(-1)).toMatchObject({ accurateOnly: false, zoom: 4 });
    // DOM không có z-index riêng: display target nằm sau PPE cũ và cùng phủ điểm giữa.
    expect(between.at(-1)?.sourceToken).toContain('DISPLAY-B');

    await waitFor(() => expect(pending.some(item => item.stage === 'accurate' && item.zoom === 4 && item.priority === 0)).toBe(true));
    await act(async () => {
        pending.find(item => item.stage === 'accurate' && item.zoom === 4 && item.priority === 0)!.resolve(source('PPE-B', 4));
    });
    await waitFor(() => expect(visibleLayersAtCenter(view.container).at(-1)?.sourceToken).toContain('PPE-B'));
    const after = visibleLayersAtCenter(view.container);
    console.log('ZOOM_ENGINE_FLASH_PROBE', JSON.stringify({
        stableUnderlayReady, before, between, after,
        topPipelineSequence: [before, between, after].map(layers => layers.at(-1)?.accurateOnly ? 'accurate' : 'display'),
    }));
});
