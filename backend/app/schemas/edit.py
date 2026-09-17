"""
Pydantic schemas cho tính năng Edit PDF Object (`pdf-object-edit`).

Định nghĩa data models nối hai mô hình:
- `ObjMeta`  : object rời rạc do Geometry_Reader (PDFium, read-only) trả về.
- `EditOp`   : mô tả một thao tác sửa do frontend gửi xuống (delete/move/...).
- `OpSpan`   : dải operator trong content stream do Object_Mapper xác định.

Quy ước:
- Pydantic v2 (`field_validator`, `model_validator`), typing hiện đại `X | None`.
- Toàn bộ tọa độ theo hệ point của PDF; BBox dạng [x0, y0, x1, y1].
- Bảo toàn màu in là correctness property hàng đầu → các validator ở đây chỉ
  từ chối thao tác không hợp lệ (vd. resize ≤ 0) chứ không tự ý sửa dữ liệu màu.

_Requirements: 1.4 (định danh ổn định / data model ánh xạ), 6.5 (từ chối resize ≤ 0)._
"""
import math
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, field_validator, model_validator

# ── Hằng số / tiện ích tolerance ────────────────────────
# Tolerance tối đa cho sai lệch BBox mỗi cạnh giữa PDFium và content stream.
# Theo Yêu cầu 1.7 / 5.2 / 6.2 / 7.2: ≤ 1.0 point.
BBOX_TOLERANCE_PT: float = 1.0


def normalize_bbox(bbox: list[float]) -> list[float]:
    """
    Chuẩn hóa thứ tự BBox sao cho x0 <= x1 và y0 <= y1.

    PDFium / content stream có thể trả về cạnh theo thứ tự bất kỳ; chuẩn hóa
    giúp các phép so khớp (tolerance) và tính diện tích nhất quán.
    """
    if len(bbox) != 4:
        raise ValueError("bbox phải gồm đúng 4 giá trị [x0, y0, x1, y1]")
    x0, y0, x1, y1 = bbox
    return [min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)]


def bbox_within_tolerance(
    a: list[float], b: list[float], tol: float = BBOX_TOLERANCE_PT
) -> bool:
    """
    Trả về True nếu hai BBox khớp nhau trong sai số `tol` (mặc định ≤ 1.0pt)
    trên từng cạnh, sau khi đã chuẩn hóa thứ tự.
    """
    na, nb = normalize_bbox(a), normalize_bbox(b)
    return all(abs(na[i] - nb[i]) <= tol for i in range(4))


# ── ObjMeta ─────────────────────────────────────────────
ObjType = Literal["text", "image", "vector"]


class ObjMeta(BaseModel):
    """
    Metadata của một PDF_Object do Geometry_Reader liệt kê (read-only, PDFium).

    `id` ổn định trong phạm vi một lần liệt kê của một trang, đủ để Object_Mapper
    ánh xạ object này về đoạn operator trong content stream (Yêu cầu 1.4).
    """

    id: str
    drawIndex: int = Field(ge=0, description="Chỉ số thứ tự vẽ từ PDFium (gợi ý map)")
    type: ObjType
    ocgIds: list[int] = Field(default_factory=list, description="OCG IDs chứa object trên trang")
    ocgNames: list[str] = Field(default_factory=list, description="Tên OCG do PDFium đọc từ marked content")
    bbox: list[float] = Field(description="[x0, y0, x1, y1] theo point")
    matrix: list[float] | None = Field(
        default=None, description="CTM affine 6 phần tử [a, b, c, d, e, f] nếu có"
    )
    content: str | None = Field(
        default=None,
        description="Nội dung text gốc (chỉ với type='text') để điền sẵn editor sửa",
    )
    color: list[int] | None = Field(
        default=None,
        description="Màu tô RGB 0..255 của text (chỉ type='text') để editor khớp màu gốc",
    )
    fontName: str | None = Field(
        default=None,
        description="Tên font gốc (BaseFont, bỏ tiền tố subset) — gợi ý/khớp font hệ thống",
    )

    @field_validator("bbox")
    @classmethod
    def _check_bbox_len(cls, v: list[float]) -> list[float]:
        if len(v) != 4:
            raise ValueError("bbox phải gồm đúng 4 giá trị [x0, y0, x1, y1]")
        # Chuẩn hóa thứ tự để đảm bảo x0<=x1, y0<=y1.
        return normalize_bbox(v)

    @field_validator("matrix")
    @classmethod
    def _check_matrix_len(cls, v: list[float] | None) -> list[float] | None:
        if v is not None and len(v) != 6:
            raise ValueError("matrix phải gồm đúng 6 phần tử [a, b, c, d, e, f]")
        return v


