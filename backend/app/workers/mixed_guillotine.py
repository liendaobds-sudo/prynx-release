"""Solver Bình cắt xén nhiều kích thước có chứng minh đường dao.

MIXED-GUILLOTINE (audit 2026-07-30 §MG.3–§MG.7): module này chỉ xử lý
hình học thuần trên hệ tọa độ canonical top-left, đơn vị point. Nó không mở PDF,
không giữ PDF handle và không tự render. Preview và export phải dùng cùng plan.
"""

from __future__ import annotations

import copy
import hashlib
import json
import math
from dataclasses import asdict, dataclass
from typing import Any, Iterable, Literal, Mapping, Sequence

from app.workers.nup_layout_solver import solve_grid


PLAN_VERSION = "mixed-guillotine/v1"
COORDINATE_SPACE = "canonical_top_left_sheet_pt"
PAIR_SIZE_TOLERANCE_PT = 0.5
GEOMETRY_TOLERANCE_PT = 0.01
ROUND_DIGITS = 6


class MixedGuillotineError(ValueError):
    """Lỗi nghiệp vụ có thể hiển thị trực tiếp cho người dùng."""


@dataclass(frozen=True)
class Rect:
    x: float
    y: float
    width: float
    height: float


@dataclass(frozen=True)
class ProductSpec:
    product_id: int
    front_page_idx: int
    trim_width: float
    trim_height: float
    requested_quantity: int = 0
    back_page_idx: int | None = None
    allow_rotate: bool = True


@dataclass(frozen=True)
class MixedGuillotineSettings:
    sheet_width: float
    sheet_height: float
    usable_rect: Rect
    gap_x: float = 0.0
    gap_y: float = 0.0
    duplex: bool = False
    flip_edge: Literal["long", "short"] = "long"


@dataclass
class _Candidate:
    family: str
    family_rank: int
    products: list[ProductSpec]
    placements: list[dict[str, Any]]
    cut_tree: dict[str, Any]
    cut_lines: list[dict[str, Any]]
    capacities: dict[int, int]
    used_trim_area: float
    rotation_count: int
    score: tuple[Any, ...] = ()


def _q(value: float) -> float:
    return round(float(value), ROUND_DIGITS)


def _rect_dict(rect: Rect) -> dict[str, float]:
    return {
        "x": _q(rect.x),
        "y": _q(rect.y),
        "width": _q(rect.width),
        "height": _q(rect.height),
    }


def _dict_rect(value: Mapping[str, Any]) -> Rect:
    return Rect(
        float(value["x"]),
        float(value["y"]),
        float(value["width"]),
        float(value["height"]),
    )


def _rect_close(first: Rect, second: Rect, tolerance: float = GEOMETRY_TOLERANCE_PT) -> bool:
    return (
        abs(first.x - second.x) <= tolerance
        and abs(first.y - second.y) <= tolerance
        and abs(first.width - second.width) <= tolerance
        and abs(first.height - second.height) <= tolerance
    )


def _validate_inputs(
    products: Sequence[ProductSpec], settings: MixedGuillotineSettings
) -> list[ProductSpec]:
    if not products:
        raise MixedGuillotineError("Chưa có sản phẩm để dàn nhiều kích thước.")
    if settings.sheet_width <= 0 or settings.sheet_height <= 0:
        raise MixedGuillotineError("Khổ giấy phải lớn hơn 0.")
    usable = settings.usable_rect
    if usable.width <= 0 or usable.height <= 0:
        raise MixedGuillotineError("Lề hiện tại không còn vùng giấy khả dụng.")
    if (
        usable.x < -GEOMETRY_TOLERANCE_PT
        or usable.y < -GEOMETRY_TOLERANCE_PT
        or usable.x + usable.width > settings.sheet_width + GEOMETRY_TOLERANCE_PT
        or usable.y + usable.height > settings.sheet_height + GEOMETRY_TOLERANCE_PT
    ):
        raise MixedGuillotineError("Vùng giấy khả dụng nằm ngoài khổ giấy.")
    if settings.gap_x < 0 or settings.gap_y < 0:
        raise MixedGuillotineError("Khoảng hở không được nhỏ hơn 0.")
    if settings.flip_edge not in ("long", "short"):
        raise MixedGuillotineError("Cạnh lật phải là cạnh dài hoặc cạnh ngắn.")

    normalized = sorted(products, key=lambda product: (product.front_page_idx, product.product_id))
    seen_ids: set[int] = set()
    for product in normalized:
        if product.product_id in seen_ids:
            raise MixedGuillotineError(f"Mã sản phẩm {product.product_id} bị trùng.")
        seen_ids.add(product.product_id)
        if product.trim_width <= 0 or product.trim_height <= 0:
            raise MixedGuillotineError(
                f"Trang {product.front_page_idx + 1} có kích thước thành phẩm không hợp lệ."
            )
        if product.requested_quantity < 0:
            raise MixedGuillotineError(
                f"Số lượng sản phẩm {product.product_id + 1} không được nhỏ hơn 0."
            )
        if settings.duplex and product.back_page_idx is None:
            raise MixedGuillotineError(
                f"Sản phẩm {product.product_id + 1} chưa có trang mặt sau."
            )
        if not _product_fits_rect(product, usable):
            rotate_text = " kể cả khi xoay 90°" if product.allow_rotate else ""
            raise MixedGuillotineError(
                f"Trang {product.front_page_idx + 1} ({product.trim_width:.2f} × "
                f"{product.trim_height:.2f} pt) lớn hơn vùng giấy khả dụng "
                f"{usable.width:.2f} × {usable.height:.2f} pt{rotate_text}."
            )
    return normalized


