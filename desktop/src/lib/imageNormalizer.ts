import { invoke } from '@tauri-apps/api/core';

/**
 * Normalizes an arbitrary image file (e.g. CMYK JPEG, TIFF) into standard RGB PNG bytes.
 * This ensures that pdf-lib and Chrome's createImageBitmap can decode it safely.
 * @param bytes The raw image bytes (ArrayBuffer or Uint8Array)
 * @returns A promise resolving to the standard PNG bytes
 */
export async function normalizeImageToPngBytes(bytes: ArrayBuffer | Uint8Array): Promise<Uint8Array> {
    if (!(window as any).__TAURI_INTERNALS__) {
        // Fallback for non-Tauri environment (browser fallback)
        return new Uint8Array(bytes);
    }
    try {
        const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        // Invoke Rust backend to decode the image safely
        const pngBytes: Uint8Array = await invoke('normalize_image_bytes', { bytes: u8 });
        return pngBytes;
    } catch (e) {
        console.error("Failed to normalize image via Rust backend, falling back to original", e);
        return new Uint8Array(bytes);
    }
}
