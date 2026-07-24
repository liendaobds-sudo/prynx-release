// ============================================================
// foldLive.ts — Giá trị gập/orbit “live” ngoài React
//
// Animation (▶ / 🎬) ghi vào đây mỗi frame; SolidPanelMesh đọc trong
// useFrame để cập nhật ma trận mà KHÔNG setState Zustand mỗi frame
// (tránh re-render toàn cây panel → UI đơ).
//
// Store `foldProgress` chỉ sync thưa (UI slider) qua `syncFoldToStore`.
// ============================================================

export interface FoldLiveState {
    /** foldProgress ∈ [0, 1] */
    progress: number;
    /** orbit yaw (rad) cho hero demo */
    orbitYawRad: number;
    /** true khi driver animation đang chạy (giữ frameloop demand) */
    driving: boolean;
    /** monotomic counter — panel bỏ qua nếu không đổi */
    version: number;
}

export const foldLive: FoldLiveState = {
    progress: 1,
    orbitYawRad: 0,
    driving: false,
    version: 0,
};

/** invalidate() từ R3F — đăng ký bởi FoldLivePump trong Canvas. */
let invalidateCanvas: (() => void) | null = null;

export function registerFoldLiveInvalidate(fn: (() => void) | null): void {
    invalidateCanvas = fn;
}

/** Ghi live (mỗi frame animation). */
export function writeFoldLive(
    progress: number,
    orbitYawRad: number = foldLive.orbitYawRad,
): void {
    const p = Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : foldLive.progress;
    const y = Number.isFinite(orbitYawRad) ? orbitYawRad : 0;
    if (
        Math.abs(p - foldLive.progress) < 1e-6
        && Math.abs(y - foldLive.orbitYawRad) < 1e-6
    ) {
        invalidateCanvas?.();
        return;
    }
    foldLive.progress = p;
    foldLive.orbitYawRad = y;
    foldLive.version += 1;
    invalidateCanvas?.();
}

/** Bật/tắt chế độ driver (animation đang chạy). */
export function setFoldLiveDriving(driving: boolean): void {
    foldLive.driving = driving;
    if (!driving) {
        foldLive.orbitYawRad = 0;
        foldLive.version += 1;
    }
}

/**
 * Đồng bộ store → live khi user kéo slider / set tay
 * (không phải animation driver).
 */
export function seedFoldLiveFromStore(progress: number): void {
    if (foldLive.driving) return;
    writeFoldLive(progress, 0);
}
