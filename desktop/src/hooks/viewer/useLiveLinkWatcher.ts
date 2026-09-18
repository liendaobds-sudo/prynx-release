import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';

interface SystemFileStatResult {
    status: 'available' | 'missing' | 'inaccessible';
    size: number;
    modified_ms?: number;
}

interface UseLiveLinkWatcherOptions {
    filePath?: string | null;
    enabled?: boolean;
    onFileChanged: () => void;
}

/**
 * Hook Live Link: Tự động phát hiện khi tệp PDF trên đĩa bị thay đổi
 * (ví dụ: người dùng nhấn Ctrl+S trong Adobe Illustrator hoặc CorelDRAW)
 * và tự động làm mới trang hiển thị trong Viewer mà không cần mở lại file.
 */
export function useLiveLinkWatcher({
    filePath,
    enabled = true,
    onFileChanged,
}: UseLiveLinkWatcherOptions) {
    const lastModifiedRef = useRef<number | null>(null);
    const lastSizeRef = useRef<number | null>(null);
    const isCheckingRef = useRef(false);

    useEffect(() => {
        if (!enabled || !filePath) {
            lastModifiedRef.current = null;
            lastSizeRef.current = null;
            return;
        }

        let cancelled = false;

        const checkChange = async () => {
            if (isCheckingRef.current || cancelled || !filePath) return;
            isCheckingRef.current = true;
            try {
                const stat = await invoke<SystemFileStatResult>('stat_system_file', { path: filePath });
                if (cancelled || stat.status !== 'available') return;

                const currentMod = stat.modified_ms ?? null;
                const currentSize = stat.size;

                if (lastModifiedRef.current === null) {
                    // Ghi nhận mtime và kích thước ban đầu lúc mới mở
                    lastModifiedRef.current = currentMod;
                    lastSizeRef.current = currentSize;
                    return;
                }

                // Phát hiện tệp bị thay đổi nội dung (mtime đổi hoặc size đổi)
                const hasChanged = (currentMod !== null && currentMod !== lastModifiedRef.current)
                    || (currentMod === null && currentSize !== lastSizeRef.current);

                if (hasChanged) {
                    lastModifiedRef.current = currentMod;
                    lastSizeRef.current = currentSize;

                    // Chờ nhẹ 150ms để ứng dụng ngoài (Illustrator) xả hết buffer ghi đĩa
                    setTimeout(() => {
                        if (cancelled) return;
                        onFileChanged();
                    }, 150);
                }
            } catch {
                // Thư mục hoặc tệp tạm thời không đọc được trong lúc ghi
            } finally {
                isCheckingRef.current = false;
            }
        };

        // 1. Đọc mtime ban đầu
        void checkChange();

        // 2. Kênh Focus: Khi người dùng chuyển cửa sổ từ Illustrator / Corel sang PrynX
        const handleFocus = () => {
            void checkChange();
        };
        window.addEventListener('focus', handleFocus);

        // 3. Kênh Polling nhẹ (1.5s): Cho trường hợp người dùng đặt 2 cửa sổ song song
        const interval = setInterval(() => {
            if (document.visibilityState !== 'hidden') {
                void checkChange();
            }
        }, 1500);

        return () => {
            cancelled = true;
            window.removeEventListener('focus', handleFocus);
            clearInterval(interval);
        };
    }, [filePath, enabled, onFileChanged]);
}
