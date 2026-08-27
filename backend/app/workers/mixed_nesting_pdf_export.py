"""Xuất PDF tờ đã lồng ghép — phase P14a.

Kế hoạch: ``docs/KE_HOACH_MIXED_TRUE_SHAPE_NESTING_DOC_LAP_2026-08-26.md`` §13, §14, §16.3.

Sáu ràng buộc, mỗi cái có test:

1. **Nguồn chân lý duy nhất là placement manifest.** Module này **không** gọi lại solver,
   không nén lại, không đổi pivot, không làm tròn. Nó chỉ áp
   ``p_sheet = R(theta)·(p_local − ref) + (tx, ty)`` — đúng công thức mà preview áp.
2. **Pivot suy theo cùng quy tắc với engine**: trọng tâm diện tích contour ngoài
   (``normalize.rs::derive_reference_point``, quy tắc có version). Có test parity đọc file
   Rust để đổi quy tắc mà quên bên này thì đỏ.
3. **Không mirror.** Ma trận luôn ``[cos, sin, −sin, cos]``, định thức ``+1``. Có test kiểm
   dấu diện tích của mọi vòng sau khi ghi.
4. **Không PDFium.** Dựng content stream bằng pikepdf thuần, cùng lý do như P12.
5. **1:1 thật.** ``MediaBox`` bằng đúng khổ tờ đổi sang point; không co giãn để "vừa trang".
6. **Đọc lại được.** Hàm ``read_back_placements`` phân tích lại PDF vừa xuất và trả về pose
   dựng lại từ hình học — đó là cách kiểm parity **độc lập**, không phải so chuỗi mình vừa
   ghi ra.
"""

from __future__ import annotations

import io
import math
from dataclasses import dataclass
from typing import Any, Final, Optional, Sequence

_MM_TO_PT: Final[float] = 72.0 / 25.4

#: Bề rộng nét vẽ đường bế, mm. Chỉ để nhìn; dao bế đi theo đường tâm.
CUT_LINE_WIDTH_MM: Final[float] = 0.1

#: Version quy tắc xuất. Đổi cách ghi (thứ tự vòng, layer, nét) là đổi hợp đồng artifact.
EXPORT_RULE_VERSION: Final[int] = 1

Point = tuple[float, float]
Ring = list[Point]


class ExportError(Exception):
    def __init__(self, code: str, message: str, status: int = 422) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


# ─────────────────────────────────────────────────────────────────────────────
#  Hình học — cùng quy tắc với engine và với preview
# ─────────────────────────────────────────────────────────────────────────────


def signed_area(ring: Sequence[Point]) -> float:
    total = 0.0
    count = len(ring)
    for index in range(count):
        x1, y1 = ring[index]
        x2, y2 = ring[(index + 1) % count]
        total += x1 * y2 - x2 * y1
    return total / 2.0


def derive_reference_point(ring: Sequence[Point]) -> Optional[Point]:
    """Trọng tâm diện tích — pivot canonical. Mirror của ``normalize::derive_reference_point``."""
    if len(ring) < 3:
        return None
    double_area = 0.0
    sum_x = 0.0
    sum_y = 0.0
    for index in range(len(ring)):
        x1, y1 = ring[index]
        x2, y2 = ring[(index + 1) % len(ring)]
        cross = x1 * y2 - x2 * y1
        double_area += cross
        sum_x += (x1 + x2) * cross
        sum_y += (y1 + y2) * cross
    if abs(double_area) < 1e-300:
        return None
    point = (sum_x / (3.0 * double_area), sum_y / (3.0 * double_area))
    if not all(math.isfinite(value) for value in point):
        return None
    return point


@dataclass(frozen=True)
class RigidMatrix:
    """Ma trận rigid 2×3, thứ tự ``[a b c d e f]`` như toán tử ``cm`` của PDF."""

    a: float
    b: float
    c: float
    d: float
    e: float
    f: float

    @property
    def determinant(self) -> float:
        return self.a * self.d - self.b * self.c

    def apply(self, point: Point) -> Point:
        return (
            self.a * point[0] + self.c * point[1] + self.e,
            self.b * point[0] + self.d * point[1] + self.f,
        )


