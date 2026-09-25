// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LiveTile, TileLayer } from './LivePageFrame';
import { clearTileUrlCache, type TileUrlSource } from '../../lib/tileUrlCache';

afterEach(() => { cleanup(); clearTileUrlCache(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const base = () => ({
  fileKey: 'audit-file|revision:r1|color:display', pageNum: 1, pageInstanceId: 'audit',
  zoom: 1, rot: 0, clipX: 0, clipY: 0, clipW: 0, clipH: 0,
  cssW: 640, cssH: 480, eager: true, renderPriority: 10, onVisible: vi.fn(),
});
const bitmapSource = (scale: number): TileUrlSource => ({
  url: `pxrg:audit:${scale}`, byteLength: 640 * 480 * scale * scale * 4,
  bitmap: { width: 640 * scale, height: 480 * scale, close: vi.fn() } as unknown as ImageBitmap,
});

it('AUDIT: zoom 1→1.3→1.2 rồi 1.4 phải thoát request 1.2 bị bỏ do bitmap 1.3 nét hơn', async () => {
  const pending: Array<(source: TileUrlSource) => void> = [];
  const getTileUrl = vi.fn(() => new Promise<TileUrlSource>(resolve => pending.push(resolve)));
  const drawImage = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as never);
  const props = { ...base(), getTileUrl };
  const view = render(<LiveTile {...props} />);
  await act(async () => { pending[0](bitmapSource(1)); });
  view.rerender(<LiveTile {...props} zoom={1.3} cssW={832} cssH={624} />);
  expect(getTileUrl).toHaveBeenCalledTimes(2);
  view.rerender(<LiveTile {...props} zoom={1.2} cssW={768} cssH={576} />);
  expect(getTileUrl).toHaveBeenCalledTimes(2);
  await act(async () => { pending[1](bitmapSource(1.3)); });
  expect(getTileUrl).toHaveBeenCalledTimes(3);
  await act(async () => { pending[2](bitmapSource(1.2)); });
  expect(drawImage).toHaveBeenCalledTimes(2);
  view.rerender(<LiveTile {...props} zoom={1.4} cssW={896} cssH={672} />);
  await act(async () => { await Promise.resolve(); });
  expect(getTileUrl).toHaveBeenCalledTimes(4);
});

it('AUDIT: zoom trong lúc decode PNG phải tiếp tục dựng target mới', async () => {
  const images: Array<{ onload: null | (() => void); onerror: null | (() => void); src: string }> = [];
  class DeferredImage {
    onload: null | (() => void) = null;
    onerror: null | (() => void) = null;
    naturalWidth = 640;
    naturalHeight = 480;
    src = '';
    constructor() { images.push(this); }
  }
  vi.stubGlobal('Image', DeferredImage);
  const getTileUrl = vi.fn(async () => ({ url: 'blob:audit-png', byteLength: 64 }));
  const props = { ...base(), getTileUrl };
  const view = render(<LiveTile {...props} />);
  await waitFor(() => expect(images).toHaveLength(1));
  expect(images[0].onload).not.toBeNull();
  view.rerender(<LiveTile {...props} zoom={2} />);
  await act(async () => { images[0].onload?.(); await Promise.resolve(); });
  expect(getTileUrl).toHaveBeenCalledTimes(2);
});

it('AUDIT: tile display đến trước PPE không được xóa chính bitmap vừa vẽ', async () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as never);
  const page = document.createElement('div');
  vi.spyOn(page, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 640, bottom: 480, width: 640, height: 480 } as DOMRect);
  const pending: Array<{ resolve: (source: TileUrlSource) => void; stage: string | undefined }> = [];
  const getTileUrl = vi.fn((...args: unknown[]) => new Promise<TileUrlSource>(resolve => {
    pending.push({ resolve, stage: (args[7] as { colorStage?: string } | undefined)?.colorStage });
  }));
  const view = render(<TileLayer
    fileKey="audit-accurate" displayFileKey="audit-display" pageNum={1}
    zoom={3} dpr={1} rotation={0} displayWidth={640} displayHeight={480}
    containerRef={{ current: page }} getTileUrl={getTileUrl} onVisible={vi.fn()}
    accurateColor accurateCommitted keepDisplayUntilAccurate={false}
  />);
  expect(pending.some(item => item.stage === undefined)).toBe(true);
  expect(pending.some(item => item.stage === 'accurate')).toBe(true);
  await act(async () => { pending.find(item => item.stage === undefined)!.resolve(bitmapSource(1)); });
  // Frame display đã được draw; PPE vẫn pending. Ít nhất một canvas có pixel phải còn được giữ.
  expect(Array.from(view.container.querySelectorAll('canvas')).some(canvas => canvas.width === 640 && canvas.height === 480)).toBe(true);
});

it('AUDIT: zoom target display mới không được retire PPE cũ trước khi PPE mới ready', async () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as never);
  const page = document.createElement('div');
  vi.spyOn(page, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 640, bottom: 480, width: 640, height: 480 } as DOMRect);
  const pending: Array<{ resolve: (source: TileUrlSource) => void; stage: string | undefined; zoom: number; priority: number }> = [];
  const getTileUrl = vi.fn((...args: unknown[]) => new Promise<TileUrlSource>(resolve => {
    const options = args[7] as { colorStage?: string; priority: number };
    pending.push({ resolve, stage: options.colorStage, priority: options.priority, zoom: args[2] as number });
  }));
  const props = {
    fileKey: 'audit-accurate-old', displayFileKey: 'audit-display-old', pageNum: 1,
    zoom: 3, dpr: 1, rotation: 0, displayWidth: 640, displayHeight: 480,
    containerRef: { current: page }, getTileUrl, onVisible: vi.fn(),
    accurateColor: true, accurateCommitted: true, keepDisplayUntilAccurate: false,
  };
  const view = render(<TileLayer {...props} />);
  await act(async () => { pending.find(item => item.stage === 'accurate' && item.priority === 0)!.resolve(bitmapSource(3)); });
  const oldCanvas = view.container.querySelector('canvas[width="1920"]');
  expect(oldCanvas).not.toBeNull();
  view.rerender(<TileLayer {...props} zoom={4} displayWidth={640 * 4 / 3} displayHeight={640} />);
  await waitFor(() => expect(pending.some(item => item.stage === undefined && item.zoom === 4)).toBe(true));
  expect(view.container.contains(oldCanvas)).toBe(true);
  await act(async () => { pending.find(item => item.stage === undefined && item.zoom === 4)!.resolve(bitmapSource(4)); });
  expect(view.container.contains(oldCanvas) || view.container.querySelector('canvas[width="2560"]') !== null).toBe(true);
});