# ── Sub-models cho EditOp ───────────────────────────────
class MoveDelta(BaseModel):
    """Độ dịch chuyển (dx, dy) cho thao tác move (Yêu cầu 5)."""

    dx: float
    dy: float

    @field_validator("dx", "dy")
    @classmethod
    def _finite_delta(cls, v: float) -> float:
        if not math.isfinite(v):
            raise ValueError("Độ dịch chuyển phải là số hữu hạn")
        return v


ResizeAnchor = Literal["nw", "ne", "sw", "se"]


class ResizeScale(BaseModel):
    """
    Hệ số tỉ lệ cho thao tác resize (Yêu cầu 6).

    `anchor` là góc cố định (đối diện handle người dùng kéo).
    Validator từ chối sx/sy ≤ 0 vì sẽ tạo kích thước ≤ 0 (Yêu cầu 6.5).
    """

    sx: float
    sy: float
    anchor: ResizeAnchor

    @field_validator("sx", "sy")
    @classmethod
    def _reject_non_positive_scale(cls, v: float) -> float:
        if v <= 0:
            raise ValueError(
                "Hệ số resize phải > 0; sx/sy ≤ 0 sẽ tạo kích thước ≤ 0 (Yêu cầu 6.5)"
            )
        return v


class TextPayload(BaseModel):
    """Nội dung text cho thao tác editText / add (Yêu cầu 8, 9)."""

    content: str
    font: str | None = None
    sizePt: float | None = Field(default=None, gt=0)
    bbox: list[float] | None = None
    color: list[float] | None = None
    bold: bool | None = None
    italic: bool | None = None

    @field_validator("bbox")
    @classmethod
    def _check_bbox(cls, v: list[float] | None) -> list[float] | None:
        if v is not None:
            if len(v) != 4:
                raise ValueError("bbox phải gồm đúng 4 giá trị [x0, y0, x1, y1]")
            return normalize_bbox(v)
        return v


class ImagePayload(BaseModel):
    """Tham chiếu ảnh + BBox đặt ảnh cho thao tác add (Yêu cầu 9.2)."""

    dataRef: str
    bbox: list[float] | None = None

    @field_validator("bbox")
    @classmethod
    def _check_bbox(cls, v: list[float] | None) -> list[float] | None:
        if v is None:
            return None
        if len(v) != 4:
            raise ValueError("bbox phải gồm đúng 4 giá trị [x0, y0, x1, y1]")
        return normalize_bbox(v)


ImageClipShape = Literal[
    "none",
    "rectangle",
    "rounded",
    "circle",
    "ellipse",
    "triangle",
    "diamond",
    "pentagon",
    "hexagon",
    "octagon",
    "star",
    "heart",
    "cross",
]


class ImageClipPayload(BaseModel):
    """Khung vector cắt ảnh; radius là tỉ lệ bán kính bo trên cạnh ngắn."""

    shape: ImageClipShape
    radius: float = Field(default=0.15, ge=0.0, le=0.5)


EditKind = Literal[
    "delete", "move", "affine", "resize", "rotate", "editText", "replaceImage",
    "clipImage", "add", "paste",
    "objectVisibility", "layerVisibility", "layerLock", "layerRename", "layerReorder",
    "layerDelete",
]

