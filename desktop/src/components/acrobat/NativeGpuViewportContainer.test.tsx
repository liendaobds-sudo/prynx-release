// @vitest-environment jsdom
// PERF (audit 2026-09-25 §R25.GPU.29): kiểm chuyển từ trang đang xem sang HWND thật qua IPC.
import { useEffect, useRef, useState } from 'react';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { useViewerZoom } from '../../hooks/viewer/useViewerZoom';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), mounted: vi.fn(), unmounted: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }));
vi.mock('../../lib/previewPerfLog', () => ({ viewerTraceLog: vi.fn().mockResolvedValue(undefined) }));
import { NativeGpuViewportContainer } from './NativeGpuViewportContainer';
import { useTextMarkupStore } from '../../stores/useTextMarkupStore';
import { useAppSettingsStore } from '../../stores/appSettingsStore';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }) }));
import camera from '../../../../tests/viewer_gpu/native-camera-v1.json';

let frames: Map<number, FrameRequestCallback>;
let frameId = 0;
function ExistingPage() {
  useEffect(() => { mocks.mounted(); return () => { mocks.unmounted(); }; }, []);
  // Mô phỏng hàng PDFium thật: inline visibility/pointer-events từng làm
  // lớp fallback tiếp tục che HWND dù node cha đã ẩn.
  return <div style={{ visibility: 'visible', pointerEvents: 'auto' }}>Trang PDF đang xem</div>;
}
function ScrollableExistingPage() {
  return <div data-testid="audit-scroll" style={{ overflow: 'auto', width: 320, height: 240 }}><div style={{ width: 2000, height: 3000 }} /></div>;
}
function Host({ selected = true, enabled = true, page = 1, scale = camera.zoom, fitMode, onError = vi.fn(), tool = 'pointer' as 'pointer' | 'hand', onContextMenu = vi.fn(), zoomAnchor }: { selected?: boolean; enabled?: boolean; page?: number; scale?: number; fitMode?: string; onError?: (error: Error) => void; tool?: 'pointer' | 'hand'; onContextMenu?: (x: number, y: number) => void; zoomAnchor?: { x: number; y: number; clientX?: number; clientY?: number } | null }) {
  return <NativeGpuViewportContainer enabled={enabled} selected={selected}
    filePath="D:/fixture.pdf" page={page} documentToken="1" scale={scale} fitMode={fitMode} onError={onError} tool={tool} onContextMenu={onContextMenu} zoomAnchor={zoomAnchor}>
    <ExistingPage />
  </NativeGpuViewportContainer>;
}
const calls = (name: string) => mocks.invoke.mock.calls.filter(([cmd]) => cmd === name);
function SettingsHost() { const enabled = useAppSettingsStore(s => s.nativeGpuViewportEnabled); return <Host enabled={enabled} />; }
const tick = async () => { await act(async () => {
  const pending = [...frames.values()]; frames.clear(); pending.forEach(cb => cb(0));
}); };
const present = async () => {
  const [, callback] = mocks.listen.mock.calls.filter(([name]) => name === 'ppe-native-status').at(-1)!;
  const payload = calls('load_native_gpu_scene').at(-1)![1];
  const bounds=(calls('resize_native_gpu_viewport').at(-1) ?? calls('open_native_gpu_viewport').at(-1))![1];
  await act(async () => callback({ payload: { ...payload, error: null, contentReady:true,
    surface:{epoch:1+calls('resize_native_gpu_viewport').length,width:bounds.width,height:bounds.height,dpr:bounds.dpr} } }));
  await tick();
  await tick();
};
beforeEach(() => {
  vi.clearAllMocks(); frames = new Map(); mocks.invoke.mockResolvedValue(camera); mocks.listen.mockResolvedValue(vi.fn());
  useTextMarkupStore.getState().clear();
  useAppSettingsStore.getState().setNativeGpuViewportEnabled(false);
  vi.stubGlobal('__TAURI_INTERNALS__', {});
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.set(++frameId, cb); return frameId; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON: () => ({}) });
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue({ length: 1 } as DOMRectList);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('giữ nguyên trang đã mount khi bật GPU cho tới first-present', async () => {
  const host = render(<Host selected={false} />); await tick();
  expect(calls('open_native_gpu_viewport')).toHaveLength(0);
  expect(screen.getByText('Trang PDF đang xem')).toBeTruthy();
  host.rerender(<Host selected />); await tick(); await tick();
  expect(calls('load_native_gpu_scene')).toHaveLength(1);
  expect(screen.getByText('Trang PDF đang xem')).toBeTruthy();
  expect(mocks.mounted).toHaveBeenCalledTimes(1);
  expect(mocks.unmounted).not.toHaveBeenCalled();
  expect(screen.queryByRole('status')).toBeNull();
  await present();
  expect(screen.getByText('Trang PDF đang xem')).toBeTruthy();
  expect(mocks.unmounted).not.toHaveBeenCalled();
});

