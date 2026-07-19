export type SavePdfResult = { kind: 'saved' } | { kind: 'cancelled' };

export async function savePdfBlob(blob: Blob, filename: string): Promise<SavePdfResult> {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const isTauri = typeof window !== 'undefined' && !!(window as any).__TAURI_INTERNALS__;
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
            setTimeout(() => URL.revokeObjectURL(url), 0);
        }
        return { kind: 'saved' };
    }
    const { save } = await import('@tauri-apps/plugin-dialog');
    const { invoke } = await import('@tauri-apps/api/core');
    const path = await save({
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
        defaultPath: filename,
        title: 'Lưu file PDF',
    });
    if (!path) return { kind: 'cancelled' };
    await invoke('write_file_atomic', { path, contents: bytes });
    return { kind: 'saved' };
}