class EditOp(BaseModel):
    """
    Mô tả một thao tác sửa gửi từ Canvas_UI xuống backend.

    Tùy `kind`, các trường tham số tương ứng phải có mặt:
    - move    → `delta`
    - resize  → `scale`
    - rotate  → `rotateDeg`
    - editText→ `text`
    - add     → `text` hoặc `image`
    - delete  → chỉ cần `targetIds`
    """

    page: int = Field(ge=0)
    kind: EditKind
    targetIds: list[str] = Field(default_factory=list)

    # paste: trang nguồn của object được copy (có thể khác `page` = trang đích).
    sourcePage: int | None = Field(default=None, ge=0)

    # Tham số theo từng kind (đều optional ở mức field; ràng buộc bằng model_validator).
    delta: MoveDelta | None = None
    affine: list[float] | None = None
    scale: ResizeScale | None = None
    rotateDeg: float | None = None
    text: TextPayload | None = None
    image: ImagePayload | None = None
    clip: ImageClipPayload | None = None

    # Tham số cho thao tác OCG/layer (dùng chung op_log để Undo/Redo đúng thứ tự).
    layerId: int | None = None
    visible: bool | None = None
    locked: bool | None = None
    layerName: str | None = None
    layerOrder: list[int] | None = None

    @field_validator("affine")
    @classmethod
    def _check_affine(cls, v: list[float] | None) -> list[float] | None:
        if v is None:
            return None
        if len(v) != 6 or not all(math.isfinite(x) for x in v):
            raise ValueError("affine phải gồm 6 số hữu hạn [a,b,c,d,e,f]")
        if abs(v[0] * v[3] - v[1] * v[2]) < 1e-9:
            raise ValueError("affine suy biến không được phép")
        return v

    @model_validator(mode="after")
    def _check_required_params(self) -> "EditOp":
        # Các thao tác object cần targetIds; add thì không bắt buộc.
        object_target_kinds = {
            "delete", "move", "affine", "resize", "rotate", "replaceImage",
            "clipImage", "editText", "objectVisibility",
        }
        if self.kind in object_target_kinds and not self.targetIds:
            raise ValueError(f"Thao tác '{self.kind}' yêu cầu ít nhất một targetIds")

        if self.kind == "move" and self.delta is None:
            raise ValueError("Thao tác 'move' yêu cầu trường 'delta' (dx, dy)")
        if self.kind == "paste":
            if self.delta is None:
                raise ValueError("Thao tác 'paste' yêu cầu trường 'delta' (offset dx, dy)")
            if self.sourcePage is None:
                raise ValueError("Thao tác 'paste' yêu cầu trường 'sourcePage'")
        if self.kind == "affine" and self.affine is None:
            raise ValueError("Thao tác 'affine' yêu cầu ma trận affine")
        if self.kind == "replaceImage":
            if self.image is None or not self.image.dataRef:
                raise ValueError("Thao tác 'replaceImage' yêu cầu dữ liệu ảnh thay thế")
        if self.kind == "clipImage" and self.clip is None:
            raise ValueError("Thao tác 'clipImage' yêu cầu cấu hình khung ảnh")
        if self.kind == "resize" and self.scale is None:
            raise ValueError("Thao tác 'resize' yêu cầu trường 'scale' (sx, sy, anchor)")
        if self.kind == "rotate" and self.rotateDeg is None:
            raise ValueError("Thao tác 'rotate' yêu cầu trường 'rotateDeg'")
        if self.kind == "editText" and self.text is None:
            raise ValueError("Thao tác 'editText' yêu cầu trường 'text'")
        if self.kind == "add" and self.text is None and self.image is None:
            raise ValueError("Thao tác 'add' yêu cầu 'text' hoặc 'image'")
        if self.kind == "add" and self.image is not None and self.image.bbox is None:
            raise ValueError("Thêm ảnh yêu cầu image.bbox")
        if self.kind in {"layerVisibility", "layerLock", "layerRename", "layerDelete"} and self.layerId is None:
            raise ValueError(f"Thao tác '{self.kind}' yêu cầu layerId")
        if self.kind == "objectVisibility" and self.visible is None:
            raise ValueError("Thao tác objectVisibility yêu cầu visible")
        if self.kind == "layerVisibility" and self.visible is None:
            raise ValueError("Thao tác layerVisibility yêu cầu visible")
        if self.kind == "layerLock" and self.locked is None:
            raise ValueError("Thao tác layerLock yêu cầu locked")
        if self.kind == "layerRename" and not (self.layerName or "").strip():
            raise ValueError("Thao tác layerRename yêu cầu layerName")
        if self.kind == "layerReorder" and self.layerOrder is None:
            raise ValueError("Thao tác layerReorder yêu cầu layerOrder")
        return self


