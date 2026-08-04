import type { CropRegionFrac } from './cropGeometry';
import { roundMm2 } from '../components/preprocess-tools/setPageBoxesUtils';

export interface BoxMm {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    width: number;
    height: number;
}

export type Frac = CropRegionFrac;

export interface RectMm {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
}

export type HorizontalCropAlign = 'left' | 'center' | 'right';
export type VerticalCropAlign = 'top' | 'center' | 'bottom';

function normalizePageRotation(rotation: number): 0 | 90 | 180 | 270 {
    const normalized = ((Math.trunc(rotation) % 360) + 360) % 360;
    return normalized === 90 || normalized === 180 || normalized === 270
        ? normalized
        : 0;
}

function displayBoxSize(pageBox: BoxMm, rotation: number): { width: number; height: number } {
    const normalized = normalizePageRotation(rotation);
    return normalized === 90 || normalized === 270
        ? { width: pageBox.height, height: pageBox.width }
        : { width: pageBox.width, height: pageBox.height };
}

/**
 * Đổi vùng từ hệ trang mà canvas dùng trước CSS-rotate sang hệ hiển thị của PDF
 * đã materialize góc xoay người dùng vào `/Rotate`.
 */
export function rotateCropFracForMaterializedPage(frac: Frac, rotation: number): Frac {
    const normalized = normalizePageRotation(rotation);
    if (normalized === 90) {
        return {
            x0: 1 - frac.y1,
            y0: frac.x0,
            x1: 1 - frac.y0,
            y1: frac.x1,
        };
    }
    if (normalized === 180) {
        return {
            x0: 1 - frac.x1,
            y0: 1 - frac.y1,
            x1: 1 - frac.x0,
            y1: 1 - frac.y0,
        };
    }
    if (normalized === 270) {
        return {
            x0: frac.y0,
            y0: 1 - frac.x1,
            x1: frac.y1,
            y1: 1 - frac.x0,
        };
    }
    return { ...frac };
}

/** Đổi ngược vùng của PDF materialized về hệ overlay trước CSS-rotate. */
export function restoreCropFracForViewer(frac: Frac, rotation: number): Frac {
    return rotateCropFracForMaterializedPage(frac, -rotation);
}

/** Khổ hiển thị tức thời trong panel trước khi upload PDF làm việc hoàn tất. */
export function rotateDisplayBoxMm(pageBox: BoxMm, rotation: number): BoxMm {
    const size = displayBoxSize(pageBox, rotation);
    return {
        x0: pageBox.x0,
        y0: pageBox.y0,
        x1: pageBox.x0 + size.width,
        y1: pageBox.y0 + size.height,
        width: size.width,
        height: size.height,
    };
}

/** Vùng theo mm trên trang người dùng nhìn thấy, gốc trên-trái. */
export function fracToDisplayRectMm(frac: Frac, pageBox: BoxMm, rotation = 0): RectMm {
    const displaySize = displayBoxSize(pageBox, rotation);
    return {
        x0: roundMm2(frac.x0 * displaySize.width),
        y0: roundMm2(frac.y0 * displaySize.height),
        x1: roundMm2(frac.x1 * displaySize.width),
        y1: roundMm2(frac.y1 * displaySize.height),
    };
}

/**
 * Resize a crop selection to an exact physical size. The alignment is relative
 * to the complete visible page, while the scanned region only supplies the
 * initial width/height when the user has not entered an exact size yet.
 */
export function resizeCropFrac(
    source: Frac,
    pageBox: BoxMm,
    widthMm: number,
    heightMm: number,
    horizontal: HorizontalCropAlign,
    vertical: VerticalCropAlign,
    rotation = 0,
): Frac {
    const displaySize = displayBoxSize(pageBox, rotation);
    const width = Math.max(0.1, Math.min(displaySize.width, widthMm)) / displaySize.width;
    const height = Math.max(0.1, Math.min(displaySize.height, heightMm)) / displaySize.height;
    const alignedStart = (size: number, align: 'start' | 'center' | 'end') => {
        const start = 0;
        const end = 1;
        const raw = align === 'start'
            ? start
            : align === 'end'
                ? end - size
                : (start + end - size) / 2;
        return Math.max(0, Math.min(1 - size, raw));
    };
    const x0 = alignedStart(width, horizontal === 'left' ? 'start' : horizontal === 'right' ? 'end' : 'center');
    const y0 = alignedStart(height, vertical === 'top' ? 'start' : vertical === 'bottom' ? 'end' : 'center');
    return { x0, y0, x1: x0 + width, y1: y0 + height };
}

