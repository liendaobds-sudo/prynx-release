import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { fetchLocalFileBuffer } from './localFileTransport';

type NativePathBlob = Blob & { path?: string };

interface RuntimeMetadataFile extends File {
  isTempUploadPath?: boolean;
  isGenerated?: boolean;
  __pathMaterializationFailed?: boolean;
  __editCommit?: boolean;
  __pathRebaseOnly?: boolean;
  __nativePathPending?: boolean;
  isBlank?: boolean;
  blankWidthPt?: number;
  blankHeightPt?: number;
  blankPageCount?: number;
  __prynxArtifactLeaseToken?: string;
}

/**
 * Utility to merge tailwind classes with standard overrides,
 * preventing conflicts when applying dynamic atomic classes.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const getFileArrayBuffer = async (file: File | Blob, explicitPath?: string): Promise<ArrayBuffer> => {
    const path = explicitPath || (file as NativePathBlob).path;
    const isTauriEnv = typeof window !== 'undefined'
        && Boolean(window.__TAURI_INTERNALS__ || (window as Window & { __PRYNX_INVOKE__?: unknown }).__PRYNX_INVOKE__ || (window as Window & { __TAURI__?: unknown }).__TAURI__);

    console.info('[getFileArrayBuffer] Bắt đầu đọc dữ liệu:', {
        name: (file as File).name,
        size: file.size,
        type: file.type,
        path,
        isTauriEnv,
    });

    if (isTauriEnv && path) {
        // FILEIO: Ưu tiên đọc qua localfile protocol (Rust streaming / range)
        try {
            console.info('[getFileArrayBuffer] Thử đọc qua fetchLocalFileBuffer:', path);
            const buf = await fetchLocalFileBuffer(path);
            console.info('[getFileArrayBuffer] fetchLocalFileBuffer thành công, bytes:', buf.byteLength);
            if (buf.byteLength > 0) {
                return buf;
            }
            console.warn('[getFileArrayBuffer] fetchLocalFileBuffer trả về 0 bytes, thử đọc qua Tauri IPC read_system_file...');
        } catch (fetchError) {
            console.warn('[getFileArrayBuffer] fetchLocalFileBuffer thất bại, chuyển sang fallback IPC read_system_file:', fetchError);
            if ((file as NativePathBlob & { __prynxArtifactLeaseToken?: string }).__prynxArtifactLeaseToken) {
                throw new Error(
                    'Không đọc được artifact làm việc đang được tab giữ; file có thể đã bị dọn hoặc lease đã hết hạn.',
                    { cause: fetchError },
                );
            }
        }

        // Fallback IPC: Gọi trực tiếp lệnh read_system_file của Tauri Rust
        try {
            const { invoke } = await import('@tauri-apps/api/core');
            console.info('[getFileArrayBuffer] Đang gọi invoke read_system_file cho path:', path);
            const res = await invoke<unknown>('read_system_file', { path });
            if (res instanceof ArrayBuffer) {
                console.info('[getFileArrayBuffer] Fallback IPC thành công (ArrayBuffer), bytes:', res.byteLength);
                return res;
            }
            if (res instanceof Uint8Array) {
                console.info('[getFileArrayBuffer] Fallback IPC thành công (Uint8Array), bytes:', res.byteLength);
                return res.buffer.slice(res.byteOffset, res.byteOffset + res.byteLength) as ArrayBuffer;
            }
            if (Array.isArray(res)) {
                console.info('[getFileArrayBuffer] Fallback IPC thành công (Array), bytes:', res.length);
                return new Uint8Array(res).buffer as ArrayBuffer;
            }
            if (res && typeof res === 'object' && 'data' in res && Array.isArray((res as { data: number[] }).data)) {
                return new Uint8Array((res as { data: number[] }).data).buffer as ArrayBuffer;
            }
            if (res && typeof (res as { arrayBuffer?: () => Promise<ArrayBuffer> }).arrayBuffer === 'function') {
                return await (res as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer!();
            }
        } catch (ipcError) {
            console.warn('[getFileArrayBuffer] Fallback IPC read_system_file thất bại:', ipcError);
        }
    }

    if (typeof file.arrayBuffer === 'function') {
        const buf = await file.arrayBuffer();
        console.info('[getFileArrayBuffer] Đọc qua file.arrayBuffer(), bytes:', buf.byteLength);
        if (buf.byteLength > 0 || !path) {
            return buf;
        }
    }
    console.info('[getFileArrayBuffer] Đọc qua Response(file).arrayBuffer()...');
    const respBuf = await new Response(file).arrayBuffer();
    console.info('[getFileArrayBuffer] Response(file).arrayBuffer() bytes:', respBuf.byteLength);
    return respBuf;
};

/**
 * Trả về một File RỖNG bytes mang metadata của file nếu có `.path` trên đĩa (Tauri) —
 * dùng cho stack undo (history / objectEdit) để KHÔNG giữ nguyên bytes PDF trong RAM
 * (audit RAM 2026-07-06: file 50MB × N bước undo = leak vài GB/tab).
 *
 * File rỗng nội dung + path vẫn render đúng qua pdfium (native) và đọc lại bytes qua
 * `getFileArrayBuffer` (đọc từ đĩa qua protocol `localfile`). Nếu KHÔNG có path (web
 * fallback / blob) → GIỮ NGUYÊN file (fallback bytes) → hành vi y hệt hiện tại.
 */
