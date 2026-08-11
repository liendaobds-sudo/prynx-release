import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { fetchLocalFileBuffer } from './localFileTransport';

/**
 * Utility to merge tailwind classes with standard overrides,
 * preventing conflicts when applying dynamic atomic classes.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const getFileArrayBuffer = async (file: File | Blob): Promise<ArrayBuffer> => {
    const path = (file as any).path as string | undefined;
    if ((window as any).__TAURI_INTERNALS__ && path) {
        // FILEIO (audit 2026-07-28 §FL.04): một kênh Rust có Range thay cho phép thử
        // asset-403 + fallback IPC. Không làm chậm file lớn trên máy mạnh.
        return fetchLocalFileBuffer(path);
    }
    return file.arrayBuffer();
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
    if (!file || !(window as any).__TAURI_INTERNALS__ || !(file as any).path) return file;

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
    ] as const;
    for (const key of runtimeMetadataKeys) {
        if (!(key in (file as any))) continue;
        Object.defineProperty(light, key, {
            value: (file as any)[key],
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
            if ((window as any).__TAURI_INTERNALS__ && (file as any).path) {
                try {
                    const { getApiUrl } = await import('./api');
                    const apiUrl = getApiUrl();
                    const res = await fetch(`${apiUrl}/imposition/quick-color-space`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ path: (file as any).path })
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
                if ((window as any).__TAURI_INTERNALS__ && (file as any).path) {
                    // FILEIO (audit 2026-07-28 §FL.02): helper bắt status lỗi và dùng
                    // protocol đọc file thật; body 403 không còn bị phân tích như PDF.
                    return fetchLocalFileBuffer(
                        (file as any).path,
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