def validate_duplex_pair_sizes(
    pairs: Sequence[tuple[int, float, float, int, float, float]],
    tolerance: float = PAIR_SIZE_TOLERANCE_PT,
) -> None:
    """Kiểm tra `(front_idx, fw, fh, back_idx, bw, bh)` trước khi tạo ProductSpec."""
    for front_idx, front_w, front_h, back_idx, back_w, back_h in pairs:
        if abs(front_w - back_w) > tolerance or abs(front_h - back_h) > tolerance:
            raise MixedGuillotineError(
                "Bình 2 mặt yêu cầu mặt trước/sau của cùng một sản phẩm có cùng "
                f"kích thước thành phẩm. Cặp trang {front_idx + 1}–{back_idx + 1}: "
                f"{front_w:.2f} × {front_h:.2f} pt và "
                f"{back_w:.2f} × {back_h:.2f} pt."
            )


def _product_fits_rect(product: ProductSpec, rect: Rect) -> bool:
    normal = (
        product.trim_width <= rect.width + GEOMETRY_TOLERANCE_PT
        and product.trim_height <= rect.height + GEOMETRY_TOLERANCE_PT
    )
    rotated = (
        product.allow_rotate
        and product.trim_height <= rect.width + GEOMETRY_TOLERANCE_PT
        and product.trim_width <= rect.height + GEOMETRY_TOLERANCE_PT
    )
    return normal or rotated


def _minimum_span(product: ProductSpec, rect: Rect, axis: Literal["x", "y"]) -> float | None:
    spans: list[float] = []
    if axis == "x":
        if product.trim_height <= rect.height + GEOMETRY_TOLERANCE_PT:
            spans.append(product.trim_width)
        if product.allow_rotate and product.trim_width <= rect.height + GEOMETRY_TOLERANCE_PT:
            spans.append(product.trim_height)
    else:
        if product.trim_width <= rect.width + GEOMETRY_TOLERANCE_PT:
            spans.append(product.trim_height)
        if product.allow_rotate and product.trim_height <= rect.width + GEOMETRY_TOLERANCE_PT:
            spans.append(product.trim_width)
    return min(spans) if spans else None


def _allocate_spans(
    total: float, gap: float, minimums: Sequence[float], weights: Sequence[float]
) -> list[float] | None:
    count = len(minimums)
    if count == 0:
        return None
    available = total - gap * max(0, count - 1)
    if available <= 0 or sum(minimums) > available + GEOMETRY_TOLERANCE_PT:
        return None
    extra = max(0.0, available - sum(minimums))
    positive_weights = [max(0.0, float(weight)) for weight in weights]
    weight_sum = sum(positive_weights)
    if weight_sum <= 0:
        positive_weights = [1.0] * count
        weight_sum = float(count)
    spans = [
        float(minimum) + extra * positive_weights[idx] / weight_sum
        for idx, minimum in enumerate(minimums)
    ]
    # Dồn nhiễu float vào phần cuối để tổng span + gap luôn đúng parent.
    spans[-1] += available - sum(spans)
    return [_q(span) for span in spans]


def _layout_measure(layout: Mapping[str, Any], key: str) -> float:
    aliases = {
        "width": ("width", "overallWidth"),
        "height": ("height", "overallHeight"),
    }
    for alias in aliases[key]:
        value = layout.get(alias)
        if value is not None:
            return float(value)
    return 0.0


def _solve_zone(
    product: ProductSpec,
    zone_rect: Rect,
    zone_id: str,
    gap_x: float,
    gap_y: float,
) -> tuple[dict[str, Any], list[dict[str, Any]]] | None:
    """Chỉ chọn một lưới orientation đồng nhất để cây cắt trong zone luôn rõ."""
    candidates: list[tuple[int, dict[str, Any], int]] = []
    normal = solve_grid(
        zone_rect.width,
        zone_rect.height,
        product.trim_width,
        product.trim_height,
        gap_x,
        gap_y,
        False,
    )
    candidates.append((0, normal, 0))
    if product.allow_rotate:
        rotated = solve_grid(
            zone_rect.width,
            zone_rect.height,
            product.trim_height,
            product.trim_width,
            gap_x,
            gap_y,
            True,
        )
        candidates.append((1, rotated, 90))

    candidates.sort(
        key=lambda item: (
            -len(item[1].get("cells", []) or []),
            item[0],  # hòa yield thì ưu tiên không xoay
        )
    )
    _rank, layout, rotation = candidates[0]
    cells = sorted(
        layout.get("cells", []) or [],
        key=lambda cell: (
            int(cell.get("r", 0)),
            int(cell.get("c", 0)),
            float(cell.get("y", 0.0)),
            float(cell.get("x", 0.0)),
        ),
    )
    if not cells:
        return None

    content_width = _layout_measure(layout, "width")
    content_height = _layout_measure(layout, "height")
    offset_x = max(0.0, (zone_rect.width - content_width) / 2.0)
    offset_y = max(0.0, (zone_rect.height - content_height) / 2.0)
    content_rect = Rect(
        zone_rect.x + offset_x,
        zone_rect.y + offset_y,
        content_width,
        content_height,
    )
    item_width = product.trim_height if rotation == 90 else product.trim_width
    item_height = product.trim_width if rotation == 90 else product.trim_height
    cols = int(layout.get("cols", 0) or 0)
    rows = int(layout.get("rows", 0) or 0)
    if cols <= 0:
        cols = max((int(cell.get("c", 0)) for cell in cells), default=-1) + 1
    if rows <= 0:
        rows = max((int(cell.get("r", 0)) for cell in cells), default=-1) + 1

    placements: list[dict[str, Any]] = []
    for slot, cell in enumerate(cells):
        placements.append(
            {
                "productId": product.product_id,
                "zoneId": zone_id,
                "frontPageIdx": product.front_page_idx,
                "backPageIdx": product.back_page_idx,
                "sourcePageIdx": product.front_page_idx,
                "x": _q(content_rect.x + float(cell.get("x", 0.0))),
                "y": _q(content_rect.y + float(cell.get("y", 0.0))),
                "width": _q(float(cell.get("width", item_width))),
                "height": _q(float(cell.get("height", item_height))),
                "rotation": rotation,
                "gridSlot": slot,
            }
        )

    leaf = {
        "kind": "zone",
        "rect": _rect_dict(zone_rect),
        "zoneId": zone_id,
        "productId": product.product_id,
        "grid": {
            "contentRect": _rect_dict(content_rect),
            "cols": cols,
            "rows": rows,
            "itemWidth": _q(item_width),
            "itemHeight": _q(item_height),
            "gapX": _q(gap_x),
            "gapY": _q(gap_y),
            "rotation": rotation,
            "capacity": len(placements),
            "occupiedSlots": list(range(len(placements))),
            "cutOrder": "columns_then_rows",
        },
    }
    return leaf, placements


