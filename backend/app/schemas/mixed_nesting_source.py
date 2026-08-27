"""Schema nguồn PDF của "Bình lồng ghép tự do" — phase P12.

Kế hoạch: ``docs/KE_HOACH_MIXED_TRUE_SHAPE_NESTING_DOC_LAP_2026-08-26.md`` §10.

Ba điều đáng nêu:

1. **Không có trường nào nhận đường dẫn cục bộ.** §10.1: frontend gửi bytes qua multipart;
   backend không nhận và không tin ``path``. Vì vậy ở đây không có ``filePath``/``sourcePath``.
2. **``sourceId``/``sourceRevision`` là server-owned** và chỉ xuất hiện ở kiểu **phản hồi**.
3. **Trạng thái ``ambiguous`` là một trạng thái thật, không phải lỗi.** Khi file có nhiều
   đường bế kín, API trả danh sách để người dùng chọn; không đoán hộ (§10.5).
"""

from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field


class ContourCandidateOut(BaseModel):
    """Một đường bế ứng viên, đủ để frontend vẽ preview mà không cần ảnh raster."""

    candidate_id: str = Field(serialization_alias="candidateId")
    page_number: int = Field(serialization_alias="pageNumber")
    #: Contour ngoài, mm, đã dịch về gốc `(0,0)`.
    outer: list[list[float]]
    holes: list[list[list[float]]]
    area_mm2: float = Field(serialization_alias="areaMm2")
    width_mm: float = Field(serialization_alias="widthMm")
    height_mm: float = Field(serialization_alias="heightMm")
    vertex_count: int = Field(serialization_alias="vertexCount")
    #: ``None`` = dùng được. Có giá trị = lý do bị loại, hiện cho người dùng biết vì sao.
    rejected_reason: Optional[str] = Field(serialization_alias="rejectedReason", default=None)

    model_config = ConfigDict(populate_by_name=True)


class SourcePageOut(BaseModel):
    page_number: int = Field(serialization_alias="pageNumber")
    width_mm: float = Field(serialization_alias="widthMm")
    height_mm: float = Field(serialization_alias="heightMm")

    model_config = ConfigDict(populate_by_name=True)


class SourceOut(BaseModel):
    source_id: str = Field(serialization_alias="sourceId")
    status: Literal["ready", "ambiguous", "no_contour"]
    file_name: str = Field(serialization_alias="fileName")
    candidates: list[ContourCandidateOut]
    pages: list[SourcePageOut]
    selected_candidate_id: Optional[str] = Field(
        serialization_alias="selectedCandidateId", default=None
    )
    #: Băm hình học của ứng viên đang chọn. ``None`` khi chưa chọn.
    source_revision: Optional[str] = Field(serialization_alias="sourceRevision", default=None)
    flatten_rule_version: int = Field(serialization_alias="flattenRuleVersion")
    created_at: float = Field(serialization_alias="createdAt")

    model_config = ConfigDict(populate_by_name=True)


class SelectCandidateRequest(BaseModel):
    """Chọn một đường bế trong danh sách ứng viên."""

    candidate_id: str = Field(alias="candidateId", min_length=1, max_length=64)

    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class AcceptPageBoxRequest(BaseModel):
    """Xác nhận dùng khổ trang làm hình chữ nhật (§10.6).

    Cố ý là một endpoint **riêng** thay vì một cờ trong ``SelectCandidateRequest``: §10.6
    yêu cầu người dùng xác nhận rõ, và một trường boolean lẫn trong payload khác thì quá
    dễ bị đặt mặc định.
    """

    page_number: int = Field(alias="pageNumber", ge=1)

    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class SourceDeleteResponse(BaseModel):
    source_id: str = Field(serialization_alias="sourceId")
    deleted: bool

    model_config = ConfigDict(populate_by_name=True)
