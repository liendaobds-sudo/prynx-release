// @vitest-environment jsdom
// PERF (audit 2026-09-25 §R25.GPU.09/11/12/13): mount DOM thật và điều khiển thứ tự IPC.
import { createElement, StrictMode } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }));
import { parseNativeCamera, matchesNativeSurfaceProof, useNativeGpuViewport, type UseNativeGpuViewportReturn } from './useNativeGpuViewport';
import snapshot from '../../../../tests/viewer_gpu/native-camera-v1.json';
let api: UseNativeGpuViewportReturn;
let frames: Map<number, FrameRequestCallback>;
let frameId = 0;
function Host({ enabled = true, change = vi.fn(), error = vi.fn(), page = 0, visible = true, token = '1' }) {
  api = useNativeGpuViewport({ enabled, visible, document: page ? { filePath: 'D:/fixture.pdf', page, token } : undefined, onCameraChange: change, onError: error });
  return createElement('div', { ref: api.containerRef });
}
const tick = async () => { await act(async () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(cb => cb(0)); await Promise.resolve(); }); };
const calls = (name: string) => mocks.invoke.mock.calls.filter(([cmd]) => cmd === name);
const sendCamera = async (camera: unknown, metadata: { cameraVersion?: number; userInitiatedZoom?: boolean } = {}) => {
  const [, callback] = mocks.listen.mock.calls.filter(([name]) => name === 'ppe-native-camera').at(-1)!;
  const payload = calls('load_native_gpu_scene').at(-1)![1];
  await act(async () => callback({ payload: { ...payload, camera, ...metadata } }));
};
const status = async (revision: number, error: string | null = null, contentReady: boolean = true) => {
  const [, callback] = mocks.listen.mock.calls.find(([name]) => name === 'ppe-native-status')!;
  const { viewId, generation } = calls('open_native_gpu_viewport').at(-1)![1];
  const bounds=(calls('resize_native_gpu_viewport').at(-1) ?? calls('open_native_gpu_viewport').at(-1))![1];
  const surface={epoch:1+calls('resize_native_gpu_viewport').length,width:bounds.width,height:bounds.height,dpr:bounds.dpr};
  await act(async () => callback({ payload: { viewId, generation, revision, error, contentReady, surface } }));
};
beforeEach(() => {
  frames = new Map(); mocks.invoke.mockReset();
  mocks.listen.mockReset(); mocks.listen.mockResolvedValue(vi.fn());
  vi.stubGlobal('__TAURI_INTERNALS__', {});
  vi.stubGlobal('devicePixelRatio', 1.5);
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.set(++frameId, cb); return frameId; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 100, top: 50, right: 900, bottom: 650, width: 800, height: 600, x: 100, y: 50, toJSON: () => ({}) });
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue({ length: 1 } as DOMRectList);
  mocks.invoke.mockImplementation(async (cmd: string) => cmd === 'open_native_gpu_viewport' || cmd.includes('camera') || cmd.includes('zoom') ? snapshot : undefined);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('camera cùng scene — phiên bản và nguồn thay đổi', () => {
  it('parse chỉ giữ sáu trường hình học, không đưa metadata vào state/dedup', () => {
    expect(parseNativeCamera({ ...snapshot, cameraVersion: 7, userInitiatedZoom: true })).toEqual(snapshot);
  });

  it.each(['event-first', 'ack-first'] as const)('Fit ACK v2 không thắng camera v3 (%s)', async order => {
    mocks.invoke.mockResolvedValue(snapshot);
    const change = vi.fn(); render(createElement(Host, { page: 1, change })); await tick();
    let finishFit!: (value: unknown) => void;
    mocks.invoke.mockImplementation((cmd: string) => cmd === 'fit_native_gpu_viewport_page'
      ? new Promise(resolve => { finishFit = resolve; }) : Promise.resolve(snapshot));
    change.mockClear();
    const pending = api.fitPage();
    if (order === 'event-first') {
      await sendCamera({ ...snapshot, zoom: 3 }, { cameraVersion: 3, userInitiatedZoom: true });
    }
    await act(async () => { finishFit({ ...snapshot, zoom: 2, cameraVersion: 2 }); await pending; });
    if (order === 'ack-first') {
      expect(change).toHaveBeenLastCalledWith({ ...snapshot, zoom: 2 }, false);
      await sendCamera({ ...snapshot, zoom: 3 }, { cameraVersion: 3, userInitiatedZoom: true });
    }
    expect(api.camera?.zoom).toBe(3);
    expect(change).toHaveBeenLastCalledWith({ ...snapshot, zoom: 3 }, true);
    expect(change).toHaveBeenCalledTimes(order === 'event-first' ? 1 : 2);
  });

  it('ACK tới trước event cùng phiên bản vẫn nhận provenance zoom tay đúng một lần', async () => {
    mocks.invoke.mockResolvedValue(snapshot);
    const change = vi.fn(); render(createElement(Host, { page: 1, change })); await tick();
    mocks.invoke.mockResolvedValue({ ...snapshot, zoom: 3, cameraVersion: 3 });
    change.mockClear();
    await act(async () => { await api.refreshCamera(); });
    expect(change).toHaveBeenLastCalledWith({ ...snapshot, zoom: 3 }, false);
    const accepted = api.camera;
    await sendCamera({ ...snapshot, zoom: 3 }, { cameraVersion: 3, userInitiatedZoom: true });
    expect(api.camera).toBe(accepted);
    expect(change).toHaveBeenLastCalledWith({ ...snapshot, zoom: 3 }, true);
    await sendCamera({ ...snapshot, zoom: 3 }, { cameraVersion: 3, userInitiatedZoom: true });
    expect(change).toHaveBeenCalledTimes(2);
  });

  it('cùng f32 qua JSON RPC/event không làm mất provenance tới sau ACK', async () => {
    mocks.invoke.mockResolvedValue(snapshot);
    const change = vi.fn(); render(createElement(Host, { page: 1, change })); await tick();
    const ack = { ...snapshot, zoom: 1.4271461 };
    mocks.invoke.mockResolvedValue({ ...ack, cameraVersion: 3 });
    await act(async () => { await api.refreshCamera(); });
    change.mockClear();
    const accepted = api.camera;
    await sendCamera({ ...snapshot, zoom: 1.427146077156067 }, { cameraVersion: 3, userInitiatedZoom: true });
    expect(api.camera).toBe(accepted);
    expect(change).toHaveBeenCalledExactlyOnceWith(ack, true);
  });

  it('ACK/event cũ thiếu phiên bản không ghi đè camera đã có phiên bản', async () => {
    mocks.invoke.mockResolvedValue(snapshot);
    const change = vi.fn(); render(createElement(Host, { page: 1, change })); await tick();
    await sendCamera({ ...snapshot, zoom: 3 }, { cameraVersion: 3 });
    change.mockClear();
    mocks.invoke.mockResolvedValue({ ...snapshot, zoom: 2 });
    await act(async () => { await api.refreshCamera(); });
    await sendCamera({ ...snapshot, zoom: 2 });
    // Cùng số phiên bản không thể đại diện cho một camera khác.
    await sendCamera({ ...snapshot, zoom: 8 }, { cameraVersion: 3 });
    expect(api.camera?.zoom).toBe(3);
    expect(change).not.toHaveBeenCalled();
  });

  it('camera cùng hình học vẫn nâng watermark để từ chối ACK đời trước', async () => {
    mocks.invoke.mockResolvedValue(snapshot);
    const change = vi.fn(); render(createElement(Host, { page: 1, change })); await tick();
    change.mockClear();
    await sendCamera(snapshot, { cameraVersion: 7 });
    await sendCamera({ ...snapshot, zoom: 9 }, { cameraVersion: 6 });
    expect(api.camera).toEqual(snapshot);
    expect(change).not.toHaveBeenCalled();
  });

  it('payload camera cũ vẫn dùng được trước khi có phiên bản, mặc định không phải zoom tay', async () => {
    mocks.invoke.mockResolvedValue(snapshot);
    const change = vi.fn(); render(createElement(Host, { page: 1, change })); await tick();
    change.mockClear(); await sendCamera({ ...snapshot, zoom: 2 });
    expect(change).toHaveBeenLastCalledWith({ ...snapshot, zoom: 2 }, false);
  });

  it('đổi scene reset watermark nhưng event của scene cũ vẫn bị chặn', async () => {
    mocks.invoke.mockResolvedValue(snapshot);
    const change = vi.fn(); const host = render(createElement(Host, { page: 1, change })); await tick();
    const old = calls('load_native_gpu_scene').at(-1)![1];
    const [, callback] = mocks.listen.mock.calls.filter(([name]) => name === 'ppe-native-camera').at(-1)!;
    await sendCamera({ ...snapshot, zoom: 8 }, { cameraVersion: 20 });
    host.rerender(createElement(Host, { page: 2, change })); await tick();
    await sendCamera({ ...snapshot, zoom: 2 }, { cameraVersion: 1 });
    change.mockClear();
    await act(async () => callback({ payload: { ...old, camera: { ...snapshot, zoom: 9 }, cameraVersion: 21, userInitiatedZoom: true } }));
    expect(api.camera?.zoom).toBe(2); expect(change).not.toHaveBeenCalled();
  });

  it('đổi lease reset watermark; ACK và event của lease đã đóng không được giành quyền', async () => {
    mocks.invoke.mockResolvedValue(snapshot);
    const change = vi.fn(); const host = render(createElement(Host, { page: 1, change })); await tick();
    const old = calls('load_native_gpu_scene').at(-1)![1];
    const [, oldCameraEvent] = mocks.listen.mock.calls.filter(([name]) => name === 'ppe-native-camera').at(-1)!;
    await sendCamera({ ...snapshot, zoom: 8 }, { cameraVersion: 20 });
    let finishFit!: (value: unknown) => void;
    mocks.invoke.mockImplementation((cmd: string) => cmd === 'fit_native_gpu_viewport_page'
      ? new Promise(resolve => { finishFit = resolve; }) : Promise.resolve(snapshot));
    const pending = api.fitPage();
    host.rerender(createElement(Host, { page: 1, enabled: false, change })); await tick();
    host.rerender(createElement(Host, { page: 1, enabled: true, change })); await tick();
    await sendCamera({ ...snapshot, zoom: 2 }, { cameraVersion: 1 });
    change.mockClear();
    await act(async () => {
      oldCameraEvent({ payload: { ...old, camera: { ...snapshot, zoom: 9 }, cameraVersion: 100, userInitiatedZoom: true } });
      finishFit({ ...snapshot, zoom: 9, cameraVersion: 100 }); await pending;
    });
    expect(api.camera?.zoom).toBe(2); expect(change).not.toHaveBeenCalled();
  });
});