def _waste_leaf(rect: Rect, zone_id: str) -> dict[str, Any]:
    return {
        "kind": "waste",
        "rect": _rect_dict(rect),
        "zoneId": zone_id,
        "productId": None,
    }


def _build_sequence_tree(
    nodes: Sequence[dict[str, Any]],
    rects: Sequence[Rect],
    parent_rect: Rect,
    axis: Literal["x", "y"],
    gap: float,
) -> dict[str, Any]:
    if len(nodes) != len(rects) or not nodes:
        raise MixedGuillotineError("Không thể dựng cây cắt từ danh sách vùng rỗng.")
    if len(nodes) == 1:
        return nodes[0]

    first_node = nodes[0]
    first_rect = rects[0]
    if axis == "x":
        gap_start = first_rect.x + first_rect.width
        gap_end = gap_start + gap
        second_rect = Rect(
            gap_end,
            parent_rect.y,
            max(0.0, parent_rect.x + parent_rect.width - gap_end),
            parent_rect.height,
        )
    else:
        gap_start = first_rect.y + first_rect.height
        gap_end = gap_start + gap
        second_rect = Rect(
            parent_rect.x,
            gap_end,
            parent_rect.width,
            max(0.0, parent_rect.y + parent_rect.height - gap_end),
        )
    second_node = _build_sequence_tree(
        nodes[1:], rects[1:], second_rect, axis, gap
    )
    return {
        "kind": "split",
        "rect": _rect_dict(parent_rect),
        "axis": axis,
        "gapStart": _q(gap_start),
        "gapEnd": _q(gap_end),
        "first": first_node,
        "second": second_node,
    }


def _tree_cut_lines(tree: Mapping[str, Any]) -> list[dict[str, Any]]:
    lines: list[dict[str, Any]] = []
    # PERF (audit 2026-07-30 §MG.3): khử trùng nhát cắt O(1), tránh quét lại danh sách O(n²).
    seen_lines: set[tuple[Any, ...]] = set()
    order = 0

    def add_line(
        axis: Literal["x", "y"],
        coordinate: float,
        start: float,
        end: float,
        kind: str,
    ) -> None:
        nonlocal order
        key = (
            axis,
            _q(coordinate),
            _q(start),
            _q(end),
            kind,
        )
        if key in seen_lines:
            return
        seen_lines.add(key)
        lines.append(
            {
                "axis": axis,
                "coordinate": key[1],
                "start": key[2],
                "end": key[3],
                "order": order,
                "kind": kind,
            }
        )
        order += 1

    def walk(node: Mapping[str, Any]) -> None:
        kind = node.get("kind")
        rect = _dict_rect(node["rect"])
        if kind == "split":
            axis = node["axis"]
            start = rect.y if axis == "x" else rect.x
            end = rect.y + rect.height if axis == "x" else rect.x + rect.width
            add_line(axis, float(node["gapStart"]), start, end, "zone")
            if abs(float(node["gapEnd"]) - float(node["gapStart"])) > GEOMETRY_TOLERANCE_PT:
                add_line(axis, float(node["gapEnd"]), start, end, "zone")
            walk(node["first"])
            walk(node["second"])
            return
        if kind != "zone":
            return

        grid = node["grid"]
        content = _dict_rect(grid["contentRect"])
        cols = int(grid["cols"])
        rows = int(grid["rows"])
        item_width = float(grid["itemWidth"])
        item_height = float(grid["itemHeight"])
        gap_x = float(grid["gapX"])
        gap_y = float(grid["gapY"])
        x_values: set[float] = {content.x, content.x + content.width}
        y_values: set[float] = {content.y, content.y + content.height}
        for col in range(cols):
            left = content.x + col * (item_width + gap_x)
            x_values.add(left)
            x_values.add(left + item_width)
        for row in range(rows):
            top = content.y + row * (item_height + gap_y)
            y_values.add(top)
            y_values.add(top + item_height)
        for x_value in sorted(x_values):
            add_line("x", x_value, rect.y, rect.y + rect.height, "item")
        for y_value in sorted(y_values):
            add_line("y", y_value, rect.x, rect.x + rect.width, "item")

    walk(tree)
    return lines


