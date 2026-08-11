import { rectMmToFrac, type BoxMm, type Frac } from './cropDialogGeometry';

export interface PlateOverlaySource {
    name: string;
    color: number[];
    dataUrl: string;
    displayMode?: 'plate-multiply' | 'color-managed-composite';
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

export type OutputPreviewPageBoxKind = 'bleedbox' | 'trimbox' | 'artbox';

export interface OutputPreviewPageBoxes {
    viewerPageNum: number;
    sourcePageNum: number;
    cropbox: BoxMm;
    trimbox: BoxMm;
    bleedbox: BoxMm;
    artbox: BoxMm;
    has_trimbox: boolean;
    has_bleedbox: boolean;
    has_artbox: boolean;
    rotation: number;
}

export interface OutputPreviewPageBoxOverlay {
    kind: OutputPreviewPageBoxKind;
    rect: Frac;
}

export type OutputPreviewOverlayKind =
    | 'soft-proof'
    | 'gamut-warning'
    | 'tac-heatmap'
    | 'overprint';

/**
 * Trả độ đục hiển thị theo đúng vai trò của từng bitmap Output Preview.
 *
 * UIUX (audit 2026-08-10 §OP.E2): Soft-Proof và composite Overprint là ảnh mô
 * phỏng chính nên luôn phải giữ 100%; slider chỉ điều khiển lớp cảnh báo và ảnh
 * diff Overprint khi người dùng chủ động bật chế độ chẩn đoán.
 */
export function getOutputPreviewOverlayOpacity(
    kind: OutputPreviewOverlayKind,
    warningOpacity: number,
    overprintDiagnosticActive: boolean,
): number {
    const normalizedWarningOpacity = Number.isFinite(warningOpacity)
        ? Math.max(0, Math.min(1, warningOpacity))
        : 1;

    if (kind === 'gamut-warning' || kind === 'tac-heatmap') {
        return normalizedWarningOpacity;
    }
    if (kind === 'overprint' && overprintDiagnosticActive) {
        return normalizedWarningOpacity;
    }
    return 1;
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

/**
 * Chỉ tạo lớp phủ khi người dùng đã thay đổi tập bản kẽm.
 *
 * UIUX (audit 2026-08-10 §OP.6): trạng thái mặc định bật toàn bộ kẽm tương đương
 * ảnh Viewer color-managed đang nằm sẵn bên dưới. Đắp lại sáu PNG màu cố định
 * trên nền trắng vừa làm trang nháy như refresh, vừa thay ảnh đúng bằng composite
 * CSS xấp xỉ. Trả mảng rỗng giữ nguyên bitmap Viewer; riêng trạng thái bỏ hết kẽm
 * vẫn phải trả đủ item `visible=false` để `LivePageFrame` dựng một trang giấy trắng.
 */
export function buildDisplayedPagePlateOverlays(
    plates: PlateOverlaySource[],
    visibleNames: ReadonlySet<string>,
    soloPlate: string | null,
    page: PlateOverlayPageIdentity,
): PlateOverlay[] {
    const allPlatesVisible = plates.length > 0
        && soloPlate === null
        && plates.every(plate => visibleNames.has(plate.name));
    if (allPlatesVisible) return [];
    return buildPagePlateOverlays(plates, visibleNames, soloPlate, page);
}

/**
 * Bitmap duy nhất đã được PPE ghép từ tập kẽm rồi đổi qua ICC.
 *
 * COLOR (audit 2026-08-10 §OP.1): đánh dấu riêng để Viewer không áp
 * `mix-blend-multiply` lần thứ hai lên một ảnh đã color-managed hoàn chỉnh.
 */
export function buildColorManagedPlateCompositeOverlay(
    dataUrl: string,
    page: PlateOverlayPageIdentity,
): PlateOverlay[] {
    return [{
        name: '__prynx_color_managed_plate_composite__',
        color: [0, 0, 0],
        dataUrl,
        displayMode: 'color-managed-composite',
        visible: true,
        pageNum: page.viewerPageNum,
        sourcePageNum: page.sourcePageNum,
        pixelWidth: page.pixelWidth,
        pixelHeight: page.pixelHeight,
    }];
}

/** Chỉ trả overlay nhìn thấy và thuộc đúng frame trang hiện tại. */
export function getVisiblePlateOverlaysForPage(
    plates: PlateOverlay[],
    viewerPageNum: number,
): PlateOverlay[] {
    return plates.filter(plate => plate.visible && plate.pageNum === viewerPageNum);
}

/** Composite ICC đã hoàn chỉnh không được nhân màu CSS thêm lần nữa. */
export function usesPlateMultiplyBlend(plate: PlateOverlay): boolean {
    return plate.displayMode !== 'color-managed-composite';
}


function isFinitePositiveBox(box: BoxMm): boolean {
    return [box.x0, box.y0, box.x1, box.y1, box.width, box.height]
        .every(Number.isFinite)
        && box.x1 > box.x0
        && box.y1 > box.y0
        && box.width > 0
        && box.height > 0;
}

/**
 * Dựng khung Art/Trim/Bleed từ PageBox thật của đúng trang Viewer.
 *
 * PAGEBOX (audit 2026-08-10 §OP.E3): response ở hệ PDF gốc dưới-trái; Viewer
 * hiển thị CropBox ở hệ trên-trái và đã áp `/Rotate`. Dùng cùng phép đổi đã khóa
 * bởi CropDialog, đồng thời chỉ vẽ box có cờ `has_*` để không biến fallback
 * MediaBox thành một PageBox được khai báo giả.
 */
export function getVisibleOutputPreviewPageBoxOverlays(
    boxes: OutputPreviewPageBoxes | null,
    viewerPageNum: number,
    showPageBoxes: boolean,
): OutputPreviewPageBoxOverlay[] {
    if (
        !showPageBoxes
        || boxes === null
        || boxes.viewerPageNum !== viewerPageNum
        || !isFinitePositiveBox(boxes.cropbox)
    ) {
        return [];
    }

    const candidates: Array<{
        kind: OutputPreviewPageBoxKind;
        box: BoxMm;
        declared: boolean;
    }> = [
        { kind: 'bleedbox', box: boxes.bleedbox, declared: boxes.has_bleedbox },
        { kind: 'trimbox', box: boxes.trimbox, declared: boxes.has_trimbox },
        { kind: 'artbox', box: boxes.artbox, declared: boxes.has_artbox },
    ];

    return candidates.flatMap(({ kind, box, declared }) => {
        if (!declared || !isFinitePositiveBox(box)) return [];
        const rect = rectMmToFrac(box, boxes.cropbox, boxes.rotation);
        if (rect.x1 <= rect.x0 || rect.y1 <= rect.y0) return [];
        return [{ kind, rect }];
    });
}
