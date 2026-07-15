import { useEffect } from 'react';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { toast } from './ui/Toast';
import { useTranslation } from 'react-i18next';

export default function SystemIntegrations() {
  const { t } = useTranslation();

    const processPaths = async (paths: string[]) => {
        // Cờ ý định từ menu chuột phải (vd "--prynx-action=convert"). Menu gọi 1
        // tiến trình/file nên cờ lặp lại theo mỗi file; chỉ cần thấy 1 lần là đủ.
        // BẮT cờ TRƯỚC bộ lọc bên dưới — nếu không nó bị loại (không phải path file).
        let action = '';
        for (const p of paths) {
            const m = p.match(/^--prynx-action=(\w+)/);
            if (m) { action = m[1]; break; }
        }

        const validPaths = paths.filter(p => {
            if (p.includes('prynx://auth/callback')) {
                window.dispatchEvent(new CustomEvent('auth-url-received', { detail: { url: p } }));
                return false;
            }
            const lower = p.toLowerCase();
            return lower.endsWith('.pdf') || lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.png');
        });

        if (validPaths.length === 0) return;

        const files: File[] = [];

        for (const path of validPaths) {
            try {
                const name = path.split('\\').pop() || path.split('/').pop() || 'unknown';
                const lower = name.toLowerCase();
                const type = lower.endsWith('.pdf') ? 'application/pdf' : 
                            lower.endsWith('.png') ? 'image/png' : 'image/jpeg';

                // Lấy kích thước bằng lệnh Rust get_file_size (std::fs), KHÔNG dùng
                // plugin-fs stat(): plugin-fs bị giới hạn scope ($DESKTOP/$HOME/$DOCUMENT
                // /$DOWNLOAD/$APPDATA) nên NÉM LỖI với file trên Ổ MẠNG/NAS (đường dẫn
                // UNC \\server\share\...) → file không mở được, phải copy ra Desktop.
                // Lệnh Rust không vướng scope → mở trực tiếp file ổ mạng. Size không
                // lấy được cũng không chặn mở (polyfill upload tự đọc bytes thật khi 0).
                let size = 0;
                try {
                    size = await invoke<number>('get_file_size', { path });
                } catch (e) {
                    console.warn(t('misc.systemIntegrations:get_file_size_loi_van_mo_size_0'), path, e);
                }
                const fileObj = new File([], name, { type });
                Object.defineProperty(fileObj, 'path', { value: path }); // CRITICAL: Skip HTTP upload polyfill by providing absolute path
                Object.defineProperty(fileObj, 'size', { value: size });
                files.push(fileObj);
            } catch (err) {
                console.error("Failed to read system file:", path, err);
                toast.error("Không thể đọc file: " + path + "\nLỗi: " + err);
            }
        }

        if (files.length > 0) {
            window.dispatchEvent(new CustomEvent('system-files-received', { detail: { files, action } }));
        }
    };

    useEffect(() => {
        // 1. Process startup args (First Instance)
        invoke<string[]>('get_startup_args')
            .then(args => {
                if (args && args.length > 1) {
                    processPaths(args.slice(1));
                }
            })
            .catch(err => console.error("Failed to get startup args:", err));

        // 2. Poll for subsequent files — KHÔNG dùng setInterval (nó bắn mỗi 1s BẤT KỂ
        // lần trước xong chưa → lúc kênh IPC nghẽn sẽ chất đống invoke, làm tệ thêm).
        // Dùng setTimeout đệ quy: chỉ lên lịch lần kế SAU khi lần này xong.
        let pollTimer: ReturnType<typeof setTimeout> | null = null;
        let pollStopped = false;
        const scheduleNextPoll = () => {
            if (pollStopped) return;
            pollTimer = setTimeout(() => {
                invoke<string[]>('get_pending_system_files')
                    .then(args => {
                        if (args && args.length > 0) {
                            processPaths(args);
                        }
                    })
                    .catch(err => {
                        console.error("Failed to poll pending system files:", err);
                    })
                    .finally(() => { scheduleNextPoll(); });
            }, 1000);
        };
        scheduleNextPoll();

        // 3. Listen to Tauri native drag and drop events
        let isUnmounted = false;
        let unlistenDrop: (() => void) | null = null;

        import('@tauri-apps/api/event').then(({ listen }) => {
            listen<any>('tauri://drag-drop', (event) => {
                let paths: string[] = [];
                if (Array.isArray(event.payload)) paths = event.payload;
                else if (event.payload && Array.isArray(event.payload.paths)) paths = event.payload.paths;
                
                if (paths.length > 0) {
                    processPaths(paths);
                }
            }).then(unlisten => { 
                if (isUnmounted) {
                    unlisten(); // if already unmounted, unlisten immediately
                } else {
                    unlistenDrop = unlisten;
                }
            });
        });

        return () => {
            isUnmounted = true;
            pollStopped = true;
            if (pollTimer) clearTimeout(pollTimer);
            if (unlistenDrop) unlistenDrop();
        };
    }, []);

    return null;
}