# ── OpSpan ──────────────────────────────────────────────
class OpSpan(BaseModel):
    """
    Dải operator [start, end) trong content stream phẳng (đã coalesce) tương ứng
    với một "object vẽ" do Object_Mapper phân đoạn (Yêu cầu 1.4).

    - `ctm`  : CTM tích lũy tại thời điểm vẽ object (6 phần tử).
    - `bbox` : BBox tính từ CTM, dùng đối khớp với BBox PDFium (tolerance ≤ 1.0pt).
    - `resource_name`: tên tài nguyên (vd. tên XObject ảnh) nếu áp dụng.
    """

    start: int = Field(ge=0)
    end: int = Field(ge=0)
    kind: str
    ctm: list[float] = Field(description="CTM affine 6 phần tử [a, b, c, d, e, f]")
    bbox: list[float] = Field(description="[x0, y0, x1, y1] theo point")
    resource_name: str | None = None
    ocgIds: list[int] = Field(default_factory=list)

    @field_validator("ctm")
    @classmethod
    def _check_ctm_len(cls, v: list[float]) -> list[float]:
        if len(v) != 6:
            raise ValueError("ctm phải gồm đúng 6 phần tử [a, b, c, d, e, f]")
        return v

    @field_validator("bbox")
    @classmethod
    def _check_bbox_len(cls, v: list[float]) -> list[float]:
        if len(v) != 4:
            raise ValueError("bbox phải gồm đúng 4 giá trị [x0, y0, x1, y1]")
        return normalize_bbox(v)

    @model_validator(mode="after")
    def _check_span_order(self) -> "OpSpan":
        if self.end < self.start:
            raise ValueError("OpSpan không hợp lệ: end phải >= start")
        return self


# ── Response contract (KIENTRUC audit 2026-07-29 §A.2, lô 13) ────────────────
# Cùng nguyên tắc với `schemas/imposition.py`: model MÔ TẢ endpoint đang chạy, field lỏng
# để `Optional`/`Any`, và ghi rõ ai đọc field đó ở phía desktop.


class PageObjectsPayload(BaseModel):
    """`GET /api/edit/objects/{fid}/{page}` — danh sách object của một trang.

    Desktop đọc (`components/workspace/LivePageFrame.tsx`): `objects` để vẽ khung chọn,
    `pageBox` để quy đổi toạ độ, `hiddenObjectIds` để biết object nào đang bị ẩn.

    `objects` để `Any` vì phần tử là `ObjMeta.model_dump()` — đã có model riêng, validate
    hai lần chỉ thêm chi phí. `pageBox` là metadata best-effort (có thể `None`).
    """

    objects: list[Any] = Field(default_factory=list)
    pageBox: Optional[Any] = Field(
        default=None, description="Page_Box của trang (CropBox/MediaBox) để quy đổi toạ độ"
    )
    hiddenObjectIds: list[Any] = Field(
        default_factory=list, description="Id object đang ẩn trong phiên sửa (best-effort)"
    )


class TextObjectPropsResponse(BaseModel):
    """`GET /api/edit/text-props/{fid}/{page}/{index}` — nội dung/màu/font của MỘT text-object.

    Nguồn: `core/geometry_reader.get_text_object_props`, lấy LAZY khi người dùng bấm vào
    chữ. Cả ba field có thể `None` khi object không phải text hoặc font không đọc được —
    đó là kết quả hợp lệ, không phải lỗi.
    """

    content: Optional[str] = None
    color: Optional[list[int]] = Field(default=None, description="RGB 0..255")
    fontName: Optional[str] = Field(default=None, description="BaseFont, đã bỏ tiền tố subset")
    fontSize: Optional[float] = Field(default=None, description="Cỡ chữ gốc (pt)")


class OcgVisibilityResponse(BaseModel):
    """`POST /api/edit/ocg/visibility` — đổi hiển thị OCG layer trên Live_Document.

    Route trả `{"success": True, **result}` với `result` từ
    `edit_session.set_ocg_visibility` (`layer_id`, `visible`, `success`).
    """

    success: bool
    layer_id: Optional[int] = None
    visible: Optional[bool] = None
    changed: Optional[bool] = None


