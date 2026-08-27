import { useEffect, useRef } from 'react';
import { onOpenUrl } from '@tauri-apps/plugin-deep-link';

type AuthUrlEventDetail = {
  url?: string;
};

type AuthDeepLinkHandler = (urls: string[]) => void | Promise<void>;

/**
 * Hợp nhất hai nguồn deep-link của Tauri. Listener DOM phải được gắn đồng bộ
 * để không mất callback được SystemIntegrations phát trước khi plugin sẵn sàng.
 */
export function useAuthDeepLinkListener(handler: AuthDeepLinkHandler): void {
  const handlerRef = useRef(handler);

  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const deliveredUrls = new Set<string>();

    const deliver = (urls: string[]) => {
      if (disposed) return;
      const uniqueUrls = urls.filter((url) => {
        if (!url || deliveredUrls.has(url)) return false;
        deliveredUrls.add(url);
        return true;
      });
      if (uniqueUrls.length === 0) return;
      void Promise.resolve(handlerRef.current(uniqueUrls)).catch(() => {
        // Handler nghiệp vụ tự hiển thị lỗi; chặn Promise rejection rơi ra window.
      });
    };

    const handleCustomEvent = (event: Event) => {
      const detail = (event as CustomEvent<AuthUrlEventDetail>).detail;
      if (detail?.url) deliver([detail.url]);
    };

    window.addEventListener('auth-url-received', handleCustomEvent);
    onOpenUrl(deliver)
      .then((stopListening) => {
        if (disposed) stopListening();
        else unlisten = stopListening;
      })
      .catch(() => {
        // Plugin có thể chưa khả dụng; nguồn custom event vẫn tiếp tục hoạt động.
      });

    return () => {
      disposed = true;
      window.removeEventListener('auth-url-received', handleCustomEvent);
      unlisten?.();
    };
  }, []);
}
