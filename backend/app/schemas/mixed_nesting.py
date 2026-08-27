"""Schema công khai của "Bình lồng ghép tự do" — phase P7a.

Kế hoạch: ``docs/KE_HOACH_MIXED_TRUE_SHAPE_NESTING_DOC_LAP_2026-08-26.md`` §9.2, §12.

Đây là **biên giới công khai**, không phải bản sao hợp đồng nội bộ của engine. Bốn khác
biệt là chủ đích:

1. **Client không được chọn ``jobId``, ``geometryHash`` hay ``sourceRevision``.** Ba
   trường đó là server-owned; ``extra="forbid"`` khiến payload gửi kèm bị **từ chối**
   thay vì bị bỏ qua im lặng — bỏ qua im lặng là cách nhanh nhất để một client tưởng
   mình đã ghim được revision.
2. **Không có ``translationStepMm``, không có matrix.** Cũng nhờ ``extra="forbid"``,
   mọi payload cố ép pose vào lưới đều thành 422 chứ không thành "được bỏ qua".
3. **``reflection`` là literal ``"forbidden"``.** Không có đường bật phản chiếu, kể cả
   bằng một giá trị lạ.
4. **Rotation là discriminated union theo ``mode``**, khớp tên trường của Rust từng chữ
   (``angleDeg``, ``anglesDeg``, ``arcs``) để không cần lớp dịch ở giữa.

Mọi giới hạn số lượng lấy từ ``imposition_core/src/mixed_nesting/model.rs``; có test
parity đọc trực tiếp file Rust ở ``backend/tests/test_mixed_nesting_api.py``.
"""

from __future__ import annotations

import math
from typing import Annotated, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

# ── Giới hạn, khớp `model.rs` ────────────────────────────────────────────────
MIXED_NESTING_PROTOCOL_VERSION = 1
MAX_PARTS = 2_000
MAX_QUANTITY_PER_PART = 100_000
MAX_INSTANCES_TOTAL = 100_000
MAX_RING_VERTICES = 20_000
MAX_TOTAL_VERTICES = 2_000_000
MAX_HOLES_PER_PART = 1_000
MAX_SHEETS_LIMIT = 10_000
MAX_PART_ID_LEN = 128
MAX_ROTATION_ANGLES = 4_096
MAX_ROTATION_ARCS = 1_024
MAX_TIME_BUDGET_MS = 24 * 60 * 60 * 1_000

#: Trần byte của body ``POST /jobs``. Đọc theo byte budget TRƯỚC khi parse JSON (§9.2.5).
MAX_REQUEST_BYTES = 24 * 1024 * 1024


class _Strict(BaseModel):
    """Nền chung: khoá lạ là lỗi, không phải thứ để bỏ qua."""

    model_config = ConfigDict(extra="forbid")


def _finite(value: float, field_name: str) -> float:
    if not math.isfinite(value):
        raise ValueError(f"{field_name} phải là số hữu hạn (không nhận NaN/Infinity).")
    return value


# ─────────────────────────────────────────────────────────────────────────────
#  Hình học
# ─────────────────────────────────────────────────────────────────────────────

#: Một điểm mm dạng ``[x, y]``. Giữ đúng dạng mảng của hợp đồng Rust (``PointMm``).
PointMm = Annotated[list[float], Field(min_length=2, max_length=2)]

Ring = Annotated[list[PointMm], Field(min_length=3, max_length=MAX_RING_VERTICES)]


class SheetMarginMm(_Strict):
    left: float = Field(ge=0.0)
    right: float = Field(ge=0.0)
    top: float = Field(ge=0.0)
    bottom: float = Field(ge=0.0)

    @field_validator("left", "right", "top", "bottom")
    @classmethod
    def _huu_han(cls, value: float) -> float:
        return _finite(value, "marginMm")


