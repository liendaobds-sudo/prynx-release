export interface PlateOverlaySource {
    name: string;
    color: number[];
    dataUrl: string;
}

export interface PlateOverlay extends PlateOverlaySource {
    visible: boolean;
    /** Vị trí trang trong viewer (1-based), không phải chỉ số trang gốc sau reorder. */
    pageNum: number;
    /** Trang thật được gửi sang backend để dựng preview (1-based). */
    sourcePageNum: number;
    pixelWidth: number;
    pixelHeight: number;
}

export interface PlateOverlayPageIdentity {
    viewerPageNum: number;
    sourcePageNum: number;
    pixelWidth: number;
    pixelHeight: number;
}

// UIUX (fix preview đa kích thước 2026-07-28): giữ danh tính trang trong từng
// bitmap; nếu bỏ metadata này, ảnh trang đang phân tích sẽ bị dán lên mọi frame.
export function buildPagePlateOverlays(
    plates: PlateOverlaySource[],
    visibleNames: ReadonlySet<string>,
    soloPlate: string | null,
    page: PlateOverlayPageIdentity,
): PlateOverlay[] {
    return plates.map(plate => ({
        ...plate,
        visible: soloPlate ? plate.name === soloPlate : visibleNames.has(plate.name),
        pageNum: page.viewerPageNum,
        sourcePageNum: page.sourcePageNum,
        pixelWidth: page.pixelWidth,
        pixelHeight: page.pixelHeight,
    }));
}

/** Chỉ trả overlay nhìn thấy và thuộc đúng frame trang hiện tại. */
export function getVisiblePlateOverlaysForPage(
    plates: PlateOverlay[],
    viewerPageNum: number,
): PlateOverlay[] {
    return plates.filter(plate => plate.visible && plate.pageNum === viewerPageNum);
}