export function stripBytesIfOnDisk<T extends File | null>(file: T): T {
    if (!file || !window.__TAURI_INTERNALS__ || !file.path) return file;

    const light = new File([], file.name, {
        type: file.type,
        lastModified: file.lastModified,
    });

    // PERF (feedback 2026-08-10 §UNDO.1): bytes thật vẫn rỗng, nhưng `.size`
    // phải là kích thước trên đĩa. Nếu để 0, policy file lớn và dò màu
    // hiểu nhầm, có thể đọc toàn bộ PDF ngay lúc Ctrl+Z đang nạp lại viewer.
    Object.defineProperty(light, 'size', {
        value: file.size,
        configurable: true,
    });

    // Các cờ này quyết định nhánh render/lưu. Làm mất chúng trong history
    // có thể khiến Undo ghi đè file tạm hoặc nạp lại sai engine.
    const runtimeMetadataKeys = [
        'path',
        'isTempUploadPath',
        'isGenerated',
        '__pathMaterializationFailed',
        '__editCommit',
        '__pathRebaseOnly',
        '__nativePathPending',
        'isBlank',
        'blankWidthPt',
        'blankHeightPt',
        'blankPageCount',
        'isInMemory',
        '__prynxArtifactLeaseToken',
    ] as const;
    const source = file as RuntimeMetadataFile;
    for (const key of runtimeMetadataKeys) {
        if (!(key in source)) continue;
        Object.defineProperty(light, key, {
            value: source[key],
            configurable: true,
        });
    }
    return light as T;
}

export async function detectColorSpace(file: File): Promise<string | null> {
    if (file.type?.startsWith('image/') || file.name.match(/\.(jpg|jpeg|png|webp|gif|bmp)$/i)) {
        return 'RGB';
    }
    
    if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
        try {
            // If in Tauri and path is available, try the backend first for 100% accuracy (decompressing streams)
            if (window.__TAURI_INTERNALS__ && file.path) {
                try {
                    const { getApiUrl } = await import('./api');
                    const apiUrl = getApiUrl();
                    const res = await fetch(`${apiUrl}/imposition/quick-color-space`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ path: file.path })
                    });
                    if (res.ok) {
                        const data = await res.json();
                        if (data.color_space) {
                            return data.color_space;
                        }
                    }
                } catch (e) {
                    console.warn("Backend color space check failed, falling back to heuristic", e);
                }
            }

            const fetchChunk = async (start: number, end: number) => {
                if (window.__TAURI_INTERNALS__ && file.path) {
                    // FILEIO (audit 2026-07-28 §FL.02): helper bắt status lỗi và dùng
                    // protocol đọc file thật; body 403 không còn bị phân tích như PDF.
                    return fetchLocalFileBuffer(
                        file.path,
                        end > start ? { start, endExclusive: end } : undefined,
                    );
                } else {
                    return await file.slice(start, end).arrayBuffer();
                }
            };
            
            let text = '';
            const size = file.size || 0;
            
            if (size <= 3 * 1024 * 1024) {
                const buffer = await fetchChunk(0, size);
                text = new TextDecoder('ascii').decode(new Uint8Array(buffer));
            } else {
                const buf1 = await fetchChunk(0, 1024 * 1024);
                const buf2 = await fetchChunk(Math.max(1024 * 1024, size - 1024 * 1024), size);
                text = new TextDecoder('ascii').decode(new Uint8Array(buf1)) + new TextDecoder('ascii').decode(new Uint8Array(buf2));
            }
            
            const cmykCount = (text.match(/\/DeviceCMYK/g) || []).length;
            const rgbCount = (text.match(/\/DeviceRGB/g) || []).length;
            const separationCount = (text.match(/\/Separation/g) || []).length;
            
            let cs = '';
            if (cmykCount > rgbCount) cs = 'CMYK';
            else if (rgbCount > cmykCount) cs = 'RGB';
            else if (cmykCount > 0) cs = 'CMYK/RGB';
            
            if (cs && separationCount > 0) cs += '/Spot';
            
            return cs || null;
        } catch (e) {
            console.warn('Failed to detect color space', e);
        }
    }
    return null;
}