class SheetSpec(_Strict):
    width_mm: float = Field(alias="widthMm", gt=0.0)
    height_mm: float = Field(alias="heightMm", gt=0.0)
    margin_mm: SheetMarginMm = Field(alias="marginMm")
    max_sheets: int = Field(alias="maxSheets", ge=1, le=MAX_SHEETS_LIMIT)

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    @field_validator("width_mm", "height_mm")
    @classmethod
    def _huu_han(cls, value: float) -> float:
        return _finite(value, "sheet")

    @model_validator(mode="after")
    def _con_vung_dung_duoc(self) -> "SheetSpec":
        if self.width_mm - self.margin_mm.left - self.margin_mm.right <= 0.0:
            raise ValueError("Lề trái/phải lớn hơn khổ tờ — không còn vùng dùng được.")
        if self.height_mm - self.margin_mm.top - self.margin_mm.bottom <= 0.0:
            raise ValueError("Lề trên/dưới lớn hơn khổ tờ — không còn vùng dùng được.")
        return self


# ─────────────────────────────────────────────────────────────────────────────
#  Rotation constraint — discriminated union theo `mode`
# ─────────────────────────────────────────────────────────────────────────────


class RotationInherit(_Strict):
    """Kế thừa policy cấp job. Chỉ hợp lệ ở cấp chi tiết."""

    mode: Literal["inherit"]


class RotationFree(_Strict):
    """Mọi góc trong miền **liên tục** ``[0°, 360°)``. Đây là mặc định của engine."""

    mode: Literal["free"]


class RotationFixed(_Strict):
    """Khóa đúng một góc — có thể là góc không-cardinal, ví dụ ``13.372849°``."""

    mode: Literal["fixed"]
    angle_deg: float = Field(alias="angleDeg")

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    @field_validator("angle_deg")
    @classmethod
    def _huu_han(cls, value: float) -> float:
        return _finite(value, "angleDeg")


class RotationDiscrete(_Strict):
    """Tập góc hữu hạn. Preset 0/180 và 0/90/180/270 compile về mode này.

    Đây là **lựa chọn thu hẹp của người dùng**, không phải miền mặc định của engine.
    """

    mode: Literal["discrete"]
    angles_deg: list[float] = Field(
        alias="anglesDeg", min_length=1, max_length=MAX_ROTATION_ANGLES
    )

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    @field_validator("angles_deg")
    @classmethod
    def _huu_han(cls, values: list[float]) -> list[float]:
        for value in values:
            _finite(value, "anglesDeg")
        return values


class AngleArcDeg(_Strict):
    """Một cung góc liên tục. ``sweepDeg`` trong ``(0, 360]`` nên cung qua 0° rõ nghĩa."""

    start_deg: float = Field(alias="startDeg")
    sweep_deg: float = Field(alias="sweepDeg", gt=0.0, le=360.0)

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    @field_validator("start_deg", "sweep_deg")
    @classmethod
    def _huu_han(cls, value: float) -> float:
        return _finite(value, "arcs")


class RotationRanges(_Strict):
    """Hợp của các cung liên tục — vẫn là miền **vô hạn góc**, không phải angle grid."""

    mode: Literal["ranges"]
    arcs: list[AngleArcDeg] = Field(min_length=1, max_length=MAX_ROTATION_ARCS)


#: Ràng buộc xoay ở **cấp chi tiết** — cho phép ``inherit``.
PartRotationConstraint = Annotated[
    Union[RotationInherit, RotationFree, RotationFixed, RotationDiscrete, RotationRanges],
    Field(discriminator="mode"),
]

#: Ràng buộc xoay ở **cấp job** — KHÔNG cho ``inherit`` (không có gì để kế thừa).
JobRotationConstraint = Annotated[
    Union[RotationFree, RotationFixed, RotationDiscrete, RotationRanges],
    Field(discriminator="mode"),
]


class OrientationPolicy(_Strict):
    default_rotation: JobRotationConstraint = Field(alias="defaultRotation")
    #: Literal duy nhất. Không có đường bật phản chiếu trong protocol v1.
    reflection: Literal["forbidden"] = "forbidden"

    model_config = ConfigDict(extra="forbid", populate_by_name=True)


# ─────────────────────────────────────────────────────────────────────────────
#  Part và request
# ─────────────────────────────────────────────────────────────────────────────