it('đổi pointer rồi bàn tay dùng lại scene, không mở hoặc compile lần nữa', async () => {
  const host = render(<Host selected />); await tick(); await present();
  for (let i = 0; i < 3; i++) {
    host.rerender(<Host selected={false} />); await tick();
    expect(screen.getByText('Trang PDF đang xem')).toBeTruthy();
    expect(calls('set_native_gpu_viewport_visibility').at(-1)![1].visible).toBe(false);
    host.rerender(<Host selected />); await tick();
    expect(screen.getByText('Trang PDF đang xem')).toBeTruthy();
    expect(calls('set_native_gpu_viewport_visibility').at(-1)![1].visible).toBe(true);
  }
  expect(calls('open_native_gpu_viewport')).toHaveLength(1);
  expect(calls('load_native_gpu_scene')).toHaveLength(1);
  expect(calls('close_native_gpu_viewport')).toHaveLength(0);
});

it('đổi tab ẩn/hiện không fit lại camera native về giữa trang', async () => {
  const host = render(<Host selected fitMode="page" />); await tick(); await present();
  const before = calls('fit_native_gpu_viewport_page').length;
  host.rerender(<Host selected={false} fitMode="page" />); await tick();
  host.rerender(<Host selected fitMode="page" />); await tick();
  expect(calls('fit_native_gpu_viewport_page')).toHaveLength(before);
});

it('fitMode smart không đè setZoom bằng scale chưa ổn định và kích hoạt fitPage', async () => {
  render(<Host selected fitMode="smart" scale={16.632} />); await tick(); await present();
  expect(calls('set_native_gpu_viewport_zoom')).toHaveLength(0);
  expect(calls('fit_native_gpu_viewport_page')).toHaveLength(1);
});

