"""Hợp đồng API nhóm preflight — phần response.

KIENTRUC (audit 2026-07-29 §A.2, lô 8 đợt 2). `routes/preflight.py` là nhóm bị 26 file
component gọi TRỰC TIẾP (không qua `lib/api.ts`), nên lệch field ở đây lan nhanh nhất.

Phạm vi đợt này: các endpoint mà **mọi** nhánh return đã được soi bằng AST và có hình dạng
xác định. Cố tình BỎ QUA (ghi lại để đợt sau làm, không phải quên):

- `/preflight/preview-layers` — có nhánh `return engine.render_with_visibility(...)` trả
  chuỗi base64 chứ không phải dict. Gắn `response_model` bây giờ sẽ làm nhánh đó sai kiểu.
- `/preflight/softproof` — nhánh thành công `return result` với `result` là dict do engine
  dựng, hình dạng chưa chốt.
- Các endpoint trả `Response`/`FileResponse` (`/download`, `/page-svg`, `/svg-by-path`) và
  các endpoint đã có model inline (`/inspect`, `/fix`, `/pipeline`, `/inspect-upload`).

Nguyên tắc chung (giống `schemas/imposition.py`): model MÔ TẢ, không siết — `output_filename`
để `Optional` vì nhánh thất bại vẫn trả `success=False` kèm khoá đó.
"""

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator  # noqa: F401
from typing import Any, Dict, List, Optional


class FixFileResponse(BaseModel):
    """Hình dạng dùng chung của các endpoint "sửa file rồi trả tên file kết quả".

    Dùng cho: `/delete-object`, `/layers/rename`, `/layers/toggle-lock`,
    `/layers/set-visibility`, `/layers/delete`, `/layers/reorder`, `/set-page-boxes`,
    `/auto-trim`, `/add-bleed`, `/mirror-bleed`, `/convert-spot`.

    Desktop đọc `data.success` + `data.output_filename` rồi gọi `/preflight/download/
    {output_filename}` để lấy file — bỏ một trong hai là đứt luồng "sửa xong nhận file".
    """

    success: bool
    output_filename: Optional[str] = Field(
        default=None, description="Tên file kết quả trong results/preflight_output"
    )


class FlattenLayersResponse(FixFileResponse):
    """`/preflight/layers/flatten` — thêm `warning`.

    `warning` mang cảnh báo khi phải flatten bằng đường raster (mất Pantone + kênh bế).
    Đây là thông tin nghiệp vụ, người vận hành cần thấy, không được lặng lẽ bỏ.
    """

    warning: Optional[str] = None


class CropRegionsResponse(FixFileResponse):
    """`/preflight/crop-regions` — mỗi vùng quét thành 1 trang nên trả thêm `page_count`."""

    page_count: Optional[int] = None


class PreviewImageResponse(BaseModel):
    """`/preflight/preview-hide` — ảnh preview base64 (data URL) của trang sau khi ẩn object."""

    success: bool
    preview_b64: Optional[str] = None


class PageObjectsResponse(BaseModel):
    """`/preflight/objects/{file_id}/{page}` — danh sách object của một trang.

    Phần tử để `Any` vì đã có model riêng (`PdfObjectResponse` khai trong route) và
    validate hai lần chỉ thêm chi phí mà không thêm bảo đảm.
    """

    objects: list[Any] = Field(default_factory=list)


class InksResponse(BaseModel):
    """`/preflight/inks/{file_id}` — danh sách kênh mực (process + spot)."""

    inks: list[Any] = Field(default_factory=list)


class IccProfilesResponse(BaseModel):
    """`/preflight/icc-profiles` — danh sách ICC dùng cho soft-proof."""

    profiles: list[Any] = Field(default_factory=list)


class OverprintPreviewResponse(BaseModel):
    """`/preflight/overprint-preview` — trả 3 hình dạng nên là hợp của cả ba.

    Nhánh đủ: ảnh overprint + overlay khác biệt + số pixel lệch. Nhánh lỗi: `success=False`
    kèm `error`. Nhánh "không có gì khác biệt": `success` + `has_differences=False` + `engine`.
    """

    success: bool
    error: Optional[str] = None
    has_differences: Optional[bool] = None
    diff_pixel_count: Optional[int] = None
    diff_overlay: Optional[str] = None
    overprint_image: Optional[str] = None
    width: Optional[int] = None
    height: Optional[int] = None
    engine: Optional[str] = Field(
        default=None, description="Engine đã dùng để dựng preview (ppe | gs)"
    )


# ── Lô 13: phủ thêm các endpoint có hình dạng xác định ───────────────────────


