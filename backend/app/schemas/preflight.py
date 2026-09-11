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
from typing import Any, Dict, List, Literal, Optional


OutputPreviewFilter = Literal[
    "all",
    "device-cmyk",
    "device-rgb",
    "device-gray",
    "spot",
    "text",
    "images",
    "line-art",
    "smooth-shades",
]

ConvertColorOperation = Literal["rgb_to_cmyk", "gray_to_cmyk", "spot_to_cmyk"]
CmykOutputProfileId = Literal[
    "auto",
    "fogra39",
    "fogra27",
    "gracol",
    "swop",
    "japan_color",
    "uncoated",
    "newspaper",
]
ColorRenderingIntent = Literal["relative", "perceptual", "saturation", "absolute"]
ColorAdjustmentStage = Literal["post_cmyk", "pre_icc"]
ColorGamutMapping = Literal["icc", "adaptive_vivid"]
ColorPreviewPolicy = Literal["manual", "balanced-v1"]
PdfxStandard = Literal["x1a", "x4"]


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


class IccProfileSummary(BaseModel):
    """Một profile output công khai; tuyệt đối không trả đường dẫn local."""

    id: str
    name: str
    description: str
    available: bool


class IccProfilesResponse(BaseModel):
    """`/preflight/icc-profiles` — danh sách ICC dùng cho soft-proof."""

    profiles: list[IccProfileSummary] = Field(default_factory=list)


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
    page_has_overprint: Optional[bool] = None
    profile_id: Optional[str] = None
    intent: Optional[str] = None
    width: Optional[int] = None
    height: Optional[int] = None
    engine: Optional[str] = Field(
        default=None, description="Engine đã dùng để dựng preview (ppe | gs)"
    )


# ── Lô 13: phủ thêm các endpoint có hình dạng xác định ───────────────────────


class FixFileLogEntryResponse(BaseModel):
    """Một bước xử lý hiển thị trong nhật ký của các công cụ sửa file."""

    action_id: str
    status: str
    message: str
    duration_ms: int


# COLOR (audit 2026-08-20 §COLOR.02): route trả mảng để UI duyệt từng bước;
# khai chuỗi ở đây từng làm FastAPI trả 500 sau khi artifact đã được tạo thành công.
class FixFileWithLogResponse(FixFileResponse):
    """Nhóm "sửa file + trả log": `/fix-hairlines`, `/set-overprint`, `/convert-colors`.

    `log` là danh sách từng bước của engine (PPE/pikepdf) để UI hiển thị trạng thái,
    thông điệp và thời gian xử lý; `error` có mặt ở nhánh thất bại.
    """

    log: list[FixFileLogEntryResponse] = Field(default_factory=list)
    error: Optional[str] = None


