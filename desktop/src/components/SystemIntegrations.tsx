import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from './ui/Toast';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import { isOfficePathOrName, isPdfOrImagePath } from '../lib/officeFileTypes';
import { createPathBackedFile } from '../lib/nativeFileAccess';
import {
    SYSTEM_FILES_POLL_SETTLED_EVENT,
    SYSTEM_FILES_RECEIVED_EVENT,
} from '../hooks/useIncomingFileDispatcher';
import { FileText } from 'lucide-react';

interface NativeSystemFileBatch {
    batchId: string;
    args: string[];
}

interface PreparedSystemFileBatch {
    batchId: string;
    action: string;
    files: File[];
}

let webviewBatchSequence = 0;

function nextWebviewBatchId(source: string): string {
    webviewBatchSequence += 1;
    return `${source}-${webviewBatchSequence}`;
}

function normalizeNativeBatches(payload: unknown, fallbackId: string): NativeSystemFileBatch[] {
    if (Array.isArray(payload)) {
        if (payload.length === 0) return [];
        if (payload.every(item => typeof item === 'string')) {
            return [{ batchId: fallbackId, args: payload }];
        }
        return payload.flatMap((item, index) => normalizeNativeBatches(item, `${fallbackId}-${index + 1}`));
    }
    if (!payload || typeof payload !== 'object' || !('args' in payload)) return [];
    const candidate = payload as { batchId?: unknown; args?: unknown };
    if (!Array.isArray(candidate.args) || !candidate.args.every(item => typeof item === 'string')) return [];
    return [{
        batchId: typeof candidate.batchId === 'string' && candidate.batchId
            ? candidate.batchId
            : fallbackId,
        args: candidate.args,
    }];
}

async function takeStartupBatches(): Promise<NativeSystemFileBatch[]> {
    try {
        const batch = await invoke<unknown>('take_startup_system_file_batch');
        return normalizeNativeBatches(batch, 'startup');
    } catch {
        // Tương thích native cũ trong vòng dev trước khi maturin/Tauri rebuild.
        const args = await invoke<unknown>('get_startup_args');
        return normalizeNativeBatches(args, 'startup-legacy');
    }
}

async function takePendingBatches(pollSequence: number): Promise<NativeSystemFileBatch[]> {
    try {
        const batches = await invoke<unknown>('take_pending_system_file_batches');
        return normalizeNativeBatches(batches, `pending-${pollSequence}`);
    } catch {
        const args = await invoke<unknown>('get_pending_system_files');
        return normalizeNativeBatches(args, `pending-legacy-${pollSequence}`);
    }
}

function dispatchPreparedBatch(batch: PreparedSystemFileBatch): void {
    if (batch.files.length === 0) return;
    window.dispatchEvent(new CustomEvent(SYSTEM_FILES_RECEIVED_EVENT, {
        detail: {
            files: batch.files,
            action: batch.action,
            batchId: batch.batchId,
        },
    }));
}