class PartSpec(_Strict):
    """Một loại chi tiết.

    Cố ý **không có** ``referencePointMm``/``geometryHash``/``sourceRevision``: ba
    trường đó do backend canonicalize và ký (§9.2). ``extra="forbid"`` biến việc client
    gửi kèm thành 422.
    """

    part_id: str = Field(alias="partId", min_length=1, max_length=MAX_PART_ID_LEN)
    quantity: int = Field(ge=1, le=MAX_QUANTITY_PER_PART)
    outer: Ring
    holes: list[Ring] = Field(default_factory=list, max_length=MAX_HOLES_PER_PART)
    rotation_constraint: PartRotationConstraint = Field(
        alias="rotationConstraint", default_factory=lambda: RotationInherit(mode="inherit")
    )

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    @field_validator("outer")
    @classmethod
    def _outer_huu_han(cls, ring: list[list[float]]) -> list[list[float]]:
        for point in ring:
            for coordinate in point:
                _finite(float(coordinate), "outer")
        return ring

    @field_validator("holes")
    @classmethod
    def _holes_huu_han(cls, holes: list[list[list[float]]]) -> list[list[list[float]]]:
        for ring in holes:
            for point in ring:
                for coordinate in point:
                    _finite(float(coordinate), "holes")
        return holes


class CreateJobRequest(_Strict):
    """Body của ``POST /api/mixed-nesting/jobs``.

    Không có ``jobId``: server sinh bằng CSPRNG rồi gắn owner trước khi cấp tài nguyên.
    """

    protocol_version: int = Field(alias="protocolVersion")
    seed: int = Field(ge=0, le=2**64 - 1)
    profile: Literal["fast", "balanced", "tight"] = "balanced"
    time_budget_ms: Optional[int] = Field(
        alias="timeBudgetMs", default=None, ge=1, le=MAX_TIME_BUDGET_MS
    )
    sheet: SheetSpec
    gap_mm: float = Field(alias="gapMm", ge=0.0)
    orientation_policy: OrientationPolicy = Field(alias="orientationPolicy")
    parts: list[PartSpec] = Field(min_length=1, max_length=MAX_PARTS)

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    @field_validator("protocol_version")
    @classmethod
    def _dung_protocol(cls, value: int) -> int:
        if value != MIXED_NESTING_PROTOCOL_VERSION:
            raise ValueError(
                f"Phiên bản protocol {value} không được hỗ trợ "
                f"(sidecar yêu cầu {MIXED_NESTING_PROTOCOL_VERSION})."
            )
        return value

    @field_validator("gap_mm")
    @classmethod
    def _gap_huu_han(cls, value: float) -> float:
        return _finite(value, "gapMm")

    @model_validator(mode="after")
    def _rang_buoc_cheo(self) -> "CreateJobRequest":
        seen: set[str] = set()
        total_instances = 0
        total_vertices = 0
        for index, part in enumerate(self.parts):
            if part.part_id in seen:
                raise ValueError(f"parts[{index}].partId bị trùng: {part.part_id!r}.")
            seen.add(part.part_id)
            total_instances += part.quantity
            total_vertices += len(part.outer) + sum(len(hole) for hole in part.holes)

        if total_instances > MAX_INSTANCES_TOTAL:
            raise ValueError(
                f"Tổng số con vượt giới hạn {MAX_INSTANCES_TOTAL} (đang là {total_instances})."
            )
        if total_vertices > MAX_TOTAL_VERTICES:
            raise ValueError(
                f"Tổng số đỉnh vượt giới hạn {MAX_TOTAL_VERTICES} (đang là {total_vertices})."
            )
        return self

    def to_engine_request(self, *, job_id: str) -> dict:
        """Dựng request nội bộ cho engine: thêm ``jobId`` server-owned.

        Dùng ``by_alias=True`` để ra đúng camelCase mà Rust ``deny_unknown_fields``
        chấp nhận, và ``exclude_none=True`` để ``timeBudgetMs`` vắng mặt thay vì
        ``null`` (Rust dùng ``Option`` với ``skip_serializing_if``).
        """
        payload = self.model_dump(by_alias=True, exclude_none=True)
        payload["jobId"] = job_id
        return payload


# ─────────────────────────────────────────────────────────────────────────────
#  Phản hồi
# ─────────────────────────────────────────────────────────────────────────────