def _candidate_from_strips(
    products: Sequence[ProductSpec],
    settings: MixedGuillotineSettings,
    remaining: Mapping[int, int],
    axis: Literal["x", "y"],
    weight_mode: Literal["equal", "demand"],
) -> _Candidate | None:
    usable = settings.usable_rect
    minimums: list[float] = []
    for product in products:
        minimum = _minimum_span(product, usable, axis)
        if minimum is None:
            return None
        minimums.append(minimum)
    weights = []
    for product in products:
        if weight_mode == "equal":
            weights.append(1.0)
        else:
            demand = max(1, int(remaining.get(product.product_id, 1)))
            weights.append(float(demand) * product.trim_width * product.trim_height)
    max_weight = max(weights, default=1.0)
    normalized_weights = [weight / max_weight for weight in weights]
    total = usable.width if axis == "x" else usable.height
    gap = settings.gap_x if axis == "x" else settings.gap_y
    spans = _allocate_spans(total, gap, minimums, normalized_weights)
    if spans is None:
        return None

    rects: list[Rect] = []
    cursor = usable.x if axis == "x" else usable.y
    for span in spans:
        if axis == "x":
            rect = Rect(cursor, usable.y, span, usable.height)
        else:
            rect = Rect(usable.x, cursor, usable.width, span)
        rects.append(rect)
        cursor += span + gap

    leaves: list[dict[str, Any]] = []
    placements: list[dict[str, Any]] = []
    capacities: dict[int, int] = {}
    for index, (product, rect) in enumerate(zip(products, rects), start=1):
        solved = _solve_zone(
            product,
            rect,
            f"Z{index:03d}",
            settings.gap_x,
            settings.gap_y,
        )
        if solved is None:
            return None
        leaf, zone_placements = solved
        leaves.append(leaf)
        placements.extend(zone_placements)
        capacities[product.product_id] = len(zone_placements)

    tree = _build_sequence_tree(leaves, rects, usable, axis, gap)
    lines = _tree_cut_lines(tree)
    family = f"{'vertical' if axis == 'x' else 'horizontal'}_{weight_mode}"
    family_rank = {
        "vertical_equal": 0,
        "vertical_demand": 1,
        "horizontal_equal": 2,
        "horizontal_demand": 3,
    }[family]
    return _Candidate(
        family=family,
        family_rank=family_rank,
        products=list(products),
        placements=placements,
        cut_tree=tree,
        cut_lines=lines,
        capacities=capacities,
        used_trim_area=sum(
            capacities[product.product_id] * product.trim_width * product.trim_height
            for product in products
        ),
        rotation_count=sum(1 for placement in placements if placement["rotation"] != 0),
    )


def _grid_shapes(count: int) -> list[tuple[int, int]]:
    if count <= 0:
        return []
    root = max(1, math.isqrt(count))
    shapes: set[tuple[int, int]] = {(count, 1), (1, count)}
    for cols in range(1, root + 2):
        rows = math.ceil(count / cols)
        shapes.add((cols, rows))
        shapes.add((rows, cols))
    return sorted(shapes, key=lambda shape: (shape[0] * shape[1], abs(shape[0] - shape[1]), shape))


def _candidate_from_grid(
    products: Sequence[ProductSpec],
    settings: MixedGuillotineSettings,
    cols: int,
    rows: int,
) -> _Candidate | None:
    usable = settings.usable_rect
    zone_width = (usable.width - max(0, cols - 1) * settings.gap_x) / cols
    zone_height = (usable.height - max(0, rows - 1) * settings.gap_y) / rows
    if zone_width <= 0 or zone_height <= 0:
        return None

    leaves_by_position: dict[tuple[int, int], dict[str, Any]] = {}
    rects_by_position: dict[tuple[int, int], Rect] = {}
    placements: list[dict[str, Any]] = []
    capacities: dict[int, int] = {}
    for row in range(rows):
        for col in range(cols):
            slot = row * cols + col
            rect = Rect(
                usable.x + col * (zone_width + settings.gap_x),
                usable.y + row * (zone_height + settings.gap_y),
                zone_width,
                zone_height,
            )
            zone_id = f"Z{slot + 1:03d}"
            rects_by_position[(col, row)] = rect
            if slot >= len(products):
                leaves_by_position[(col, row)] = _waste_leaf(rect, zone_id)
                continue
            product = products[slot]
            solved = _solve_zone(
                product,
                rect,
                zone_id,
                settings.gap_x,
                settings.gap_y,
            )
            if solved is None:
                return None
            leaf, zone_placements = solved
            leaves_by_position[(col, row)] = leaf
            placements.extend(zone_placements)
            capacities[product.product_id] = len(zone_placements)

    column_nodes: list[dict[str, Any]] = []
    column_rects: list[Rect] = []
    for col in range(cols):
        nodes = [leaves_by_position[(col, row)] for row in range(rows)]
        rects = [rects_by_position[(col, row)] for row in range(rows)]
        column_rect = Rect(rects[0].x, usable.y, zone_width, usable.height)
        column_nodes.append(
            _build_sequence_tree(
                nodes,
                rects,
                column_rect,
                "y",
                settings.gap_y,
            )
        )
        column_rects.append(column_rect)
    tree = _build_sequence_tree(
        column_nodes,
        column_rects,
        usable,
        "x",
        settings.gap_x,
    )
    lines = _tree_cut_lines(tree)
    return _Candidate(
        family=f"grid_{cols}x{rows}",
        family_rank=10 + cols * rows,
        products=list(products),
        placements=placements,
        cut_tree=tree,
        cut_lines=lines,
        capacities=capacities,
        used_trim_area=sum(
            capacities[product.product_id] * product.trim_width * product.trim_height
            for product in products
        ),
        rotation_count=sum(1 for placement in placements if placement["rotation"] != 0),
    )


def _candidate_signature(candidate: _Candidate) -> tuple[Any, ...]:
    return tuple(
        (
            placement["productId"],
            placement["zoneId"],
            placement["x"],
            placement["y"],
            placement["width"],
            placement["height"],
            placement["rotation"],
        )
        for placement in candidate.placements
    )