class OcgActionResponse(BaseModel):
    """`POST /api/edit/session/ocg-action` và `/session/ocg-visibility` (đường tương thích).

    `edit_session.apply_ocg_action` trả nhiều hình dạng tuỳ action (đổi tên / khoá / ẩn /
    xoá / gộp), nên model là hợp của các nhánh. `removed_instructions = -1` nghĩa là "đã
    xoá cả trang" chứ không phải lỗi.
    """

    success: bool
    action: Optional[str] = None
    layer_id: Optional[int] = None
    changed: Optional[bool] = None
    visible: Optional[bool] = None
    removed_instructions: Optional[int] = None


class DiscardWorkingFileResponse(BaseModel):
    """`DELETE /api/edit/working/{fid}` — bỏ một Working_File của phiên sửa.

    `deleted=False` KHÔNG phải lỗi: `reason` cho biết vì sao (không tìm thấy, không phải
    working file, hoặc lỗi khi xoá). Cố tình không raise để UI dọn dẹp được mà không phải
    bắt exception.
    """

    deleted: bool
    reason: Optional[str] = Field(
        default=None, description="not_found | not_working_file | error"
    )


class SessionCloseResponse(BaseModel):
    """`DELETE /api/edit/session/{sid}` — đóng Edit_Session.

    `closed=False` nghĩa là phiên không tồn tại (đã hết TTL hoặc đóng rồi) — an toàn khi
    gọi lại nhiều lần.
    """

    closed: bool


# ── Model gom từ app/api/routes/edit.py (audit 2026-07-29 §A.2 lô 13) ──

class EditRequest(BaseModel):
    """
    Bọc một `EditOp` cùng `fid` (id file đã upload) để định tuyến thao tác sửa.

    Cùng một schema dùng cho mọi endpoint POST (/delete, /transform, /text, /add);
    mỗi endpoint kiểm tra `op.kind` có thuộc tập hợp lệ của nó hay không.
    """

    fid: str = Field(description="ID file PDF đã upload (UploadedFile.id)")
    op: EditOp

class PreviewHideReq(BaseModel):
    """
    Yêu cầu render preview TRANG SAU KHI ẨN (xóa hình thật) một tập object.

    Dùng cho tính năng "Ẩn đối tượng" (tắt mắt) ở chế độ Edit: backend áp một thao
    tác delete IN-MEMORY (pikepdf) rồi render trang read-only → FE đắp ảnh này làm
    overlay để hình thật của object biến mất (không chỉ ẩn ô chọn). KHÔNG ghi file,
    KHÔNG mutate file gốc.
    """

    fid: str = Field(description="ID file PDF đã upload (UploadedFile.id)")
    page: int = Field(ge=0, description="Chỉ số trang 0-based cần render")
    targetIds: list[str] = Field(
        default_factory=list, description="Danh sách id object cần ẩn (xóa khỏi ảnh preview)"
    )

class EditResponse(BaseModel):
    """Kết quả một thao tác edit + tham chiếu Working_File mới."""

    success: bool
    output_filename: str
    output_url: str = Field(description="URL tĩnh tương đối phục vụ qua /results")
    output_path: str = Field(description="Đường dẫn tuyệt đối Working_File mới")
    output_fid: str = Field(
        description=(
            "ID bản ghi UploadedFile trỏ tới Working_File mới — dùng làm fid cho "
            "thao tác edit kế tiếp (thao tác trực tiếp trên kết quả mới, KHÔNG cần "
            "tải-về-rồi-upload-lại trên desktop)."
        )
    )
    artifact_lease: str = Field(
        description=(
            "Token lease do backend phát để tab claim/heartbeat Working_File; "
            "client không được gửi đường dẫn artifact."
        )
    )
    warning: str | None = Field(
        default=None,
        description="Cảnh báo suy giảm chất lượng cần hiển thị rõ cho người vận hành",
    )
    result: dict | list = Field(default_factory=dict, description="Tóm tắt op_result")