export default function SystemIntegrations() {
  const { t } = useTranslation();
  const [isGlobalDragActive, setIsGlobalDragActive] = useState(false);


    // FILEIO (feedback 2026-08-26 LANG.1): listener phải giữ nguyên vòng đời khi
    // đổi ngôn ngữ; nếu callback đổi identity, effect sẽ đọc lại startup args cũ.
    // Đọc i18n global ngay lúc cần log để vẫn dùng ngôn ngữ hiện hành.
    const prepareBatch = useCallback(async (batch: NativeSystemFileBatch): Promise<PreparedSystemFileBatch> => {
        const paths = batch.args;
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
            // PDF / ảnh (viewer) + Office (→ PDF convert)
            return isPdfOrImagePath(p) || isOfficePathOrName(p);
        });

        if (validPaths.length === 0) return { batchId: batch.batchId, action, files: [] };

        // FILEIO (audit 2026-08-02 §OPEN.1): khởi động mọi probe cùng lúc; NAS/UNC
        // chậm chỉ làm size=0 sau deadline, không giữ toàn bộ dispatcher theo từng file.
        const files = (await Promise.all(validPaths.map(async (path): Promise<File | null> => {
            try {
                const { file, stat } = await createPathBackedFile(path);
                if (stat.status !== 'available') {
                    console.warn(
                        i18n.t('misc.systemIntegrations:get_file_size_loi_van_mo_size_0'),
                        file.name,
                        stat.status,
                    );
                }
                return file;
            } catch (error) {
                const name = path.split('\\').pop() || path.split('/').pop() || 'unknown';
                console.error('Không thể chuẩn bị file hệ thống:', name, error);
                toast.error(`Không thể mở file: ${name}`);
                return null;
            }
        }))).filter((file): file is File => file !== null);

        return { batchId: batch.batchId, action, files };
    }, []);

    useEffect(() => {
        // 1–2. Startup chạy xong mới bắt đầu poll để hai lượt không tự chồng nhau.
        // Poll for subsequent files — KHÔNG dùng setInterval (nó bắn mỗi 1s BẤT KỂ
        // lần trước xong chưa → lúc kênh IPC nghẽn sẽ chất đống invoke, làm tệ thêm).
        // Dùng setTimeout đệ quy: chỉ lên lịch lần kế SAU khi lần này xong.
        let pollTimer: ReturnType<typeof setTimeout> | null = null;
        let pollStopped = false;
        let pollSequence = 0;
        const processBatches = async (batches: NativeSystemFileBatch[]) => {
            // Probe song song để một NAS chậm không đẩy batch explicit vượt fallback 3 giây.
            const prepared = await Promise.all(batches.map(batch => prepareBatch(batch)));
            if (pollStopped) return;
            prepared.forEach(dispatchPreparedBatch);
        };
        const scheduleNextPoll = () => {
            if (pollStopped) return;
            pollTimer = setTimeout(() => {
                // FILEIO (audit 2026-08-02 §OPEN.1): chỉ đặt lượt kế tiếp sau khi
                // toàn bộ path của lượt hiện tại đã thành file và được dispatch.
                void (async () => {
                    try {
                        pollSequence += 1;
                        const batches = await takePendingBatches(pollSequence);
                        if (batches.length > 0) await processBatches(batches);
                    } catch (error) {
                        console.error('Không thể đọc hàng đợi file hệ thống:', error);
                    } finally {
                        // FILEIO (audit 2026-08-02 §TEST.1): explicit intent Combine/
                        // Convert chỉ đóng batch sau khi lượt pending đầu đã được vét.
                        window.dispatchEvent(new Event(SYSTEM_FILES_POLL_SETTLED_EVENT));
                        scheduleNextPoll();
                    }
                })();
            }, 1000);
        };

        void (async () => {
            try {
                const batches = await takeStartupBatches();
                if (batches.length > 0) await processBatches(batches);
            } catch (error) {
                console.error('Không thể đọc tham số khởi động:', error);
            } finally {
                scheduleNextPoll();
            }
        })();

        // 3. Tauri native drag-drop: WebView không đảm bảo có dataTransfer.files.
        let isUnmounted = false;
        const nativeUnlisteners: Array<() => void> = [];

        const payloadPaths = (payload: unknown): string[] => {
            if (Array.isArray(payload)) return payload.filter((path): path is string => typeof path === 'string');
            if (payload && typeof payload === 'object' && 'paths' in payload) {
                const paths = (payload as { paths?: unknown }).paths;
                return Array.isArray(paths) ? paths.filter((path): path is string => typeof path === 'string') : [];
            }
            return [];
        };

        import('@tauri-apps/api/event').then(({ listen }) => {
            const register = async (eventName: string, handler: (payload: unknown) => void) => {
                const unlisten = await listen<unknown>(eventName, event => handler(event.payload));
                if (isUnmounted) unlisten();
                else nativeUnlisteners.push(unlisten);
            };

            void register('tauri://drag-enter', payload => {
                const paths = payloadPaths(payload);
                const hasSupportedFile = paths.length === 0 || paths.some(path => isPdfOrImagePath(path) || isOfficePathOrName(path));
                if (hasSupportedFile) setIsGlobalDragActive(true);
            });
            void register('tauri://drag-over', () => setIsGlobalDragActive(true));
            void register('tauri://drag-leave', () => setIsGlobalDragActive(false));
            void register('tauri://drag-drop', payload => {
                setIsGlobalDragActive(false);
                const paths = payloadPaths(payload);
                if (paths.length > 0) {
                    void processBatches([{
                        batchId: nextWebviewBatchId('native-drop'),
                        args: paths,
                    }]);
                }
            });
        }).catch(err => console.error('Failed to register native drag-drop:', err));

        // 4. DOM fallback cho bản web/dev. Dropzone con đã preventDefault thì giữ quyền xử lý.
        let domDragDepth = 0;
        const isDomFileDrag = (event: DragEvent) => Array.from(event.dataTransfer?.types || []).includes('Files');
        const onDomDragEnter = (event: DragEvent) => {
            if (!isDomFileDrag(event)) return;
            event.preventDefault();
            domDragDepth += 1;
            setIsGlobalDragActive(true);
        };
        const onDomDragOver = (event: DragEvent) => {
            if (!isDomFileDrag(event)) return;
            event.preventDefault();
            if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
        };
        const onDomDragLeave = (event: DragEvent) => {
            if (!isDomFileDrag(event)) return;
            domDragDepth = Math.max(0, domDragDepth - 1);
            if (domDragDepth === 0) setIsGlobalDragActive(false);
        };
        const onDomDrop = (event: DragEvent) => {
            domDragDepth = 0;
            setIsGlobalDragActive(false);
            if (event.defaultPrevented || !isDomFileDrag(event)) return;
            event.preventDefault();
            const files = Array.from(event.dataTransfer?.files || []).filter(file => (
                isPdfOrImagePath(file.name) || isOfficePathOrName(file.name)
            ));
            dispatchPreparedBatch({
                batchId: nextWebviewBatchId('dom-drop'),
                action: '',
                files,
            });
        };

        const isTauri = !!(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
        if (!isTauri) {
            window.addEventListener('dragenter', onDomDragEnter);
            window.addEventListener('dragover', onDomDragOver);
            window.addEventListener('dragleave', onDomDragLeave);
            window.addEventListener('drop', onDomDrop);
        }

        return () => {
            isUnmounted = true;
            pollStopped = true;
            if (pollTimer) clearTimeout(pollTimer);
            for (const unlisten of nativeUnlisteners) unlisten();
            if (!isTauri) {
                window.removeEventListener('dragenter', onDomDragEnter);
                window.removeEventListener('dragover', onDomDragOver);
                window.removeEventListener('dragleave', onDomDragLeave);
                window.removeEventListener('drop', onDomDrop);
                }
        };
    }, [prepareBatch]);

    if (!isGlobalDragActive) return null;

    return (
        <div className="fixed inset-0 z-[2000] pointer-events-none p-3" role="status" aria-live="polite">
            <div className="w-full h-full rounded-2xl border-2 border-dashed border-indigo-400 bg-indigo-50/95 dark:bg-indigo-950/95 shadow-[inset_0_0_80px_rgba(99,102,241,0.18)] flex items-center justify-center backdrop-blur-sm">
                <div className="flex flex-col items-center gap-3 text-center px-6">
                    <div className="w-16 h-16 rounded-2xl bg-white dark:bg-zinc-900 shadow-lg flex items-center justify-center text-indigo-600 dark:text-indigo-400" aria-hidden="true">
                        <FileText className="w-8 h-8" strokeWidth={1.8} />
                    </div>
                    <div className="text-xl font-bold text-slate-900 dark:text-white">
                        {t('misc.systemIntegrations:tha_file_de_mo')}
                    </div>
                    <div className="text-sm text-slate-600 dark:text-zinc-300">
                        {t('misc.systemIntegrations:pdf_se_mo_trong_tab_moi')}
                    </div>
                </div>
            </div>
        </div>
    );
}
