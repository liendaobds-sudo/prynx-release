"""Chuẩn hóa hệ tọa độ trang PDF trước khi bình bản.

Chốt này bake `/UserUnit`, `/Rotate` và gốc MediaBox vào content stream để mọi
engine hạ nguồn chỉ làm việc với point vật lý 1/72 inch, trang không xoay và gốc
`(0, 0)`. File đã chuẩn được giữ nguyên đường dẫn và byte.
"""

import logging
import math
import os
import tempfile
import uuid

import pikepdf

from app.workers.mixed_guillotine_adapter import canonicalize_pikepdf_page_boxes

logger = logging.getLogger(__name__)
ORIGIN_EPS_PT = 0.01


def _page_user_unit(page) -> float:
    try:
        value = float(page.get("/UserUnit", 1) or 1)
    except (TypeError, ValueError, OverflowError):
        return 1.0
    return value if math.isfinite(value) and value > 0 else 1.0


def _page_rotation(page, page_number: int) -> int:
    raw = page.get("/Rotate", 0) or 0
    try:
        value = float(raw)
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValueError(f"Trang {page_number} có /Rotate không hợp lệ: {raw}") from exc
    rounded = round(value)
    if not math.isfinite(value) or abs(value - rounded) > 1e-9:
        raise ValueError(f"Trang {page_number} có /Rotate không hợp lệ: {raw}")
    rotation = int(rounded) % 360
    if rotation not in (0, 90, 180, 270):
        raise ValueError(f"Trang {page_number} có /Rotate không hợp lệ: {raw}")
    return rotation


def _needs_canonicalization(pdf: pikepdf.Pdf) -> bool:
    for page_number, page in enumerate(pdf.pages, start=1):
        if abs(_page_user_unit(page) - 1.0) > 1e-12:
            return True
        if _page_rotation(page, page_number) != 0:
            return True
        try:
            media_box = [float(value) for value in page.MediaBox]
        except Exception:
            continue
        if abs(media_box[0]) > ORIGIN_EPS_PT or abs(media_box[1]) > ORIGIN_EPS_PT:
            return True
    return False


def _page_matrix(page, page_number: int):
    rotation = _page_rotation(page, page_number)
    user_unit = _page_user_unit(page)
    mx0, my0, mx1, my1 = [float(value) for value in page.MediaBox]
    width, height = mx1 - mx0, my1 - my0

    if rotation == 0:
        matrix = (
            user_unit, 0.0, 0.0, user_unit,
            -mx0 * user_unit, -my0 * user_unit,
        )
        new_size = (width * user_unit, height * user_unit)
    elif rotation == 90:
        matrix = (
            0.0, -user_unit, user_unit, 0.0,
            -my0 * user_unit, (mx0 + width) * user_unit,
        )
        new_size = (height * user_unit, width * user_unit)
    elif rotation == 180:
        matrix = (
            -user_unit, 0.0, 0.0, -user_unit,
            (mx0 + width) * user_unit, (my0 + height) * user_unit,
        )
        new_size = (width * user_unit, height * user_unit)
    else:
        matrix = (
            0.0, user_unit, -user_unit, 0.0,
            (my0 + height) * user_unit, -mx0 * user_unit,
        )
        new_size = (height * user_unit, width * user_unit)
    return matrix, new_size, user_unit, rotation, mx0, my0


def canonicalize_page_space_file(source_path: str, job_id: str = None) -> tuple[str, bool]:
    """Trả `(path, is_temp)` sau khi chuẩn hóa trang; lỗi thì fail-open có log."""
    try:
        pdf = pikepdf.Pdf.open(source_path)
        try:
            if not _needs_canonicalization(pdf):
                return source_path, False

            for page_number, page in enumerate(pdf.pages, start=1):
                matrix, new_size, user_unit, rotation, mx0, my0 = _page_matrix(
                    page, page_number,
                )
                if (
                    rotation == 0
                    and abs(mx0) <= ORIGIN_EPS_PT
                    and abs(my0) <= ORIGIN_EPS_PT
                    and abs(user_unit - 1.0) <= 1e-12
                ):
                    continue
                a, b, c, d, e, f = matrix
                prefix = (
                    f"q {a:.6g} {b:.6g} {c:.6g} {d:.6g} {e:.4f} {f:.4f} cm\n"
                ).encode("ascii")
                if "/Contents" in page.obj:
                    page.contents_coalesce()
                    stream = page.obj["/Contents"]
                    stream.write(prefix + stream.read_bytes() + b"\nQ")
                else:
                    page.obj["/Contents"] = pikepdf.Stream(pdf, prefix + b"Q")
                canonicalize_pikepdf_page_boxes(page, matrix, new_size)
                if "/UserUnit" in page.obj:
                    del page.obj[pikepdf.Name("/UserUnit")]

            owner = "".join(
                char for char in str(job_id or "") if char.isalnum() or char in "-_"
            ) or "direct"
            output = os.path.join(
                tempfile.gettempdir(), f"nup_canon_{owner}_{uuid.uuid4().hex}.pdf",
            )
            pdf.save(output)
            return output, True
        finally:
            pdf.close()
    except Exception as exc:
        logger.warning(
            "[PAGE-CANON] bỏ qua canonicalize /UserUnit + /Rotate + gốc MediaBox "
            "(%s); dùng file gốc.",
            exc,
        )
        return source_path, False
