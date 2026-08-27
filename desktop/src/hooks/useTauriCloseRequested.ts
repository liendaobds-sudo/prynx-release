import { useEffect, useRef } from 'react';
import { getCurrentWindow, type CloseRequestedEvent } from '@tauri-apps/api/window';

type CloseRequestedHandler = (event: CloseRequestedEvent) => void | Promise<void>;

/**
 * Giữ listener đóng cửa sổ ổn định qua các lần render và dọn cả trường hợp
 * Promise đăng ký hoàn tất sau khi component đã unmount.
 */
export function useTauriCloseRequested(enabled: boolean, handler: CloseRequestedHandler): void {
  const handlerRef = useRef(handler);

  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useEffect(() => {
    if (!enabled) return;

    let disposed = false;
    let unlisten: (() => void) | undefined;

    getCurrentWindow()
      .onCloseRequested((event) => handlerRef.current(event))
      .then((stopListening) => {
        if (disposed) stopListening();
        else unlisten = stopListening;
      })
      .catch(() => {
        // Cửa sổ có thể đang bị huỷ trong lúc plugin hoàn tất đăng ký.
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [enabled]);
}