describe('lease viewport native', () => {
  it('V27: idle không đo layout mỗi frame và camera trùng không phát React callback', async()=>{
    mocks.invoke.mockResolvedValue(snapshot);
    const change=vi.fn();render(createElement(Host,{page:1,change}));
    for(let i=0;i<5;i++) await tick();
    const geometry=vi.mocked(HTMLElement.prototype.getBoundingClientRect);geometry.mockClear();
    for(let i=0;i<20;i++) await tick();
    expect(geometry).not.toHaveBeenCalled();
    const [,callback]=mocks.listen.mock.calls.find(([name])=>name==='ppe-native-camera')!;
    const payload=calls('load_native_gpu_scene').at(-1)![1];change.mockClear();
    await act(async()=>{callback({payload:{...payload,camera:{...snapshot}}});callback({payload:{...payload,camera:{...snapshot}}});});
    expect(change).not.toHaveBeenCalled();
    await act(async()=>callback({payload:{...payload,camera:{...snapshot,pan_x:30}}}));
    expect(change).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event('resize'));await tick();expect(geometry).toHaveBeenCalled();
  });
  it('gửi revision nội dung độc lập với revision viewport để cache không lấy scene cũ', async () => {
    mocks.invoke.mockResolvedValue(snapshot);
    const host = render(createElement(Host, { page: 1, token: 'doc-v1' })); await tick();
    host.rerender(createElement(Host, { page: 2, token: 'doc-v1' })); await tick();
    host.rerender(createElement(Host, { page: 1, token: 'doc-v2' })); await tick();
    const requests = calls('load_native_gpu_scene').map(([, value]) => value);
    expect(requests.map(v => v.documentToken)).toEqual(['doc-v1', 'doc-v1', 'doc-v2']);
    expect(new Set(requests.map(v => v.revision)).size).toBe(3);
  });
  it('đổi trang chỉ nhận camera và ready của scene mới nhất', async () => {
    const pending: Array<(value: unknown) => void> = [];
    mocks.invoke.mockImplementation((cmd: string) => cmd === 'load_native_gpu_scene' ? new Promise(resolve => pending.push(resolve)) : Promise.resolve(snapshot));
    const host = render(createElement(Host, { page: 1 })); await tick();
    host.rerender(createElement(Host, { page: 2 })); await tick();
    expect(calls('load_native_gpu_scene').map(([, payload]) => payload.page)).toEqual([1, 2]);
    await act(async () => { pending[1]({ ...snapshot, zoom: 2 }); pending[0]({ ...snapshot, zoom: 8 }); });
    expect(api.camera?.zoom).toBe(2); expect(api.isSceneReady).toBe(true);
  });
  it('ẩn dialog không hủy scene hoặc mở lại HWND', async () => {
    mocks.invoke.mockResolvedValue(snapshot);
    const host = render(createElement(Host, { page: 1 })); await tick();
    const revision = calls('load_native_gpu_scene')[0][1].revision;
    await status(revision); await tick();
    expect(calls('set_native_gpu_viewport_visibility')[0][1].visible).toBe(true);
    host.rerender(createElement(Host, { page: 1, visible: false })); await tick();
    expect(calls('set_native_gpu_viewport_visibility')[1][1].visible).toBe(false);
    host.rerender(createElement(Host, { page: 1, visible: true })); await tick();
    expect(calls('set_native_gpu_viewport_visibility')[2][1].visible).toBe(true);
    expect(calls('open_native_gpu_viewport')).toHaveLength(1);
    expect(calls('close_native_gpu_viewport')).toHaveLength(0);
  });
  it('chỉ hiện sau first-present của revision mới; lỗi render được báo về', async () => {
    mocks.invoke.mockResolvedValue(snapshot); const error = vi.fn();
    const host = render(createElement(Host, { page: 1, error })); await tick();
    expect(api.isSceneReady).toBe(true); expect(api.isPresented).toBe(false);
    expect(calls('set_native_gpu_viewport_visibility')).toHaveLength(0);
    const first = calls('load_native_gpu_scene')[0][1].revision;
    host.rerender(createElement(Host, { page: 2, error })); await tick();
    const second = calls('load_native_gpu_scene')[1][1].revision;
    await status(first); await tick(); expect(api.isPresented).toBe(false);
    await status(second); await tick(); expect(api.isPresented).toBe(true);
    await status(first, 'lỗi scene cũ'); expect(error).not.toHaveBeenCalled();
    await status(second, 'GPU device lost'); expect(error).toHaveBeenCalledWith(expect.objectContaining({ message: 'GPU device lost' }));
  });
  it('không mở ngoài Tauri hoặc khi tắt', () => {
    const first = render(createElement(Host, { enabled: false })); first.unmount();
    vi.stubGlobal('__TAURI_INTERNALS__', undefined); render(createElement(Host));
    expect(calls('open_native_gpu_viewport')).toHaveLength(0);
  });
  it('mở đúng physical geometry và schema Rust, callback đổi không mở lại', async () => {
    const host = render(createElement(Host)); await tick();
    expect(api.isReady).toBe(true); expect(api.camera).toEqual(snapshot);
    expect(calls('open_native_gpu_viewport')[0][1]).toMatchObject({ x: 150, y: 75, width: 1200, height: 900, dpr: 1.5, generation: 1 });
    host.rerender(createElement(Host, { change: vi.fn() })); await tick();
    expect(calls('open_native_gpu_viewport')).toHaveLength(1);
    await act(async () => { await api.setZoom(2, 20, 30); });
    const { viewId, generation } = calls('open_native_gpu_viewport')[0][1];
    expect(calls('set_native_gpu_viewport_zoom')[0][1]).toMatchObject({ zoom: 2, cursorX: 20, cursorY: 30, viewId, generation });
    expect(calls('set_native_gpu_viewport_zoom')[0][1].revision).toBeGreaterThan(0);
  });
  it('Fit Page gửi lệnh camera với đúng scene revision', async () => {
    mocks.invoke.mockResolvedValue(snapshot);
    render(createElement(Host, { page: 1 })); await tick();
    const scene = calls('load_native_gpu_scene').at(-1)![1];
    await act(async () => { await api.fitPage(); });
    expect(calls('fit_native_gpu_viewport_page').at(-1)![1]).toMatchObject({ revision: scene.revision });
    expect(calls('fit_native_gpu_viewport_page').at(-1)![1].maxZoom).toBeUndefined();
  });
  it('Smart Fit chuyển giới hạn 100% đã hiệu chuẩn tới native, Fit Page bỏ giới hạn', async () => {
    mocks.invoke.mockResolvedValue(snapshot);
    render(createElement(Host, { page: 1 })); await tick();
    const maxZoom = 92 / 72;
    await act(async () => { await api.fitPage(maxZoom); });
    expect(calls('fit_native_gpu_viewport_page').at(-1)![1].maxZoom).toBe(maxZoom);
    await act(async () => { await api.fitPage(); });
    expect(calls('fit_native_gpu_viewport_page').at(-1)![1].maxZoom).toBeUndefined();
  });
  it('chỉ mở một lần khi open còn pending; cleanup đóng đúng lease sau resolve', async () => {
    let finish!: (value: unknown) => void;
    mocks.invoke.mockImplementation((cmd: string) => cmd === 'open_native_gpu_viewport' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve());
    const host = render(createElement(Host)); await tick(); await tick();
    expect(calls('open_native_gpu_viewport')).toHaveLength(1);
    const { viewId, generation } = calls('open_native_gpu_viewport')[0][1];
    host.unmount();
    await act(async () => { finish(snapshot); });
    expect(calls('close_native_gpu_viewport').length).toBeGreaterThan(0);
    for (const [, payload] of calls('close_native_gpu_viewport')) expect(payload).toEqual({ viewId, generation });
  });
  it('hai owner độc lập và StrictMode không nhận response của generation cũ', async () => {
    const pending: Array<(value: unknown) => void> = [];
    mocks.invoke.mockImplementation((cmd: string) => cmd === 'open_native_gpu_viewport' ? new Promise(resolve => pending.push(resolve)) : Promise.resolve());
    const first = render(createElement(StrictMode, {}, createElement(Host)));
    expect(calls('open_native_gpu_viewport')).toHaveLength(2);
    const opens = calls('open_native_gpu_viewport');
    expect(opens[0][1].viewId).toBe(opens[1][1].viewId);
    expect(opens[1][1].generation).toBeGreaterThan(opens[0][1].generation);
    await act(async () => { pending[1](snapshot); pending[0]({ ...snapshot, zoom: 8 }); });
    expect(api.camera?.zoom).toBe(1);
    render(createElement(Host));
    expect(calls('open_native_gpu_viewport')[2][1].viewId).not.toBe(opens[0][1].viewId);
    first.unmount();
  });
  it('đổi DPR trong cùng CSS rect vẫn resize', async () => {
    render(createElement(Host)); await tick(); vi.stubGlobal('devicePixelRatio', 2); await tick();
    // Resize non-opening được debounce 80ms để tránh surface-lost khi layout
    // chạy qua nhiều frame liên tiếp.
    await new Promise(resolve => setTimeout(resolve, 90)); await tick();
    expect(calls('resize_native_gpu_viewport')[0][1]).toMatchObject({ x: 200, y: 100, width: 1600, height: 1200, dpr: 2 });
  });
  it('tắt sau khi mở xóa trạng thái ready và chỉ đóng lease đang sở hữu', async () => {
    const host = render(createElement(Host)); await tick();
    expect(api.isReady).toBe(true);
    host.rerender(createElement(Host, { enabled: false })); await tick();
    expect(api.isReady).toBe(false); expect(api.camera).toBeNull();
    expect(calls('close_native_gpu_viewport')).toHaveLength(1);
    expect(calls('open_native_gpu_viewport')).toHaveLength(1);
  });
  it('từ chối payload sai và đóng HWND vừa tạo', async () => {
    const error = vi.fn(); mocks.invoke.mockResolvedValue({ zoom: 1, translation_x: 0 });
    render(createElement(Host, { error })); await tick();
    expect(api.isReady).toBe(false); expect(error).toHaveBeenCalled();
    expect(calls('close_native_gpu_viewport')).toHaveLength(1);
    expect(() => parseNativeCamera({ ...snapshot, dpr: NaN })).toThrow();
  });
});

