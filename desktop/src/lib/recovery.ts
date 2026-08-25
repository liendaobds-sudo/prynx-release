/**
 * recovery.ts — Autosave & Crash Recovery (an toàn dữ liệu).
 *
 * Phương án A (nhẹ): mỗi tab đang-sửa ghi 1 snapshot JSON chứa ĐƯỜNG DẪN +
 * fingerprint size/mtime của file gốc và các thao tác sửa bền vững
 * (thứ tự/instance/xoay trang, field VDP) ra `%APPDATA%\PrynX\recovery\`.
 * KHÔNG lưu bytes PDF. Khi app/máy crash (không thoát sạch), file snapshot còn sót →
 * lúc khởi động App phát hiện và hỏi khôi phục. Thoát sạch → xóa hết snapshot.
 *
 * Chỉ áp cho file CÓ đường dẫn trên đĩa. File không path, không đọc được mtime,
 * hoặc còn edit-object trong RAM (chưa có journal bền vững) đều fail-closed.
 *
 * Ghi qua lệnh Rust `write_file_atomic` (temp+rename) để snapshot không bao giờ
 * dở-dang. Đọc/liệt kê/xóa qua plugin-fs (appDataDir đã có scope).
 */

import {
    normalizeWorkspaceHistoryPageRevision,
    type WorkspaceHistoryEntry,
} from './workspaceHistory';

export interface RecoverySourceFingerprint {
    size: number;
    mtimeMs: number;
}

export interface RecoverySnapshot {
    v: 2;
    tabId: string;
    title: string;
    savedAt: string;               // ISO timestamp
    originalPath: string;          // BẮT BUỘC (phương án A) — file gốc để mở lại
    originalName: string;
    /** null chỉ tồn tại trong RAM khi migrate v1; writeSnapshot từ chối ghi lại. */
    sourceFingerprint: RecoverySourceFingerprint | null;
    migratedFromVersion?: 1;
    dirty: true;
    pendingObjectEdits: false;
    feature?: string;              // initialFeature (focusFeature)
    lockedMode?: string;           // 'booklet'|'nup'|'sticker_imposer'|'cnc_imposer'
    viewerPageOrder?: number[];
    viewerPageInstanceIds?: string[];
    /** number[] THEO VỊ TRÍ (out[i]=góc trang ở vị trí i). */
    viewerPageRotations?: number[];
    vdpFields?: Array<Record<string, unknown>>;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readRequiredString(source: UnknownRecord, key: string): string | null {
    const value = source[key];
    return typeof value === 'string' && value.trim() ? value : null;
}

function cloneOptionalIntegerArray(value: unknown): number[] | undefined | null {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) return null;
    if (value.some(item => !Number.isInteger(item) || Number(item) < -1)) return null;
    return value.map(Number);
}

function cloneOptionalStringArray(value: unknown): string[] | undefined | null {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) return null;
    if (value.some(item => typeof item !== 'string' || item.length === 0)) return null;
    return [...value] as string[];
}

function normalizeRotation(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
    return ((value % 360) + 360) % 360;
}

function cloneOptionalRotationArray(value: unknown): number[] | undefined | null {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) return null;
    return value.map(normalizeRotation);
}

function cloneOptionalFields(value: unknown): Array<Record<string, unknown>> | undefined | null {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.some(item => !isRecord(item))) return null;
    return value.map(item => ({ ...item }));
}

function parseFingerprint(value: unknown): RecoverySourceFingerprint | null {
    if (!isRecord(value)) return null;
    const size = value.size;
    const mtimeMs = value.mtimeMs;
    if (
        typeof size !== 'number'
        || !Number.isFinite(size)
        || size < 0
        || typeof mtimeMs !== 'number'
        || !Number.isFinite(mtimeMs)
        || mtimeMs <= 0
    ) return null;
    return { size, mtimeMs };
}

function legacyHasDurableState(
    pageOrder: readonly number[] | undefined,
    rotations: readonly number[] | undefined,
    vdpFields: readonly Record<string, unknown>[] | undefined,
): boolean {
    // v1 không ghi cờ edit-object. Chỉ identity order + góc 0 có thể là snapshot
    // được tạo duy nhất vì edit RAM; bỏ nó để không quảng cáo khả năng recovery giả.
    return Boolean(
        pageOrder?.some((page, index) => page !== index + 1)
        || rotations?.some(rotation => rotation !== 0)
        || (vdpFields && vdpFields.length > 0),
    );
}

/**
 * REVISION (audit 2026-08-25 §REV.08): parse/migrate snapshot tại một biên duy
 * nhất. v1 không có fingerprint nên giữ marker legacy để App áp policy mtime.
 */
