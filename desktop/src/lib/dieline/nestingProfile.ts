// ============================================================
// nestingProfile — Biên dạng khuôn theo CỘT, dùng cho lồng khuôn + kiểm va chạm
// [HANGING-WINDOW 2026-07-27]
//
// VÌ SAO CÓ FILE NÀY: `computeDieOutline` (nestingEngine) cần một vòng CUT KHÉP
// KÍN để trả về Outer_Silhouette, nhưng khuôn thật luôn có rãnh xả / nét cụt /
// lỗ khoét nên chuỗi không bao giờ khép được — đo thực tế: MỌI loại hộp đều rơi
// về bbox-rect (4 đỉnh). Hệ quả nặng: `validatePlacementPositions` so va chạm
// bằng hình chữ nhật nên LOẠI SẠCH mọi vị trí lồng, và mọi chiến lược lồng
// (RTE/SLB/pizza/envelope) thực chất không còn tác dụng trong app.
//
// Giải pháp: không cần vòng kín. Rời rạc hoá khuôn thành PROFILE theo cột x —
// mỗi cột lưu [yMin, yMax] của vật liệu, lấy từ min/max giao điểm với TẤT CẢ nét
// CUT. Nét cắt nội bộ (rãnh, khe, lỗ cửa sổ, lỗ euro) nằm trong vật liệu nên
// không ảnh hưởng cực trị ⇒ đúng bằng biên ngoài.
//
// GIỚI HẠN ĐÃ BIẾT (ghi rõ để không ai nhầm): khoảng hở được đo theo TRỤC DỌC
// trên từng cột. Với hai mép cùng nghiêng gắt ở góc chéo, khoảng cách Euclid có
// thể nhỏ hơn `gap` một ít so với phép đo này. Đổi lại nó không bao giờ báo
// chồng oan (điều đang giết mọi chiến lược lồng). Với dieGap mặc định 3mm và
// bước cột ≤ ~8mm thì sai số đó nằm trong dung sai dao bế.
// ============================================================

import { DielineModel } from './types';
import { PlacedDieline } from './nestingTypes';

/** Số cột lấy mẫu. 128 đủ mịn cho khuôn ≤ 1000mm mà vẫn rẻ khi chạy trong Boa. */
export const PROFILE_SAMPLES = 128;

/** Bước rời rạc hoá bezier khi lấy profile. */
const BEZIER_STEPS = 8;

export type DieProfile = {
    /** Mép vật liệu thấp nhất của cột (toạ độ khuôn, y hướng LÊN). */
    yMin: number[];
    /** Mép vật liệu cao nhất của cột. */
    yMax: number[];
    /** Cột không có vật liệu (không ràng buộc gì). */
    empty: boolean[];
    samples: number;
    dieW: number;
    dieH: number;
    /**
     * `true` = profile TỔNG HỢP (khuôn đặc hình chữ nhật) vì không có model để
     * đọc biên dạng. Phía gọi PHẢI bỏ qua mọi kết luận va chạm dựa trên profile
     * này: nó không mang thông tin hình học nào, dùng nó để "kiểm" sẽ loại oan
     * mọi vị trí lồng (đúng cái bug mà file này sinh ra để sửa).
     */
    synthetic: boolean;
};

/** Profile "khuôn đặc hình chữ nhật" — dùng khi không có model để đọc. */
export function fullRectProfile(dieW: number, dieH: number, samples = PROFILE_SAMPLES): DieProfile {
    return {
        yMin: new Array<number>(samples).fill(0),
        yMax: new Array<number>(samples).fill(dieH),
        empty: new Array<boolean>(samples).fill(false),
        samples, dieW, dieH, synthetic: true,
    };
}

/**
 * Profile lấy trực tiếp từ nét CUT của model (toạ độ quy về gốc bbox khuôn).
 * Hàm THUẦN, chỉ đọc model.
 */
