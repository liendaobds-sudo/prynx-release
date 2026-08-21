import type { StoreApi, UseBoundStore } from 'zustand';
import type { BatchItem, ImageBatchStore } from './store';
import { tv } from '../../../i18n';
import { fetchLocalFileBuffer } from '../../../lib/localFileTransport';

// Helper dùng chung cho các công cụ batch ảnh (tách nền, upscale). Tham số hoá theo
// `store` để mỗi công cụ truyền store riêng — phần đọc/ghi file + picker hoàn toàn
// giống nhau.

type BatchStore<O> = UseBoundStore<StoreApi<ImageBatchStore<O>>>;

// ─── MIME từ phần mở rộng ────────────────────────────────────────────────────
export function mimeFromName(name: string): string {
    const n = name.toLowerCase();
    if (n.endsWith('.png')) return 'image/png';
    if (n.endsWith('.jpg') || n.endsWith('.jpeg')) return 'image/jpeg';
    if (n.endsWith('.webp')) return 'image/webp';
    if (n.endsWith('.bmp')) return 'image/bmp';
    if (n.endsWith('.tif') || n.endsWith('.tiff')) return 'image/tiff';
    if (n.endsWith('.pdf')) return 'application/pdf';
    return 'application/octet-stream';
}

interface BatchFileOptions {
    allowPdf?: boolean;
    onFilesSelected?: (files: File[]) => void;
}

const SOURCE_LOADING_PREVIEW = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120" viewBox="0 0 160 120"><rect width="160" height="120" fill="#e2e8f0"/><rect x="54" y="28" width="52" height="64" rx="5" fill="#f8fafc" stroke="#94a3b8" stroke-width="3"/><path d="M65 49h30M65 60h30M65 71h20" stroke="#94a3b8" stroke-width="4" stroke-linecap="round"/></svg>',
)}`;
const SOURCE_ERROR_PREVIEW = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120" viewBox="0 0 160 120"><rect width="160" height="120" fill="#fee2e2"/><circle cx="80" cy="60" r="30" fill="#ef4444"/><path d="M80 41v24M80 78v1" stroke="white" stroke-width="7" stroke-linecap="round"/></svg>',
)}`;

interface BatchSourceCandidate {
    file: File;
    id: string;
    isNativePath: boolean;
    item: BatchItem;
    path: string;
}

/** Không khôi phục tab đã đóng và không ghi đè item đã bị người dùng xóa. */
function updateExistingBatchItem<O>(
    tabId: string,
    store: BatchStore<O>,
    itemId: string,
    update: (item: BatchItem) => BatchItem,
): boolean {
    const state = store.getState();
    const tab = state.tabs[tabId];
    if (!tab?.batchItems.some(item => item.id === itemId)) return false;
    state.setBatchItems(tabId, items => items.map(item => item.id === itemId ? update(item) : item));
    return true;
}

