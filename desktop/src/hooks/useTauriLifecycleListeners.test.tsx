// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTauriCloseRequested } from './useTauriCloseRequested';

type Unlisten = () => void;
type CloseHandler = (event: { preventDefault: () => void }) => void | Promise<void>;

const mocks = vi.hoisted(() => ({
  onCloseRequested: vi.fn(),
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ onCloseRequested: mocks.onCloseRequested }),
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

// ĐĂNG NHẬP GOOGLE ĐÃ GỠ (2026-08-28): useAuthDeepLinkListener đã xoá cùng luồng OAuth
// deep link, nên nhóm test của nó cũng gỡ theo. Nhóm useTauriCloseRequested ở trên giữ nguyên.
