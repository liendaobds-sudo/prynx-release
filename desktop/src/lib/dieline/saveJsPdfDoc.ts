// ============================================================
// saveJsPdfDoc — Ghi một tài liệu jsPDF ra đĩa theo đúng pattern Tauri
// của toàn app (KHÔNG dùng `doc.save()` — cơ chế `<a download>` của
// trình duyệt bị WebView2 nuốt im lặng nên file không rơi xuống đĩa).
//
// Trong Tauri: mở save-dialog → ghi nguyên tử qua lệnh Rust
// `write_file_atomic` (giống ImpositionTab, không vướng
// scope plugin-fs). Ngoài Tauri (browser/dev): fallback `<a download>`.
// ============================================================

import type { jsPDF } from 'jspdf';

/** Đang chạy trong cửa sổ Tauri (WebView2) hay không. */
function isTauri(): boolean {
    return typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;
}

/** Fallback trình duyệt: tải blob bằng thẻ `<a download>` (dev/web thường). */
function browserDownload(bytes: ArrayBuffer, filename: string): void {
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    try {
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.rel = 'noopener';
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    } finally {
        setTimeout(() => URL.revokeObjectURL(url), 0);
    }
}

/**
 * Kết quả ghi file:
 *   - `saved`     : đã ghi ra đĩa (Tauri) hoặc đã kích hoạt tải (browser).
 *   - `cancelled` : người dùng đóng save-dialog (chỉ xảy ra trong Tauri).
 */
export type SaveResult = { kind: 'saved' } | { kind: 'cancelled' };

/**
 * Ghi tài liệu jsPDF ra đĩa. Trả về `cancelled` nếu người dùng huỷ
 * save-dialog (Tauri); `saved` nếu đã ghi/tải. Ném lỗi khi ghi thất bại.
 */
export async function saveJsPdfDoc(doc: jsPDF, filename: string): Promise<SaveResult> {
    const bytes = doc.output('arraybuffer') as ArrayBuffer;

    if (!isTauri()) {
        browserDownload(bytes, filename);
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

    await invoke('write_file_atomic', { path, contents: new Uint8Array(bytes) });
    return { kind: 'saved' };
}
