/**
 * tileUrl.ts — dựng URL cho tile.localhost (renderer pdfium native).
 *
 * URL: http://tile.localhost/{encodedPath}/{page}/{zoom}/{rot}/{cx}/{cy}/{cw}/{ch}
 * 4 số cuối là vùng clip (device px). 0/0/0/0 = KHÔNG clip → render nguyên
 * MediaBox (gồm cả phần bleed tràn lề).
 *
 * Xem trước THÀNH PHẨM (sách lật / bình sách) phải cắt bỏ bleed để hiện đúng
 * khổ trang sau xén: trang thành phẩm = trang nguồn co vào `bleed` mỗi cạnh
 * (finished = page − 2×bleed mỗi chiều). Vì bleed đối xứng 4 cạnh nên offset
 * trên/dưới bằng nhau → không phụ thuộc chiều trục y của pdfium.
 */
const MM_TO_PT = 2.83465;

export type TileRenderPurpose = 'interactive' | 'background';

export interface TileUrlOpts {
    path: string;
    page: number;
    /** zoom truyền cho renderer; render_scale thực = (96/72)*zoom. */
    scale: number;
    rot?: number;
    /** Khổ trang nguồn (MediaBox) theo pt — cần để tính vùng clip trừ bleed. */
    pageWpt?: number;
    pageHpt?: number;
    /** Bleed mỗi cạnh (mm). 0/undefined → không clip (hiện nguyên trang). */
    bleedMm?: number;
    /** Trang đang nhìn dùng interactive; trang nạp trước/thumbnail dùng background. */
    purpose?: TileRenderPurpose;
}

export function buildTileUrl(opts: TileUrlOpts): string {
    const {
        path, page, scale, rot = 0, pageWpt, pageHpt, bleedMm,
        purpose = 'interactive',
    } = opts;
    const enc = encodeURIComponent(path);

    let cx = 0, cy = 0, cw = 0, ch = 0;
    const b = bleedMm || 0;
    if (b > 0 && pageWpt && pageWpt > 0 && pageHpt && pageHpt > 0) {
        const renderScale = (96 / 72) * scale;
        const bleedPt = b * MM_TO_PT;
        const trimWpt = pageWpt - 2 * bleedPt;
        const trimHpt = pageHpt - 2 * bleedPt;
        // Chỉ clip khi vùng thành phẩm còn dương (bleed không nuốt hết trang).
        if (trimWpt > 0 && trimHpt > 0) {
            cx = Math.round(bleedPt * renderScale);
            cy = Math.round(bleedPt * renderScale);
            cw = Math.round(trimWpt * renderScale);
            ch = Math.round(trimHpt * renderScale);
        }
    }

    return `http://tile.localhost/${enc}/${page}/${scale}/${rot}/${cx}/${cy}/${cw}/${ch}?purpose=${purpose}`;
}

/** Tỉ lệ khung trang SAU xén (để layout không kéo giãn ảnh đã clip). */
export function trimmedAspectRatio(pageWpt: number, pageHpt: number, bleedMm?: number): number {
    const b = bleedMm || 0;
    if (b > 0) {
        const bleedPt = b * MM_TO_PT;
        const tw = pageWpt - 2 * bleedPt;
        const th = pageHpt - 2 * bleedPt;
        if (tw > 0 && th > 0) return tw / th;
    }
    return pageWpt / pageHpt;
}
