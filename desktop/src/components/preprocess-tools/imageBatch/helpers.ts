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
    return 'application/octet-stream';
}

// ─── Add files vào store ──────────────────────────────────────────────────────
export async function normalizeAndAddFiles<O>(files: File[], tabId: string, store: BatchStore<O>) {
    const s = store.getState();
    s.initTab(tabId);
    const newItems: BatchItem[] = [];
    for (const file of files) {
        if (/\.gif$/i.test(file.name) || file.type === 'image/gif') {
            s.setError(tabId, tv('GIF động chưa được hỗ trợ; hãy chuyển sang PNG, TIFF hoặc WebP tĩnh.'));
            continue;
        }
        const isImage = file.type.startsWith('image/') || file.name.match(/\.(jpg|jpeg|png|webp|tiff?|bmp)$/i);
        if (!isImage) continue;
        const path = (file as any).path || '';
        let url = '';
        let fileObj = file;
        if (path && (window as any).__TAURI_INTERNALS__) {
            // Trong app Tauri đóng gói, file picker trả về File([]) RỖNG chỉ mang theo `path`.
            // Phải đọc bytes thật qua protocol Rust vì file kéo-thả có thể ngoài scope plugin-fs.
            // Lưu ý: KHÔNG dựa vào lệnh Rust image::open cho mọi định dạng — crate `image`
            // không bật webp/gif nên sẽ throw và làm preview vỡ ở bản release.
            try {
                // FILEIO (audit 2026-07-28 §DROP.02): file native có thể nằm ngoài
                // scope plugin-fs (ổ D/USB/NAS), nên dùng protocol local đã kiểm soát.
                const rawBuffer = await fetchLocalFileBuffer(path);
                const raw = new Uint8Array(rawBuffer);
                const sourceMime = mimeFromName(file.name);
                const sourceBlob = new Blob([rawBuffer], { type: sourceMime });
                // UPSCALE (audit 2026-07-28 §UP-03/09): fileObj luôn giữ bytes
                // nguồn; TIFF chỉ sinh thêm PNG để WebView xem trước.
                fileObj = new File([sourceBlob], file.name, { type: sourceMime });
                const isTiff = /\.tiff?$/i.test(file.name);
                if (isTiff) {
                    // Webview không render được TIFF → convert sang PNG bằng Rust (feature tiff đã bật).
                    const { invoke } = await import('@tauri-apps/api/core');
                    const png: ArrayBuffer = await invoke('normalize_image_bytes', { bytes: raw });
                    const blob = new Blob([png as any], { type: 'image/png' });
                    url = URL.createObjectURL(blob);
                } else {
                    // png/jpg/webp/bmp đều được WebView hiển thị trực tiếp.
                    url = URL.createObjectURL(sourceBlob);
                }
                Object.defineProperty(fileObj, 'path', { value: path });
            } catch (e) {
                console.error('Tauri image load failed:', e);
                url = URL.createObjectURL(file);
            }
        } else {
            url = URL.createObjectURL(file);
        }
        // UIUX (audit 2026-08-10 §UP.X.01): danh tính nội dung — path canonical nếu
        // có, nếu không thì token ngẫu nhiên. Name+size không phải danh tính nội dung.
        const identity = path
            ? `path:${path}`
            : `ingest:${Date.now()}-${Math.random().toString(36).substring(2)}`;
        newItems.push({
            id: Math.random().toString(36).substring(7),
            path: path || 'browser-file',
            fileName: file.name,
            originalUrl: url,
            status: 'pending',
            fileObj,
            sourceIdentity: identity,
        });
    }
    if (newItems.length > 0) s.addItems(tabId, newItems);
}

// ─── File picker ──────────────────────────────────────────────────────────────
export async function openFilePicker<O>(tabId: string, store: BatchStore<O>) {
    if ((window as any).__TAURI_INTERNALS__) {
        const { open } = await import('@tauri-apps/plugin-dialog');
        const selected = await open({
            multiple: true,
            title: 'Chọn ảnh (Có thể chọn nhiều)',
            filters: [{ name: 'Image', extensions: ['png', 'jpg', 'jpeg', 'webp', 'tif', 'tiff', 'bmp'] }],
        });
        if (selected && Array.isArray(selected)) {
            const files = selected.map(path => {
                const name = path.split('\\').pop()?.split('/').pop() || 'image.png';
                const f = new File([], name);
                Object.defineProperty(f, 'path', { value: path });
                return f;
            });
            normalizeAndAddFiles(files, tabId, store);
        }
    } else {
        const input = document.createElement('input');
        input.type = 'file'; input.accept = '.png,.jpg,.jpeg,.webp,.tif,.tiff,.bmp'; input.multiple = true;
        input.onchange = () => { if (input.files) normalizeAndAddFiles(Array.from(input.files), tabId, store); };
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
            const outName = `${prefix}_${item.fileName.replace(/\.[^/.]+$/, '')}.png`;
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