it('giữ lease khi chuyển trang và loại camera/response zoom của revision cũ', async () => {
  mocks.invoke.mockResolvedValue(snapshot); const change = vi.fn();
  const host = render(createElement(Host, { page: 1, change })); await tick();
  const old = calls('load_native_gpu_scene').at(-1)![1];
  await status(old.revision); await tick(); expect(api.isVisible).toBe(true);
  let finishZoom!: (value: unknown) => void;
  mocks.invoke.mockImplementation((cmd: string) => cmd === 'set_native_gpu_viewport_zoom'
    ? new Promise(resolve => { finishZoom = resolve; }) : Promise.resolve(snapshot));
  let pending!: ReturnType<typeof api.setZoom>;
  await act(async () => { pending = api.setZoom(8); });
  host.rerender(createElement(Host, { page: 2, change })); await tick();
  const current = calls('load_native_gpu_scene').at(-1)![1];
  // Scene mới đang compile: HWND native ẩn để fallback giữ pixel, không che
  // WebView bằng surface có thể đã bị driver xoá.
  expect(api.isVisible).toBe(false); expect(api.isPresented).toBe(false);
  expect(calls('open_native_gpu_viewport')).toHaveLength(1);
  expect(calls('close_native_gpu_viewport')).toHaveLength(0);
  expect(current.revision).toBeGreaterThan(old.revision);
  change.mockClear();
  const [, cameraEvent] = mocks.listen.mock.calls.find(([name]) => name === 'ppe-native-camera')!;
  await act(async () => {
    cameraEvent({ payload: { ...old, camera: { ...snapshot, zoom: 9 } } });
    finishZoom({ ...snapshot, zoom: 8 }); await pending;
  });
  expect(change).not.toHaveBeenCalled(); expect(api.camera?.zoom).toBe(1);
  await act(async () => cameraEvent({ payload: { ...current, camera: { ...snapshot, zoom: 2 } } }));
  expect(api.camera?.zoom).toBe(2);
  await status(old.revision); await tick(); expect(api.isVisible).toBe(false);
  await status(current.revision); await tick(); expect(api.isVisible).toBe(true);
});