class FixFileWithLogResponse(FixFileResponse):
    """Nhóm "sửa file + trả log": `/fix-hairlines`, `/set-overprint`, `/convert-colors`.

    `log` là chuỗi nhật ký của engine (Ghostscript/PPE) để người dùng đọc khi kết quả
    không như mong đợi; `error` có mặt ở nhánh thất bại. Cả hai đều `Optional` vì nhánh
    thành công không nhất thiết có log.
    """

    log: Optional[str] = None
    error: Optional[str] = None


class ExportPdfxResponse(FixFileResponse):
    """`/preflight/export-pdfx` — xuất PDF/X-1a hoặc X-4.

    `warnings` là danh sách cảnh báo nghiệp vụ (thiếu OutputIntent, spot bị chuyển…) —
    người vận hành cần thấy, không được lặng lẽ bỏ. `engine` cho biết đường nào đã dựng
    (PPE hay Ghostscript) để truy vết khác biệt kết quả.
    """

    warnings: list[str] = Field(default_factory=list)
    engine: Optional[str] = None


class PageBoxesResponse(BaseModel):
    """`/preflight/page-boxes/{file_id}/{page}` — 5 box của một trang, đơn vị **mm**.

    Desktop đọc (`workspace/CropDialog.tsx`): các box để vẽ khung và các cờ `has_*` để
    biết box nào được KHAI TƯỜNG MINH trong file (khác với fallback về MediaBox). Phân
    biệt đó là nghiệp vụ: TrimBox không khai ≠ TrimBox bằng MediaBox.
    """

    page: int
    total_pages: int
    mediabox: Any
    cropbox: Any
    trimbox: Any
    bleedbox: Any
    artbox: Any
    has_trimbox: bool = False
    has_bleedbox: bool = False
    has_artbox: bool = False
    has_cropbox: bool = False
    rotation: int = Field(
        default=0,
        description="Góc /Rotate nội tại của trang, đã chuẩn hóa về 0/90/180/270 độ.",
    )


class OcgLayerTreeResponse(BaseModel):
    """`/preflight/layers/{file_id}` — cây OCG của tài liệu.

    `layers` để `Any` vì cấu trúc cây do `LayerEngine` dựng (có thể lồng nhau theo /Order).
    """

    layers: list[Any] = Field(default_factory=list)
    total: int = 0


class PdfxComplianceResponse(BaseModel):
    """`/preflight/check-pdfx/{file_id}/{standard}` — kiểm tuân thủ PDF/X.

    `checks` là danh sách từng hạng mục kèm kết quả; `passed` là kết luận tổng.
    """

    standard: str
    standard_label: Optional[str] = None
    passed: bool
    passed_checks: int = 0
    total_checks: int = 0
    checks: list[Any] = Field(default_factory=list)


# ── Model gom từ app/api/routes/preflight.py (audit 2026-07-29 §A.2 lô 13) ──

class InspectByIdRequest(BaseModel):
    file_id: str
    rules: Optional[List[str]] = None
    tac_threshold: Optional[int] = 300

class PreflightIssueResponse(BaseModel):
    rule_id: str
    severity: str
    page: Optional[int]
    object_ref: str
    description: str
    auto_fixable: bool
    bbox: Optional[List[float]] = None
    bboxes: Optional[List[List[float]]] = None

class PreflightReportResponse(BaseModel):
    file_name: str
    total_pages: int
    issues: List[PreflightIssueResponse]
    summary: dict
    color_summary: dict
    font_summary: dict
    image_summary: dict

class FixRequest(BaseModel):
    file_id: str
    action_id: str
    params: Optional[dict] = None

class PipelineAction(BaseModel):
    id: str
    params: Optional[dict] = None

class PipelineRequest(BaseModel):
    file_id: str
    actions: List[PipelineAction]

class ChannelReportResponse(BaseModel):
    """Báo cáo bổ sung cho action sinh dữ liệu ΔE (vd REMOVE_CHANNELS).

    Cho phép UI hiển thị cảnh báo vùng ngoài gamut và thống kê ΔE (Req 4.1, 4.2).
    Mọi trường đều optional để các action không sinh report vẫn hoạt động.
    """
    max_delta_e: Optional[float] = None
    avg_delta_e: Optional[float] = None
    out_of_gamut_count: Optional[int] = None
    total_colors: Optional[int] = None
    warnings: List[str] = []
    identical_to_original: Optional[bool] = None

class ActionLogResponse(BaseModel):
    action_id: str
    status: str
    message: str
    duration_ms: int
    # Report bổ sung của riêng step này (None nếu action không sinh report).
    report: Optional[ChannelReportResponse] = None