export function parseRecoverySnapshot(value: unknown): RecoverySnapshot | null {
    if (!isRecord(value)) return null;
    const tabId = readRequiredString(value, 'tabId');
    const title = readRequiredString(value, 'title');
    const savedAt = readRequiredString(value, 'savedAt');
    const originalPath = readRequiredString(value, 'originalPath');
    const originalName = readRequiredString(value, 'originalName');
    if (
        !tabId || !title || !savedAt || !originalPath || !originalName
        || !Number.isFinite(Date.parse(savedAt))
    ) return null;

    const pageOrder = cloneOptionalIntegerArray(value.viewerPageOrder);
    const pageInstanceIds = cloneOptionalStringArray(value.viewerPageInstanceIds);
    const vdpFields = cloneOptionalFields(value.vdpFields);
    if (pageOrder === null || pageInstanceIds === null || vdpFields === null) return null;

    if (value.v === 1) {
        let rotations: number[] | undefined;
        if (Array.isArray(value.viewerPageRotations)) {
            const parsed = cloneOptionalRotationArray(value.viewerPageRotations);
            if (parsed === null) return null;
            rotations = parsed;
        } else if (isRecord(value.viewerPageRotations)) {
            const legacyRotations = value.viewerPageRotations;
            rotations = pageOrder?.map(page => normalizeRotation(legacyRotations[String(page)]));
        } else if (value.viewerPageRotations !== undefined) {
            return null;
        }
        if (!legacyHasDurableState(pageOrder, rotations, vdpFields)) return null;
        return {
            v: 2,
            tabId,
            title,
            savedAt,
            originalPath,
            originalName,
            sourceFingerprint: null,
            migratedFromVersion: 1,
            dirty: true,
            pendingObjectEdits: false,
            feature: typeof value.feature === 'string' ? value.feature : undefined,
            lockedMode: typeof value.lockedMode === 'string' ? value.lockedMode : undefined,
            viewerPageOrder: pageOrder,
            // Không suy ID từ source page: duplicate nhận ID mới riêng lúc hydrate.
            viewerPageInstanceIds: undefined,
            viewerPageRotations: rotations,
            vdpFields,
        };
    }

    if (
        value.v !== 2
        || value.dirty !== true
        || value.pendingObjectEdits !== false
    ) return null;
    const sourceFingerprint = parseFingerprint(value.sourceFingerprint);
    const rotations = cloneOptionalRotationArray(value.viewerPageRotations);
    if (!sourceFingerprint || rotations === null) return null;
    return {
        v: 2,
        tabId,
        title,
        savedAt,
        originalPath,
        originalName,
        sourceFingerprint,
        dirty: true,
        pendingObjectEdits: false,
        feature: typeof value.feature === 'string' ? value.feature : undefined,
        lockedMode: typeof value.lockedMode === 'string' ? value.lockedMode : undefined,
        viewerPageOrder: pageOrder,
        viewerPageInstanceIds: pageInstanceIds,
        viewerPageRotations: rotations,
        vdpFields,
    };
}

export function isRecoverySourceCurrent(
    snapshot: RecoverySnapshot,
    current: RecoverySourceFingerprint | null,
): boolean {
    if (!current) return false;
    if (snapshot.sourceFingerprint) {
        return snapshot.sourceFingerprint.size === current.size
            && snapshot.sourceFingerprint.mtimeMs === current.mtimeMs;
    }
    if (snapshot.migratedFromVersion !== 1) return false;
    const savedAtMs = Date.parse(snapshot.savedAt);
    // v1 không có size/mtime lịch sử. Chỉ chấp nhận khi mtime hiện tại không mới
    // hơn snapshot; thay đổi rõ ràng sau autosave phải fail-closed.
    return Number.isFinite(savedAtMs) && current.mtimeMs <= savedAtMs;
}

export function bindRecoverySourceFingerprint(
    snapshot: RecoverySnapshot,
    sourceFingerprint: RecoverySourceFingerprint,
): RecoverySnapshot {
    return {
        v: 2,
        tabId: snapshot.tabId,
        title: snapshot.title,
        savedAt: snapshot.savedAt,
        originalPath: snapshot.originalPath,
        originalName: snapshot.originalName,
        sourceFingerprint: { ...sourceFingerprint },
        dirty: true,
        pendingObjectEdits: false,
        feature: snapshot.feature,
        lockedMode: snapshot.lockedMode,
        viewerPageOrder: snapshot.viewerPageOrder ? [...snapshot.viewerPageOrder] : undefined,
        viewerPageInstanceIds: snapshot.viewerPageInstanceIds
            ? [...snapshot.viewerPageInstanceIds]
            : undefined,
        viewerPageRotations: snapshot.viewerPageRotations
            ? [...snapshot.viewerPageRotations]
            : undefined,
        vdpFields: snapshot.vdpFields?.map(field => ({ ...field })),
    };
}