def _score_candidate(
    candidate: _Candidate,
    active_count: int,
    remaining: Mapping[int, int],
) -> tuple[Any, ...]:
    missing_count = active_count - len(candidate.products)
    estimated_runs = 1
    ratios: list[float] = []
    served_area = 0.0
    for product in candidate.products:
        quantity = max(1, int(remaining.get(product.product_id, 1)))
        capacity = max(1, candidate.capacities[product.product_id])
        estimated_runs = max(estimated_runs, math.ceil(quantity / capacity))
        ratios.append(quantity / capacity)
        served_area += (
            min(quantity, capacity) * product.trim_width * product.trim_height
        )
    imbalance = max(ratios, default=0.0) - min(ratios, default=0.0)
    return (
        missing_count,
        estimated_runs,
        _q(imbalance),
        -_q(served_area),
        -_q(candidate.used_trim_area),
        len(candidate.cut_lines),
        candidate.rotation_count,
        candidate.family_rank,
        tuple(product.product_id for product in candidate.products),
        _candidate_signature(candidate),
    )


def _all_candidates(
    products: Sequence[ProductSpec],
    settings: MixedGuillotineSettings,
    remaining: Mapping[int, int],
) -> list[_Candidate]:
    candidates: list[_Candidate] = []
    for axis in ("x", "y"):
        for weight_mode in ("equal", "demand"):
            candidate = _candidate_from_strips(
                products, settings, remaining, axis, weight_mode
            )
            if candidate is not None:
                candidates.append(candidate)
    for cols, rows in _grid_shapes(len(products)):
        candidate = _candidate_from_grid(products, settings, cols, rows)
        if candidate is not None:
            candidates.append(candidate)

    unique: dict[tuple[Any, ...], _Candidate] = {}
    for candidate in candidates:
        signature = _candidate_signature(candidate)
        previous = unique.get(signature)
        if previous is None or candidate.family_rank < previous.family_rank:
            unique[signature] = candidate
    return list(unique.values())


def _candidate_groups(
    active: Sequence[ProductSpec],
    settings: MixedGuillotineSettings,
    remaining: Mapping[int, int],
) -> list[list[ProductSpec]]:
    """Ưu tiên toàn bộ; nếu không vừa thì tạo các tập con cực đại ổn định."""
    if _all_candidates(active, settings, remaining):
        return [list(active)]

    groups: dict[tuple[int, ...], list[ProductSpec]] = {}
    for seed in active:
        group = [seed]
        for product in active:
            if product.product_id == seed.product_id:
                continue
            proposal = sorted(
                [*group, product],
                key=lambda item: (item.front_page_idx, item.product_id),
            )
            if _all_candidates(proposal, settings, remaining):
                group = proposal
        signature = tuple(product.product_id for product in group)
        groups[signature] = group
    for product in active:
        groups.setdefault((product.product_id,), [product])
    return sorted(
        groups.values(),
        key=lambda group: (-len(group), tuple(product.product_id for product in group)),
    )


def _choose_candidate(
    active: Sequence[ProductSpec],
    settings: MixedGuillotineSettings,
    remaining: Mapping[int, int],
) -> _Candidate:
    candidates: list[_Candidate] = []
    for group in _candidate_groups(active, settings, remaining):
        candidates.extend(_all_candidates(group, settings, remaining))
    if not candidates:
        product = active[0]
        raise MixedGuillotineError(
            f"Không tìm được cách cắt thẳng an toàn cho sản phẩm {product.product_id + 1}."
        )
    for candidate in candidates:
        candidate.score = _score_candidate(candidate, len(active), remaining)
    return min(candidates, key=lambda candidate: candidate.score)


def _set_occupied_slots(
    tree: dict[str, Any], counts: Mapping[int, int]
) -> None:
    kind = tree.get("kind")
    if kind == "split":
        _set_occupied_slots(tree["first"], counts)
        _set_occupied_slots(tree["second"], counts)
    elif kind == "zone":
        capacity = int(tree["grid"]["capacity"])
        occupied = min(capacity, max(0, int(counts.get(int(tree["productId"]), 0))))
        tree["grid"]["occupiedSlots"] = list(range(occupied))


def _materialize_template(
    candidate: _Candidate,
    counts: Mapping[int, int],
    run_count: int,
    template_index: int,
) -> dict[str, Any]:
    template_id = f"T{template_index:03d}"
    used_by_product: dict[int, int] = {int(product_id): 0 for product_id in counts}
    placements: list[dict[str, Any]] = []
    for placement in candidate.placements:
        product_id = int(placement["productId"])
        if used_by_product.get(product_id, 0) >= int(counts.get(product_id, 0)):
            continue
        copied = dict(placement)
        copied["placementId"] = f"{template_id}-P{len(placements) + 1:04d}"
        placements.append(copied)
        used_by_product[product_id] = used_by_product.get(product_id, 0) + 1

    tree = copy.deepcopy(candidate.cut_tree)
    _set_occupied_slots(tree, used_by_product)
    placed_by_product = [
        {
            "productId": product_id,
            "placedPerRun": used_by_product[product_id],
        }
        for product_id in sorted(used_by_product)
        if used_by_product[product_id] > 0
    ]
    return {
        "templateId": template_id,
        "family": candidate.family,
        "runCount": int(run_count),
        "placements": placements,
        "cutTree": tree,
        "cutLines": copy.deepcopy(candidate.cut_lines),
        "placedByProduct": placed_by_product,
    }


