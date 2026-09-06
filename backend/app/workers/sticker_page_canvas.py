"""Preserve source page boxes after sticker bleed / cutline processing.

The sticker engine historically tight-crops whole-page jobs to the detected
contour. Background removal must not own that page-cropping decision: the
dedicated Crop tool already does. This module restores the source page-box
contract without touching artwork, transparency, bleed, or CutContour content.

When cutline / bleed geometry extends past the original page edge (e.g. a
sticker only 1 mm from the margin with 3 mm bleed), the restored canvas is
expanded just enough to keep that geometry visible. The page never shrinks
below the source canvas.
"""

from __future__ import annotations

import math
import os
import tempfile
from typing import Iterable

import pikepdf


_OPTIONAL_PAGE_BOXES = ("/TrimBox", "/BleedBox", "/ArtBox")
_BOX_EPS = 1e-6


def _read_box(
    page_obj: pikepdf.Object,
    key: str,
    *,
    fallback: Iterable[float] | None = None,
) -> tuple[float, float, float, float]:
    raw = page_obj.get(key)
    if raw is None:
        raw = fallback
    if raw is None:
        raise ValueError(f"Trang PDF thiếu {key}.")

    values = tuple(float(value) for value in raw)
    if (
        len(values) != 4
        or not all(math.isfinite(value) for value in values)
        or values[2] <= values[0]
        or values[3] <= values[1]
    ):
        raise ValueError(f"{key} không hợp lệ: {values!r}")
    return values


def _translate_box_tuple(
    box: tuple[float, float, float, float],
    *,
    source_x0: float,
    source_y0: float,
    expansion_pts: float,
) -> tuple[float, float, float, float]:
    return (
        expansion_pts + box[0] - source_x0,
        expansion_pts + box[1] - source_y0,
        expansion_pts + box[2] - source_x0,
        expansion_pts + box[3] - source_y0,
    )


def _as_array(box: tuple[float, float, float, float]) -> pikepdf.Array:
    return pikepdf.Array(list(box))


def _union_expand_only(
    floor: tuple[float, float, float, float],
    content: tuple[float, float, float, float],
) -> tuple[float, float, float, float]:
    """Expand ``floor`` to cover ``content``; never shrink below ``floor``."""
    return (
        min(floor[0], content[0]),
        min(floor[1], content[1]),
        max(floor[2], content[2]),
        max(floor[3], content[3]),
    )


def _box_strictly_larger(
    candidate: tuple[float, float, float, float],
    floor: tuple[float, float, float, float],
) -> bool:
    return (
        candidate[0] < floor[0] - _BOX_EPS
        or candidate[1] < floor[1] - _BOX_EPS
        or candidate[2] > floor[2] + _BOX_EPS
        or candidate[3] > floor[3] + _BOX_EPS
    )


def expand_preserved_sticker_page_canvas(
    document: pikepdf.Pdf,
    page: pikepdf.Page,
    visible_boxes: Iterable[tuple[float, float, float, float]],
) -> None:
    """Nới trang được copy nguyên vẹn theo CUT/bleed đã vẽ, không dịch artwork."""
    source_media = _read_box(page.obj, "/MediaBox", fallback=page.mediabox)
    source_crop = _read_box(page.obj, "/CropBox", fallback=page.cropbox)
    source_crop = (
        max(source_crop[0], source_media[0]),
        max(source_crop[1], source_media[1]),
        min(source_crop[2], source_media[2]),
        min(source_crop[3], source_media[3]),
    )
    if source_crop[2] <= source_crop[0] or source_crop[3] <= source_crop[1]:
        source_crop = source_media
    final_crop = source_crop
    for box in visible_boxes:
        if (
            len(box) != 4
            or not all(math.isfinite(value) for value in box)
            or box[2] <= box[0]
            or box[3] <= box[1]
        ):
            raise ValueError("Khung đường cắt hoặc bù xén không hợp lệ.")
        final_crop = _union_expand_only(final_crop, box)
    if not _box_strictly_larger(final_crop, source_crop):
        return

    # BLEED (feedback 2026-09-06 §VIEW.1): CropBox mới không được làm lộ
    # artwork vốn đã bị xén khỏi nguồn. Chỉ kẹp các stream cũ trước khi caller
    # thêm bleed/CUT; giữ nguyên text, vector, lớp màu và hệ tọa độ PDF.
    x0, y0, x1, y1 = source_crop
    page.contents_add(pikepdf.Stream(document, (
        f"q {x0:.6f} {y0:.6f} {x1 - x0:.6f} {y1 - y0:.6f} re W n\n"
    ).encode("ascii")), prepend=True)
    page.contents_add(pikepdf.Stream(document, b"\nQ\n"))
    final_media = _union_expand_only(source_media, final_crop)
    page.obj["/MediaBox"] = _as_array(final_media)
    page.obj["/CropBox"] = _as_array(final_crop)
    page.obj["/BleedBox"] = _as_array(final_crop)