export function createRecoveryHistoryEntry(
    snapshot: RecoverySnapshot,
    file: File,
    createInstanceId?: () => string,
): WorkspaceHistoryEntry {
    return Object.freeze({
        // Không strip/clone File: pending fence so sánh đúng object loader đang mở.
        file,
        pageRevision: normalizeWorkspaceHistoryPageRevision(
            snapshot.viewerPageOrder,
            snapshot.viewerPageInstanceIds,
            snapshot.viewerPageRotations,
            createInstanceId,
        ),
        pageRevisionDirty: snapshot.dirty,
        sourceImageFile: null,
        stickerSourceFile: null,
        recipeDraftLen: null,
    });
}

const RECOVERY_SUBDIR = 'recovery';
type RecoveryFsApi = typeof import('@tauri-apps/plugin-fs');
type RecoveryPathApi = typeof import('@tauri-apps/api/path');

function isTauri(): boolean {
    return typeof window !== 'undefined'
        && Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

let _fs: RecoveryFsApi | null = null;
let _path: RecoveryPathApi | null = null;
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
    if (!(await init()) || !_fs || !_path) return null;
    const fs = _fs;
    const pathApi = _path;
    try {
        const appData = await pathApi.appDataDir();
        const sep = appData.includes('\\') ? '\\' : '/';
        const dir = `${appData}${appData.endsWith(sep) ? '' : sep}${RECOVERY_SUBDIR}`;
        try { await fs.mkdir(dir, { recursive: true }); } catch { /* exists */ }
        return dir;
    } catch {
        return null;
    }
}

/** Đọc fingerprint nhẹ từ metadata filesystem; không hash nền và không đọc bytes PDF. */
export async function readRecoverySourceFingerprint(
    path: string,
): Promise<RecoverySourceFingerprint | null> {
    if (!path || !(await init()) || !_fs) return null;
    try {
        const info = await _fs.stat(path);
        const mtimeMs = info.mtime?.getTime();
        if (
            !info.isFile
            || !Number.isFinite(info.size)
            || info.size < 0
            || typeof mtimeMs !== 'number'
            || !Number.isFinite(mtimeMs)
            || mtimeMs <= 0
        ) return null;
        return { size: info.size, mtimeMs };
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
    const normalized = parseRecoverySnapshot(snap);
    // v1 migrate chỉ tồn tại trong RAM tới khi App bind fingerprint hiện tại.
    if (!normalized?.sourceFingerprint || normalized.migratedFromVersion === 1) return false;
    const dir = await recoveryDir();
    if (!dir) return false;
    try {
        const { invoke } = await import('@tauri-apps/api/core');
        const json = JSON.stringify(normalized);
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
    const fs = _fs;
    if (!dir || !fs) return;
    try { await fs.remove(joinDir(dir, snapName(tabId))); } catch { /* không có cũng được */ }
}

/** Liệt kê mọi snapshot còn sót (dấu hiệu lần trước CRASH). Bỏ qua file hỏng. */
export async function listSnapshots(): Promise<RecoverySnapshot[]> {
    const dir = await recoveryDir();
    const fs = _fs;
    if (!dir || !fs) return [];
    const out: RecoverySnapshot[] = [];
    try {
        const entries = await fs.readDir(dir);
        for (const e of entries) {
            if (!e.name?.endsWith('.json')) continue;
            try {
                const content = await fs.readTextFile(joinDir(dir, e.name));
                const snap = parseRecoverySnapshot(JSON.parse(content));
                if (snap) out.push(snap);
            } catch { /* file hỏng → bỏ qua */ }
        }
    } catch { /* thư mục lỗi */ }
    return out.sort((a, b) => new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime());
}

/** Xóa TOÀN BỘ snapshot — gọi khi THOÁT SẠCH (đã xác nhận / không dirty). */
export async function clearAllSnapshots(): Promise<void> {
    const dir = await recoveryDir();
    const fs = _fs;
    if (!dir || !fs) return;
    try {
        const entries = await fs.readDir(dir);
        for (const e of entries) {
            if (e.name?.endsWith('.json')) {
                try { await fs.remove(joinDir(dir, e.name)); } catch { /* skip */ }
            }
        }
    } catch { /* skip */ }
}