class PreviewResponse(BaseModel):
    """
    Ảnh preview (PNG base64) của một trang SAU khi áp thao tác EditOp.

    Ảnh được render READ-ONLY bằng PDFium từ BYTES mà pikepdf vừa ghi in-memory
    (KHÔNG lưu file vĩnh viễn, KHÔNG dùng PDFium để ghi — Yêu cầu 12.2). Hình học
    của ảnh khớp với kết quả lưu pikepdf (Yêu cầu 12.1, 12.3).
    """

    success: bool
    image: str = Field(description="Data URI 'data:image/png;base64,...'")
    width: int = Field(description="Chiều rộng ảnh render (px)")
    height: int = Field(description="Chiều cao ảnh render (px)")
    page: int = Field(description="Chỉ số trang 0-based đã render")

class SessionOpenReq(BaseModel):
    """Mở một Edit_Session từ `fid` (file đã upload)."""

    fid: str = Field(description="ID file PDF đã upload (UploadedFile.id)")

class SessionOpenResp(BaseModel):
    """Kết quả mở phiên: Session_Id duy nhất + số trang của Live_Document."""

    session_id: str = Field(description="Session_Id duy nhất do backend cấp")
    page_count: int = Field(description="Số trang của Live_Document")

class SessionOpReq(BaseModel):
    """
    Áp một `EditOp` in-memory lên Live_Document của phiên + render clip.

    `render_scale` (px/point ≈ zoom×dpr) và `clip_pad_pt` (lề an toàn quanh
    Clip_Region, point) điều khiển Incremental_Render.
    """

    session_id: str = Field(description="Session_Id của Edit_Session đang sống")
    op: EditOp
    render_scale: float = Field(default=2.0, description="px/point để render preview (≈ zoom×dpr)")
    clip_pad_pt: float = Field(default=8.0, description="lề an toàn quanh clip (point)")

class SessionRefReq(BaseModel):
    """
    Tham chiếu phiên cho thao tác KHÔNG kèm EditOp (undo/redo) — vẫn cần tham số
    render để dựng Preview_Image của vùng bị thay đổi sau khi hoàn tác/làm lại.
    """

    session_id: str = Field(description="Session_Id của Edit_Session đang sống")
    render_scale: float = Field(default=2.0, description="px/point để render preview (≈ zoom×dpr)")
    clip_pad_pt: float = Field(default=8.0, description="lề an toàn quanh clip (point)")

class SessionOcgActionReq(BaseModel):
    session_id: str
    action: str
    layer_id: int | None = None
    name: str | None = None
    locked: bool | None = None
    new_order: list[int] | None = None

class SessionOcgVisibilityReq(BaseModel):
    session_id: str = Field(description="Session_Id của Edit_Session đang sống")
    layer_id: int
    visible: bool

class SessionCommitReq(BaseModel):
    """Yêu cầu Commit Live_Document hiện tại ra một Working_File mới."""

    session_id: str = Field(description="Session_Id của Edit_Session đang sống")

class SessionOpResp(BaseModel):
    """
    Kết quả một thao tác phiên (op / undo / redo): Preview_Image (vùng clip hoặc
    toàn trang) + tọa độ Clip_Region + opResult (gồm BBox MỚI để FE cập nhật overlay
    tại chỗ) + trạng thái Undo/Redo.
    """

    success: bool
    preview: str | None = Field(
        default=None,
        description="data:image/png;base64,... (vùng clip hoặc toàn trang); None nếu no-op",
    )
    clipRect: list[float] | None = Field(
        default=None,
        description="[x0,y0,x1,y1] POINT gốc Page_Box-relative; None = toàn trang/no-op",
    )
    full: bool = Field(default=False, description="True nếu render toàn trang (fallback)")
    page: int | None = Field(default=None, description="Chỉ số trang 0-based bị tác động")
    opResult: dict = Field(default_factory=dict, description="Gồm BBox MỚI để FE cập nhật overlay")
    canUndo: bool = Field(default=False, description="Còn op để hoàn tác?")
    canRedo: bool = Field(default=False, description="Còn op để làm lại?")

class OcgVisibilityRequest(BaseModel):
    fid: str
    layer_id: int
    visible: bool
