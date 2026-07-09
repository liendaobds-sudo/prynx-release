import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

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
        const { convertFileSrc, invoke } = await import('@tauri-apps/api/core');
        try {
            const resp = await fetch(convertFileSrc(path));
            if (resp.ok) return await resp.arrayBuffer();
            throw new Error('asset fetch status ' + resp.status);
        } catch (e) {
            // Fallback: đọc qua lệnh Rust read_system_file (std::fs) — chắc chắn đọc
            // được file trên Ổ MẠNG/NAS (UNC \\server\share\...) kể cả khi asset
            // protocol vướng edge-case với path mạng.
            const raw: any = await invoke('read_system_file', { path });
            const u8 = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
            return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
        }
    }
    return file.arrayBuffer();
};

/**
 * Trả về một File RỖNG bytes chỉ mang tên + path nếu file có `.path` trên đĩa (Tauri) —
 * dùng cho stack undo (history / objectEdit) để KHÔNG giữ nguyên bytes PDF trong RAM
 * (audit RAM 2026-07-06: file 50MB × N bước undo = leak vài GB/tab).
 *
 * File rỗng + path vẫn render đúng qua pdfium (native) và đọc lại bytes qua
 * `getFileArrayBuffer` (fetch từ đĩa qua convertFileSrc). Nếu KHÔNG có path (web
 * fallback / blob) → GIỮ NGUYÊN file (fallback bytes) → hành vi y hệt hiện tại.
 */
export function stripBytesIfOnDisk<T extends File | null>(file: T): T {
    if (!file || !(window as any).__TAURI_INTERNALS__ || !(file as any).path) return file;
    const light = new File([], file.name, { type: file.type });
    Object.defineProperty(light, 'path', { value: (file as any).path });
    // Giữ cờ __editCommit nếu có → viewer không full-reload khi apply lại.
    if ((file as any).__editCommit) {
        Object.defineProperty(light, '__editCommit', { value: true, configurable: true });
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
                    const { convertFileSrc } = await import('@tauri-apps/api/core');
                    const resp = await fetch(convertFileSrc((file as any).path), {
                        headers: { 'Range': `bytes=${start}-${end - 1}` }
                    });
                    return await resp.arrayBuffer();
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
