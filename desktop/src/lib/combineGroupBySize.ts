/**
 * Chia nhóm file/trang Combine theo kích thước trang hiển thị (MediaBox + rotation),
 * cùng quy ước viewer: width/height điểm sau khi tính góc xoay.
 */

export const PT_TO_MM = 25.4 / 72; // ≈ 0.352778

/** Làm tròn mm (mặc định 0.5mm) để gom nhóm size gần nhau. */
export function roundMm(mm: number, step = 0.5): number {
    if (!Number.isFinite(mm) || step <= 0) return 0;
    return Math.round(mm / step) * step;
}

/**
 * Kích thước hiển thị (pt) sau rotation — khớp viewer (viewport scale=1 + xoay).
 * angleDeg: 0 | 90 | 180 | 270 (góc trang PDF + xoay node UI).
 */
export function displaySizePt(
    widthPt: number,
    heightPt: number,
    angleDeg = 0,
): { w: number; h: number } {
    const a = ((Math.round(angleDeg) % 360) + 360) % 360;
    if (a === 90 || a === 270) {
        return { w: heightPt, h: widthPt };
    }
    return { w: widthPt, h: heightPt };
}

/** Khóa nhóm, vd "50x70" (mm, đã làm tròn). */
export function pageSizeKeyMm(
    widthPt: number,
    heightPt: number,
    angleDeg = 0,
    stepMm = 0.5,
): string {
    const { w, h } = displaySizePt(widthPt, heightPt, angleDeg);
    const wMm = roundMm(w * PT_TO_MM, stepMm);
    const hMm = roundMm(h * PT_TO_MM, stepMm);
    return `${fmtMm(wMm)}x${fmtMm(hMm)}`;
}

function fmtMm(n: number): string {
    // Bỏ .0 thừa: 50.0 → 50, 50.5 → 50.5
    return Number.isInteger(n) ? String(n) : String(n);
}

/** Nhãn UI / tên tab / tên file. */
export function sizeKeyLabel(key: string): string {
    return `${key}mm`;
}

/**
 * Gom các phần tử đã có sizeKey thành map key → items (giữ thứ tự xuất hiện).
 * Phần tử không đo được (blank chưa gán) nhận key fallback.
 */
export function groupBySizeKey<T extends { sizeKey: string }>(
    items: T[],
    fallbackKey = 'unknown',
): Map<string, T[]> {
    const map = new Map<string, T[]>();
    for (const it of items) {
        const k = it.sizeKey || fallbackKey;
        const list = map.get(k);
        if (list) list.push(it);
        else map.set(k, [it]);
    }
    return map;
}