def _build_templates(
    products: Sequence[ProductSpec], settings: MixedGuillotineSettings
) -> list[dict[str, Any]]:
    explicit_quantities = any(product.requested_quantity > 0 for product in products)
    if not explicit_quantities:
        remaining = {product.product_id: 1 for product in products}
        candidate = _choose_candidate(products, settings, remaining)
        counts = dict(candidate.capacities)
        return [_materialize_template(candidate, counts, 1, 1)]

    remaining = {
        product.product_id: int(product.requested_quantity)
        for product in products
        if product.requested_quantity > 0
    }
    by_id = {product.product_id: product for product in products}
    templates: list[dict[str, Any]] = []
    while remaining:
        active = [by_id[product_id] for product_id in sorted(remaining)]
        candidate = _choose_candidate(active, settings, remaining)
        covered_ids = [product.product_id for product in candidate.products]
        bulk_runs = min(
            remaining[product_id] // candidate.capacities[product_id]
            for product_id in covered_ids
        )
        if bulk_runs > 0:
            counts = {
                product_id: candidate.capacities[product_id]
                for product_id in covered_ids
            }
            run_count = bulk_runs
        else:
            counts = {
                product_id: min(
                    remaining[product_id], candidate.capacities[product_id]
                )
                for product_id in covered_ids
            }
            run_count = 1
        if not any(counts.values()):
            raise MixedGuillotineError("Solver không đặt được sản phẩm nào lên tờ.")

        templates.append(
            _materialize_template(
                candidate,
                counts,
                run_count,
                len(templates) + 1,
            )
        )
        for product_id, count in counts.items():
            remaining[product_id] -= count * run_count
            if remaining[product_id] <= 0:
                remaining.pop(product_id, None)
    return templates


def _totals(
    products: Sequence[ProductSpec], templates: Sequence[Mapping[str, Any]]
) -> list[dict[str, int]]:
    actual = {product.product_id: 0 for product in products}
    for template in templates:
        run_count = int(template["runCount"])
        for item in template["placedByProduct"]:
            actual[int(item["productId"])] += int(item["placedPerRun"]) * run_count
    totals = []
    for product in products:
        requested = int(product.requested_quantity)
        actual_quantity = int(actual[product.product_id])
        totals.append(
            {
                "productId": product.product_id,
                "requestedQuantity": requested,
                "actualQuantity": actual_quantity,
                "excessQuantity": max(0, actual_quantity - requested) if requested > 0 else 0,
            }
        )
    return totals


def build_mixed_guillotine_plan(
    products: Sequence[ProductSpec],
    settings: MixedGuillotineSettings,
) -> dict[str, Any]:
    """Dựng plan deterministic; raise lỗi tiếng Việt thay vì trả tờ rỗng."""
    normalized = _validate_inputs(products, settings)
    templates = _build_templates(normalized, settings)
    plan: dict[str, Any] = {
        "version": PLAN_VERSION,
        "coordinateSpace": COORDINATE_SPACE,
        "sheetWidth": _q(settings.sheet_width),
        "sheetHeight": _q(settings.sheet_height),
        "usableRect": _rect_dict(settings.usable_rect),
        "duplex": bool(settings.duplex),
        "flipEdge": settings.flip_edge,
        "products": [asdict(product) for product in normalized],
        "templates": templates,
        "totalsByProduct": _totals(normalized, templates),
    }
    validate_guillotine_plan(plan)
    plan["planHash"] = compute_plan_hash(plan)
    return plan


def _mirror_rect(
    rect: Rect,
    sheet_width: float,
    sheet_height: float,
    flip_edge: Literal["long", "short"],
) -> Rect:
    if flip_edge == "long":
        return Rect(
            sheet_width - rect.x - rect.width,
            rect.y,
            rect.width,
            rect.height,
        )
    return Rect(
        rect.x,
        sheet_height - rect.y - rect.height,
        rect.width,
        rect.height,
    )


def _mirror_tree(
    node: Mapping[str, Any],
    sheet_width: float,
    sheet_height: float,
    flip_edge: Literal["long", "short"],
) -> dict[str, Any]:
    mirrored = copy.deepcopy(dict(node))
    mirrored["rect"] = _rect_dict(
        _mirror_rect(_dict_rect(node["rect"]), sheet_width, sheet_height, flip_edge)
    )
    kind = node.get("kind")
    if kind == "split":
        axis = node["axis"]
        mirrored["first"] = _mirror_tree(
            node["first"], sheet_width, sheet_height, flip_edge
        )
        mirrored["second"] = _mirror_tree(
            node["second"], sheet_width, sheet_height, flip_edge
        )
        if (flip_edge == "long" and axis == "x") or (
            flip_edge == "short" and axis == "y"
        ):
            extent = sheet_width if axis == "x" else sheet_height
            mirrored["gapStart"] = _q(extent - float(node["gapEnd"]))
            mirrored["gapEnd"] = _q(extent - float(node["gapStart"]))
            mirrored["first"], mirrored["second"] = (
                mirrored["second"],
                mirrored["first"],
            )
    elif kind == "zone":
        grid = mirrored["grid"]
        grid["contentRect"] = _rect_dict(
            _mirror_rect(
                _dict_rect(node["grid"]["contentRect"]),
                sheet_width,
                sheet_height,
                flip_edge,
            )
        )
        grid["rotation"] = (-int(grid["rotation"])) % 360
    return mirrored