it('bỏ qua lỗi IPC của scene cũ, không hạ GPU thành lỗi fatal', async () => {
  mocks.invoke.mockResolvedValue(snapshot);
  const error = vi.fn();
  render(createElement(Host, { page: 1, error })); await tick();
  const current = calls('load_native_gpu_scene').at(-1)![1];
  await status(current.revision, 'Zoom thuộc trang cũ');
  expect(error).not.toHaveBeenCalled();
  expect(api.isReady).toBe(true);
});

it('bỏ qua trạng thái refinement bị thay thế trong lúc đổi trang', async () => {
  mocks.invoke.mockResolvedValue(snapshot);
  const error = vi.fn();
  render(createElement(Host, { page: 1, error })); await tick();
  const current = calls('load_native_gpu_scene').at(-1)![1];
  await status(current.revision, 'Frame đã bị thay thế');
  expect(error).not.toHaveBeenCalled();
  expect(api.isReady).toBe(true);
});

it('cache first-present tới trước lần đo DOM vẫn hiện lại HWND ở revision mới', async () => {
  mocks.invoke.mockResolvedValue(snapshot);
  const host = render(createElement(Host, { page: 1 })); await tick();
  await status(calls('load_native_gpu_scene').at(-1)![1].revision); await tick();
  expect(api.isVisible).toBe(true);
  host.rerender(createElement(Host, { page: 2 }));
  await tick();
  const current = calls('load_native_gpu_scene').at(-1)![1];
  // Handoff mới phải hide HWND cũ rồi show lại sau first-present đúng revision.
  await status(current.revision); await tick();
  const visibility = calls('set_native_gpu_viewport_visibility');
  const shows = visibility.filter(([, p]) => p.visible);
  expect(shows.length).toBeGreaterThanOrEqual(1);
  expect(shows.at(-1)![1].revision).toBe(current.revision);
  expect(api.isVisible).toBe(true);
});

