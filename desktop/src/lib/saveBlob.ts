export type SaveBlobResult = { kind: 'saved' } | { kind: 'cancelled' };

export interface SaveBlobOptions {
    title: string;
    filterName: string;
    extensions: string[];
}

async function readBlobBytes(blob: Blob): Promise<Uint8Array> {
    if (typeof blob.arrayBuffer === 'function') {
        return new Uint8Array(await blob.arrayBuffer());
    }
    const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error ?? new Error('Không đọc được dữ liệu cần lưu.'));
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.readAsArrayBuffer(blob);
    });
    return new Uint8Array(buffer);
}

/**
 * Ghi Blob theo đúng đường Tauri của PrynX; WebView2 có thể nuốt `<a download>`.
 * UIUX (audit 2026-07-29 §LR.01): Tauri dùng Save dialog + ghi nguyên tử,
 * browser/dev mới dùng anchor fallback.
 */
export async function saveBlob(
    blob: Blob,
    filename: string,
    options: SaveBlobOptions,
): Promise<SaveBlobResult> {
    const isTauri = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;
    if (!isTauri) {
        const url = URL.createObjectURL(blob);
        try {
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = filename;
            anchor.rel = 'noopener';
            anchor.style.display = 'none';
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
        } finally {
            window.setTimeout(() => URL.revokeObjectURL(url), 0);
        }
        return { kind: 'saved' };
    }

    const { save } = await import('@tauri-apps/plugin-dialog');
    const { invoke } = await import('@tauri-apps/api/core');
    const path = await save({
        filters: [{ name: options.filterName, extensions: options.extensions }],
        defaultPath: filename,
        title: options.title,
    });
    if (!path) return { kind: 'cancelled' };

    const contents = await readBlobBytes(blob);
    await invoke('write_file_atomic', { path, contents });
    return { kind: 'saved' };
}
