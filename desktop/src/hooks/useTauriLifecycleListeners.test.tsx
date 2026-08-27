// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthDeepLinkListener } from './useAuthDeepLinkListener';
import { useTauriCloseRequested } from './useTauriCloseRequested';

type Unlisten = () => void;
type CloseHandler = (event: { preventDefault: () => void }) => void | Promise<void>;

const mocks = vi.hoisted(() => ({
  onCloseRequested: vi.fn(),
  onOpenUrl: vi.fn(),
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ onCloseRequested: mocks.onCloseRequested }),
}));

vi.mock('@tauri-apps/plugin-deep-link', () => ({
  onOpenUrl: mocks.onOpenUrl,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushPromises(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('useTauriCloseRequested', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('không đăng ký lại khi callback đổi và luôn gọi callback mới nhất', async () => {
    let registeredHandler: CloseHandler | undefined;
    const unlisten = vi.fn<Unlisten>();
    mocks.onCloseRequested.mockImplementation((handler: CloseHandler) => {
      registeredHandler = handler;
      return Promise.resolve(unlisten);
    });
    const first = vi.fn();
    const second = vi.fn();
    const hook = renderHook(({ handler }) => useTauriCloseRequested(true, handler), {
      initialProps: { handler: first },
    });
    await flushPromises();

    hook.rerender({ handler: second });
    await act(async () => registeredHandler?.({ preventDefault: vi.fn() }));

    expect(mocks.onCloseRequested).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    hook.unmount();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it('gỡ listener đến muộn sau khi hook đã unmount', async () => {
    const pending = deferred<Unlisten>();
    const unlisten = vi.fn<Unlisten>();
    mocks.onCloseRequested.mockReturnValue(pending.promise);
    const hook = renderHook(() => useTauriCloseRequested(true, vi.fn()));

    hook.unmount();
    pending.resolve(unlisten);
    await flushPromises();

    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});

describe('useAuthDeepLinkListener', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('nhận custom event trước khi plugin hoàn tất đăng ký', () => {
    const pending = deferred<Unlisten>();
    mocks.onOpenUrl.mockReturnValue(pending.promise);
    const handler = vi.fn();
    const hook = renderHook(() => useAuthDeepLinkListener(handler));

    act(() => {
      window.dispatchEvent(new CustomEvent('auth-url-received', {
        detail: { url: 'prynx://auth/callback?code=early' },
      }));
    });

    expect(handler).toHaveBeenCalledWith(['prynx://auth/callback?code=early']);
    hook.unmount();
  });

  it('không đăng ký lại khi callback đổi và dùng callback mới nhất', async () => {
    let pluginHandler: ((urls: string[]) => void) | undefined;
    mocks.onOpenUrl.mockImplementation((handler: (urls: string[]) => void) => {
      pluginHandler = handler;
      return Promise.resolve(vi.fn());
    });
    const first = vi.fn();
    const second = vi.fn();
    const hook = renderHook(({ handler }) => useAuthDeepLinkListener(handler), {
      initialProps: { handler: first },
    });
    await flushPromises();

    hook.rerender({ handler: second });
    act(() => pluginHandler?.(['prynx://auth/callback?code=latest']));

    expect(mocks.onOpenUrl).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith(['prynx://auth/callback?code=latest']);
    hook.unmount();
  });

  it('chỉ giao một lần khi plugin và custom event gửi cùng URL', async () => {
    let pluginHandler: ((urls: string[]) => void) | undefined;
    mocks.onOpenUrl.mockImplementation((handler: (urls: string[]) => void) => {
      pluginHandler = handler;
      return Promise.resolve(vi.fn());
    });
    const handler = vi.fn();
    const hook = renderHook(() => useAuthDeepLinkListener(handler));
    await flushPromises();
    const url = 'prynx://auth/callback?code=duplicate';

    act(() => {
      window.dispatchEvent(new CustomEvent('auth-url-received', { detail: { url } }));
      pluginHandler?.([url]);
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith([url]);
    hook.unmount();
  });

  it('gỡ listener plugin đến muộn sau unmount', async () => {
    const pending = deferred<Unlisten>();
    const unlisten = vi.fn<Unlisten>();
    mocks.onOpenUrl.mockReturnValue(pending.promise);
    const hook = renderHook(() => useAuthDeepLinkListener(vi.fn()));

    hook.unmount();
    pending.resolve(unlisten);
    await flushPromises();

    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it('plugin reject vẫn giữ nguồn custom event hoạt động', async () => {
    const pending = deferred<Unlisten>();
    mocks.onOpenUrl.mockReturnValue(pending.promise);
    const handler = vi.fn();
    const hook = renderHook(() => useAuthDeepLinkListener(handler));
    pending.reject(new Error('plugin unavailable'));
    await flushPromises();

    act(() => {
      window.dispatchEvent(new CustomEvent('auth-url-received', {
        detail: { url: 'prynx://auth/callback?code=fallback' },
      }));
    });

    expect(handler).toHaveBeenCalledWith(['prynx://auth/callback?code=fallback']);
    hook.unmount();
  });
});
