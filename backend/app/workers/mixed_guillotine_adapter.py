"""Adapter giữa MixedGuillotinePlan và contract cũ của N-Up renderer.

MIXED-GUILLOTINE (audit 2026-07-30 §MG.4–§MG.5): planner giữ tọa độ
top-left; renderer cũ cần đồng thời `original_cell_y` top-left và `abs_y`
bottom-up. Mặt sau đã được materialize ở đây nên worker không được mirror lần nữa.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

import pikepdf

from app.core.imposition_page_box import effective_imposition_box
from app.workers.mixed_guillotine import (
    MixedGuillotineError,
    ProductSpec,
    project_template_face,
    validate_duplex_pair_sizes,
)


def canonicalize_pikepdf_page_boxes(
    page: Any,
    transform: tuple[float, float, float, float, float, float],
    page_size: tuple[float, float],
) -> None:
    """Đưa PageBox về hệ tọa độ đã canonicalize mà không mất trang logic."""
    # GUILLOTINE-BOX FIX (audit 2026-08-04): CropBox có thể là trang logic nhỏ
    # trên canvas lớn; phải chụp mọi PageBox trước khi thay MediaBox.
    original_boxes = {
        box: [float(value) for value in page[box]]
        for box in ("/CropBox", "/TrimBox", "/ArtBox", "/BleedBox")
        if box in page
    }
    ma, mb, mc, md, me, mf = transform
    width, height = page_size
    page.MediaBox = pikepdf.Array([0, 0, width, height])
    page.Rotate = 0
    for box, bounds in original_boxes.items():
        x0, y0, x1, y1 = bounds
        corners = ((x0, y0), (x1, y0), (x1, y1), (x0, y1))
        xs = [ma * x + mc * y + me for x, y in corners]
        ys = [mb * x + md * y + mf for x, y in corners]
        page[box] = pikepdf.Array([min(xs), min(ys), max(xs), max(ys)])
    if "/CropBox" not in original_boxes:
        page.CropBox = pikepdf.Array([0, 0, width, height])


def resolve_guillotine_geometry(
    page: Any,
    bleed_pt: float,
) -> tuple[float, float, tuple[float, float, float, float] | None]:
    """Trả khổ thành phẩm và vùng nguồn cho mọi chế độ bình cắt xén.

    Bleed trên UI là nguồn duy nhất để suy ra khổ thành phẩm. TrimBox nhúng trong
    PDF không được ghi đè lựa chọn đó. CropBox chỉ được chọn khi nó nhỏ đáng kể so
    với MediaBox và thực sự đại diện cho một trang logic trên canvas lớn.

    Renderer dùng toàn bộ hộp trang logic làm vùng có bleed; footprint của solver
    là hộp đó trừ bleed UI ở bốn cạnh. Tọa độ clip trả về theo hệ top-down mà
    ``show_pdf_page`` tiêu thụ.
    """
    rect = page.rect
    bleed = max(0.0, float(bleed_pt))

    # [BLEED-UI FIX 2026-08-12] Không dùng TrimBox làm khổ thành phẩm: nhiều PDF
    # mang TrimBox từ lần xuất trước (ví dụ 3 mm), trong khi người dùng đang chọn
    # bleed khác trên UI. Chỉ giữ ngoại lệ CropBox cho trang con trên canvas lớn.
    logical_box = effective_imposition_box(page)
    logical_width = float(logical_box.width)
    logical_height = float(logical_box.height)
    logical_differs = (
        abs(logical_width - float(rect.width)) > 1.0
        or abs(logical_height - float(rect.height)) > 1.0
    )
    source_clip = None
    if logical_differs and logical_width > 0 and logical_height > 0:
        source_clip = (
            float(logical_box.x0),
            float(rect.height) - float(logical_box.y1),
            float(logical_box.x1),
            float(rect.height) - float(logical_box.y0),
        )
    return (
        max(0.0, logical_width - 2.0 * bleed),
        max(0.0, logical_height - 2.0 * bleed),
        source_clip,
    )


def resolve_guillotine_trim(page: Any, bleed_pt: float) -> tuple[float, float]:
    """Trả footprint chữ nhật dùng chung cho preview và export."""
    width, height, _source_clip = resolve_guillotine_geometry(page, bleed_pt)
    return width, height


def resolve_guillotine_source_clip(
    page: Any,
    bleed_pt: float,
) -> tuple[float, float, float, float] | None:
    """Trả vùng nguồn top-down; ``None`` nghĩa là dùng toàn bộ MediaBox."""
    _width, _height, source_clip = resolve_guillotine_geometry(page, bleed_pt)
    return source_clip


def build_product_specs(
    trim_sizes: Sequence[tuple[float, float]],
    *,
    target_quantity: int,
    target_quantities_by_page: Mapping[Any, Any] | None,
    duplex: bool,
) -> list[ProductSpec]:
    """Chuẩn hóa trang/cặp trang và số lượng thành input thuần của solver."""
    page_count = len(trim_sizes)
    if page_count == 0:
        raise MixedGuillotineError("File PDF không có trang để bình.")
    if duplex and page_count % 2 != 0:
        raise MixedGuillotineError(
            "Bình 2 mặt cần từng cặp trang trước/sau. "
            f"File hiện có {page_count} trang; hãy thêm hoặc xóa 1 trang."
        )

    quantities = target_quantities_by_page or {}

    def quantity_for(page_idx: int) -> int:
        raw = quantities.get(
            str(page_idx), quantities.get(page_idx, target_quantity)
        )
        try:
            return max(0, int(raw or 0))
        except (TypeError, ValueError):
            raise MixedGuillotineError(
                f"Số lượng của sản phẩm tại trang {page_idx + 1} không hợp lệ."
            ) from None

    if duplex:
        pairs = []
        for front_idx in range(0, page_count, 2):
            back_idx = front_idx + 1
            front_w, front_h = trim_sizes[front_idx]
            back_w, back_h = trim_sizes[back_idx]
            pairs.append(
                (front_idx, front_w, front_h, back_idx, back_w, back_h)
            )
        validate_duplex_pair_sizes(pairs)

    products: list[ProductSpec] = []
    unit_count = page_count // 2 if duplex else page_count
    for product_id in range(unit_count):
        front_idx = product_id * 2 if duplex else product_id
        width, height = trim_sizes[front_idx]
        products.append(
            ProductSpec(
                product_id=product_id,
                front_page_idx=front_idx,
                back_page_idx=front_idx + 1 if duplex else None,
                trim_width=float(width),
                trim_height=float(height),
                requested_quantity=quantity_for(front_idx),
                allow_rotate=True,
            )
        )
    return products


def _rotation_flags(rotation: int) -> tuple[bool, bool]:
    normalized = int(rotation) % 360
    if normalized not in (0, 90, 180, 270):
        raise MixedGuillotineError(f"Góc xoay {rotation}° không được hỗ trợ.")
    return normalized in (90, 270), normalized in (180, 270)


def _legacy_placement(
    placement: Mapping[str, Any],
    *,
    sheet_height: float,
    zone_index: int,
    side: str,
    template_id: str,
    physical_sheet_index: int,
) -> dict[str, Any]:
    is_rotated, is_rotated_180 = _rotation_flags(int(placement["rotation"]))
    x = float(placement["x"])
    y = float(placement["y"])
    width = float(placement["width"])
    height = float(placement["height"])
    source_page_idx = int(placement["sourcePageIdx"])
    product_id = int(placement["productId"])
    cell = {
        "x": x,
        "y": y,
        "width": width,
        "height": height,
        "isRotated": is_rotated,
        "isRotated180": is_rotated_180,
        "blockId": product_id,
        "pageIdx": source_page_idx,
        "c": int(placement.get("gridSlot", 0)),
        "r": 0,
    }
    return {
        "cluster_idx": zone_index,
        "cell": cell,
        "src_page_idx": source_page_idx,
        "abs_x": x,
        "abs_y": float(sheet_height) - y - height,
        "width": width,
        "height": height,
        "original_cell_y": y,
        # Worker dùng marker này để không chạy lại mirror duplex legacy.
        "_duplex_transform_applied": side == "back",
        "_mixed_template_id": template_id,
        "_mixed_physical_sheet_index": physical_sheet_index,
        "_mixed_side": side,
    }


def materialize_plan_for_renderer(
    plan: Mapping[str, Any],
    *,
    expand_run_count: bool = True,
) -> tuple[dict[int, list[dict[str, Any]]], dict[int, dict[str, Any]]]:
    """Trả placements theo trang PDF output và metadata từng mặt/tờ vật lý."""
    sheet_width = float(plan["sheetWidth"])
    sheet_height = float(plan["sheetHeight"])
    duplex = bool(plan.get("duplex", False))
    flip_edge = str(plan.get("flipEdge", "long"))
    output: dict[int, list[dict[str, Any]]] = {}
    face_metadata: dict[int, dict[str, Any]] = {}
    output_page_idx = 0
    physical_sheet_idx = 0

    for template in plan["templates"]:
        repeat_count = int(template["runCount"]) if expand_run_count else 1
        for run_ordinal in range(repeat_count):
            sides = ("front", "back") if duplex else ("front",)
            for side in sides:
                face = project_template_face(
                    template,
                    side=side,
                    sheet_width=sheet_width,
                    sheet_height=sheet_height,
                    flip_edge=flip_edge,
                )
                zone_ids = sorted(
                    {str(placement["zoneId"]) for placement in face["placements"]}
                )
                zone_indexes = {
                    zone_id: index for index, zone_id in enumerate(zone_ids)
                }
                output[output_page_idx] = [
                    _legacy_placement(
                        placement,
                        sheet_height=sheet_height,
                        zone_index=zone_indexes[str(placement["zoneId"])],
                        side=side,
                        template_id=str(template["templateId"]),
                        physical_sheet_index=physical_sheet_idx,
                    )
                    for placement in face["placements"]
                ]
                face_metadata[output_page_idx] = {
                    "physicalSheetIndex": physical_sheet_idx,
                    "templateId": str(template["templateId"]),
                    "runOrdinal": run_ordinal,
                    "side": side,
                    "cutTree": face["cutTree"],
                    "cutLines": face["cutLines"],
                    "planHash": plan.get("planHash"),
                }
                output_page_idx += 1
            physical_sheet_idx += 1
    return output, face_metadata


def full_span_cut_coordinates(
    face_metadata: Mapping[str, Any],
    *,
    sheet_width: float,
    sheet_height: float,
    usable_rect: Mapping[str, Any] | None = None,
) -> dict[str, set[float]]:
    """Projection tương thích renderer marks cũ; không kéo dài cut segment cục bộ."""
    bounds = usable_rect or {
        "x": 0.0,
        "y": 0.0,
        "width": sheet_width,
        "height": sheet_height,
    }
    min_x = float(bounds["x"])
    min_y = float(bounds["y"])
    max_x = min_x + float(bounds["width"])
    max_y = min_y + float(bounds["height"])
    vertical: set[float] = set()
    horizontal: set[float] = set()
    for line in face_metadata.get("cutLines", []):
        axis = line.get("axis")
        start = float(line.get("start", 0.0))
        end = float(line.get("end", 0.0))
        if axis == "x" and start <= min_y + 0.01 and end >= max_y - 0.01:
            vertical.add(round(float(line["coordinate"]), 2))
        elif axis == "y" and start <= min_x + 0.01 and end >= max_x - 0.01:
            horizontal.add(round(float(line["coordinate"]), 2))
    return {"v": vertical, "h": horizontal}


__all__ = [
    "build_product_specs",
    "canonicalize_pikepdf_page_boxes",
    "full_span_cut_coordinates",
    "materialize_plan_for_renderer",
    "resolve_guillotine_geometry",
    "resolve_guillotine_source_clip",
    "resolve_guillotine_trim",
]
