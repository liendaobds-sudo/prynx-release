/**
 * editGeometry.ts — Hàm THUẦN (pure) cho phần toán toạ độ của tính năng
 * "Chỉnh sửa đối tượng" (pdf-object-edit). Tách khỏi LivePageFrame để KIỂM THỬ
 * đơn vị deterministic (đây là chỗ từng gây lỗi lệch toạ độ: px@96 ↔ point,
 * lật trục y, offset CropBox, scale, snap góc, khớp tên font).
 *
 * Quy ước:
 * - pageDim.w/h là PX @ 96 DPI (= point × 96/72). point = px × 72/96.
 * - Bbox /edit/objects ở hệ PDF user-space NATIVE, gốc dưới-trái: [x0,yb,x1,yt].
 * - Canvas overlay: gốc trên-trái, đơn vị POINT (theo CropBox).
 */
export type BBox = [number, number, number, number];

/** Chiều rộng/cao trang theo POINT từ pageDim (px@96). Fallback 595 nếu thiếu. */
export function pageWidthPtFromDim(pageDimW: number | undefined | null): number {
    return (pageDimW || 595) * 72 / 96;
}
export function pageHeightPtFromDim(pageDimH: number | undefined | null): number {
    return (pageDimH || 842) * 72 / 96;
}

/** Hệ số px-màn / POINT để vẽ overlay (= displayWidth / chiều rộng trang theo point). */
export function editScale(displayWidth: number, pageWidthPt: number): number {
    return displayWidth / pageWidthPt;
}

/**
 * Đổi bbox object từ PDF NATIVE (bottom-left) sang CANVAS top-left (point),
 * trừ gốc CropBox (bx0,by0) để khớp ảnh render theo CropBox.
 */
export function objectBboxNativeToCanvas(
    bbox: BBox, pageHeightPt: number, cropX0 = 0, cropY0 = 0,
): BBox {
    const [x0, yb, x1, yt] = bbox;
    const top = pageHeightPt - (yt - cropY0);
    const bottom = pageHeightPt - (yb - cropY0);
    return [x0 - cropX0, Math.min(top, bottom), x1 - cropX0, Math.max(top, bottom)];
}

/**
 * Đổi điểm/bbox THÊM object từ canvas top-left (point) sang PDF NATIVE
 * (bottom-left), CỘNG lại gốc CropBox. `xPt,yPt` = góc trên-trái; w,h = kích thước.
 */
export function addBboxCanvasToNative(
    xPt: number, yPt: number, wPt: number, hPt: number,
    pageHeightPt: number, cropX0 = 0, cropY0 = 0,
): BBox {
    const x0 = xPt + cropX0;
    const x1 = xPt + wPt + cropX0;
    const yTopCanvas = yPt;
    const yBottomCanvas = yPt + hPt;
    return [x0, pageHeightPt - yBottomCanvas + cropY0, x1, pageHeightPt - yTopCanvas + cropY0];
}

/**
 * Đổi delta kéo (px canvas) → delta PDF (point, y hướng LÊN): dx giữ nguyên,
 * dy ĐẢO DẤU (canvas y xuống ↔ pdf y lên).
 */
export function moveDeltaCanvasToPdf(dxPx: number, dyPx: number, scale: number): { dx: number; dy: number } {
    return { dx: dxPx / scale, dy: -(dyPx / scale) };
}

/** Snap góc khi giữ Shift về bội số 45° (0/45/90/135/180...). */
export function snapRotation(deg: number, shift: boolean): number {
    return shift ? Math.round(deg / 45) * 45 : deg;
}

/** Góc xoay gửi backend = ĐẢO DẤU góc trên màn (màn y xuống ↔ PDF y lên). */
export function rotationScreenToPdf(screenDeg: number): number {
    return -screenDeg;
}

/** Chuẩn hoá tên font để khớp mờ: bỏ ký tự không phải chữ/số, về thường. */
export function normalizeFontName(s: string): string {
    return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Khớp tên font gốc (vd 'Montserrat-Bold') với một font hệ thống.
 * Ưu tiên trùng chuẩn hoá tuyệt đối; sau đó chứa lẫn nhau. None nếu không có.
 */
export function pickFontForName(
    name: string | undefined | null,
    list: { name: string; path: string }[],
): { name: string; path: string } | null {
    if (!name || !list || !list.length) return null;
    const target = normalizeFontName(name);
    if (!target) return null;
    let m = list.find(f => normalizeFontName(f.name) === target);
    if (!m) m = list.find(f => {
        const n = normalizeFontName(f.name);
        return n.includes(target) || target.includes(n);
    });
    return m || null;
}