/** Đổi tỉ lệ trên trang hiển thị (gốc trên-trái) sang CropBox PDF gốc (gốc dưới-trái). */
export function fracToRectMm(frac: Frac, pageBox: BoxMm, rotation = 0): RectMm {
    const normalized = normalizePageRotation(rotation);
    let u0: number;
    let v0: number;
    let u1: number;
    let v1: number;

    // PAGEBOX (audit 2026-08-04 §W1.PB1): PDF.js/PDFium đã áp /Rotate khi
    // hiển thị; request crop phải quay ngược về hệ CropBox chưa xoay.
    if (normalized === 90) {
        u0 = frac.y0;
        v0 = frac.x0;
        u1 = frac.y1;
        v1 = frac.x1;
    } else if (normalized === 180) {
        u0 = 1 - frac.x1;
        v0 = frac.y0;
        u1 = 1 - frac.x0;
        v1 = frac.y1;
    } else if (normalized === 270) {
        u0 = 1 - frac.y1;
        v0 = 1 - frac.x1;
        u1 = 1 - frac.y0;
        v1 = 1 - frac.x0;
    } else {
        u0 = frac.x0;
        v0 = 1 - frac.y1;
        u1 = frac.x1;
        v1 = 1 - frac.y0;
    }

    return {
        x0: roundMm2(pageBox.x0 + u0 * pageBox.width),
        y0: roundMm2(pageBox.y0 + v0 * pageBox.height),
        x1: roundMm2(pageBox.x0 + u1 * pageBox.width),
        y1: roundMm2(pageBox.y0 + v1 * pageBox.height),
    };
}

/** Đổi hình chữ nhật PDF gốc về tỉ lệ trên trang hiển thị đã áp /Rotate. */
export function rectMmToFrac(rect: RectMm, pageBox: BoxMm, rotation = 0): Frac {
    const clamp = (value: number) => Math.max(0, Math.min(1, value));
    const normalized = normalizePageRotation(rotation);
    const u0 = clamp((rect.x0 - pageBox.x0) / pageBox.width);
    const v0 = clamp((rect.y0 - pageBox.y0) / pageBox.height);
    const u1 = clamp((rect.x1 - pageBox.x0) / pageBox.width);
    const v1 = clamp((rect.y1 - pageBox.y0) / pageBox.height);

    if (normalized === 90) {
        return { x0: v0, y0: u0, x1: v1, y1: u1 };
    }
    if (normalized === 180) {
        return { x0: 1 - u1, y0: v0, x1: 1 - u0, y1: v1 };
    }
    if (normalized === 270) {
        return { x0: 1 - v1, y0: 1 - u1, x1: 1 - v0, y1: 1 - u0 };
    }
    // Giữ đúng thứ tự phép tính cũ cho /Rotate=0 để tránh làm trôi float ở
    // đường phổ biến và không thay đổi hợp đồng đã có của overlay.
    return {
        x0: u0,
        y0: clamp((pageBox.y1 - rect.y1) / pageBox.height),
        x1: u1,
        y1: clamp((pageBox.y1 - rect.y0) / pageBox.height),
    };
}

/** Kích thước thành phẩm theo hướng người dùng đang nhìn thấy. */
export function rectDisplaySizeMm(rect: RectMm, rotation = 0): { width: number; height: number } {
    const rawWidth = rect.x1 - rect.x0;
    const rawHeight = rect.y1 - rect.y0;
    const normalized = normalizePageRotation(rotation);
    return normalized === 90 || normalized === 270
        ? { width: roundMm2(rawHeight), height: roundMm2(rawWidth) }
        : { width: roundMm2(rawWidth), height: roundMm2(rawHeight) };
}
