/**
 * recovery.ts — Autosave & Crash Recovery (an toàn dữ liệu).
 *
 * Phương án A (nhẹ): mỗi tab đang-sửa ghi 1 snapshot JSON chứa ĐƯỜNG DẪN file gốc +
 * các thao tác sửa (thứ tự/xoay trang, field VDP) ra `%APPDATA%\PrynX\recovery\`.
 * KHÔNG lưu bytes PDF. Khi app/máy crash (không thoát sạch), file snapshot còn sót →
 * lúc khởi động App phát hiện và hỏi khôi phục. Thoát sạch → xóa hết snapshot.
 *
 * Chỉ áp cho file CÓ đường dẫn trên đĩa (file gốc còn để mở lại). File không path
 * (trang trắng/kết quả chưa lưu) KHÔNG snapshot được ở phương án A — bỏ qua.
 *
 * Ghi qua lệnh Rust `write_file_atomic` (temp+rename) để snapshot không bao giờ
 * dở-dang. Đọc/liệt kê/xóa qua plugin-fs (appDataDir đã có scope).
 */

export interface RecoverySnapshot {
    v: 1;
    tabId: string;
    title: string;
    savedAt: string;               // ISO timestamp
    originalPath: string;          // BẮT BUỘC (phương án A) — file gốc để mở lại
    originalName: string;
    feature?: string;              // initialFeature (focusFeature)
    lockedMode?: string;           // 'booklet'|'nup'|'sticker_imposer'|'cnc_imposer'
    viewerPageOrder?: number[];
    // number[] THEO VỊ TRÍ (out[i]=góc trang ở vị trí i). Dạng CŨ Record<pageNum,deg>
    // vẫn đọc được: restore tự migrate sang mảng theo vị trí (per-instance rotation).
    viewerPageRotations?: number[] | Record<string, number>;
    vdpFields?: any[];
}

const RECOVERY_SUBDIR = 'recovery';

function isTauri(): boolean {
    return typeof window !== 'undefined' && !!(window as any).__TAURI_INTERNALS__;
}

let _fs: any = null;
let _path: any = null;
async function init(): Promise<boolean> {
    if (!isTauri()) return false;
    try {
        if (!_fs) _fs = await import('@tauri-apps/plugin-fs');
        if (!_path) _path = await import('@tauri-apps/api/path');
        return true;
    } catch {
        return false;
    }
}

async function recoveryDir(): Promise<string | null> {
    if (!(await init())) return null;
    try {
        const appData = await _path.appDataDir();
        const sep = appData.includes('\\') ? '\\' : '/';
        const dir = `${appData}${appData.endsWith(sep) ? '' : sep}${RECOVERY_SUBDIR}`;
        try { await _fs.mkdir(dir, { recursive: true }); } catch { /* exists */ }
        return dir;
    } catch {
        return null;
    }
}

function joinDir(dir: string, name: string): string {
    const sep = dir.includes('\\') ? '\\' : '/';
    return `${dir}${dir.endsWith(sep) ? '' : sep}${name}`;
}

/** Tên file snapshot an toàn theo tabId (chỉ giữ ký tự an toàn). */
function snapName(tabId: string): string {
    return `${tabId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`;
}

/** Ghi (atomic) snapshot cho 1 tab. No-op nếu không có originalPath / không Tauri. */
export async function writeSnapshot(snap: RecoverySnapshot): Promise<boolean> {
    if (!snap.originalPath) return false;       // phương án A: cần file gốc
    const dir = await recoveryDir();
    if (!dir) return false;
    try {
        const { invoke } = await import('@tauri-apps/api/core');
        const json = JSON.stringify(snap);
        await invoke('write_file_atomic', {
            path: joinDir(dir, snapName(snap.tabId)),
            contents: new TextEncoder().encode(json),
        });
        return true;
    } catch {
        // best-effort: snapshot lỗi KHÔNG được làm hỏng phiên làm việc.
        return false;
    }
}

/** Xóa snapshot của 1 tab (sau khi đã lưu / đóng tab có xác nhận). */
export async function deleteSnapshot(tabId: string): Promise<void> {
    const dir = await recoveryDir();
    if (!dir) return;
    try { await _fs.remove(joinDir(dir, snapName(tabId))); } catch { /* không có cũng được */ }
}

/** Liệt kê mọi snapshot còn sót (dấu hiệu lần trước CRASH). Bỏ qua file hỏng. */
export async function listSnapshots(): Promise<RecoverySnapshot[]> {
    const dir = await recoveryDir();
    if (!dir) return [];
    const out: RecoverySnapshot[] = [];
    try {
        const entries = await _fs.readDir(dir);
        for (const e of entries) {
            if (!e.name?.endsWith('.json')) continue;
            try {
                const content = await _fs.readTextFile(joinDir(dir, e.name));
                const snap = JSON.parse(content);
                if (snap && snap.tabId && snap.originalPath) out.push(snap);
            } catch { /* file hỏng → bỏ qua */ }
        }
    } catch { /* thư mục lỗi */ }
    return out.sort((a, b) => new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime());
}

/** Xóa TOÀN BỘ snapshot — gọi khi THOÁT SẠCH (đã xác nhận / không dirty). */
export async function clearAllSnapshots(): Promise<void> {
    const dir = await recoveryDir();
    if (!dir) return;
    try {
        const entries = await _fs.readDir(dir);
        for (const e of entries) {
            if (e.name?.endsWith('.json')) {
                try { await _fs.remove(joinDir(dir, e.name)); } catch { /* skip */ }
            }
        }
    } catch { /* skip */ }
}