export function computeCutProfile(
    model: DielineModel | undefined,
    dieW: number, dieH: number,
    samples: number = PROFILE_SAMPLES,
): DieProfile {
    const bb = model?.boundingBox;
    if (!model || !bb || dieW <= 0 || dieH <= 0 || samples <= 0) {
        return fullRectProfile(dieW, dieH, samples);
    }

    const yMin = new Array<number>(samples).fill(Infinity);
    const yMax = new Array<number>(samples).fill(-Infinity);
    const empty = new Array<boolean>(samples).fill(true);
    const step = dieW / samples;

    const addSegment = (ax: number, ay: number, bx: number, by: number) => {
        const dx = bx - ax;
        if (Math.abs(dx) < 1e-9) return; // đoạn đứng: cột kề đã phủ giá trị y
        const lo = Math.min(ax, bx);
        const hi = Math.max(ax, bx);
        let i0 = Math.floor(lo / step - 0.5);
        let i1 = Math.ceil(hi / step - 0.5);
        if (i0 < 0) i0 = 0;
        if (i1 > samples - 1) i1 = samples - 1;
        for (let i = i0; i <= i1; i++) {
            const x = (i + 0.5) * step;
            if (x < lo || x > hi) continue;
            const y = ay + ((x - ax) / dx) * (by - ay);
            if (y < yMin[i]) yMin[i] = y;
            if (y > yMax[i]) yMax[i] = y;
            empty[i] = false;
        }
    };

    for (const seg of model.allPaths) {
        if (seg.tag !== 'CUT') continue;
        if (seg.type === 'bezier' && seg.controlPoints && seg.controlPoints.length >= 4) {
            const [p0, c1, c2, p3] = seg.controlPoints;
            let px = p0.x - bb.minX;
            let py = p0.y - bb.minY;
            for (let s = 1; s <= BEZIER_STEPS; s++) {
                const t = s / BEZIER_STEPS;
                const u = 1 - t;
                const qx = u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p3.x - bb.minX;
                const qy = u * u * u * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p3.y - bb.minY;
                addSegment(px, py, qx, qy);
                px = qx; py = qy;
            }
            continue;
        }
        for (let k = 0; k + 1 < seg.points.length; k++) {
            addSegment(
                seg.points[k].x - bb.minX, seg.points[k].y - bb.minY,
                seg.points[k + 1].x - bb.minX, seg.points[k + 1].y - bb.minY,
            );
        }
    }

    for (let i = 0; i < samples; i++) {
        if (empty[i]) { yMin[i] = dieH; yMax[i] = 0; }
    }
    return { yMin, yMax, empty, samples, dieW, dieH, synthetic: false };
}

/** Dải vật liệu tại cột `i` trong hệ KHUÔN, đã tính chiều xoay 0°/180°. */
export function extentAt(p: DieProfile, i: number, rotation: number): { min: number; max: number } {
    if (((rotation % 360) + 360) % 360 === 180) {
        const m = p.samples - 1 - i;
        return { min: p.dieH - p.yMax[m], max: p.dieH - p.yMin[m] };
    }
    return { min: p.yMin[i], max: p.yMax[i] };
}

/** Cột `i` có vật liệu không (đã tính chiều xoay). */
function columnFilled(p: DieProfile, i: number, rotation: number): boolean {
    const idx = ((rotation % 360) + 360) % 360 === 180 ? p.samples - 1 - i : i;
    return !p.empty[idx];
}

/**
 * Dải vật liệu của cột `i` trong hệ TỜ GIẤY, tính từ mép TRÊN của bao khuôn
 * (y hướng xuống). `min` = từ mép trên xuống tới vật liệu, `max` = tới mép dưới
 * của vật liệu.
 */
function localSheetExtent(p: DieProfile, i: number, rotation: number): { min: number; max: number } {
    const rot = ((rotation % 360) + 360) % 360;
    if (rot === 180) {
        const m = p.samples - 1 - i;
        return { min: p.yMin[m], max: p.yMax[m] };
    }
    return { min: p.dieH - p.yMax[i], max: p.dieH - p.yMin[i] };
}