it('AcrobatViewer nối Smart Fit với mức 100% vật lý, không lấy zoom hiện hành', () => {
  const source = readFileSync('src/components/AcrobatViewer.tsx', 'utf8');
  const ast = ts.createSourceFile('AcrobatViewer.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const expressions: string[] = [];
  let bitmapDpi: number | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'VIEWER_BITMAP_DPI'
      && node.initializer && ts.isNumericLiteral(node.initializer)) bitmapDpi = Number(node.initializer.text);
    if (ts.isJsxOpeningElement(node) && node.tagName.getText(ast) === 'NativeGpuViewportContainer') {
      const attr = node.attributes.properties.find(item => ts.isJsxAttribute(item) && item.name.getText(ast) === 'smartFitScale');
      if (attr && ts.isJsxAttribute(attr) && attr.initializer && ts.isJsxExpression(attr.initializer) && attr.initializer.expression) {
        expressions.push(attr.initializer.expression.getText(ast));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  expect(expressions).toHaveLength(1);
  expect(bitmapDpi).toBe(96);
  const code = ts.transpileModule(`return (${expressions[0]});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const resolve = new Function('physicalDisplayScale', 'VIEWER_BITMAP_DPI', code) as (displayScale: number, bitmapDpi: number) => number;
  expect(resolve(92 / 96, bitmapDpi!)).toBeCloseTo(92 / 72, 12);
  expect(resolve(144 / 96 / 1.5, bitmapDpi!)).toBeCloseTo(96 / 72, 12);
});

it('Smart Fit giới hạn theo hiệu chuẩn; đổi hiệu chuẩn fit lại, Fit Page không giữ giới hạn', async () => {
  const change = vi.fn();
  let version = 1;
  mocks.invoke.mockImplementation((cmd: string, payload?: { maxZoom?: number }) => Promise.resolve(cmd === 'fit_native_gpu_viewport_page'
    ? { ...camera, zoom: payload?.maxZoom ?? 2, cameraVersion: ++version } : camera));
  const props = { filePath: 'D:/fixture.pdf', page: 1, documentToken: '1', scale: 4, onCameraChange: change };
  const host = render(<NativeGpuViewportContainer {...props} fitMode="smart" smartFitScale={92 / 72}><ExistingPage /></NativeGpuViewportContainer>);
  await tick(); await present();
  expect(calls('fit_native_gpu_viewport_page').at(-1)![1].maxZoom).toBe(92 / 72);
  expect(change).toHaveBeenLastCalledWith({ ...camera, zoom: 92 / 72 }, false);
  expect(calls('set_native_gpu_viewport_zoom')).toHaveLength(0);
  const before = calls('fit_native_gpu_viewport_page').length;
  host.rerender(<NativeGpuViewportContainer {...props} fitMode="smart" smartFitScale={100 / 72}><ExistingPage /></NativeGpuViewportContainer>);
  await tick();
  expect(calls('fit_native_gpu_viewport_page')).toHaveLength(before + 1);
  expect(calls('fit_native_gpu_viewport_page').at(-1)![1].maxZoom).toBe(100 / 72);
  host.rerender(<NativeGpuViewportContainer {...props} fitMode="page" smartFitScale={100 / 72}><ExistingPage /></NativeGpuViewportContainer>);
  await tick();
  expect(calls('fit_native_gpu_viewport_page')).toHaveLength(before + 2);
  expect(calls('fit_native_gpu_viewport_page').at(-1)![1].maxZoom).toBeUndefined();
});

it.each(['smart', 'page'])('chế độ %s fit lại sau resize/DPR nhưng không fit lại vì pan', async fitMode => {
  let currentCamera = { ...camera };
  mocks.invoke.mockImplementation(() => Promise.resolve(currentCamera));
  render(<Host selected fitMode={fitMode} />); await tick(); await present();
  const before = calls('fit_native_gpu_viewport_page').length;
  const [, callback] = mocks.listen.mock.calls.filter(([name]) => name === 'ppe-native-camera').at(-1)!;
  const payload = calls('load_native_gpu_scene').at(-1)![1];
  currentCamera = { ...camera, viewport_width: 1600, viewport_height: 1000 };
  await act(async () => callback({ payload: { ...payload, camera: currentCamera, cameraVersion: 2 } }));
  expect(calls('fit_native_gpu_viewport_page')).toHaveLength(before + 1);
  currentCamera = { ...currentCamera, pan_x: -40, pan_y: -80 };
  await act(async () => callback({ payload: { ...payload, camera: currentCamera, cameraVersion: 3 } }));
  expect(calls('fit_native_gpu_viewport_page')).toHaveLength(before + 1);
  currentCamera = { ...currentCamera, dpr: 2 };
  await act(async () => callback({ payload: { ...payload, camera: currentCamera, cameraVersion: 4 } }));
  expect(calls('fit_native_gpu_viewport_page')).toHaveLength(before + 2);
});

it('nối provenance camera tới Viewer: Fit ACK false, wheel native true, tab ẩn không nhận', async () => {
  const change = vi.fn();
  mocks.invoke.mockImplementation((cmd: string) => Promise.resolve(cmd === 'fit_native_gpu_viewport_page'
    ? { ...camera, zoom: 1.4, cameraVersion: 2 } : camera));
  const props = { filePath: 'D:/fixture.pdf', page: 1, documentToken: '1', scale: 1, fitMode: 'smart', onCameraChange: change };
  const host = render(<NativeGpuViewportContainer {...props} selected><ExistingPage /></NativeGpuViewportContainer>);
  await tick(); await present();
  expect(change).toHaveBeenLastCalledWith({ ...camera, zoom: 1.4 }, false);
  const [, callback] = mocks.listen.mock.calls.filter(([name]) => name === 'ppe-native-camera').at(-1)!;
  const payload = calls('load_native_gpu_scene').at(-1)![1];
  await act(async () => callback({ payload: { ...payload, camera: { ...camera, zoom: 2 }, cameraVersion: 3, userInitiatedZoom: true } }));
  expect(change).toHaveBeenLastCalledWith({ ...camera, zoom: 2 }, true);
  host.rerender(<NativeGpuViewportContainer {...props} selected={false}><ExistingPage /></NativeGpuViewportContainer>);
  await tick(); change.mockClear();
  await act(async () => callback({ payload: { ...payload, camera: { ...camera, zoom: 3 }, cameraVersion: 4, userInitiatedZoom: true } }));
  expect(change).not.toHaveBeenCalled();
});

it('Fit ACK trễ không kéo scale native lùi sau wheel mới trong cùng scene', async () => {
  let finishFit!: (value: unknown) => void;
  mocks.invoke.mockImplementation((cmd: string) => cmd === 'fit_native_gpu_viewport_page'
    ? new Promise(resolve => { finishFit = resolve; }) : Promise.resolve(camera));
  const change = vi.fn();
  render(<NativeGpuViewportContainer filePath="D:/fixture.pdf" page={1} documentToken="1" scale={1}
    fitMode="smart" onCameraChange={change}><ExistingPage /></NativeGpuViewportContainer>);
  await tick(); await present();
  const [, callback] = mocks.listen.mock.calls.filter(([name]) => name === 'ppe-native-camera').at(-1)!;
  const payload = calls('load_native_gpu_scene').at(-1)![1];
  change.mockClear();
  await act(async () => callback({ payload: { ...payload, camera: { ...camera, zoom: 3 }, cameraVersion: 3, userInitiatedZoom: true } }));
  await act(async () => finishFit({ ...camera, zoom: 2, cameraVersion: 2 }));
  expect(change).toHaveBeenCalledExactlyOnceWith({ ...camera, zoom: 3 }, true);
});

it('handoff native giữ nguyên node scroll và vị trí camera DOM', async () => {
  const host = render(<NativeGpuViewportContainer enabled selected filePath="D:/fixture.pdf" page={1}
    documentToken="1" scale={camera.zoom}><ScrollableExistingPage /></NativeGpuViewportContainer>);
  await tick();
  const before = screen.getByTestId('audit-scroll');
  before.scrollLeft = 240; before.scrollTop = 360;
  await present();
  host.rerender(<NativeGpuViewportContainer enabled={false} selected={false} filePath="D:/fixture.pdf" page={1}
    documentToken="1" scale={camera.zoom}><ScrollableExistingPage /></NativeGpuViewportContainer>);
  await tick();
  const after = screen.getByTestId('audit-scroll');
  expect(after).toBe(before);
  expect([after.scrollLeft, after.scrollTop]).toEqual([240, 360]);
});

it('tắt native trả lại trang hiện hành và đóng lease', async () => {
  const host = render(<Host selected />); await tick(); await present();
  host.rerender(<Host selected enabled={false} />); await tick();
  expect(screen.getByText('Trang PDF đang xem')).toBeTruthy();
  expect(calls('close_native_gpu_viewport')).toHaveLength(1);
});

it('đổi trang giữ trang mới trong lúc chuẩn bị scene mới, không dùng first-present cũ', async () => {
  const host = render(<Host selected />); await tick(); await present();
  host.rerender(<Host selected page={2} />); await tick();
  expect(screen.getByText('Trang PDF đang xem')).toBeTruthy();
  expect(calls('load_native_gpu_scene').map(([, payload]) => payload.page)).toEqual([1, 2]);
  expect(calls('close_native_gpu_viewport')).toHaveLength(0);
  expect(calls('open_native_gpu_viewport')).toHaveLength(1);
  await present(); expect(screen.getByText('Trang PDF đang xem')).toBeTruthy();
});

it('không bỏ trang cũ khi first-present đã tới nhưng lệnh hiện HWND chưa hoàn tất', async () => {
  let finishShow!: () => void;
  mocks.invoke.mockImplementation((cmd: string, payload: { visible?: boolean }) =>
    cmd === 'set_native_gpu_viewport_visibility' && payload.visible
      ? new Promise<void>(resolve => { finishShow = resolve; }) : Promise.resolve(camera));
  render(<Host selected />); await tick(); await present();
  expect(screen.getByText('Trang PDF đang xem')).toBeTruthy();
  await act(async () => finishShow());
  expect(screen.getByText('Trang PDF đang xem')).toBeTruthy();
});

it('rời bàn tay trong lúc chuẩn bị không để status tới muộn che trang pointer', async () => {
  const host = render(<Host selected />); await tick();
  host.rerender(<Host selected={false} />); await tick(); await present();
  expect(screen.getByText('Trang PDF đang xem')).toBeTruthy();
  expect(calls('set_native_gpu_viewport_visibility')).toHaveLength(0);
  host.rerender(<Host selected />); await tick(); await tick();
  expect(screen.getByText('Trang PDF đang xem')).toBeTruthy();
  expect(calls('load_native_gpu_scene')).toHaveLength(1);
});

const interaction = async (event: object, override = {}) => {
  const [, callback] = mocks.listen.mock.calls.filter(([name]) => name === 'ppe-native-interaction').at(-1)!;
  const payload = calls('load_native_gpu_scene').at(-1)![1];
  await act(async () => callback({ payload: { ...payload, ...override, event } }));
};

it('phím native nối ngay tới menu Viewer, giữ từng lần lặp và đúng thứ tự', async () => {
  render(<Host />); await tick(); await present();
  const dispatch = vi.spyOn(window, 'dispatchEvent');
  const [, callback] = mocks.listen.mock.calls.filter(([name]) => name === 'ppe-native-interaction').at(-1)!;
  const payload = calls('load_native_gpu_scene').at(-1)![1];
  const commands = ['fit-page', 'zoom-100', 'fit-width', 'zoom-in', 'zoom-out',
    'prev-page', 'next-page', 'next-page', 'next-page', 'first-page', 'last-page'];
  await act(async () => {
    for (const [index, command] of commands.entries()) {
      callback({ payload: { ...payload, event: { kind: 'viewer_command', command } } });
      // Kiểm ngay trước khi React có lượt commit: không gom key-repeat qua state.
      const emitted = dispatch.mock.calls.map(([event]) => event)
        .filter(event => event.type === 'prynx-menu-command');
      expect(emitted).toHaveLength(index + 1);
    }
  });
  const emitted = dispatch.mock.calls.map(([event]) => event)
    .filter(event => event.type === 'prynx-menu-command') as CustomEvent<{ cmd: string }>[];
  expect(emitted.map(event => event.detail)).toEqual(commands.map(cmd => ({ cmd })));
});

it('lệnh bàn phím native không nhận lệnh ngoài allowlist hoặc sai lease/revision', async () => {
  render(<Host />); await tick(); await present();
  const dispatch = vi.spyOn(window, 'dispatchEvent');
  for (const command of ['delete-pages', 'open', 'FIT-PAGE', '', null, undefined, 123, { cmd: 'next-page' }]) {
    await interaction({ kind: 'viewer_command', command });
  }
  await interaction({ kind: 'viewer_command', command: 'next-page' }, { revision: -1 });
  await interaction({ kind: 'viewer_command', command: 'next-page' }, { generation: -1 });
  await interaction({ kind: 'viewer_command', command: 'next-page' }, { viewId: 'viewport-khac' });
  expect(dispatch.mock.calls.filter(([event]) => event.type === 'prynx-menu-command')).toHaveLength(0);
});

it('lệnh bàn phím native không phát từ tab ẩn, view ẩn, modal hoặc lease đã đóng', async () => {
  const props = { filePath: 'D:/fixture.pdf', page: 1, documentToken: '1', scale: 1 };
  const host = render(<NativeGpuViewportContainer {...props}><ExistingPage /></NativeGpuViewportContainer>);
  await tick(); await present();
  const dispatch = vi.spyOn(window, 'dispatchEvent');
  host.rerender(<NativeGpuViewportContainer {...props} selected={false}><ExistingPage /></NativeGpuViewportContainer>);
  await tick(); await interaction({ kind: 'viewer_command', command: 'next-page' });
  host.rerender(<NativeGpuViewportContainer {...props} visible={false}><ExistingPage /></NativeGpuViewportContainer>);
  await tick(); await interaction({ kind: 'viewer_command', command: 'next-page' });
  host.rerender(<NativeGpuViewportContainer {...props}><ExistingPage /></NativeGpuViewportContainer>);
  await tick();
  const popup = document.createElement('dialog'); popup.open = true;
  await act(async () => { document.body.appendChild(popup); });
  await interaction({ kind: 'viewer_command', command: 'next-page' });
  await act(async () => popup.remove());
  const [, callback] = mocks.listen.mock.calls.filter(([name]) => name === 'ppe-native-interaction').at(-1)!;
  const payload = calls('load_native_gpu_scene').at(-1)![1];
  host.unmount();
  await act(async () => callback({ payload: { ...payload, event: { kind: 'viewer_command', command: 'next-page' } } }));
  expect(dispatch.mock.calls.filter(([event]) => event.type === 'prynx-menu-command')).toHaveLength(0);
});
it('GPU khởi tạo ngay với pointer; đổi hand/pointer giữ nguyên lease, scene và camera', async () => {
  const host = render(<Host />); await tick(); await present();
  expect(calls('set_native_gpu_viewport_interaction')[0][1].tool).toBe('pointer');
  expect(screen.getByText('Trang PDF đang xem')).toBeTruthy();
  const zoomCalls = calls('set_native_gpu_viewport_zoom').length;
  for (const tool of ['hand', 'pointer', 'hand', 'pointer'] as const) {
    host.rerender(<Host tool={tool} />); await tick();
    expect(calls('set_native_gpu_viewport_interaction').at(-1)![1].tool).toBe(tool);
  }
  expect(calls('open_native_gpu_viewport')).toHaveLength(1);
  expect(calls('load_native_gpu_scene')).toHaveLength(1);
  expect(calls('close_native_gpu_viewport')).toHaveLength(0);
  expect(calls('set_native_gpu_viewport_zoom')).toHaveLength(zoomCalls);
});
it('duy trì hiển thị cây fallback (không ép opacity 0) khi HWND native nhận quyền vẽ để tránh mất view', async () => {
  const host = render(<Host selected />); await tick(); await present();
  const container = screen.getByTestId('native-gpu-viewport-container');
  const fallback = container.querySelector('[data-native-fallback-hidden]') as HTMLElement;
  expect(fallback.dataset.nativeFallbackHidden).toBe('true');
  // UIUX: Không ép visibility: hidden hay opacity: 0; chỉ khóa pointerEvents
  expect(fallback.style.pointerEvents).toBe('none');
  expect(fallback.style.opacity).not.toBe('0');
  host.rerender(<Host selected={false} />); await tick();
  expect(fallback.dataset.nativeFallbackHidden).toBe('false');
  expect(fallback.style.pointerEvents).toBe('');
});
it('cài đặt GPU/CPU là nguồn quyết định mở và đóng native ở con trỏ mặc định', async () => {
  render(<SettingsHost />); await tick(); expect(calls('open_native_gpu_viewport')).toHaveLength(0);
  await act(async () => useAppSettingsStore.getState().setNativeGpuViewportEnabled(true)); await tick(); await present();
  expect(calls('open_native_gpu_viewport')).toHaveLength(1);
  expect(calls('set_native_gpu_viewport_interaction')[0][1].tool).toBe('pointer');
  await act(async () => useAppSettingsStore.getState().setNativeGpuViewportEnabled(false)); await tick();
  expect(calls('close_native_gpu_viewport')).toHaveLength(1); expect(screen.getByText('Trang PDF đang xem')).toBeTruthy();
});
it('chưa ACK hợp đồng input thì không che trang hiện hành dù GPU đã present', async () => {
  let finish!: () => void;
  mocks.invoke.mockImplementation((cmd: string) => cmd === 'set_native_gpu_viewport_interaction'
    ? new Promise<void>(resolve => { finish = resolve; }) : Promise.resolve(camera));
  render(<Host />); await tick(); await present();
  expect(calls('set_native_gpu_viewport_visibility')).toHaveLength(0);
  expect(screen.getByText('Trang PDF đang xem')).toBeTruthy();
  await act(async () => finish()); await tick();
  expect(screen.getByText('Trang PDF đang xem')).toBeTruthy();
});
it('vùng chọn native cho copy và markup, popup không hủy scene', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  render(<Host />); await tick(); await present();
  const selection = { text: 'Tiếng Việt', rects: [{ x: 10, y: 20, width: 50, height: 12 }] };
  await interaction({ kind: 'selection', selection }); await tick();
  expect(screen.getByTitle('Sao chép văn bản (Copy)')).toBeTruthy();
  fireEvent.keyDown(window, { key: 'c', ctrlKey: true });
  expect(writeText).toHaveBeenCalledWith('Tiếng Việt');
  await interaction({ kind: 'selection', selection });
  fireEvent.click(screen.getByTitle('Đánh dấu văn bản (Highlight)'));
  expect(useTextMarkupStore.getState().markups[0]).toMatchObject({ type: 'highlight', pageNum: 1, rectPt: selection.rects[0] });
  await tick();
  expect(calls('set_native_gpu_viewport_interaction').some(([,p]) => p.markups?.length === 1)).toBe(true);
  expect(calls('load_native_gpu_scene')).toHaveLength(1);
  expect(calls('close_native_gpu_viewport')).toHaveLength(0);
});
it('menu nhận CSS coordinates; event tab nền và revision cũ bị bỏ', async () => {
  const menu = vi.fn(); const host = render(<Host onContextMenu={menu} />); await tick(); await present();
  await interaction({ kind: 'context_menu', x: 70, y: 90 }); expect(menu).toHaveBeenLastCalledWith(70, 90);
  menu.mockClear(); await interaction({ kind: 'context_menu', x: 1, y: 1 }, { revision: -1 }); expect(menu).not.toHaveBeenCalled();
  host.rerender(<Host selected={false} onContextMenu={menu} />); await tick();
  await interaction({ kind: 'context_menu', x: 1, y: 1 }); expect(menu).not.toHaveBeenCalled();
});

it('viewport giữ ẩn không dựng lại theo zoom của công cụ khác', async () => {
  const host = render(<Host selected />); await tick(); await present();
  const before = calls('set_native_gpu_viewport_zoom').length;
  host.rerender(<Host selected={false} scale={2} />); await tick();
  expect(calls('set_native_gpu_viewport_zoom')).toHaveLength(before);
  host.rerender(<Host selected scale={2} />); await tick();
  expect(calls('set_native_gpu_viewport_zoom').at(-1)![1].zoom).toBe(2);
  expect(calls('load_native_gpu_scene')).toHaveLength(1);
});


// UIUX (audit 2026-09-25 §R25.GPU.32): callback IPC thật của hook → reducer Viewer.
function WheelHost({ active = true }: { active?: boolean }) {
  const [page, setPage] = useState(1);
  const containerRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const { handlePageWheel } = useViewerZoom({ containerRef, sidebarRef, internalScrollRef: containerRef,
    numPages: 3, zoom: 1, setZoom: vi.fn(), fitMode: 'custom', setFitMode: vi.fn(), fitPageSizes: [],
    pageDisplayMode: 'single_fit', setPageDisplayMode: vi.fn(), activePage: page,
    actualWidth100: 100, navigatePage: setPage, toolMode: 'pointer' });
  return <div className={active ? '' : 'opacity-0'}><div ref={containerRef} data-testid="wheel-host">
    <output data-testid="wheel-page">{page}</output>
    <NativeGpuViewportContainer selected={active} filePath="D:/fixture.pdf" page={page}
      documentToken="1" scale={1} onPageWheel={handlePageWheel}><ExistingPage /></NativeGpuViewportContainer>
  </div></div>;
}
const pageWheel = (delta = 100, atTop = true, atBottom = true) => ({
  kind: 'wheel', delta_y: delta, at_top: atTop, at_bottom: atBottom, viewport_height: 600,
});
it('wheel native tích lũy đủ delta trong cùng lượt React, cooldown sống qua đổi trang', async () => {
  let now = 1000; vi.spyOn(performance, 'now').mockImplementation(() => now);
  render(<WheelHost />); await tick(); await present();
  const [, oldCallback] = mocks.listen.mock.calls.filter(([n]) => n === 'ppe-native-interaction').at(-1)!;
  const oldPayload = calls('load_native_gpu_scene').at(-1)![1];
  await act(async () => { for (let i = 0; i < 8; i++) oldCallback({ payload: { ...oldPayload, event: pageWheel(8) } }); });
  expect(screen.getByTestId('wheel-page').textContent).toBe('2'); await tick(); await present();
  now = 1100; await interaction(pageWheel());
  expect(screen.getByTestId('wheel-page').textContent).toBe('2');
  now = 1500;
  await act(async () => oldCallback({ payload: { ...oldPayload, event: pageWheel() } }));
  expect(screen.getByTestId('wheel-page').textContent).toBe('2');
  await interaction(pageWheel(100, false, false));
  expect(screen.getByTestId('wheel-page').textContent).toBe('2');
  now = 1800; await interaction(pageWheel()); await tick(); await present();
  expect(screen.getByTestId('wheel-page').textContent).toBe('3');
  now = 2200; await interaction(pageWheel());
  expect(screen.getByTestId('wheel-page').textContent).toBe('3');
  now = 2600; await interaction(pageWheel(-100)); await tick(); await present();
  expect(screen.getByTestId('wheel-page').textContent).toBe('2');
  now = 3000; await interaction(pageWheel(-100)); await tick(); await present();
  now = 3400; await interaction(pageWheel(-100));
  expect(screen.getByTestId('wheel-page').textContent).toBe('1');
});
it('wheel không chuyển trang từ revision cũ, tab ẩn, tab đóng hoặc popup che viewport', async () => {
  vi.spyOn(performance, 'now').mockReturnValue(1000);
  const host = render(<WheelHost />); await tick(); await present();
  await interaction(pageWheel(), { revision: -1 }); expect(screen.getByTestId('wheel-page').textContent).toBe('1');
  const popup = document.createElement('dialog'); popup.open = true;
  await act(async () => { document.body.appendChild(popup); });
  await interaction(pageWheel()); expect(screen.getByTestId('wheel-page').textContent).toBe('1');
  await act(async () => popup.remove());
  host.rerender(<WheelHost active={false} />); await tick();
  await interaction(pageWheel()); expect(screen.getByTestId('wheel-page').textContent).toBe('1');
  const [, callback] = mocks.listen.mock.calls.filter(([n]) => n === 'ppe-native-interaction').at(-1)!;
  const payload = calls('load_native_gpu_scene').at(-1)![1];
  host.unmount(); const count = calls('load_native_gpu_scene').length;
  await act(async () => callback({ payload: { ...payload, event: pageWheel() } }));
  expect(calls('load_native_gpu_scene')).toHaveLength(count);
});
it('wheel DOM dùng chung cooldown với native, Ctrl+wheel không chuyển trang', async () => {
  let now = 1000; vi.spyOn(performance, 'now').mockImplementation(() => now);
  render(<WheelHost />); await tick(); await present();
  const sendWheel = (ctrlKey = false) => {
    const e = new WheelEvent('wheel', { deltaY: 100, ctrlKey, bubbles: true, cancelable: true });
    Object.defineProperty(e, 'timeStamp', { value: now });
    fireEvent(screen.getByTestId('wheel-host'), e);
  };
  sendWheel(true); expect(screen.getByTestId('wheel-page').textContent).toBe('1');
  sendWheel(); expect(screen.getByTestId('wheel-page').textContent).toBe('2'); await tick(); await present();
  now = 1100; await interaction(pageWheel()); expect(screen.getByTestId('wheel-page').textContent).toBe('2');
  now = 1500; await interaction(pageWheel()); expect(screen.getByTestId('wheel-page').textContent).toBe('3');
});

it('zoomAnchor với clientX/clientY chuẩn hóa tọa độ theo getBoundingClientRect() và gửi đúng cursorX, cursorY cho set_native_gpu_viewport_zoom', async () => {
  const host = render(<Host scale={1.0} fitMode="custom" />); await tick(); await present();
  const container = screen.getByTestId('native-gpu-viewport-container');
  const innerDiv = container.children[1] as HTMLElement;
  vi.spyOn(innerDiv, 'getBoundingClientRect').mockReturnValue({
    left: 100, top: 50, right: 900, bottom: 650, width: 800, height: 600, x: 100, y: 50, toJSON: () => ({}),
  });
  host.rerender(<Host scale={1.5} fitMode="custom" zoomAnchor={{ x: 0, y: 0, clientX: 350, clientY: 250 }} />);
  await tick();
  const zoomCalls = calls('set_native_gpu_viewport_zoom');
  expect(zoomCalls.length).toBeGreaterThan(0);
  const lastZoomCall = zoomCalls.at(-1)![1];
  expect(lastZoomCall.zoom).toBe(1.5);
  // cursorX = 350 - 100 = 250, cursorY = 250 - 50 = 200
  expect(lastZoomCall.cursorX).toBe(250);
  expect(lastZoomCall.cursorY).toBe(200);
});

it('onNativeVisibilityChange bao dung true khi GPU visible va false khi occluded de shell dung duplicate fallback requests', async () => {
  const onVisibility = vi.fn();
  const host = render(
    <NativeGpuViewportContainer
      enabled
      selected
      filePath="D:/fixture.pdf"
      page={1}
      documentToken="1"
      scale={1.0}
      onNativeVisibilityChange={onVisibility}
    >
      <ExistingPage />
    </NativeGpuViewportContainer>
  );
  await tick();
  await present();

  // Khi GPU da presentation on dinh, onNativeVisibilityChange phai duoc goi voi true
  expect(onVisibility).toHaveBeenCalledWith(true);

  // Khi mo dialog/modal (UI occlusion)
  const popup = document.createElement('dialog');
  popup.open = true;
  await act(async () => {
    document.body.appendChild(popup);
  });
  await tick();

  // onNativeVisibilityChange phai duoc goi voi false de fallback producer bat lai
  expect(onVisibility).toHaveBeenLastCalledWith(false);

  // Khi dong dialog
  await act(async () => {
    popup.remove();
  });
  await tick();

  // onNativeVisibilityChange tro lai true de tiep tuc pause duplicate producer
  expect(onVisibility).toHaveBeenLastCalledWith(true);
});

it('V27: scene mới phải bật lại producer cho tới proof mới, không tháo bitmap fallback', async()=>{
  const ready=vi.fn();
  const props={enabled:true,selected:true,filePath:'D:/fixture.pdf',documentToken:'1',scale:1,onNativeVisibilityChange:ready};
  const host=render(<NativeGpuViewportContainer {...props} page={1}><ExistingPage/></NativeGpuViewportContainer>);
  await tick();await present();expect(ready).toHaveBeenLastCalledWith(true);
  host.rerender(<NativeGpuViewportContainer {...props} page={2}><ExistingPage/></NativeGpuViewportContainer>);
  await tick();expect(ready).toHaveBeenLastCalledWith(false);
  expect(mocks.unmounted).not.toHaveBeenCalled();
  await present();expect(ready).toHaveBeenLastCalledWith(true);
});