it('từ chối bàn giao HWND khi contentReady là false (chống màn xám)', async () => {
  mocks.invoke.mockResolvedValue(snapshot);
  render(createElement(Host, { page: 1 })); await tick();
  const current = calls('load_native_gpu_scene').at(-1)![1];
  // Status báo present thành công nhưng contentReady=false (ví dụ: texture rỗng/xám)
  await status(current.revision, null, false); await tick();
  expect(api.isPresented).toBe(false);
  expect(api.isVisible).toBe(false);
  expect(calls('set_native_gpu_viewport_visibility')).toHaveLength(0);
});

it('V27: thiếu proof không ACK; false sau true thu lại quyền native',async()=>{
  mocks.invoke.mockResolvedValue(snapshot);render(createElement(Host,{page:1}));await tick();
  const payload=calls('load_native_gpu_scene').at(-1)![1];
  const [,callback]=mocks.listen.mock.calls.find(([name])=>name==='ppe-native-status')!;
  await act(async()=>callback({payload:{...payload,error:null}}));await tick();expect(api.isPresented).toBe(false);
  await status(payload.revision);await tick();expect(api.isVisible).toBe(true);
  await status(payload.revision,null,false);await tick();expect(api.isPresented).toBe(false);expect(api.isVisible).toBe(false);
});
it('V27: surface proof kiểm epoch, extent và DPR, không nhận NaN hoặc đời cũ',()=>{
  const expected={width:1200,height:900,dpr:1.5};const good={...expected,epoch:3};
  expect(matchesNativeSurfaceProof(good,expected,3)).toBe(true);
  for(const value of [undefined,{...good,epoch:2},{...good,width:800},{...good,dpr:2},{...good,epoch:NaN}]){
    expect(matchesNativeSurfaceProof(value,expected,3)).toBe(false);
  }
});

it('bất biến chống chớp: khi native đã visible, thay đổi bounds do resize không làm hạ visibility về false', async () => {
  mocks.invoke.mockResolvedValue(snapshot);
  render(createElement(Host, { page: 1 })); await tick();
  const current = calls('load_native_gpu_scene').at(-1)![1];
  await status(current.revision, null, true); await tick();
  expect(api.isVisible).toBe(true);
  const initialVisibilityCalls = calls('set_native_gpu_viewport_visibility').length;
  expect(initialVisibilityCalls).toBeGreaterThanOrEqual(1);

  // Giả lập resize/zoom làm thay đổi bounding client rect
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 120, top: 60, right: 920, bottom: 660, width: 800, height: 600, x: 120, y: 60, toJSON: () => ({})
  });
  await tick();
  await tick();

  // Bất biến: KHÔNG được gọi set_native_gpu_viewport_visibility(false) khi đang hiển thị
  const falseVisCalls = calls('set_native_gpu_viewport_visibility').filter(([, p]) => !p.visible);
  expect(falseVisCalls).toHaveLength(0);
  expect(api.isVisible).toBe(true);
});