def pose_matrix(
    rotation_deg: float, translate_x_mm: float, translate_y_mm: float, reference: Point
) -> RigidMatrix:
    """Chỉ xoay và tịnh tiến. Định thức luôn ``+1`` nên không thể lật hay co giãn."""
    radians = math.radians(rotation_deg)
    cos = math.cos(radians)
    sin = math.sin(radians)
    return RigidMatrix(
        a=cos,
        b=sin,
        c=-sin,
        d=cos,
        e=translate_x_mm - (cos * reference[0] - sin * reference[1]),
        f=translate_y_mm - (sin * reference[0] + cos * reference[1]),
    )


def transform_ring(
    ring: Sequence[Point],
    rotation_deg: float,
    translate_x_mm: float,
    translate_y_mm: float,
    reference: Point,
) -> Ring:
    matrix = pose_matrix(rotation_deg, translate_x_mm, translate_y_mm, reference)
    return [matrix.apply(point) for point in ring]


# ─────────────────────────────────────────────────────────────────────────────
#  Dựng PDF
# ─────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class PartGeometry:
    """Contour nguồn của một loại chi tiết, hệ local mm — đúng thứ đã gửi cho engine."""

    part_id: str
    outer: Ring
    holes: list[Ring]


def _ring_to_ops(ring: Sequence[Point]) -> list[str]:
    """Chuỗi toán tử vẽ một vòng kín, toạ độ **point**.

    Dùng ``repr`` của float qua ``f"{value:.6f}"``: 6 chữ số thập phân point ≈ 0,35 µm, dưới
    mọi tolerance của ngành in, và đủ để đọc lại ra đúng pose tới 1e-6 mm.
    """
    if len(ring) < 3:
        return []
    ops = [f"{ring[0][0] * _MM_TO_PT:.6f} {ring[0][1] * _MM_TO_PT:.6f} m"]
    for x, y in ring[1:]:
        ops.append(f"{x * _MM_TO_PT:.6f} {y * _MM_TO_PT:.6f} l")
    ops.append("h")
    return ops


def build_sheet_stream(
    placements: Sequence[dict[str, Any]], parts: dict[str, PartGeometry]
) -> bytes:
    """Content stream của một tờ: mọi đường bế đã áp pose, vẽ bằng nét.

    Vẽ bằng **nét** (``S``) chứ không tô: đây là bản giao cho khâu làm khuôn, và tô đặc sẽ
    che mất lỗ khoét.
    """
    ops: list[str] = [
        f"{CUT_LINE_WIDTH_MM * _MM_TO_PT:.6f} w",
        "0 0 0 RG",
    ]
    for placement in placements:
        part = parts.get(placement["partId"])
        if part is None:
            raise ExportError(
                "MIXED_NESTING_EXPORT_MISSING_PART",
                f"Thiếu hình học của chi tiết {placement['partId']}.",
            )
        reference = derive_reference_point(part.outer)
        if reference is None:
            raise ExportError(
                "MIXED_NESTING_EXPORT_BAD_GEOMETRY",
                f"Contour của {part.part_id} suy biến, không dựng được pivot.",
            )
        pose = placement["pose"]
        for ring in [part.outer, *part.holes]:
            moved = transform_ring(
                ring,
                float(pose["rotationDeg"]),
                float(pose["translateXmm"]),
                float(pose["translateYmm"]),
                reference,
            )
            ops.extend(_ring_to_ops(moved))
            ops.append("S")
    return "\n".join(ops).encode("latin-1")