def restore_sticker_page_canvas(
    source_path: str,
    output_path: str,
    *,
    expansion_pts: float,
) -> None:
    """Restore every output page box to the corresponding source page canvas.

    ``expansion_pts`` is the symmetric working margin used by StickerEngine.
    Mapping the source CropBox origin to that margin preserves all existing
    content transforms while restoring the original page dimensions.

    If the engine's tight MediaBox/CropBox already extends past that restored
    canvas (bleed or cutline overflow), the page is expanded to the union so
    geometry is not clipped. Dimensions never fall below the source canvas.
    """

    expansion = float(expansion_pts)
    if not math.isfinite(expansion) or expansion < 0:
        raise ValueError("expansion_pts phải là số hữu hạn không âm.")

    output_dir = os.path.dirname(os.path.abspath(output_path)) or "."
    temp_path: str | None = None
    try:
        with (
            pikepdf.Pdf.open(source_path) as source_pdf,
            pikepdf.Pdf.open(output_path) as output_pdf,
        ):
            if len(source_pdf.pages) != len(output_pdf.pages):
                raise ValueError(
                    "Không thể giữ khổ trang: số trang nguồn và kết quả khác nhau."
                )

            for source_page, output_page in zip(
                source_pdf.pages, output_pdf.pages, strict=True
            ):
                source_obj = source_page.obj
                output_obj = output_page.obj
                source_media = _read_box(
                    source_obj,
                    "/MediaBox",
                    fallback=source_page.mediabox,
                )
                source_crop = _read_box(
                    source_obj,
                    "/CropBox",
                    fallback=source_page.cropbox,
                )
                source_x0, source_y0 = source_crop[0], source_crop[1]

                floor_media = _translate_box_tuple(
                    source_media,
                    source_x0=source_x0,
                    source_y0=source_y0,
                    expansion_pts=expansion,
                )
                floor_crop = _translate_box_tuple(
                    source_crop,
                    source_x0=source_x0,
                    source_y0=source_y0,
                    expansion_pts=expansion,
                )

                # Engine may tight-crop to dieline+bleed. Use that as the content
                # extent so overflow past the original page expands the canvas.
                try:
                    engine_media = _read_box(
                        output_obj,
                        "/MediaBox",
                        fallback=output_page.mediabox,
                    )
                except ValueError:
                    engine_media = floor_media
                try:
                    engine_crop = _read_box(
                        output_obj,
                        "/CropBox",
                        fallback=output_page.cropbox,
                    )
                except ValueError:
                    engine_crop = engine_media

                final_media = _union_expand_only(floor_media, engine_media)
                final_crop = _union_expand_only(floor_crop, engine_crop)
                # CropBox must stay inside MediaBox.
                final_crop = (
                    max(final_crop[0], final_media[0]),
                    max(final_crop[1], final_media[1]),
                    min(final_crop[2], final_media[2]),
                    min(final_crop[3], final_media[3]),
                )
                if final_crop[2] <= final_crop[0] or final_crop[3] <= final_crop[1]:
                    final_crop = final_media

                output_obj["/MediaBox"] = _as_array(final_media)
                output_obj["/CropBox"] = _as_array(final_crop)

                expanded = _box_strictly_larger(final_media, floor_media)

                for key in _OPTIONAL_PAGE_BOXES:
                    raw_box = source_obj.get(key)
                    if raw_box is None:
                        if key == "/BleedBox" and expanded:
                            # Page grew to hold bleed/cutline — declare that area.
                            output_obj[key] = _as_array(final_media)
                        elif key in output_obj:
                            del output_obj[key]
                        continue
                    source_box = _read_box(source_obj, key)
                    mapped = _translate_box_tuple(
                        source_box,
                        source_x0=source_x0,
                        source_y0=source_y0,
                        expansion_pts=expansion,
                    )
                    if key == "/BleedBox" and expanded:
                        mapped = _union_expand_only(mapped, final_media)
                    output_obj[key] = _as_array(mapped)

            fd, temp_path = tempfile.mkstemp(
                suffix=".pdf",
                dir=output_dir,
            )
            os.close(fd)
            output_pdf.save(temp_path)

        os.replace(temp_path, output_path)
        temp_path = None
    finally:
        if temp_path and os.path.exists(temp_path):
            try:
                os.unlink(temp_path)
            except OSError:
                pass
