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
from typing import Literal

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
    bbox: list[float]

    @field_validator("bbox")
    @classmethod
    def _check_bbox(cls, v: list[float]) -> list[float]:
        if len(v) != 4:
            raise ValueError("bbox phải gồm đúng 4 giá trị [x0, y0, x1, y1]")
        return normalize_bbox(v)


EditKind = Literal["delete", "move", "resize", "rotate", "editText", "add"]


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

    # Tham số theo từng kind (đều optional ở mức field; ràng buộc bằng model_validator).
    delta: MoveDelta | None = None
    scale: ResizeScale | None = None
    rotateDeg: float | None = None
    text: TextPayload | None = None
    image: ImagePayload | None = None

    @model_validator(mode="after")
    def _check_required_params(self) -> "EditOp":
        # delete/move/resize/rotate/editText cần targetIds; add thì không bắt buộc.
        if self.kind != "add" and not self.targetIds:
            raise ValueError(f"Thao tác '{self.kind}' yêu cầu ít nhất một targetIds")

        if self.kind == "move" and self.delta is None:
            raise ValueError("Thao tác 'move' yêu cầu trường 'delta' (dx, dy)")
        if self.kind == "resize" and self.scale is None:
            raise ValueError("Thao tác 'resize' yêu cầu trường 'scale' (sx, sy, anchor)")
        if self.kind == "rotate" and self.rotateDeg is None:
            raise ValueError("Thao tác 'rotate' yêu cầu trường 'rotateDeg'")
        if self.kind == "editText" and self.text is None:
            raise ValueError("Thao tác 'editText' yêu cầu trường 'text'")
        if self.kind == "add" and self.text is None and self.image is None:
            raise ValueError("Thao tác 'add' yêu cầu 'text' hoặc 'image'")
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