/**
 * Bước hàng TỐI THIỂU giữa hai khuôn cùng cột, trong hệ TỜ GIẤY (y hướng xuống):
 * khuôn `rotAbove` ở trên, khuôn `rotBelow` ở dưới. Với mọi cột, mép trên của
 * khuôn dưới phải cách mép dưới của khuôn trên ≥ `gap`.
 *
 * PHẢI tính trong hệ tờ giấy, không phải hệ khuôn: y khuôn hướng LÊN còn y tờ
 * giấy hướng XUỐNG, tính lẫn hệ sẽ đảo hai bước xen kẽ của layout 0°/180° (đã
 * mắc đúng lỗi này một lần — test `placementsTooClose` bắt được).
 *
 * Không bao giờ vượt `dieH + gap` nên chiến lược dùng nó không thể tệ hơn grid.
 */
export function minRowPitch(
    p: DieProfile, rotAbove: number, rotBelow: number, gap: number,
): number {
    let need = 0;
    for (let i = 0; i < p.samples; i++) {
        if (!columnFilled(p, i, rotAbove) || !columnFilled(p, i, rotBelow)) continue;
        const above = localSheetExtent(p, i, rotAbove);
        const below = localSheetExtent(p, i, rotBelow);
        const d = above.max - below.min;
        if (d > need) need = d;
    }
    return Math.min(p.dieH + gap, Math.max(gap, need + gap));
}

/**
 * Dải vật liệu của một khuôn ĐÃ ĐẶT, tại hoành độ tuyệt đối `xAbs`, trong hệ
 * TỜ GIẤY (y hướng XUỐNG: `pos.y` là mép TRÊN của bao khuôn).
 *
 * Trả `null` khi cột nằm ngoài khuôn hoặc cột rỗng.
 */
export function sheetExtentAt(
    pos: PlacedDieline, p: DieProfile, xAbs: number,
): { min: number; max: number } | null {
    const rot = ((pos.rotation % 360) + 360) % 360;
    if (rot !== 0 && rot !== 180) return null; // 90°/270° không mô tả được bằng profile cột
    const step = p.dieW / p.samples;
    const i = Math.round((xAbs - pos.x) / step - 0.5);
    if (i < 0 || i >= p.samples) return null;
    if (!columnFilled(p, i, rot)) return null;
    const e = extentAt(p, i, rot);
    // Lật trục: y khuôn hướng lên, y tờ giấy hướng xuống.
    return { min: pos.y + (p.dieH - e.max), max: pos.y + (p.dieH - e.min) };
}

/**
 * Hai khuôn đã đặt có vi phạm khoảng hở `gap` không (theo profile).
 * `null` = không kết luận được (có khuôn xoay 90°/270°) → phía gọi nên dùng
 * phép kiểm polygon thận trọng.
 */
export function placementsTooClose(
    a: PlacedDieline, b: PlacedDieline, p: DieProfile, gap: number,
): boolean | null {
    const rotA = ((a.rotation % 360) + 360) % 360;
    const rotB = ((b.rotation % 360) + 360) % 360;
    if ((rotA !== 0 && rotA !== 180) || (rotB !== 0 && rotB !== 180)) return null;

    const step = p.dieW / p.samples;
    const xLo = Math.max(a.x, b.x);
    const xHi = Math.min(a.x, b.x) + p.dieW;
    if (xHi <= xLo) return false; // không cột nào chung → chỉ cách nhau theo x

    const iStart = Math.max(0, Math.floor((xLo - a.x) / step - 0.5));
    const iEnd = Math.min(p.samples - 1, Math.ceil((xHi - a.x) / step - 0.5));
    for (let i = iStart; i <= iEnd; i++) {
        const xAbs = a.x + (i + 0.5) * step;
        if (xAbs < xLo || xAbs > xHi) continue;
        const ea = sheetExtentAt(a, p, xAbs);
        if (!ea) continue;
        const eb = sheetExtentAt(b, p, xAbs);
        if (!eb) continue;
        const clearance = eb.min >= ea.max
            ? eb.min - ea.max
            : (ea.min >= eb.max ? ea.min - eb.max : -1);
        if (clearance < gap - 0.01) return true;
    }
    return false;
}