def _mirror_cut_lines(
    lines: Iterable[Mapping[str, Any]],
    sheet_width: float,
    sheet_height: float,
    flip_edge: Literal["long", "short"],
) -> list[dict[str, Any]]:
    mirrored: list[dict[str, Any]] = []
    for line in lines:
        copied = dict(line)
        axis = copied["axis"]
        if flip_edge == "long":
            if axis == "x":
                copied["coordinate"] = _q(sheet_width - float(copied["coordinate"]))
            else:
                start = sheet_width - float(copied["end"])
                end = sheet_width - float(copied["start"])
                copied["start"], copied["end"] = _q(start), _q(end)
        else:
            if axis == "y":
                copied["coordinate"] = _q(sheet_height - float(copied["coordinate"]))
            else:
                start = sheet_height - float(copied["end"])
                end = sheet_height - float(copied["start"])
                copied["start"], copied["end"] = _q(start), _q(end)
        mirrored.append(copied)
    mirrored.sort(
        key=lambda line: (
            int(line.get("order", 0)),
            line["axis"],
            line["coordinate"],
            line["start"],
        )
    )
    return mirrored


def project_template_face(
    template: Mapping[str, Any],
    *,
    side: Literal["front", "back"],
    sheet_width: float,
    sheet_height: float,
    flip_edge: Literal["long", "short"],
) -> dict[str, Any]:
    """Materialize một mặt; mặt sau đã đổi tọa độ nên renderer không mirror lần nữa."""
    if side not in ("front", "back"):
        raise MixedGuillotineError("Mặt in phải là front hoặc back.")
    if flip_edge not in ("long", "short"):
        raise MixedGuillotineError("Cạnh lật phải là cạnh dài hoặc cạnh ngắn.")
    face = copy.deepcopy(dict(template))
    face["side"] = side
    if side == "front":
        for placement in face["placements"]:
            placement["sourcePageIdx"] = placement["frontPageIdx"]
        return face

    for placement in face["placements"]:
        if placement.get("backPageIdx") is None:
            raise MixedGuillotineError(
                f"Sản phẩm {int(placement['productId']) + 1} chưa có mặt sau."
            )
        rect = _mirror_rect(
            Rect(
                float(placement["x"]),
                float(placement["y"]),
                float(placement["width"]),
                float(placement["height"]),
            ),
            sheet_width,
            sheet_height,
            flip_edge,
        )
        placement["x"] = _q(rect.x)
        placement["y"] = _q(rect.y)
        placement["rotation"] = (-int(placement["rotation"])) % 360
        placement["sourcePageIdx"] = placement["backPageIdx"]
    face["cutTree"] = _mirror_tree(
        template["cutTree"], sheet_width, sheet_height, flip_edge
    )
    face["cutLines"] = _mirror_cut_lines(
        template["cutLines"], sheet_width, sheet_height, flip_edge
    )
    return face


def _validate_tree(
    node: Mapping[str, Any],
    expected_rect: Rect,
    zones: dict[str, Mapping[str, Any]],
) -> None:
    rect = _dict_rect(node["rect"])
    if not _rect_close(rect, expected_rect):
        raise MixedGuillotineError("Cây cắt không phủ đúng vùng cha.")
    kind = node.get("kind")
    if kind in ("zone", "waste"):
        zone_id = str(node["zoneId"])
        if zone_id in zones:
            raise MixedGuillotineError(f"Zone {zone_id} bị khai báo trùng.")
        zones[zone_id] = node
        return
    if kind != "split":
        raise MixedGuillotineError(f"Node cây cắt không hợp lệ: {kind!r}.")

    axis = node.get("axis")
    gap_start = float(node["gapStart"])
    gap_end = float(node["gapEnd"])
    if gap_end + GEOMETRY_TOLERANCE_PT < gap_start:
        raise MixedGuillotineError("Khoảng hở trong cây cắt bị đảo ngược.")
    if axis == "x":
        if not (
            rect.x - GEOMETRY_TOLERANCE_PT
            <= gap_start
            <= gap_end
            <= rect.x + rect.width + GEOMETRY_TOLERANCE_PT
        ):
            raise MixedGuillotineError("Nhát cắt dọc nằm ngoài vùng cha.")
        first_rect = Rect(rect.x, rect.y, gap_start - rect.x, rect.height)
        second_rect = Rect(
            gap_end,
            rect.y,
            rect.x + rect.width - gap_end,
            rect.height,
        )
    elif axis == "y":
        if not (
            rect.y - GEOMETRY_TOLERANCE_PT
            <= gap_start
            <= gap_end
            <= rect.y + rect.height + GEOMETRY_TOLERANCE_PT
        ):
            raise MixedGuillotineError("Nhát cắt ngang nằm ngoài vùng cha.")
        first_rect = Rect(rect.x, rect.y, rect.width, gap_start - rect.y)
        second_rect = Rect(
            rect.x,
            gap_end,
            rect.width,
            rect.y + rect.height - gap_end,
        )
    else:
        raise MixedGuillotineError("Trục cây cắt phải là x hoặc y.")
    if first_rect.width <= 0 or first_rect.height <= 0 or second_rect.width <= 0 or second_rect.height <= 0:
        raise MixedGuillotineError("Cây cắt sinh vùng con rỗng.")
    _validate_tree(node["first"], first_rect, zones)
    _validate_tree(node["second"], second_rect, zones)