class JobAcceptedResponse(BaseModel):
    """202 của ``POST /jobs``. Chỉ trả mã job; kết quả lấy qua polling."""

    job_id: str = Field(serialization_alias="jobId")
    status: str

    model_config = ConfigDict(populate_by_name=True)


class JobProgress(BaseModel):
    """Ảnh chụp tiến độ. Cố ý gọn — không đẩy log hàng nghìn dòng lên UI (§12.2)."""

    phase: str
    progress: float = Field(ge=0.0, le=1.0)
    attempt: int = Field(ge=0)
    elapsed_ms: int = Field(serialization_alias="elapsedMs", ge=0)
    best_sheet_count: Optional[int] = Field(
        serialization_alias="bestSheetCount", default=None
    )
    best_utilization: Optional[float] = Field(
        serialization_alias="bestUtilization", default=None
    )
    message_code: Optional[str] = Field(serialization_alias="messageCode", default=None)

    model_config = ConfigDict(populate_by_name=True)


class JobStatusResponse(BaseModel):
    job_id: str = Field(serialization_alias="jobId")
    status: str
    terminal: bool = False
    cancel_requested: bool = Field(serialization_alias="cancelRequested", default=False)
    created_at: float = Field(serialization_alias="createdAt")
    started_at: Optional[float] = Field(serialization_alias="startedAt", default=None)
    completed_at: Optional[float] = Field(serialization_alias="completedAt", default=None)
    progress: Optional[JobProgress] = None
    #: Mã lỗi ổn định khi ``status == "failed"``. Không chứa toạ độ của khách hàng.
    error_code: Optional[str] = Field(serialization_alias="errorCode", default=None)
    message: Optional[str] = None

    model_config = ConfigDict(populate_by_name=True)


class JobCancelResponse(BaseModel):
    job_id: str = Field(serialization_alias="jobId")
    status: str
    cancelled: bool = False
    already_cancelled: bool = Field(serialization_alias="alreadyCancelled", default=False)
    terminal: bool = False

    model_config = ConfigDict(populate_by_name=True)


class JobDeleteResponse(BaseModel):
    job_id: str = Field(serialization_alias="jobId")
    deleted: bool

    model_config = ConfigDict(populate_by_name=True)


class CapabilitiesResponse(BaseModel):
    """``GET /capabilities``. Ba trường giữa là bất biến của hợp đồng, không phải gợi ý."""

    protocol_version: int = Field(serialization_alias="protocolVersion")
    engine_version: str = Field(serialization_alias="engineVersion")
    reflection: Literal["forbidden"]
    default_rotation: Literal["free"] = Field(serialization_alias="defaultRotation")
    continuous_translation: bool = Field(serialization_alias="continuousTranslation")
    profiles: list[str]
    max_request_bytes: int = Field(serialization_alias="maxRequestBytes")

    model_config = ConfigDict(populate_by_name=True)


# ─────────────────────────────────────────────────────────────────────────────
#  Xuất PDF — phase P14a
# ─────────────────────────────────────────────────────────────────────────────


class ExportJobRequest(_Strict):
    """Body của ``POST /jobs/{job_id}/export``.

    Cố ý **rỗng**: mọi thứ cần để xuất đã nằm trong phương án đã validate của job. Nhận thêm
    tham số ở đây là mở đường cho việc "xuất khác preview" — đúng thứ §13 cấm.
    """

    model_config = ConfigDict(extra="forbid")


class ExportResponse(BaseModel):
    artifact_id: str = Field(serialization_alias="artifactId")
    job_id: str = Field(serialization_alias="jobId")
    sheet_count: int = Field(serialization_alias="sheetCount")
    size_bytes: int = Field(serialization_alias="sizeBytes")
    #: Băm hình học của mọi nguồn đã dùng. Đổi khuôn thì băm khác ⇒ file cũ không dùng lẫn.
    source_revision: str = Field(serialization_alias="sourceRevision")
    export_rule_version: int = Field(serialization_alias="exportRuleVersion")
    file_name: str = Field(serialization_alias="fileName")

    model_config = ConfigDict(populate_by_name=True)
