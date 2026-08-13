"""
die_detection.py — Lớp 1 (Detection / SSOT) cho nhận diện hình khuôn bế.

Phase 0 (module này, phần đầu): định nghĩa contract dữ liệu chuẩn hoá
`DetectedShape` cùng cấu hình, trạng thái, JSON schema, và mapping tương thích
ngược với endpoint `/detect-shape` cũ.

Phase 1 (bổ sung sau): hàm `detect_die_shapes()` — nguồn sự thật duy nhất gom
toàn bộ heuristic chọn-path + phân loại + chuẩn hoá props về TRIM.

Spec: .kiro/specs/die-shape-detection-ssot
Requirements: 1.x, 4.6, 5.5, 7.5, 11.5, 14.1, 14.2, 14.3
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Optional

from app.core.imposition_page_box import effective_imposition_box
from app.workers.shape_types import ShapeType, coerce_shape_type

logger = logging.getLogger(__name__)

# Giới hạn kích thước thành phẩm hợp lý (points). 14400pt = 200 inch (R1.6).
MAX_TRIM_PT = 14400.0

# Nguồn nhận diện hợp lệ cho trường `source` của DetectedShape.
VALID_SOURCES: frozenset[str] = frozenset(
    {"vector", "xobject", "separation", "raster_fallback", "custom"}
)


# =========================================================================
#  Cấu hình & trạng thái (R1.2, R3.x, R5.3, R7.5, R11.5)
# =========================================================================

@dataclass(frozen=True)
class DetectionConfig:
    """Cấu hình nhận diện đường khuôn (Phase 0)."""
    # Tên kênh Spot/Separation coi là đường khuôn — khớp full-name, case-insensitive (R3.6, R3.7).
    # Mở rộng tên phổ biến prepress (AI/Corel/PDF tem bế VN + quốc tế).
    die_channel_names: tuple[str, ...] = (
        "CutContour", "Cut Contour", "CutLine", "Cut Line", "Cut",
        "Dieline", "Die Line", "DieLine", "Die", "DieCut", "Die Cut",
        "Thru-cut", "Thru Cut", "Thrucut",
        "Kiss", "Kiss Cut", "KissCut",
        "Crease", "Perforate", "Perf",
        "Stanc", "Decoupe",
    )
    # Màu đường bế nhận diện kèm (ngoài tên kênh): bắt ca đường bế tô màu thuần,
    # KHÔNG có kênh spot riêng. Mỗi phần tử là tuple màu:
    #   4 số = CMYK, 3 số = RGB, 1 số = DeviceGray.
    # Quy ước prepress / thợ bế VN + file AI/Corel: magenta, đen, xanh (cyan/blue), vàng.
    die_colors: tuple[tuple[float, ...], ...] = (
        # Magenta
        (0.0, 1.0, 0.0, 0.0),  # CMYK M100
        (1.0, 0.0, 1.0),       # RGB magenta
        # Đen. DeviceGray đi qua 'G'/'g' (và cs+scn) đã được parser ghi thành
        # (g, g, g) nên khớp mục "RGB black" bên dưới — KHÔNG thêm mục 1 thành phần.
        # [DIE-TINT 2026-07-28] Màu 1 thành phần giờ chỉ còn một nghĩa: TINT của kênh
        # Separation/DeviceN. Tint không mang thông tin sắc màu (tint 0 = không mực),
        # nên không có màu bế nào được khai báo dạng 1 thành phần.
        (0.0, 0.0, 0.0, 1.0),  # CMYK K100
        (0.0, 0.0, 0.0),       # RGB black
        # Xanh dương (process cyan / RGB blue)
        (1.0, 0.0, 0.0, 0.0),  # CMYK C100
        (0.0, 0.0, 1.0),       # RGB blue
        (0.0, 1.0, 1.0),       # RGB cyan
        # Vàng
        (0.0, 0.0, 1.0, 0.0),  # CMYK Y100
        (1.0, 1.0, 0.0),       # RGB yellow
    )
    die_color_tol: float = 0.06       # dung sai khớp màu (0..1)
    max_xobject_depth: int = 10        # giới hạn đệ quy Form XObject (R3.3, R3.4)
    batch_size: int = 50               # ngưỡng xử lý theo lô, hợp lệ 10..500 (R5.3)
    raster_fallback_dpi: int = 144     # DPI cho mask fallback (R3.8)
    parity_tol_mm: float = 0.1         # dung sai parity mặc định (R7.3, R7.5)
    parity_tol_deg: float = 0.01       # dung sai góc xoay (R7.3)
    classifier_tol_mm: float = 0.01    # dung sai đối chiếu Rust==Python (R11.5)

    def __post_init__(self):
        # Ràng buộc batch_size trong [10, 500] (R5.3) — clamp + cảnh báo thay vì fail.
        bs = self.batch_size
        if bs < 10 or bs > 500:
            clamped = min(500, max(10, bs))
            logger.warning(
                "[DETECT] batch_size=%s ngoài [10,500] → dùng %s.", bs, clamped
            )
            object.__setattr__(self, "batch_size", clamped)


@dataclass(frozen=True)
class PageDetectionStatus:
    """Trạng thái nhận diện 1 trang để trả về frontend (R4.6, R5.5)."""
    page: int                          # 0-based
    ok: bool
    source: str                        # thuộc VALID_SOURCES
    error: Optional[str] = None


# =========================================================================
#  Contract DetectedShape (R1)
# =========================================================================

@dataclass(frozen=True)
class Trim:
    """Kích thước thành phẩm (points). 0 < w,h <= MAX_TRIM_PT (R1.6)."""
    w: float
    h: float


@dataclass(frozen=True)
class DetectedShape:
    """Hợp đồng dữ liệu chuẩn hoá — nguồn sự thật duy nhất cho 1 trang (R1.1)."""
    page: int                          # 0-based
    type: ShapeType                    # đúng 1 giá trị enum thống nhất (R1.3)
    props: dict[str, Any]              # đã chuẩn hoá về TRIM, round 3 số (R1.2)
    trim: Trim
    poly: tuple[tuple[float, float], ...]
    source: str
    confidence: float                  # [0.0, 1.0] (R1.5)

    def __post_init__(self):
        # Đủ 7 trường, không null (R1.1)
        if self.page is None or self.page < 0:
            raise ValueError(f"DetectedShape.page không hợp lệ: {self.page!r}")
        if not isinstance(self.type, ShapeType):
            raise ValueError(f"DetectedShape.type phải là ShapeType: {self.type!r}")
        if self.props is None or not isinstance(self.props, dict):
            raise ValueError("DetectedShape.props phải là dict không null")
        if not isinstance(self.trim, Trim):
            raise ValueError("DetectedShape.trim phải là Trim")
        if self.poly is None:
            raise ValueError("DetectedShape.poly không được null")
        # confidence ∈ [0.0, 1.0] (R1.5)
        if not (0.0 <= float(self.confidence) <= 1.0):
            raise ValueError(
                f"DetectedShape.confidence ngoài [0.0,1.0]: {self.confidence!r}"
            )
        # 0 < trim.w,h <= MAX_TRIM_PT (R1.6)
        if not (0.0 < self.trim.w <= MAX_TRIM_PT and 0.0 < self.trim.h <= MAX_TRIM_PT):
            raise ValueError(
                f"DetectedShape.trim ngoài (0,{MAX_TRIM_PT}]: "
                f"w={self.trim.w} h={self.trim.h}"
            )
        # source thuộc tập hợp lệ
        if self.source not in VALID_SOURCES:
            raise ValueError(
                f"DetectedShape.source không hợp lệ: {self.source!r} "
                f"(phải thuộc {sorted(VALID_SOURCES)})"
            )


def make_custom_shape(
    page: int, trim_w: float, trim_h: float,
    poly: tuple[tuple[float, float], ...] = (),
    source: str = "custom",
) -> DetectedShape:
    """Tạo DetectedShape CUSTOM an toàn cho trang không phân loại được / lỗi (R1.4, R4.2)."""
    safe_w = trim_w if (trim_w and 0.0 < trim_w <= MAX_TRIM_PT) else 1.0
    safe_h = trim_h if (trim_h and 0.0 < trim_h <= MAX_TRIM_PT) else 1.0
    return DetectedShape(
        page=page,
        type=ShapeType.CUSTOM,
        props={},
        trim=Trim(round(float(safe_w), 3), round(float(safe_h), 3)),
        poly=tuple(poly),
        source=source,
        confidence=0.0,
    )


@dataclass(frozen=True)
class DetectionResult:
    """Kết quả nhận diện toàn file (R4.4, R5.5)."""
    shapes: list[DetectedShape]
    statuses: list[PageDetectionStatus]
    total_pages: int
    success_pages: int
    failed_pages: tuple[int, ...] = field(default_factory=tuple)  # 1-based (R5.5)


# =========================================================================
#  JSON Schema + serialize/deserialize (R1, qua boundary process/HTTP)
# =========================================================================

DETECTED_SHAPE_JSON_SCHEMA: dict[str, Any] = {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "title": "DetectedShape",
    "type": "object",
    "required": ["page", "type", "props", "trim", "poly", "source", "confidence"],
    "additionalProperties": False,
    "properties": {
        "page": {"type": "integer", "minimum": 0},
        "type": {"type": "string", "enum": [m.name for m in ShapeType]},
        "props": {"type": "object"},
        "trim": {
            "type": "object",
            "required": ["w", "h"],
            "properties": {
                "w": {"type": "number", "exclusiveMinimum": 0, "maximum": MAX_TRIM_PT},
                "h": {"type": "number", "exclusiveMinimum": 0, "maximum": MAX_TRIM_PT},
            },
        },
        "poly": {
            "type": "array",
            "items": {"type": "array", "items": {"type": "number"},
                      "minItems": 2, "maxItems": 2},
        },
        "source": {"type": "string", "enum": sorted(VALID_SOURCES)},
        "confidence": {"type": "number", "minimum": 0.0, "maximum": 1.0},
    },
}


def shape_to_dict(shape: DetectedShape) -> dict[str, Any]:
    """Serialize DetectedShape → dict JSON-an-toàn."""
    return {
        "page": shape.page,
        "type": shape.type.name,
        "props": shape.props,
        "trim": {"w": shape.trim.w, "h": shape.trim.h},
        "poly": [[float(x), float(y)] for (x, y) in shape.poly],
        "source": shape.source,
        "confidence": float(shape.confidence),
    }


def shape_from_dict(data: dict[str, Any]) -> DetectedShape:
    """Deserialize dict → DetectedShape (validate qua __post_init__)."""
    trim = data["trim"]
    return DetectedShape(
        page=int(data["page"]),
        type=coerce_shape_type(data["type"]),
        props=dict(data.get("props") or {}),
        trim=Trim(float(trim["w"]), float(trim["h"])),
        poly=tuple((float(p[0]), float(p[1])) for p in (data.get("poly") or [])),
        source=str(data["source"]),
        confidence=float(data["confidence"]),
    )


# =========================================================================
#  Mapping tương thích ngược với /detect-shape cũ (R14)
# =========================================================================

def to_legacy_response(result: DetectionResult) -> dict[str, Any]:
    """DetectionResult → response cũ (shapes/dimensions/shapeParams) + perPage (R14.1, R4.6)."""
    return {
        "shapes": [s.type.name for s in result.shapes],
        "dimensions": [{"w": s.trim.w, "h": s.trim.h} for s in result.shapes],
        "shapeParams": [s.props for s in result.shapes],
        "perPage": [
            {"page": st.page, "ok": st.ok, "source": st.source, "error": st.error}
            for st in result.statuses
        ],
        "totalPages": result.total_pages,
        "successPages": result.success_pages,
        "failedPages": list(result.failed_pages),
        # Luôn True khi hoàn tất; trang lỗi → CUSTOM, KHÔNG fail toàn cục (R4.7).
        "success": True,
    }


def _shape_has_die_geometry(shape: DetectedShape) -> bool:
    """Trang có khuôn nhận diện được (vector/spot), không phải CUSTOM trống."""
    if shape is None or shape.type is ShapeType.CUSTOM:
        return False
    return shape.source in ("vector", "separation", "xobject", "raster_fallback")


def apply_master_die_inheritance(result: DetectionResult) -> DetectionResult:
    """Tem không có đường bế kế thừa hình học từ ĐÚNG 1 trang master (homogeneous UI).

    Product: file 1 khuôn + nhiều artwork — trang 0 có CutContour → Tròn/Elip; trang
    sau không path bế vẫn phải hiển thị cùng loại + trim master (không 'Đặc biệt').
    Khớp quy tắc sticker_homogeneous.detect_homogeneous (đúng 1 master, ≥2 trang).

    Không đụng khi 0 hoặc ≥2 trang có khuôn riêng.
    """
    shapes = list(result.shapes or [])
    statuses = list(result.statuses or [])
    n = len(shapes)
    if n < 2 or len(statuses) != n:
        return result

    master_idxs = [i for i, s in enumerate(shapes) if _shape_has_die_geometry(s)]
    if len(master_idxs) != 1:
        return result

    mi = master_idxs[0]
    master = shapes[mi]
    inherited = 0
    new_shapes: list[DetectedShape] = []
    new_statuses: list[PageDetectionStatus] = []

    for i, s in enumerate(shapes):
        st = statuses[i]
        if i == mi or _shape_has_die_geometry(s):
            new_shapes.append(s)
            new_statuses.append(st)
            continue
        # Trang không khuôn / CUSTOM → copy type, props, poly, trim từ master.
        props = dict(master.props or {})
        props["inheritedFromPage"] = int(master.page)
        new_shapes.append(
            DetectedShape(
                page=s.page,
                type=master.type,
                props=props,
                trim=Trim(master.trim.w, master.trim.h),
                poly=tuple(master.poly or ()),
                # Giữ nguồn 'vector' để raster fallback không quét lại 20+ trang.
                source="vector",
                confidence=max(0.5, min(0.95, float(master.confidence or 0.8) * 0.9)),
            )
        )
        new_statuses.append(
            PageDetectionStatus(
                page=s.page,
                ok=True,
                source="vector",
                error=None,
            )
        )
        inherited += 1

    if inherited == 0:
        return result

    logger.info(
        "[DETECT] master die inheritance: master_page=%s type=%s → %d content page(s)",
        master.page, master.type.name, inherited,
    )
    failed = tuple(
        st.page + 1 for st in new_statuses if not st.ok
    )  # 1-based if any
    return DetectionResult(
        shapes=new_shapes,
        statuses=new_statuses,
        total_pages=result.total_pages,
        success_pages=sum(1 for st in new_statuses if st.ok),
        failed_pages=failed,
    )


class LegacyMappingError(ValueError):
    """Lỗi ánh xạ dữ liệu legacy từ frontend → DetectedShape (R14.3)."""


def from_legacy_settings(settings: dict[str, Any]) -> dict[int, DetectedShape]:
    """Ánh xạ detectedShapesByPage/Params/Dimensions (frontend) → {page: DetectedShape} (R14.2).

    Không loại bỏ trang nào. Dữ liệu không ánh xạ được → LegacyMappingError nêu
    rõ trường gây lỗi (R14.3); caller giữ nguyên trạng thái job.
    """
    shapes_by_page = settings.get("detectedShapesByPage") or {}
    params_by_page = settings.get("detectedShapeParamsByPage") or {}
    dims_by_page = settings.get("detectedDimensionsByPage") or {}

    out: dict[int, DetectedShape] = {}
    for raw_key, raw_type in shapes_by_page.items():
        try:
            page = int(raw_key)
        except (TypeError, ValueError) as exc:
            raise LegacyMappingError(
                f"detectedShapesByPage có khoá trang không hợp lệ: {raw_key!r}"
            ) from exc
        try:
            shp_type = coerce_shape_type(raw_type)
        except ValueError as exc:
            raise LegacyMappingError(
                f"detectedShapesByPage[{raw_key}] giá trị không hợp lệ: {raw_type!r}"
            ) from exc

        dim = dims_by_page.get(raw_key) or dims_by_page.get(page) or {}
        try:
            w = float(dim.get("w", 1.0)) if isinstance(dim, dict) else 1.0
            h = float(dim.get("h", 1.0)) if isinstance(dim, dict) else 1.0
        except (TypeError, ValueError) as exc:
            raise LegacyMappingError(
                f"detectedDimensionsByPage[{raw_key}] không hợp lệ: {dim!r}"
            ) from exc
        if not (0.0 < w <= MAX_TRIM_PT):
            w = 1.0
        if not (0.0 < h <= MAX_TRIM_PT):
            h = 1.0

        props = params_by_page.get(raw_key) or params_by_page.get(page) or {}
        if not isinstance(props, dict):
            raise LegacyMappingError(
                f"detectedShapeParamsByPage[{raw_key}] phải là object: {props!r}"
            )

        out[page] = DetectedShape(
            page=page,
            type=shp_type,
            props=dict(props),
            trim=Trim(round(w, 3), round(h, 3)),
            poly=(),
            source="vector" if shp_type is not ShapeType.CUSTOM else "custom",
            confidence=1.0 if shp_type is not ShapeType.CUSTOM else 0.0,
        )
    return out


# =========================================================================
#  Lớp 1 — detect_die_shapes (SSOT) — Phase 1
#  Gom toàn bộ heuristic chọn-path về MỘT nơi (R3.1), phân loại đúng một lần,
#  chuẩn hoá props/poly về TRIM, cô lập lỗi theo trang, phủ đủ trang.
# =========================================================================

def _page_dims_pt(page) -> tuple[float, float]:
    """Kích thước trang logic (points), tính cả UserUnit.

    Bình tem bế phải đo vùng trang người dùng nhìn thấy. Một số PDF đặt artwork
    trên MediaBox lớn nhưng dùng CropBox làm trang logic; lấy MediaBox ở nhánh
    CUSTOM sẽ làm kích thước nhận diện phình lên đúng bằng canvas nền.
    """
    try:
        # [DIE-BOX FIX 2026-08-12] Dùng cùng policy hộp trang với imposition:
        # CropBox chỉ thắng khi thực sự là trang logic trên canvas lớn; bleed
        # nhỏ thông thường vẫn giữ MediaBox.
        box = effective_imposition_box(page)
        w, h = float(box.width), float(box.height)
    except Exception:
        w, h = float(page.rect.width), float(page.rect.height)
    try:
        if "/UserUnit" in page._page:
            uu = float(page._page["/UserUnit"])
            w *= uu
            h *= uu
    except Exception:
        pass
    return w, h


def _norm_channel_token(name: str) -> str:
    """Chuẩn hoá tên kênh để khớp biến thể: 'Cut Contour' / 'Cut-Contour' / 'CutContour'."""
    return "".join(ch for ch in str(name).strip().lower() if ch.isalnum())


def _match_die_channel(spot_name, names_lower: frozenset) -> bool:
    """Khớp tên kênh khuôn: full-name, case-insensitive, KHÔNG khớp chuỗi con (R3.7).

    spot_name có thể là DeviceN nối '+' (vd 'Cut+Crease') → tách kiểm tra từng kênh.
    Độc lập tên trùng Cyan/Magenta/Yellow/Black (R3.9) vì so khớp theo danh sách
    cấu hình, không loại trừ theo CMYK.

    So khớp cả dạng đã bỏ khoảng/gạch (Cut Contour ≡ CutContour) để bắt tên kênh
    từ AI/Corel xuất khác nhau.
    """
    if not spot_name or not names_lower:
        return False
    names_norm = frozenset(_norm_channel_token(n) for n in names_lower if n)
    for part in str(spot_name).split("+"):
        raw = part.strip().lower()
        if not raw:
            continue
        if raw in names_lower:
            return True
        if _norm_channel_token(raw) in names_norm:
            return True
    return False


def _is_strokish_path(path) -> bool:
    """Path có thành phần nét (stroke hoặc stroke+fill). Legacy — dùng nội bộ hạn chế."""
    ptype = path.get("type")
    fill = path.get("fill")
    color = path.get("color")
    return ptype in ("s", "sf") or (fill is None and color is not None)


def _has_fill_paint(path) -> bool:
    """Path có tô (fill) — mảng màu / vùng đặc, không phải đường bế nét thuần."""
    fill = path.get("fill")
    if fill is None:
        return False
    # Một số parser gán fill=() hoặc fill=False — coi như không tô.
    if fill is False:
        return False
    if isinstance(fill, (list, tuple)) and len(fill) == 0:
        return False
    return True


def _is_stroke_only_path(path) -> bool:
    """Đường bế hợp lệ: CHỈ nét (stroke), KHÔNG có fill/tô màu.

    - type 'f' / fill-only → False (mảng màu artwork)
    - type 'sf' (stroke+fill) → False (vùng tô + nét mép)
    - type 's' + fill paint → False
    - type 's' + fill None → True
    """
    if path is None:
        return False
    ptype = path.get("type")
    if ptype in ("f", "f*", "sf", "B", "b", "B*", "b*"):
        return False
    if _has_fill_paint(path):
        return False
    # Nét thuần: type stroke, hoặc có stroke color mà không fill
    if ptype == "s":
        return True
    color = path.get("color")
    if color is not None and not _has_fill_paint(path) and ptype not in ("f", "sf"):
        return True
    return False


# Tên colorspace process/không-phải-spot — KHÔNG coi là kênh bế dành riêng.
_PROCESS_CS_NAMES: frozenset[str] = frozenset({
    "cyan", "magenta", "yellow", "black", "all", "none",
    "devicecmyk", "devicergb", "devicegray", "device-n", "devicen",
    "red", "green", "blue", "gray", "grey", "white",
})


# [DIE-SPOT-DENY 2026-07-28] Kênh spot của LỚP GIA CÔNG — không bao giờ là đường bế.
# Lý do có mục này: trước đây mọi kênh Separation không-phải-process đều được +400
# ("spot nào cũng có thể là bế"), nên lớp mực trắng lót / phủ UV / ép kim bị nhận
# thành đường cắt. Khách báo trực tiếp ca "màu spot là màu trắng để in" bị nhận nhầm.
# Khớp theo TỪ trong tên (nên bắt được 'White Ink', 'Opaque White', 'Spot UV') chứ
# không phải chuỗi con, để tên spot thường như 'Gold-Pantone' không bị loại oan.
_NON_DIE_SPOT_WORDS: frozenset[str] = frozenset({
    # Mực trắng (lót hoặc in phủ)
    "white", "whites", "blanco", "blanc", "weiss", "wit", "opaque",
    "underprint", "underbase", "trắng",
    # Phủ / vecni / UV định vị
    "varnish", "vernis", "verni", "lacquer", "gloss", "matt", "matte",
    "uv", "coating", "aqueous",
    # Ép kim / nhũ
    "foil", "metallic", "silver", "nhũ",
    # Dập nổi / dập chìm
    "emboss", "embossing", "deboss", "debossing",
    # Lớp kỹ thuật khác
    "primer", "adhesive", "glue", "keo", "braille", "texture",
})

# Tên viết liền (không tách được thành từ) của cùng nhóm lớp gia công.
_NON_DIE_SPOT_TOKENS: frozenset[str] = frozenset({
    "whiteink", "inkwhite", "opaquewhite", "spotwhite", "whitebase",
    "underprintwhite", "muctrang", "mautrang",
    "spotuv", "uvspot", "uvvarnish", "spotvarnish", "glossvarnish",
    "mattvarnish", "mattevarnish", "phuuv", "uvdinhvi", "canbong", "canmo",
    "hotfoil", "coldfoil", "hotstamp", "coldstamp", "epnhu", "epkim", "epkimloai",
    "dapnoi", "dapchim",
})

# Từ khoá ngành in chỉ đường bế/cấn. Tên spot chứa các từ này KHÔNG bị deny-list
# loại, kể cả khi có kèm từ gia công (vd 'Matte Cut') — tránh mất khuôn thật.
_DIE_WORD_HINTS: frozenset[str] = frozenset({
    "cut", "cutting", "cutcontour", "contour", "die", "dieline", "diecut",
    "crease", "fold", "perf", "perforate", "perforation", "thru", "thrucut",
    "kiss", "kisscut", "stanc", "decoupe", "bế", "be", "dao", "khuôn",
})


def _spot_words(spot_part: str) -> frozenset[str]:
    """Tách tên kênh thành các TỪ (cắt ở mọi ký tự không phải chữ/số), lowercase.

    'White Ink' → {'white','ink'}; 'C=0 M=100 Y=0 K=0' → {'c','0','m','100','y','k'}.
    """
    words: set[str] = set()
    cur: list[str] = []
    for ch in str(spot_part).lower():
        if ch.isalnum():
            cur.append(ch)
        elif cur:
            words.add("".join(cur))
            cur = []
    if cur:
        words.add("".join(cur))
    return frozenset(words)


def _is_non_die_spot(spot_name) -> bool:
    """Tên kênh thuộc LỚP GIA CÔNG (trắng / phủ UV / ép kim / dập nổi …) → không phải bế.

    Kiểm theo từng kênh của DeviceN (nối '+'). Kênh nào có từ khoá bế thì bỏ qua
    deny-list cho kênh đó. Chỉ cần MỘT kênh là lớp gia công thuần → coi cả path là
    lớp gia công (vd 'White+Varnish').
    """
    if not spot_name:
        return False
    for part in str(spot_name).split("+"):
        part = part.strip()
        if not part:
            continue
        words = _spot_words(part)
        if words & _DIE_WORD_HINTS:
            continue
        if words & _NON_DIE_SPOT_WORDS:
            return True
        if _norm_channel_token(part) in _NON_DIE_SPOT_TOKENS:
            return True
    return False


def _is_genuine_spot(spot_name) -> bool:
    """spot_name là kênh Separation/DeviceN DÀNH RIÊNG (không phải tên process).

    Đường bế trong prepress gần như luôn nằm trên 1 kênh spot riêng. Tên như
    'C=0 M=100 Y=0 K=0' (Illustrator đặt theo công thức CMYK) VẪN là spot → coi
    là ứng viên đường bế.
    """
    if not spot_name:
        return False
    for part in str(spot_name).split("+"):
        if part.strip().lower() not in _PROCESS_CS_NAMES:
            return True
    return False


def _color_matches_die(color, die_colors, tol: float) -> bool:
    """Màu (RGB 3-tuple / CMYK 4-tuple) khớp một trong die_colors trong dung sai."""
    if not color or not die_colors:
        return False
    try:
        c = tuple(float(x) for x in color)
    except (TypeError, ValueError):
        return False
    for tgt in die_colors:
        if len(tgt) == len(c) and all(abs(a - b) <= tol for a, b in zip(c, tgt)):
            return True
    return False


def _is_hairline(width, page_rect) -> bool:
    """Nét mảnh (đường bế thường ≤ ~1pt, hoặc < 1% cạnh ngắn của trang)."""
    try:
        w = float(width or 0)
    except (TypeError, ValueError):
        return False
    if w <= 0:
        return False
    short = min(page_rect.width, page_rect.height) or 1.0
    return w <= 2.0 or w <= 0.01 * short


_NAME_MATCH_SCORE = 1000.0   # khớp tên kênh bế cấu hình — tín hiệu tin cậy nhất
_ANON_SPOT_SCORE = 400.0     # kênh spot dành riêng nhưng tên không nhận ra
_DIE_COLOR_SCORE = 300.0     # nét đúng màu bế quy ước, không có kênh spot


def _score_die_candidate(path, page_rect, names_lower, die_colors, die_color_tol):
    """Chấm điểm 1 path là ĐƯỜNG BẾ — tách TÍN HIỆU MẠNH / YẾU.

    BẮT BUỘC: path là NÉT THUẦN (stroke-only, không fill). Mảng tô / sf → strong=0
    → không chọn; caller fallback khổ trang.

    Tín hiệu MẠNH (chỉ trên stroke-only):
      - Tên kênh khuôn (CutContour, Dieline, …)
      - Kênh spot dành riêng
      - Màu bế cấu hình trên stroke (magenta / đen / xanh / vàng 100%)

    Tín hiệu YẾU (xếp hạng giữa ứng viên đã strong>0): hairline, closePath, area.

    Trả (strong, weak, matched_by_spot).
    """
    # Cổng cứng: không nét thuần → không bao giờ là đường bế (kể cả tên kênh trên fill).
    if not _is_stroke_only_path(path):
        return 0.0, 0.0, False

    spot = path.get("spot_name")
    color = path.get("color")
    ptype = path.get("type")
    strong = 0.0
    weak = 0.0
    by_spot = False

    if _match_die_channel(spot, names_lower):
        strong += _NAME_MATCH_SCORE
        by_spot = True
    elif _is_non_die_spot(spot):
        # [DIE-SPOT-DENY 2026-07-28] Lớp gia công (mực trắng, phủ UV, ép kim…):
        # loại DỨT ĐIỂM, không cho nhánh màu bên dưới vớt lại. Nét trên kênh spot
        # có tint 1 thành phần, tint 0 trùng 'DeviceGray đen' trong die_colors nên
        # nếu chỉ bỏ điểm spot thì vẫn lọt qua đường +300 khớp màu.
        return 0.0, 0.0, False
    elif _is_genuine_spot(spot):
        strong += _ANON_SPOT_SCORE
        by_spot = True

    # Màu bế chỉ trên stroke color (không đọc fill — path stroke-only đã không có fill).
    # [DIE-TINT 2026-07-28] Bỏ qua khi path nằm trên kênh Separation/DeviceN: giá trị
    # `color` lúc đó là TINT (một số 0..1) mà parser nhân thành (t,t,t) để giữ hợp đồng
    # màu 3 thành phần. Tint 0 = KHÔNG MỰC nhưng lại đúng bằng (0,0,0) = "đen RGB" trong
    # die_colors, nên nét spot ở 0% từng được cộng 300 điểm màu bế oan (vd Separation
    # /Black ở tint 0). Kênh spot đã có tín hiệu riêng ở trên, không cần điểm màu.
    if spot is None and _color_matches_die(color, die_colors, die_color_tol):
        strong += _DIE_COLOR_SCORE

    # Yếu: xếp hạng khi đã có strong > 0.
    if ptype == "s":
        weak += 100.0
    if _is_hairline(path.get("width"), page_rect):
        weak += 60.0
    if path.get("closePath"):
        weak += 30.0
    page_area = (page_rect.width * page_rect.height) or 1.0
    r = path["rect"]
    weak += min(1.0, (r.width * r.height) / page_area) * 20.0

    return strong, weak, by_spot


def _paint_order_map(paths) -> dict:
    """{id(path): thứ tự tô}. Dùng 'paint_index' do parser gắn; thiếu thì lấy vị trí list.

    Fallback theo vị trí giữ nguyên ý nghĩa vì parser append `drawings` đúng thứ tự
    tô — nhờ vậy caller/test dựng path bằng tay vẫn xếp hạng đúng.
    """
    order: dict = {}
    for i, p in enumerate(paths):
        idx = p.get("paint_index") if hasattr(p, "get") else None
        order[id(p)] = int(idx) if isinstance(idx, int) else i
    return order


def _die_layer_key(path, die_colors, die_color_tol):
    """Khoá "lớp bế" của một path: theo kênh spot, hoặc theo màu bế, hoặc chính nó.

    Cùng khoá = cùng một lớp trong cây đối tượng (vd viền ngoài + vòng trong của
    cùng khuôn). Dùng để so THỨ TỰ TÔ giữa các LỚP thay vì giữa từng path lẻ.
    """
    spot_key = _die_group_key_spot(path.get("spot_name"))
    if spot_key is not None:
        return ("spot", spot_key)
    color = path.get("color")
    if _color_matches_die(color, die_colors, die_color_tol):
        try:
            return ("color", tuple(float(x) for x in color))
        except (TypeError, ValueError):
            pass
    return ("path", id(path))


def _select_from_paths(paths, page_rect, die_channel_names=(),
                       die_colors=(), die_color_tol=0.06):
    """Lõi chọn đường khuôn (thuần, KHÔNG IO) — dùng chung (R3.1, R3.2, R3.6, R3.10).

    Chỉ chọn path:
      1) stroke-only (không fill), VÀ
      2) có tín hiệu bế mạnh (tên kênh / spot / màu-bế trên nét).

    Không có → (None, False, False): caller dùng khổ trang (MediaBox), KHÔNG
    lấy mảng màu / path tô lớn nhất.

    Xếp hạng 2 tầng:
      - Có path khớp TÊN kênh bế → chỉ xét nhóm đó (tên là tín hiệu tin cậy nhất,
        thắng cả vị trí: khuôn vẫn nhận đúng dù nằm dưới lớp phủ UV).
      - Không có tên → chọn LỚP TRÊN CÙNG theo thứ tự tô ([DIE-ZORDER]).
    Trong nhóm đã chọn: strong ↓, weak ↓, area ↓, thứ tự tô ↓.
    Trả (path_dict, matched_by_spot, is_fallback).
    """
    if not paths:
        return None, False, False

    valid = [p for p in paths if p["rect"].width > 5 and p["rect"].height > 5]
    if not valid:
        return None, False, False

    # Chỉ xét nét thuần — loại fill/sf trước khi chấm điểm (rẻ + rõ ràng).
    stroke_only = [p for p in valid if _is_stroke_only_path(p)]
    if not stroke_only:
        return None, False, False

    filtered = [
        p for p in stroke_only
        if not (abs(p["rect"].width - page_rect.width) <= 2
                and abs(p["rect"].height - page_rect.height) <= 2)
    ]
    candidates = filtered if filtered else stroke_only

    names_lower = frozenset(n.strip().lower() for n in (die_channel_names or ()))
    order = _paint_order_map(paths)

    scored = []  # (strong, weak, area, paint_order, by_spot, path)
    for p in candidates:
        strong, weak, by_spot = _score_die_candidate(
            p, page_rect, names_lower, die_colors, die_color_tol
        )
        if strong <= 0:
            continue
        area = p["rect"].width * p["rect"].height
        scored.append((strong, weak, area, order[id(p)], by_spot, p))

    if not scored:
        return None, False, False

    named = [c for c in scored if c[0] >= _NAME_MATCH_SCORE]
    if named:
        pool = named
    else:
        # [DIE-ZORDER 2026-07-28] Không có kênh nào mang tên bế → dựa vào quy ước
        # chế bản: bế là khâu SAU CÙNG nên thợ đặt lớp bế TRÊN CÙNG cây đối tượng.
        # So theo LỚP (không theo path lẻ) rồi lấy lớp có path tô muộn nhất; trong
        # lớp vẫn để diện tích quyết định, nếu không khuôn nhiều vòng sẽ lấy vòng
        # TRONG (vẽ sau) làm khổ thành phẩm → trim thiếu.
        layer_top: dict = {}
        for c in scored:
            key = _die_layer_key(c[5], die_colors, die_color_tol)
            if key not in layer_top or c[3] > layer_top[key]:
                layer_top[key] = c[3]
        best_layer = max(layer_top, key=lambda k: layer_top[k])
        pool = [
            c for c in scored
            if _die_layer_key(c[5], die_colors, die_color_tol) == best_layer
        ]

    # Hoà điểm thì lấy path TÔ SAU (nằm trên). Trước đây so '>' thuần nên path gặp
    # trước — tức DƯỚI CÙNG — thắng, ngược hẳn quy ước đặt lớp bế trên cùng.
    best = max(pool, key=lambda c: (c[0], c[1], c[2], c[3]))
    return best[5], best[4], False


def _die_group_key_spot(spot_name):
    """Khoá nhóm theo kênh spot (tập tên đã chuẩn hoá), hoặc None nếu không phải spot."""
    if not _is_genuine_spot(spot_name):
        return None
    return frozenset(s.strip().lower() for s in str(spot_name).split("+"))


def _is_background(path, page_rect) -> bool:
    r = path["rect"]
    return (abs(r.width - page_rect.width) <= 2 and abs(r.height - page_rect.height) <= 2)


def _collect_die_group(paths, anchor, page_rect, die_colors=(), die_color_tol=0.06):
    """Gom MỌI path cùng "layer bế" với anchor → một khuôn (R3.5 mở rộng).

    Mô hình đúng: 1 khuôn = tất cả nét cùng kênh spot (hoặc cùng màu bế), KHÔNG
    phải 1 path đơn. Nhờ vậy khuôn nhiều vòng (chữ O / donut / nét cắt trong) giữ
    đủ mọi vòng khi vẽ trang Khuôn và khi tính bbox.

    Chỉ gộp khi anchor có TÍN HIỆU bế rõ (spot riêng, hoặc khớp màu bế) — tránh
    nuốt nhầm nét artwork khi anchor chỉ là fallback "stroke lớn nhất".
    """
    anchor_spot_key = _die_group_key_spot(anchor.get("spot_name"))
    # Chỉ stroke color — không dùng fill (mảng màu) để gộp layer bế.
    anchor_col = anchor.get("color")
    anchor_is_diecolor = _color_matches_die(anchor_col, die_colors, die_color_tol)

    if anchor_spot_key is None and not anchor_is_diecolor:
        return [anchor]  # không tín hiệu bế → giữ 1 path (an toàn)

    # Ứng viên: cùng layer bế + stroke-only (không nuốt mảng tô cùng màu).
    def _is_member_candidate(p):
        if p is anchor:
            return True
        if not _is_stroke_only_path(p):
            return False
        # [DIE-SPOT-DENY 2026-07-28] Nét lớp gia công không được gộp vào khuôn —
        # nhánh gộp theo MÀU chỉ so màu + kề nhau, nên nét trắng/phủ UV trùng màu
        # bế sẽ phình bbox khuôn nếu không chặn ở đây.
        if _is_non_die_spot(p.get("spot_name")):
            return False
        r = p["rect"]
        if r.width <= 5 or r.height <= 5 or _is_background(p, page_rect):
            return False
        if anchor_spot_key is not None:
            return _die_group_key_spot(p.get("spot_name")) == anchor_spot_key
        # [DIE-TINT 2026-07-28] Nhóm theo MÀU chỉ gồm nét KHÔNG spot — cùng lý do như
        # lúc chấm điểm: `color` của nét spot là tint, tint 0 trùng đen (0,0,0).
        if p.get("spot_name") is not None:
            return False
        return _color_matches_die(p.get("color"), die_colors, die_color_tol)

    candidates = [p for p in paths if _is_member_candidate(p)]

    # Spot-key riêng = kênh bế dành riêng → mọi nét cùng key CHẮC là 1 khuôn (kể cả
    # rời rạc). Gộp toàn bộ (giữ hành vi cũ, đúng cho chữ O/donut nhiều vòng).
    if anchor_spot_key is not None:
        return candidates or [anchor]

    # Gộp theo MÀU bế (file không có spot riêng, vd magenta/đen/xanh/vàng quy ước):
    # chỉ so màu dễ NUỐT logo/chữ artwork cùng màu ở chỗ khác (audit bảo toàn nội dung
    # 2026-07-07). Giới hạn theo KHÔNG GIAN: lan dần từ anchor, chỉ thu path có bbox
    # chồng/kề (pad nhỏ) với nhóm hiện tại → viền ngoài + vòng trong + nét cắt lân cận
    # được gộp; mảng cùng màu bế rời rạc ở góc khác bị loại.
    def _rects_touch(a, b, pad):
        return not (a.x1 + pad < b.x0 or b.x1 + pad < a.x0 or
                    a.y1 + pad < b.y0 or b.y1 + pad < a.y0)

    pad = 0.02 * max(page_rect.width, page_rect.height)  # ~2% khổ: đủ nối nét kề, không nối góc xa
    group = [anchor]
    group_rect = anchor["rect"]
    Rect = type(group_rect)
    remaining = [p for p in candidates if p is not anchor]
    changed = True
    while changed:
        changed = False
        still = []
        for p in remaining:
            if _rects_touch(group_rect, p["rect"], pad):
                group.append(p)
                r = p["rect"]
                group_rect = Rect(
                    min(group_rect.x0, r.x0), min(group_rect.y0, r.y0),
                    max(group_rect.x1, r.x1), max(group_rect.y1, r.y1),
                )
                changed = True
            else:
                still.append(p)
        remaining = still
    return group


def _merge_die_paths(members):
    """Hợp nhất nhiều path bế thành 1 dict path: gộp items, bbox bao tất cả.

    Giữ color/width/type/spot của member đầu (anchor) cho việc vẽ nét; closePath
    = True nếu bất kỳ member kín.
    """
    if not members:
        return None
    if len(members) == 1:
        return members[0]
    base = dict(members[0])
    items = []
    for m in members:
        items.extend(m.get("items", []) or [])
    base["items"] = items
    r0 = members[0]["rect"]
    Rect = type(r0)
    x0 = min(m["rect"].x0 for m in members)
    y0 = min(m["rect"].y0 for m in members)
    x1 = max(m["rect"].x1 for m in members)
    y1 = max(m["rect"].y1 for m in members)
    base["rect"] = Rect(x0, y0, x1, y1)
    base["closePath"] = any(m.get("closePath") for m in members)
    return base


def select_die_path(page, die_channel_names=(), die_colors=None, die_color_tol=0.06):
    """Chọn đường khuôn (gom 1 chỗ — R3.1). Phiên bản tiện dụng cho layout: NUỐT
    lỗi extract (trả None) để không làm sập solver. Detection dùng `_select_from_paths`
    trực tiếp để lỗi extract nổi lên cơ chế cô lập lỗi theo trang.

    Trả về path ĐÃ GỘP cả layer bế (mọi vòng cùng spot/màu) → trang Khuôn vẽ đủ
    mọi vòng (vd chữ O 2 vòng), bbox bao trọn. die_colors mặc định =
    DetectionConfig().die_colors → layout NHẤT QUÁN với detection.
    """
    if die_colors is None:
        die_colors = DetectionConfig().die_colors
    try:
        paths = page.extract_vector_paths()
    except Exception:
        return None
    anchor, _, _ = _select_from_paths(paths, page.rect, die_channel_names, die_colors, die_color_tol)
    if anchor is None:
        return None
    members = _collect_die_group(paths, anchor, page.rect, die_colors, die_color_tol)
    return _merge_die_paths(members)


def _same_color_group_poly(page, target_color, paths=None):
    """Hợp nhất (union) các subpath cùng màu thành 1 đa giác (R3.5).

    Đường bế có thể bị chia thành nhiều subpath (vd contour + chi tiết) dùng
    chung màu. Gộp lại để poly phản ánh đủ đường khuôn. `paths` (nếu truyền) được
    tái dùng để khỏi trích vector 2 lần/trang (tối ưu).
    """
    try:
        from app.workers.nup_diecut import _path_items_to_polygon
        from shapely.ops import unary_union
    except Exception:
        return None
    if paths is None:
        try:
            paths = page.extract_vector_paths()
        except Exception:
            return None
    if not paths:
        return None
    polys = []
    for p in paths:
        if p.get("color") == target_color or p.get("fill") == target_color:
            poly_part = _path_items_to_polygon(p.get("items", []))
            if poly_part is not None and poly_part.is_valid and not poly_part.is_empty:
                polys.append(poly_part)
    if not polys:
        return None
    try:
        merged = unary_union(polys)
        if merged.is_empty:
            return None
        return merged
    except Exception:
        return None


def _poly_to_trim_coords(geom) -> tuple[tuple[float, float], ...]:
    """Lấy toạ độ exterior của polygon Shapely, dịch về gốc (0,0) (chuẩn hoá TRIM)."""
    try:
        g = geom
        if g.geom_type == "MultiPolygon":
            g = max(g.geoms, key=lambda x: x.area)
        minx, miny, _, _ = g.bounds
        return tuple(
            (round(x - minx, 3), round(y - miny, 3))
            for (x, y) in g.exterior.coords
        )
    except Exception:
        return ()


def _normalize_props(props: dict) -> dict:
    """Làm tròn mọi giá trị số trong props về 3 chữ số (R1.2)."""
    out: dict[str, Any] = {}
    for k, v in (props or {}).items():
        if isinstance(v, bool):
            out[k] = v
        elif isinstance(v, (int, float)):
            out[k] = round(float(v), 3)
        else:
            out[k] = v
    return out


def _detect_one_page_vector(page, page_idx: int, die_channel_names=(),
                            die_colors=(), die_color_tol=0.06) -> Optional[DetectedShape]:
    """Nhận diện 1 trang bằng phân tích vector. Trả None nếu không thấy đường bế.

    Gọi extract_vector_paths TRỰC TIẾP (không nuốt lỗi) để lỗi trích xuất nổi
    lên cơ chế cô lập lỗi theo trang ở detect_die_shapes (R4.2, R5.4).
    """
    paths = page.extract_vector_paths()
    largest, matched_by_spot, is_fallback = _select_from_paths(
        paths, page.rect, die_channel_names, die_colors, die_color_tol
    )
    if largest is None:
        return None

    from app.workers.shape_classifier import (
        classify_shape, _sample_bezier_contour, _bounding_box,
    )

    items = largest.get("items", [])
    result = classify_shape(items)
    shape_type = coerce_shape_type(result["shape_type"].name)
    props = _normalize_props(result.get("params", {}) or {})

    # Kích thước thành phẩm. Nếu đường bế bị TÁCH nhiều subpath cùng spot/màu
    # (vd contour + chi tiết), extent của NHÓM ĐÃ GỘP mới phản ánh đủ; anchor đơn
    # có thể thiếu (audit shape-detection #3). Ca 1 subpath → GIỮ NGUYÊN cách cũ
    # (sample contour anchor) để không đổi kết quả phổ biến.
    _members = _collect_die_group(paths, largest, page.rect, die_colors, die_color_tol)
    if len(_members) > 1:
        _mr = _merge_die_paths(_members)["rect"]
        visual_w = _mr.width
        visual_h = _mr.height
    else:
        try:
            samples = _sample_bezier_contour(items)
            if samples:
                min_x, max_x, min_y, max_y = _bounding_box(samples)
                visual_w = max_x - min_x
                visual_h = max_y - min_y
            else:
                visual_w = largest["rect"].width
                visual_h = largest["rect"].height
        except Exception:
            visual_w = largest["rect"].width
            visual_h = largest["rect"].height

    try:
        rot = page.rotation
    except Exception:
        rot = 0
    if rot in (90, 270):
        visual_w, visual_h = visual_h, visual_w

    # poly: ưu tiên union các subpath cùng màu (R3.5); fallback dùng samples.
    target_color = largest.get("color") if largest.get("color") is not None else largest.get("fill")
    poly = _same_color_group_poly(page, target_color, paths=paths)
    poly_coords = _poly_to_trim_coords(poly) if poly is not None else ()
    if not poly_coords:
        try:
            samples = _sample_bezier_contour(items)
            if samples:
                mnx = min(s[0] for s in samples)
                mny = min(s[1] for s in samples)
                poly_coords = tuple((round(sx - mnx, 3), round(sy - mny, 3)) for sx, sy in samples)
        except Exception:
            poly_coords = ()

    w = max(0.001, round(float(visual_w), 3))
    h = max(0.001, round(float(visual_h), 3))
    return DetectedShape(
        page=page_idx,
        type=shape_type,
        props=props,
        trim=Trim(min(w, MAX_TRIM_PT), min(h, MAX_TRIM_PT)),
        poly=poly_coords,
        source="separation" if matched_by_spot else "vector",
        # is_fallback = không có tín hiệu bế nào (điểm 0), phải đoán mò path lớn nhất
        # (thường là khung ảnh/nền artwork) → KHÔNG báo "chắc chắn 1.0" dù classify ra
        # hình chuẩn, để người dùng không tin nhầm (Fix F, audit bảo toàn nội dung 2026-07-07).
        confidence=(
            (0.5 if shape_type is not ShapeType.CUSTOM else 0.3) if is_fallback
            else (1.0 if shape_type is not ShapeType.CUSTOM else 0.5)
        ),
    )


def build_shape_from_raster(page_idx: int, mask, spot_w: float, spot_h: float) -> DetectedShape:
    """Phân loại 1 mask raster → DetectedShape (source=raster_fallback) (R3.8).

    Dùng cho nhánh fallback khi không tìm được đường bế dạng vector. Toàn bộ
    logic phân loại nằm trong module Detection (giữ SSOT); caller chỉ cấp mask.
    """
    from app.workers.shape_analyzer import detect_shape, extract_shape_properties

    shape_enum = detect_shape(mask)
    shape_type = coerce_shape_type(shape_enum.name)
    props = _normalize_props(extract_shape_properties(mask))
    if shape_type is ShapeType.HAMMER:
        props["effective_body_w_ratio"] = 0.37
    elif shape_type is ShapeType.DUMBBELL:
        props["effective_body_w_ratio"] = 0.65

    w = max(0.001, round(float(spot_w), 3))
    h = max(0.001, round(float(spot_h), 3))
    return DetectedShape(
        page=page_idx,
        type=shape_type,
        props=props,
        trim=Trim(min(w, MAX_TRIM_PT), min(h, MAX_TRIM_PT)),
        poly=(),
        source="raster_fallback",
        confidence=0.5 if shape_type is not ShapeType.CUSTOM else 0.3,
    )


def detect_die_shapes(doc, config: DetectionConfig = DetectionConfig()) -> DetectionResult:
    """NGUỒN SỰ THẬT DUY NHẤT cho hình học đường khuôn — vector (R2.1, R3.1).

    - Xử lý MỌI trang (R5.1, R5.2): không giới hạn 30 trang.
    - Mỗi trang trong scope cô lập lỗi (R4): lỗi 1 trang → CUSTOM, không dừng.
    - Trả về đúng N DetectedShape theo thứ tự trang (R1.1, R5.1, R6.4).

    Lưu ý: nhánh raster fallback (cần render/IO bất đồng bộ) do caller thực
    hiện và gọi `build_shape_from_raster` để giữ logic phân loại trong module này.
    Trang không có đường bế vector trả về CUSTOM với source='custom' để caller
    có thể thử raster.
    """
    try:
        total = doc.page_count
    except Exception:
        total = len(doc)

    shapes: list[DetectedShape] = []
    statuses: list[PageDetectionStatus] = []
    failed: list[int] = []

    # Xử lý theo lô để phủ đủ trang mà không giữ quá nhiều state (R5.3).
    bs = max(1, int(config.batch_size))
    for batch_start in range(0, total, bs):
        for page_idx in range(batch_start, min(batch_start + bs, total)):
            try:
                page = doc[page_idx]
                shape = _detect_one_page_vector(
                    page, page_idx, config.die_channel_names,
                    config.die_colors, config.die_color_tol,
                )
                if shape is None:
                    # Không thấy đường bế vector → CUSTOM(custom); caller có thể thử raster.
                    pw, ph = _page_dims_pt(page)
                    shapes.append(make_custom_shape(page_idx, pw, ph, source="custom"))
                    statuses.append(PageDetectionStatus(page_idx, True, "custom"))
                else:
                    shapes.append(shape)
                    statuses.append(PageDetectionStatus(page_idx, True, shape.source))
            except Exception as exc:  # cô lập lỗi theo trang (R4.1, R4.2)
                logger.error("[DETECT] Trang %d lỗi: %s", page_idx + 1, exc)
                try:
                    pw, ph = _page_dims_pt(doc[page_idx])
                except Exception:
                    pw, ph = 1.0, 1.0
                shapes.append(make_custom_shape(page_idx, pw, ph, source="custom"))
                statuses.append(PageDetectionStatus(page_idx, False, "custom", str(exc)))
                failed.append(page_idx + 1)  # 1-based (R5.5)

    return DetectionResult(
        shapes=shapes,
        statuses=statuses,
        total_pages=total,
        success_pages=total - len(failed),
        failed_pages=tuple(failed),
    )