// ─── Add files vào store ──────────────────────────────────────────────────────
export async function normalizeAndAddFiles<O>(files: File[], tabId: string, store: BatchStore<O>, options: BatchFileOptions = {}) {
    const s = store.getState();
    s.initTab(tabId);
    options.onFilesSelected?.(files);
    const candidates: BatchSourceCandidate[] = [];
    for (const file of files) {
        if (/\.gif$/i.test(file.name) || file.type === 'image/gif') {
            s.setError(tabId, tv('GIF động chưa được hỗ trợ; hãy chuyển sang PNG, TIFF hoặc WebP tĩnh.'));
            continue;
        }
        const isImage = file.type.startsWith('image/') || /\.(jpg|jpeg|png|webp|tiff?|bmp)$/i.test(file.name);
        const isPdf = options.allowPdf && (file.type === 'application/pdf' || /\.pdf$/i.test(file.name));
        if (!isImage && !isPdf) continue;
        const path = (file as File & { path?: string }).path || '';
        const isNativePath = Boolean(path && (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
        const id = Math.random().toString(36).substring(7);
        const identity = path
            ? `path:${path}`
            : `ingest:${Date.now()}-${Math.random().toString(36).substring(2)}`;
        candidates.push({
            file,
            id,
            isNativePath,
            path,
            item: {
                id,
                path: path || 'browser-file',
                fileName: file.name,
                // UIUX (feedback 2026-08-21 §DOC.THUMB.01): file từ picker native
                // chỉ là stub rỗng. Đưa placeholder vào store trước khi đọc ổ đĩa để
                // người dùng thấy ngay file đã được nhận, nhưng không coi stub là nguồn.
                originalUrl: isNativePath ? SOURCE_LOADING_PREVIEW : URL.createObjectURL(file),
                status: isNativePath ? 'processing' : 'pending',
                fileObj: isNativePath ? undefined : file,
                sourceIdentity: identity,
            },
        });
    }
    if (candidates.length === 0) return;

    s.addItems(tabId, candidates.map(candidate => candidate.item));

    // Đọc tuần tự để một batch ảnh lớn không nhân đỉnh RAM; toàn bộ thumbnail chờ
    // đã được thêm ở trên nên giao diện vẫn phản hồi ngay cho mọi file.
    for (const candidate of candidates) {
        if (!candidate.isNativePath) continue;
        const { file, id, path } = candidate;
        let url = '';
        try {
            // Trong app Tauri đóng gói, file picker trả về File([]) RỖNG chỉ mang theo `path`.
            // Phải đọc bytes thật qua protocol Rust vì file kéo-thả có thể ngoài scope plugin-fs.
            // Lưu ý: KHÔNG dựa vào lệnh Rust image::open cho mọi định dạng — crate `image`
            // không bật webp/gif nên sẽ throw và làm preview vỡ ở bản release.
            // FILEIO (audit 2026-07-28 §DROP.02): file native có thể nằm ngoài
            // scope plugin-fs (ổ D/USB/NAS), nên dùng protocol local đã kiểm soát.
            const rawBuffer = await fetchLocalFileBuffer(path);
            if (rawBuffer.byteLength === 0) throw new Error('File nguồn rỗng');
            const raw = new Uint8Array(rawBuffer);
            const sourceMime = mimeFromName(file.name);
            const sourceBlob = new Blob([rawBuffer], { type: sourceMime });
            // UPSCALE (audit 2026-07-28 §UP-03/09): fileObj luôn giữ bytes
            // nguồn; TIFF chỉ sinh thêm PNG để WebView xem trước.
            const fileObj = new File([sourceBlob], file.name, { type: sourceMime });
            const isTiff = /\.tiff?$/i.test(file.name);
            if (isTiff) {
                // Webview không render được TIFF → convert sang PNG bằng Rust (feature tiff đã bật).
                const { invoke } = await import('@tauri-apps/api/core');
                const png: ArrayBuffer = await invoke('normalize_image_bytes', { bytes: raw });
                if (png.byteLength === 0) throw new Error('Preview TIFF rỗng');
                url = URL.createObjectURL(new Blob([png], { type: 'image/png' }));
            } else {
                // png/jpg/webp/bmp/pdf đều giữ nguyên bytes nguồn.
                url = URL.createObjectURL(sourceBlob);
            }
            Object.defineProperty(fileObj, 'path', { value: path });
            const updated = updateExistingBatchItem(tabId, store, id, item => ({
                ...item,
                originalUrl: url,
                status: 'pending',
                fileObj,
                error: undefined,
            }));
            if (!updated) URL.revokeObjectURL(url);
        } catch (error) {
            console.error('Tauri image load failed:', error);
            if (url) URL.revokeObjectURL(url);
            const message = tv('Không đọc được file từ ổ đĩa; hãy kiểm tra file còn tồn tại rồi chọn lại.');
            updateExistingBatchItem(tabId, store, id, item => ({
                ...item,
                originalUrl: SOURCE_ERROR_PREVIEW,
                status: 'error',
                fileObj: undefined,
                error: message,
            }));
            if (store.getState().tabs[tabId]) store.getState().setError(tabId, message);
        }
    }
}

// ─── File picker ──────────────────────────────────────────────────────────────
export async function openFilePicker<O>(tabId: string, store: BatchStore<O>, options: BatchFileOptions = {}) {
    if ((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) {
        const { open } = await import('@tauri-apps/plugin-dialog');
        const selected = await open({
            multiple: true,
            title: options.allowPdf ? 'Chọn ảnh hoặc PDF scan' : 'Chọn ảnh (Có thể chọn nhiều)',
            filters: [{
                name: options.allowPdf ? 'Ảnh / PDF' : 'Image',
                extensions: [...(options.allowPdf ? ['pdf'] : []), 'png', 'jpg', 'jpeg', 'webp', 'tif', 'tiff', 'bmp'],
            }],
        });
        if (selected && Array.isArray(selected)) {
            const files = selected.map(path => {
                const name = path.split('\\').pop()?.split('/').pop() || 'image.png';
                const f = new File([], name);
                Object.defineProperty(f, 'path', { value: path });
                return f;
            });
            normalizeAndAddFiles(files, tabId, store, options);
        }
    } else {
        const input = document.createElement('input');
        input.type = 'file'; input.accept = `${options.allowPdf ? '.pdf,' : ''}.png,.jpg,.jpeg,.webp,.tif,.tiff,.bmp`; input.multiple = true;
        input.onchange = () => { if (input.files) normalizeAndAddFiles(Array.from(input.files), tabId, store, options); };
        input.click();
    }
}

// ─── Save batch ───────────────────────────────────────────────────────────────
export async function saveBatch<O>(tabId: string, store: BatchStore<O>, prefix: string) {
    const items = store.getState().getTab(tabId).batchItems.filter(i => i.status === 'success' && i.resultBlob);
    if (items.length === 0) return { saved: 0, ok: true };
    try {
        const { open } = await import('@tauri-apps/plugin-dialog');
        const { writeFile } = await import('@tauri-apps/plugin-fs');
        const { join } = await import('@tauri-apps/api/path');
        const dir = await open({ directory: true, multiple: false, title: 'Chọn thư mục lưu ảnh' });
        if (!dir || typeof dir !== 'string') return { saved: 0, ok: true };
        let saved = 0;
        for (const item of items) {
            const extension = item.resultBlob!.type === 'application/pdf' ? 'pdf' : 'png';
            const outName = `${prefix}_${item.fileName.replace(/\.[^/.]+$/, '')}.${extension}`;
            const outPath = await join(dir, outName);
            await writeFile(outPath, new Uint8Array(await item.resultBlob!.arrayBuffer()));
            saved++;
        }
        return { saved, ok: true };
    } catch (e) {
        console.error(e);
        return { saved: 0, ok: false };
    }
}