class ExportPdfxResponse(FixFileResponse):
    """`/preflight/export-pdfx` — xuất PDF/X-1a hoặc X-4.

    `warnings` là danh sách cảnh báo nghiệp vụ (thiếu OutputIntent, spot bị chuyển…) —
    người vận hành cần thấy, không được lặng lẽ bỏ. `engine` cho biết đường nào đã dựng
    (PPE, pikepdf hay PDFium xấp xỉ) để truy vết khác biệt kết quả.
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
    # GS-SUNSET (audit 2026-08-08 §GS.4): hợp đồng mới nói theo chất lượng.
    render_mode: Literal["accurate", "approximate"] = "accurate"
    profile_id: str = "fogra39"
    intent: Literal["perceptual", "relative", "saturation", "absolute"] = "relative"
    output_preview_filter: OutputPreviewFilter = "all"

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
    margin_mm: float = Field(default=0, ge=0, le=20)
    # UIUX (feedback 2026-08-26): None giữ hành vi tự động của client cũ;
    # danh sách tường minh là các cạnh bắt buộc xén trên mọi trang đã chọn.
    trim_sides: Optional[List[Literal["left", "top", "right", "bottom"]]] = Field(
        default=None,
        min_length=1,
        max_length=4,
    )

class AddBleedRequest(BaseModel):
    file_id: str
    bleed_mm: float = 3
    pages: Optional[List[int]] = None
    # Cạnh nào được bù xén: ["left","right","bottom","top"]. None = cả 4 cạnh
    # (mặc định cũ) để client/recipe cũ không đổi kết quả.
    bleed_sides: Optional[List[str]] = None


class MirrorBleedRequest(AddBleedRequest):
    """Tham số riêng cho bù xén lật gương."""

    edge_bite_mm: float = Field(
        default=0.0,
        ge=0.0,
        le=5.0,
        allow_inf_nan=False,
        description="Độ lẹm mép vào vùng TrimBox, đơn vị mm (0–5).",
    )

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
    # SECURITY/COLOR (audit 2026-08-20 §COLOR.23): `standard` từng đi thẳng
    # vào tên output và mọi giá trị khác x1a bị âm thầm xử lý như X-4.
    standard: PdfxStandard = "x4"

class ConvertColorsRequest(BaseModel):
    file_id: str
    conversions: list[ConvertColorOperation] = Field(
        default_factory=lambda: ["rgb_to_cmyk"],
        min_length=1,
    )
    icc_profile: CmykOutputProfileId = "auto"
    rendering_intent: ColorRenderingIntent = "relative"
    preserve_black: bool = True
    black_point_compensation: bool = True
    # COLOR (audit 2026-08-22 §COLOR.38): ICC intent và gamut mapping thích
    # nghi là hai quyết định riêng. Mặc định "icc" giữ nguyên artifact/API cũ.
    gamut_mapping: ColorGamutMapping = "icc"
    adjustment_stage: ColorAdjustmentStage = Field(
        default="post_cmyk",
        description=(
            "post_cmyk: đổi sang CMYK rồi tinh chỉnh theo proof (mặc định); "
            "pre_icc: tinh chỉnh gamut nguồn trước khi đổi profile."
        ),
    )
    # COLOR (audit 2026-08-21): tinh chỉnh trên bản CMYK sau khi đổi profile cho
    # luồng in nhanh. Các giá trị mặc định là phép đồng nhất (identity), để
    # recipe/API cũ giữ nguyên kết quả.
    brightness_lstar: int = Field(
        default=0,
        ge=-10,
        le=10,
        description="Bù độ sáng L* sau khi đổi sang CMYK, trong khoảng -10..10.",
    )
    contrast_percent: int = Field(
        default=0,
        ge=-20,
        le=20,
        description="Bù tương phản trên bản CMYK, trong khoảng -20..20%.",
    )
    vibrance_percent: int = Field(
        default=0,
        ge=-20,
        le=20,
        description="Bù độ rực màu trên bản CMYK, trong khoảng -20..20%.",
    )

    @field_validator("conversions")
    @classmethod
    def validate_unique_conversions(cls, value):
        # COLOR (audit 2026-08-20 §COLOR.12): tránh chạy cùng phép đổi hai lần
        # và chặn `all([])` tạo response thành công giả mà không sinh artifact.
        if len(set(value)) != len(value):
            raise ValueError("Mỗi phép chuyển màu chỉ được xuất hiện một lần")
        return value

    @model_validator(mode="after")
    def validate_gamut_mapping_contract(self):
        if self.gamut_mapping == "adaptive_vivid" and (
            self.rendering_intent != "relative"
            or self.adjustment_stage != "post_cmyk"
        ):
            raise ValueError("adaptive_vivid yêu cầu Relative + post_cmyk")
        return self


class ConvertColorsPreviewRequest(BaseModel):
    """Phân tích một trang trước khi chuyển màu thật.

    Preview cố ý không kế thừa ConvertColorsRequest: grayscale chưa có một
    phép so màu RGB-CMYK có ý nghĩa và không được âm thầm đi qua endpoint này.
    """

    model_config = ConfigDict(extra="forbid")

    file_id: str = Field(min_length=1)
    page: int = Field(default=1, ge=1)
    conversions: list[Literal["rgb_to_cmyk", "spot_to_cmyk"]] = Field(
        default_factory=lambda: ["rgb_to_cmyk"],
        min_length=1,
        max_length=2,
    )
    icc_profile: CmykOutputProfileId = "auto"
    rendering_intent: ColorRenderingIntent = "relative"
    preserve_black: bool = True
    black_point_compensation: bool = True
    gamut_mapping: ColorGamutMapping = "icc"
    adjustment_stage: ColorAdjustmentStage = "post_cmyk"
    brightness_lstar: int = Field(default=0, ge=-10, le=10)
    contrast_percent: int = Field(default=0, ge=-20, le=20)
    vibrance_percent: int = Field(default=0, ge=-20, le=20)
    preview_policy: ColorPreviewPolicy = "manual"
    dpi: int = Field(default=150, ge=72, le=300)
    request_id: str = Field(min_length=1, max_length=128)

    @field_validator("conversions")
    @classmethod
    def validate_preview_conversions(cls, value):
        # COLOR (audit 2026-08-21 §COLOR.32): cùng thứ tự với route xuất file;
        # không nhận Spot riêng hoặc lặp bước rồi trả một preview gây hiểu nhầm.
        if value not in (["rgb_to_cmyk"], ["rgb_to_cmyk", "spot_to_cmyk"]):
            raise ValueError(
                "Preview chỉ hỗ trợ RGB → CMYK, có thể kèm Spot → CMYK sau đó"
            )
        return value

    @model_validator(mode="after")
    def validate_gamut_mapping_contract(self):
        if self.gamut_mapping == "adaptive_vivid" and (
            self.rendering_intent != "relative"
            or self.adjustment_stage != "post_cmyk"
        ):
            raise ValueError("adaptive_vivid yêu cầu Relative + post_cmyk")
        return self


class ColorAdjustmentValues(BaseModel):
    brightness_lstar: int
    contrast_percent: int
    vibrance_percent: int
    adjustment_stage: ColorAdjustmentStage

class ColorTransformOptionsResponse(BaseModel):
    gamut_mapping: ColorGamutMapping



class ColorPreviewImagesResponse(BaseModel):
    source_b64: str
    output_b64: str
    gamut_b64: Optional[str] = None
    mime: str = "image/png"
    width: int
    height: int
    proof_accuracy: str
    proof_engine: str
    measurement_basis: str


class ColorPreviewTacResponse(BaseModel):
    available: bool
    mean_pct: Optional[float] = None
    p95_pct: Optional[float] = None
    max_pct: Optional[float] = None
    engine: str
    spot_excluded: bool = True
    spot_plate_count: int = 0


class ColorPreviewMetricsResponse(BaseModel):
    sample_pixels: int
    delta_lstar_mean: float
    delta_chroma_mean: float
    delta_e00_mean: float
    delta_e00_p95: float
    new_highlight_clip_pct: float
    new_paper_white_pct: float
    new_shadow_clip_pct: float
    neutral_delta_e00_mean: Optional[float] = None
    skin_delta_e00_mean: Optional[float] = None
    out_of_gamut_pct: float = 0
    tac: ColorPreviewTacResponse


class ColorPreviewRecommendationResponse(BaseModel):
    policy: ColorPreviewPolicy
    status: Literal["manual", "recommended", "identity", "unavailable"]
    gates_passed: bool
    reason_codes: list[str] = Field(default_factory=list)


class ConvertColorsPreviewResponse(BaseModel):
    """Preview chỉ trả ảnh/số đo; không bao giờ công bố tên artifact tải xuống."""

    model_config = ConfigDict(extra="forbid")

    success: bool
    request_id: str
    page: int
    requested_dpi: int
    effective_dpi: int
    effective_options: ColorTransformOptionsResponse
    effective_adjustments: ColorAdjustmentValues
    preview: ColorPreviewImagesResponse
    metrics: ColorPreviewMetricsResponse
    recommendation: ColorPreviewRecommendationResponse
    warnings: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_trusted_recommendation(self):
        """Không cho response tự mâu thuẫn biến proof gần đúng thành gợi ý an toàn."""

        recommendation = self.recommendation
        if recommendation.policy == "manual":
            if recommendation.status != "manual" or recommendation.gates_passed:
                raise ValueError("Preview manual không được công bố là gợi ý đã qua gate")
        elif recommendation.status == "unavailable":
            if recommendation.gates_passed:
                raise ValueError("Gợi ý không khả dụng không được qua gate")
        elif (
            recommendation.status not in ("recommended", "identity")
            or not recommendation.gates_passed
        ):
            raise ValueError("Gợi ý cân bằng phải có trạng thái và gate nhất quán")

        if recommendation.gates_passed and (
            self.preview.proof_accuracy != "rip_softproof"
            or self.preview.measurement_basis != "display_rgb_vs_rip_softproof"
            or not self.metrics.tac.available
        ):
            # COLOR (audit 2026-08-21 §COLOR.36): core hiện phát đúng tổ hợp;
            # validator này chặn hồi quy contract trước khi UI có thể tin nhầm.
            raise ValueError("Chỉ RIP soft-proof có TAC PPE mới được qua gate")
        return self

class SoftProofRequest(BaseModel):
    file_id: str
    page: int = 1
    profile_id: str = "fogra39"
    intent: str = "relative"
    show_gamut_warning: bool = False
    dpi: int = 150
    simulate_overprint: bool = True
    output_preview_filter: OutputPreviewFilter = "all"
    simulate_paper_color: bool = False
    simulate_black_ink: bool = False
    page_background_rgb: Optional[tuple[int, int, int]] = None

    @field_validator("page_background_rgb")
    @classmethod
    def validate_page_background_rgb(cls, value):
        if value is not None and any(not 0 <= channel <= 255 for channel in value):
            raise ValueError("page_background_rgb phải gồm ba kênh 0..255")
        return value


class SeparationCompositePlateRequest(BaseModel):
    """Một mặt phẳng lượng mực đã nén của Output Preview."""

    name: str = Field(min_length=1, max_length=256)
    alpha_data: str = Field(min_length=1)
    is_spot: bool = False
    alternate_cmyk_lut: Optional[List[List[float]]] = None

    @field_validator("alternate_cmyk_lut")
    @classmethod
    def validate_spot_lut(cls, value):
        if value is None:
            return value
        # COLOR (audit 2026-08-10 §OP.1): PPE lấy 33 mẫu tint. Cho LUT lệch
        # kích thước qua API sẽ khiến native phải đoán hoặc cho màu spot khác
        # Soft-Proof, nên fail-loud ngay tại biên contract.
        if len(value) != 33:
            raise ValueError("alternate_cmyk_lut phải có đúng 33 mẫu")
        for sample in value:
            if len(sample) != 4 or any(
                not isinstance(channel, (int, float))
                or isinstance(channel, bool)
                or not 0 <= float(channel) <= 1
                for channel in sample
            ):
                raise ValueError("mỗi mẫu LUT phải gồm bốn kênh CMYK trong miền 0..1")
        return value


class SeparationCompositeRequest(BaseModel):
    """Ghép tập kẽm đang bật qua ICC mà không raster lại PDF."""

    width: int = Field(ge=1, le=4_294_967_295)
    height: int = Field(ge=1, le=4_294_967_295)
    plates: List[SeparationCompositePlateRequest] = Field(min_length=1, max_length=64)
    enabled_names: List[str] = Field(default_factory=list, max_length=64)
    profile_id: str = Field(
        default="fogra39",
        min_length=1,
        max_length=64,
        pattern=r"^[A-Za-z0-9_-]+$",
    )
    intent: Literal["perceptual", "relative", "saturation", "absolute"] = "relative"

    @model_validator(mode="after")
    def validate_plate_identity(self):
        if self.width * self.height > 80_000_000:
            raise ValueError("ảnh composite vượt giới hạn an toàn 80 triệu pixel")
        names = [plate.name for plate in self.plates]
        if len(names) != len(set(names)):
            raise ValueError("tên bản kẽm không được trùng")
        unknown = set(self.enabled_names) - set(names)
        if unknown:
            raise ValueError(
                f"bản kẽm được chọn không có trong payload: {', '.join(sorted(unknown))}"
            )
        return self


class ViewerAccurateRenderRequest(BaseModel):
    """Render color-managed cho Viewer từ file PDF đang mở tại máy người dùng."""

    file_path: str = Field(min_length=1)
    page: int = Field(default=1, ge=1)
    # COLOR (audit 2026-08-07 §GV.3): renderZoom phía Viewer đã tự giữ cạnh dài
    # trong ngân sách bitmap. Giới hạn này chỉ chặn payload IPC bất thường, không hạ
    # chất lượng zoom hợp lệ trên máy mạnh.
    dpi: int = Field(default=96, ge=24, le=9600)
    profile_id: str = Field(
        default="fogra39",
        min_length=1,
        max_length=64,
        pattern=r"^[A-Za-z0-9_-]+$",
    )
    intent: Literal["perceptual", "relative", "saturation", "absolute"] = "relative"
    output_preview_filter: OutputPreviewFilter = "all"
    simulate_paper_color: bool = False
    simulate_black_ink: bool = False
    page_background_rgb: Optional[tuple[int, int, int]] = None
    # PERF (audit 2026-08-08 §RENDER.5): endpoint Viewer luôn phải có danh tính
    # latest-wins; cho phép caller bỏ trống sẽ tái tạo backlog khi zoom nhanh.
    owner_id: str = Field(min_length=1, max_length=128)
    # PERF (audit 2026-08-09 §L2C): full-page nền và viewport có request owner
    # khác nhau nhưng phải dùng chung một PPE session theo tab/tài liệu.
    # Client cũ không gửi field này vẫn giữ contract owner cũ.
    session_owner_id: Optional[str] = Field(default=None, min_length=1, max_length=128)
    request_id: str = Field(min_length=1, max_length=128)
    generation: int = Field(ge=1)
    purpose: Literal["interactive", "background"] = "interactive"
    # PERF (audit 2026-08-08 §RENDER.3/5): clip dùng pixel của ảnh PPE full-page
    # tại đúng DPI request, sau `/Rotate`, gốc trên-trái. None cả bốn = full-page.
    clip_x: Optional[int] = Field(default=None, ge=0, le=4_294_967_295)
    clip_y: Optional[int] = Field(default=None, ge=0, le=4_294_967_295)
    clip_width: Optional[int] = Field(default=None, ge=1, le=4_294_967_295)
    clip_height: Optional[int] = Field(default=None, ge=1, le=4_294_967_295)

    @model_validator(mode="after")
    def validate_complete_clip(self):
        values = (self.clip_x, self.clip_y, self.clip_width, self.clip_height)
        if any(value is not None for value in values) and not all(
            value is not None for value in values
        ):
            raise ValueError("clip Viewer phải truyền đủ x/y/width/height")
        return self

    @field_validator("page_background_rgb")
    @classmethod
    def validate_viewer_page_background_rgb(cls, value):
        if value is not None and any(not 0 <= channel <= 255 for channel in value):
            raise ValueError("page_background_rgb phải gồm ba kênh 0..255")
        return value

    @property
    def raster_clip(self) -> tuple[int, int, int, int] | None:
        if self.clip_x is None:
            return None
        return (
            self.clip_x,
            self.clip_y,
            self.clip_width or 0,
            self.clip_height or 0,
        )

class OverprintPreviewRequest(BaseModel):
    file_id: str
    page: int = 1
    dpi: int = 150
    profile_id: str = Field(
        default="fogra39",
        min_length=1,
        max_length=64,
        pattern=r"^[A-Za-z0-9_-]+$",
    )
    intent: Literal["perceptual", "relative", "saturation", "absolute"] = "relative"