def _validate_placement(
    placement: Mapping[str, Any],
    product: Mapping[str, Any],
    zone: Mapping[str, Any],
) -> None:
    zone_rect = _dict_rect(zone["rect"])
    x = float(placement["x"])
    y = float(placement["y"])
    width = float(placement["width"])
    height = float(placement["height"])
    if (
        x < zone_rect.x - GEOMETRY_TOLERANCE_PT
        or y < zone_rect.y - GEOMETRY_TOLERANCE_PT
        or x + width > zone_rect.x + zone_rect.width + GEOMETRY_TOLERANCE_PT
        or y + height > zone_rect.y + zone_rect.height + GEOMETRY_TOLERANCE_PT
    ):
        raise MixedGuillotineError("Placement nằm ngoài zone của nó.")
    rotation = int(placement["rotation"]) % 360
    trim_width = float(product["trim_width"])
    trim_height = float(product["trim_height"])
    expected = (trim_width, trim_height) if rotation in (0, 180) else (trim_height, trim_width)
    if abs(width - expected[0]) > GEOMETRY_TOLERANCE_PT or abs(height - expected[1]) > GEOMETRY_TOLERANCE_PT:
        raise MixedGuillotineError("Kích thước placement không khớp sản phẩm và góc xoay.")

    grid = zone["grid"]
    slot = int(placement["gridSlot"])
    cols = int(grid["cols"])
    rows = int(grid["rows"])
    if slot < 0 or slot >= cols * rows:
        raise MixedGuillotineError("Grid slot nằm ngoài lưới zone.")
    content = _dict_rect(grid["contentRect"])
    col = slot % cols
    row = slot // cols
    expected_x = content.x + col * (float(grid["itemWidth"]) + float(grid["gapX"]))
    expected_y = content.y + row * (float(grid["itemHeight"]) + float(grid["gapY"]))
    if abs(x - expected_x) > GEOMETRY_TOLERANCE_PT or abs(y - expected_y) > GEOMETRY_TOLERANCE_PT:
        raise MixedGuillotineError("Placement không nằm đúng grid slot đã khai.")


def validate_guillotine_plan(plan: Mapping[str, Any]) -> None:
    """Fail-fast nếu plan không còn là một phép chia guillotine hợp lệ."""
    if plan.get("version") != PLAN_VERSION:
        raise MixedGuillotineError("Phiên bản plan Bình cắt xén không được hỗ trợ.")
    usable = _dict_rect(plan["usableRect"])
    products = {int(product["product_id"]): product for product in plan["products"]}
    if len(products) != len(plan["products"]):
        raise MixedGuillotineError("Danh sách sản phẩm trong plan bị trùng mã.")

    actual = {product_id: 0 for product_id in products}
    for template in plan["templates"]:
        zones: dict[str, Mapping[str, Any]] = {}
        _validate_tree(template["cutTree"], usable, zones)
        canonical_lines = _tree_cut_lines(template["cutTree"])
        if canonical_lines != template["cutLines"]:
            raise MixedGuillotineError("Đường cắt không khớp cây cắt.")

        placement_ids: set[str] = set()
        slots_by_zone: dict[str, set[int]] = {}
        placed_per_run: dict[int, int] = {}
        for placement in template["placements"]:
            placement_id = str(placement["placementId"])
            if placement_id in placement_ids:
                raise MixedGuillotineError(f"Placement {placement_id} bị trùng.")
            placement_ids.add(placement_id)
            product_id = int(placement["productId"])
            zone_id = str(placement["zoneId"])
            if product_id not in products or zone_id not in zones:
                raise MixedGuillotineError("Placement tham chiếu sản phẩm/zone không tồn tại.")
            zone = zones[zone_id]
            if zone.get("kind") != "zone" or int(zone["productId"]) != product_id:
                raise MixedGuillotineError("Zone chứa nhiều hơn một loại sản phẩm.")
            slot = int(placement["gridSlot"])
            used_slots = slots_by_zone.setdefault(zone_id, set())
            if slot in used_slots:
                raise MixedGuillotineError("Hai placement dùng chung một grid slot.")
            used_slots.add(slot)
            _validate_placement(placement, products[product_id], zone)
            placed_per_run[product_id] = placed_per_run.get(product_id, 0) + 1

        declared = {
            int(item["productId"]): int(item["placedPerRun"])
            for item in template["placedByProduct"]
        }
        if declared != placed_per_run:
            raise MixedGuillotineError("Số lượng placement trong template không khớp report.")
        run_count = int(template["runCount"])
        if run_count <= 0:
            raise MixedGuillotineError("Số lần in tờ mẫu phải lớn hơn 0.")
        for product_id, count in placed_per_run.items():
            actual[product_id] += count * run_count

    totals = {int(item["productId"]): item for item in plan["totalsByProduct"]}
    if set(totals) != set(products):
        raise MixedGuillotineError("Bảng tổng số lượng không đủ sản phẩm.")
    for product_id, product in products.items():
        requested = int(product["requested_quantity"])
        item = totals[product_id]
        expected_actual = actual[product_id]
        if int(item["actualQuantity"]) != expected_actual:
            raise MixedGuillotineError("Số lượng thực không khớp placements × số lần in.")
        if requested > 0 and expected_actual < requested:
            raise MixedGuillotineError("Plan chưa đáp ứng đủ số lượng yêu cầu.")
        expected_excess = max(0, expected_actual - requested) if requested > 0 else 0
        if int(item["excessQuantity"]) != expected_excess:
            raise MixedGuillotineError("Số lượng dư trong report không chính xác.")

    existing_hash = plan.get("planHash")
    if existing_hash is not None and str(existing_hash) != compute_plan_hash(plan):
        raise MixedGuillotineError("Hash plan không khớp nội dung.")


def compute_plan_hash(plan: Mapping[str, Any]) -> str:
    canonical = copy.deepcopy(dict(plan))
    canonical.pop("planHash", None)
    payload = json.dumps(
        canonical,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


__all__ = [
    "COORDINATE_SPACE",
    "GEOMETRY_TOLERANCE_PT",
    "MixedGuillotineError",
    "MixedGuillotineSettings",
    "PAIR_SIZE_TOLERANCE_PT",
    "PLAN_VERSION",
    "ProductSpec",
    "Rect",
    "build_mixed_guillotine_plan",
    "compute_plan_hash",
    "project_template_face",
    "validate_duplex_pair_sizes",
    "validate_guillotine_plan",
]
