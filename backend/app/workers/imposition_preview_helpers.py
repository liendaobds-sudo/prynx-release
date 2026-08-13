"""Helper hình học cho preview bình bản, tách khỏi route điều phối."""

from __future__ import annotations

from typing import Any


def build_pont_base_poly(page, result: dict, req: Any, shape_type_hint: str = None):
    """Dựng polygon va chạm từ kích thước ô solver, cùng quy ước với worker."""
    pont = getattr(req, "pont_config", None)
    if not pont or pont.get("disableCollision", False):
        return None

    items = result.get("items") or []
    width = float(items[0].get("width", 0) or 0) if items else 0.0
    height = float(items[0].get("height", 0) or 0) if items else 0.0
    width = width or float(result.get("trimW") or getattr(req, "item_w", 0) or 0)
    height = height or float(result.get("trimH") or getattr(req, "item_h", 0) or 0)
    shape = str(
        result.get("shapeType")
        or shape_type_hint
        or getattr(req, "shape_type", None)
        or ""
    ).upper()
    cut_type = getattr(req, "cut_type", None) or "default"

    if width > 0 and height > 0 and (cut_type == "one_dao" or shape == "RECTANGLE"):
        from shapely.geometry import box

        # PONT (audit 2026-08-13 §RECT-ROT.1): kích thước ô đã phản ánh xoay 90°.
        return box(-width / 2.0, -height / 2.0, width / 2.0, height / 2.0)
    if shape == "CIRCLE_ELLIPSE" and width > 0 and height > 0:
        from shapely.affinity import scale
        from shapely.geometry import Point

        return scale(Point(0, 0).buffer(1.0, resolution=64), xfact=width / 2.0, yfact=height / 2.0)
    try:
        from app.workers.pont_collision import build_shapely_polygon_from_paths

        paths = page.extract_vector_paths()
        if paths:
            return build_shapely_polygon_from_paths(paths, page.rect)
    except Exception:
        pass
    if width > 0 and height > 0:
        from shapely.geometry import box

        return box(-width / 2.0, -height / 2.0, width / 2.0, height / 2.0)
    return None


def resolve_preview_secondary_gap(req: Any) -> float | None:
    """Giữ cùng thứ tự ưu tiên với engine xuất: 1 Dao rồi split gap."""
    from app.workers.pont_collision import MM_TO_PTS

    cut_type = getattr(req, "cut_type", None) or "default"
    fill_block_gap_mm = float(getattr(req, "fill_block_gap", None) or 0)
    split_gap_pt = float(getattr(req, "split_gap", None) or 0)
    if cut_type == "one_dao" and fill_block_gap_mm > 0:
        return fill_block_gap_mm * MM_TO_PTS
    return split_gap_pt if split_gap_pt > 0 else None


def normalize_polygon_to_unit(poly, max_pts: int = 80):
    """Chuẩn hóa outline Shapely về danh sách điểm phân số 0..1 cho UI."""
    if poly is None:
        return None
    try:
        geom = poly
        if getattr(geom, "geom_type", None) == "MultiPolygon":
            geom = max(geom.geoms, key=lambda candidate: candidate.area)
        if getattr(geom, "geom_type", None) != "Polygon":
            return None
        min_x, min_y, max_x, max_y = geom.bounds
        width, height = max_x - min_x, max_y - min_y
        if width <= 0 or height <= 0:
            return None
        try:
            exterior = geom.simplify(
                max(width, height) * 0.005,
                preserve_topology=True,
            ).exterior
        except Exception:
            exterior = geom.exterior
        coordinates = list(exterior.coords)
        if len(coordinates) > max_pts:
            step = len(coordinates) / max_pts
            coordinates = [coordinates[int(index * step)] for index in range(max_pts)]
        return [
            [(x - min_x) / width, (y - min_y) / height]
            for x, y in coordinates
        ]
    except Exception:
        return None


def sticker_capacity_after_pont(
    layout_result: dict,
    req: Any,
    page,
    page_idx: int,
    shape_override: str | None,
    *,
    is_cluster: bool,
    logger,
) -> int:
    """Đếm sức chứa sau né ốc bằng cùng finalize/resolver của preview và export."""
    raw_items = list((layout_result or {}).get("items") or [])
    pont = getattr(req, "pont_config", None)
    if not raw_items or not pont or pont.get("disableCollision", False) or is_cluster:
        return len(raw_items)
    try:
        from app.workers.imposition_finalize import (
            finalize_placements,
            resolve_pont_collisions_on_placements,
        )

        placements = finalize_placements(
            raw_items,
            req.usable_w,
            req.usable_h,
            req.margin_left,
            req.margin_bottom,
            req.margin_top,
            page_idx,
        )
        return len(resolve_pont_collisions_on_placements(
            placements,
            req,
            build_pont_base_poly(page, layout_result, req, shape_override),
        ))
    except Exception as exc:
        logger.warning("[BATCH CAPACITY] page %s pont collision failed: %s", page_idx, exc)
        return len(raw_items)


__all__ = [
    "build_pont_base_poly",
    "normalize_polygon_to_unit",
    "resolve_preview_secondary_gap",
    "sticker_capacity_after_pont",
]
