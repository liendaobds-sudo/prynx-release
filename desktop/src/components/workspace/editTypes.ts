/**
 * editTypes.ts — TypeScript types cho tính năng Edit PDF Object (`pdf-object-edit`).
 *
 * Các type này khớp với schema backend (`backend/app/schemas/edit.py`):
 *  - `ObjMeta`  ← Geometry_Reader (PDFium read-only) liệt kê object.
 *  - `EditOp`   → mô tả thao tác sửa gửi tới các endpoint `/edit/*`.
 *
 * Tham chiếu: design.md → Data Models. Requirement 1.4 (định danh ổn định cho object).
 */

/** Loại đối tượng PDF do Geometry_Reader phân loại (PDFium `GetType`). */
export type ObjType = 'text' | 'image' | 'vector';

/**
 * Hộp bao [x0, y0, x1, y1] theo hệ tọa độ trang (point),
 * lấy từ PDFium `FPDFPageObj_GetBounds`.
 */
export type BBox = [number, number, number, number];

/** Ma trận biến đổi 2D affine [a, b, c, d, e, f] (CTM của object, nếu có). */
export type Matrix = [number, number, number, number, number, number];

/** Góc neo khi resize — tương ứng handle nw/ne/sw/se trên Canvas_UI. */
export type ResizeAnchor = 'nw' | 'ne' | 'sw' | 'se';

/** Loại thao tác sửa hỗ trợ. */
export type EditKind = 'delete' | 'move' | 'affine' | 'resize' | 'rotate' | 'editText' | 'replaceImage' | 'clipImage' | 'add' | 'paste' | 'objectVisibility'
    | 'layerVisibility' | 'layerLock' | 'layerRename' | 'layerReorder' | 'layerDelete';

/**
 * Metadata của một PDF_Object do Geometry_Reader trả về.
 * `id` là định danh ổn định trong phạm vi một lần liệt kê của một trang,
 * đủ để Object_Mapper ánh xạ lại về đoạn operator trong content stream.
 */
export interface ObjMeta {
    id: string;
    drawIndex: number;
    type: ObjType;
    /** OCG object IDs chứa object trên trang hiện tại. */
    ocgIds?: number[];
    /** Tên marked-content do PDFium đọc; dùng làm fallback cho Form XObject. */
    ocgNames?: string[];
    bbox: BBox;
    matrix?: Matrix;
}

/** Tham số tịnh tiến cho thao tác `move`. */
export interface MoveDelta {
    dx: number;
    dy: number;
}


/** Tham số tỉ lệ cho thao tác `resize` (anchor = góc đối diện handle đang kéo). */
export interface ResizeScale {
    sx: number;
    sy: number;
    anchor: ResizeAnchor;
}

/** Tham số nội dung text cho thao tác `editText` / `add`. */
export interface EditTextPayload {
    content: string;
    font?: string;
    sizePt?: number;
    bbox?: BBox;
    color?: number[] | null;
    bold?: boolean;
    italic?: boolean;
}

/** Tham số ảnh cho thao tác `add`. */
export interface EditImagePayload {
    dataRef: string;
    bbox?: BBox;
}

export type ImageClipShape =
    | 'none'
    | 'rectangle'
    | 'rounded'
    | 'circle'
    | 'ellipse'
    | 'triangle'
    | 'diamond'
    | 'pentagon'
    | 'hexagon'
    | 'octagon'
    | 'star'
    | 'heart'
    | 'cross';

export interface EditImageClipPayload {
    shape: ImageClipShape;
    radius?: number;
}

/**
 * Mô tả một thao tác sửa gửi tới backend.
 * Các trường tùy chọn được dùng theo `kind`:
 *  - move   → `delta`
 *  - resize → `scale`
 *  - rotate → `rotateDeg`
 *  - editText / add → `text`
 *  - add (image)    → `image`
 */
export interface EditOp {
    page: number;
    kind: EditKind;
    targetIds: string[];
    /** Trang nguồn cho `paste` (object được trích từ đây; `page` là trang đích). */
    sourcePage?: number;
    delta?: MoveDelta;
    affine?: Matrix;
    scale?: ResizeScale;
    rotateDeg?: number;
    text?: EditTextPayload;
    image?: EditImagePayload;
    clip?: EditImageClipPayload;
    layerId?: number;
    visible?: boolean;
    locked?: boolean;
    layerName?: string;
    layerOrder?: number[];
}