def export_manifest_to_pdf(
    *,
    manifest: dict[str, Any],
    sheet: dict[str, Any],
    parts: Sequence[PartGeometry],
) -> bytes:
    """Dựng PDF nhiều trang: mỗi tờ một trang, tỷ lệ **1:1** theo mm.

    **Chặn thread gọi.** Nơi gọi phải đẩy qua threadpool.
    """
    import pikepdf  # noqa: PLC0415

    if manifest.get("status") != "completed":
        raise ExportError(
            "MIXED_NESTING_EXPORT_NOT_COMPLETED",
            f"Chỉ xuất được phương án đã hoàn tất (đang là: {manifest.get('status')}).",
            409,
        )
    validation = manifest.get("validation") or {}
    if validation.get("valid") is not True:
        # §13: xuất phải dùng phương án ĐÃ validate. Không có nhánh "xuất tạm".
        raise ExportError(
            "MIXED_NESTING_EXPORT_NOT_VALIDATED",
            "Phương án chưa qua bước kiểm nên không xuất được.",
            409,
        )

    by_id = {item.part_id: item for item in parts}
    sheet_count = int(manifest.get("stats", {}).get("sheetCount") or 0)
    if sheet_count <= 0:
        raise ExportError(
            "MIXED_NESTING_EXPORT_EMPTY", "Phương án không có tờ nào để xuất.", 409
        )

    width_pt = float(sheet["widthMm"]) * _MM_TO_PT
    height_pt = float(sheet["heightMm"]) * _MM_TO_PT

    by_sheet: dict[int, list[dict[str, Any]]] = {}
    for placement in manifest.get("placements", []):
        by_sheet.setdefault(int(placement["sheetIndex"]), []).append(placement)

    pdf = pikepdf.Pdf.new()
    for index in range(sheet_count):
        stream = pdf.make_stream(build_sheet_stream(by_sheet.get(index, []), by_id))
        page = pdf.make_indirect(
            pikepdf.Dictionary(
                Type=pikepdf.Name.Page,
                MediaBox=[0, 0, width_pt, height_pt],
                Resources=pikepdf.Dictionary(),
                Contents=stream,
            )
        )
        pdf.pages.append(pikepdf.Page(page))

    # Không truyền tham số cho `open_metadata`: chữ ký của nó khác nhau giữa các bản pikepdf
    # (bản trong venv không nhận `set_pikepdf_as_producer`), và tiêu đề là thứ duy nhất cần.
    with pdf.open_metadata() as meta:
        meta["dc:title"] = f"PrynX — Bình lồng ghép tự do (job {manifest.get('jobId', '')})"

    buffer = io.BytesIO()
    pdf.save(buffer)
    return buffer.getvalue()


# ─────────────────────────────────────────────────────────────────────────────
#  Đọc lại để kiểm parity
# ─────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ReadBackRing:
    sheet_index: int
    ring_mm: Ring


def read_back_rings(pdf_bytes: bytes) -> list[ReadBackRing]:
    """Đọc lại PDF vừa xuất và trả các vòng theo mm, hệ tờ (Y hướng lên).

    Dùng chính parser của P12 nên đây là đường **độc lập** với đường ghi: nếu hai bên lệch,
    test đỏ. So chuỗi mình vừa ghi ra thì không chứng minh được gì.
    """
    import pikepdf  # noqa: PLC0415

    from app.workers.mixed_nesting_pdf_source import _subpaths_of  # noqa: PLC0415
    from app.workers.pdf_content_parser import extract_vector_paths  # noqa: PLC0415

    result: list[ReadBackRing] = []
    document = pikepdf.Pdf.open(io.BytesIO(pdf_bytes))
    try:
        for page_index, page in enumerate(document.pages):
            media = page.mediabox
            height_pt = float(media[3] - media[1])
            for drawing in extract_vector_paths(page, document):
                items = drawing.get("items") or []
                if not items:
                    continue
                for ring in _subpaths_of(items, height_pt):
                    result.append(ReadBackRing(sheet_index=page_index, ring_mm=ring))
    finally:
        document.close()
    return result


def ring_centroid(ring: Sequence[Point]) -> Optional[Point]:
    return derive_reference_point(ring)


def expected_rings(
    *, manifest: dict[str, Any], parts: Sequence[PartGeometry]
) -> list[ReadBackRing]:
    """Vòng **mong đợi** trên từng tờ, tính lại từ manifest. Dùng để so với bản đọc lại."""
    by_id = {item.part_id: item for item in parts}
    result: list[ReadBackRing] = []
    for placement in manifest.get("placements", []):
        part = by_id[placement["partId"]]
        reference = derive_reference_point(part.outer)
        if reference is None:
            continue
        pose = placement["pose"]
        for ring in [part.outer, *part.holes]:
            result.append(
                ReadBackRing(
                    sheet_index=int(placement["sheetIndex"]),
                    ring_mm=transform_ring(
                        ring,
                        float(pose["rotationDeg"]),
                        float(pose["translateXmm"]),
                        float(pose["translateYmm"]),
                        reference,
                    ),
                )
            )
    return result