class FixResponse(BaseModel):
    success: bool
    output_filename: Optional[str] = None
    log: List[ActionLogResponse]
    error: Optional[str] = None
    # Report tổng hợp (lấy từ step gần nhất có report) để UI hiển thị cảnh báo
    # ngoài gamut và thống kê ΔE mà không phải dò trong log (Req 4.1, 4.2).
    report: Optional[ChannelReportResponse] = None

class PdfObjectResponse(BaseModel):
    id: str
    type: str  # 'text', 'image', 'drawing'
    bbox: List[float]  # [x0, y0, x1, y1]
    content: Optional[str] = None
    xref: Optional[int] = None

class ObjectToDelete(BaseModel):
    type: str
    bbox: List[float]
    xref: Optional[int] = None

class DeleteObjectRequest(BaseModel):
    file_id: str
    page: int
    preview_dpi: float = 200.0
    preview_max_pixels: Optional[int] = None
    objects: List[ObjectToDelete]

class PreviewLayersRequest(BaseModel):
    file_id: str
    page: int
    hidden_layer_ids: List[int] = []

class RenameLayerRequest(BaseModel):
    file_id: str
    layer_id: int
    new_name: str

class ToggleLockRequest(BaseModel):
    file_id: str
    layer_id: int
    locked: bool

class SetVisibilityRequest(BaseModel):
    file_id: str
    layer_id: int
    visible: bool

class DeleteLayerRequest(BaseModel):
    file_id: str
    layer_id: int

class ReorderLayersRequest(BaseModel):
    file_id: str
    new_order: List[int]

class FlattenLayersRequest(BaseModel):
    file_id: str

class SeparationsPathRequest(BaseModel):
    file_path: str
    page: int = 1
    dpi: int = 150
    # Tên legacy: None/True = PPE chính xác; False = buộc đường xấp xỉ.
    use_gs: bool | None = None
    profile_id: str = "fogra39"

class SetPageBoxesRequest(BaseModel):
    file_id: str
    box_type: str  # mediabox|cropbox|trimbox|bleedbox|artbox
    rect_mm: dict  # {x0, y0, x1, y1}
    pages: Optional[List[int]] = None  # None = all

class CropRegionsRequest(BaseModel):
    """Crop nhiều vùng trên 1 trang → PDF nhiều trang (mỗi vùng = 1 page)."""
    file_id: str
    page: int  # 1-indexed
    rects_mm: List[dict]  # [{x0,y0,x1,y1}, ...] mm trong hệ CropBox PDF gốc, chưa áp /Rotate
    display_rects_mm: Optional[List[dict]] = None  # mm theo trang hiển thị, gốc trên-trái; dùng cho range/all
    keep_other_pages: bool = False  # True = thay trang nguồn bằng N vùng, giữ phần còn lại

    pages: Optional[List[int]] = None  # None = chỉ page; danh sách = áp dụng cùng vùng cho các trang này

class AutoTrimRequest(BaseModel):
    file_id: str
    pages: Optional[List[int]] = None
    margin_mm: float = 0

class AddBleedRequest(BaseModel):
    file_id: str
    bleed_mm: float = 3
    pages: Optional[List[int]] = None
    # Cạnh nào được bù xén: ["left","right","bottom","top"]. None = cả 4 cạnh
    # (mặc định cũ) để client/recipe cũ không đổi kết quả.
    bleed_sides: Optional[List[str]] = None

class FixHairlinesRequest(BaseModel):
    file_id: str
    threshold_pt: float = 0.1
    replace_pt: float = 0.25
    pages: Optional[List[int]] = None

class ConvertSpotRequest(BaseModel):
    file_id: str
    spot_name: Optional[str] = None  # None = convert ALL

class ExportPdfxRequest(BaseModel):
    file_id: str
    standard: str = "x4"  # "x1a" | "x4"

class ConvertColorsRequest(BaseModel):
    file_id: str
    conversions: list[str] = ["rgb_to_cmyk"]  # "rgb_to_cmyk" | "gray_to_cmyk" | "spot_to_cmyk"
    icc_profile: str = "auto"  # "auto" | "fogra39" | "swop" | "japan_color"
    rendering_intent: str = "relative"  # "relative" | "perceptual" | "saturation" | "absolute"
    preserve_black: bool = True

class SoftProofRequest(BaseModel):
    file_id: str
    page: int = 1
    profile_id: str = "fogra39"
    intent: str = "relative"
    show_gamut_warning: bool = False
    dpi: int = 150

class OverprintPreviewRequest(BaseModel):
    file_id: str
    page: int = 1
    dpi: int = 150
