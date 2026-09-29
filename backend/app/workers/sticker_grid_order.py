"""Kế hoạch tem: simple/manual giữ lưới; optimal một loại dùng tiler chuyên biệt."""
from collections import Counter
from dataclasses import dataclass
import math
from typing import Any

from shapely.geometry import box

from app.workers.nup_diecut import _find_largest_die_path, resolve_default_page_die, resolve_one_dao_trim, MM_TO_PTS as MM
from app.workers.nup_layout_solver import solve_grid, apply_alternate_rotation, solve_optimal_layout, build_cut_stack_sheets
from app.workers.pont_collision import calculate_forbidden_zones
from app.workers.sticker_nup_policy import is_sticker_nup, sticker_order_quantities

def uses_sticker_simple_grid(settings) -> bool:
    return is_sticker_nup(settings) and settings.get("gridStrategy") in ("simple_auto", "manual")

def uses_sticker_single_order(settings, page_count: int) -> bool:
    return (is_sticker_nup(settings) and page_count == 1
            and settings.get("gridStrategy") in ("optimal_auto", "optimal_portrait", "optimal_landscape")
            and settings.get("groupingStrategy") != "cluster_tile")

def uses_page_sheet_pont_order(settings) -> bool:
    """BE.01: phân tờ sau khi chừa boong, không cắt bớt mẫu ở writer."""
    return (
        settings.get("page_sheet_mode") is True
        and settings.get("layoutType") in ("sequential", "cut_stacks")
        and settings.get("pontType", "none") != "none"
        and bool(settings.get("pontConfig"))
        and settings.get("groupingStrategy") != "cluster_tile"
    )


@dataclass
class StickerGridOrder:
    layout: dict[str, Any]
    placements: dict[int, list[dict[str, Any]]]
    preview: dict[str, Any]
    master_page: int | None = None
    # N-Up thường có 1 lượt/tờ; S&R lưu recipe gọn cùng số lần in thật.
    run_counts: dict[int, int] | None = None
    requested_by_page: dict[int, int] | None = None

    def export_sheets(self, unique: bool):
        """BE.08: chỉ gộp các recipe trùng cả nguồn, vị trí và hướng."""
        entries, by_recipe = [], {}
        for source_index, values in self.placements.items():
            runs = (self.run_counts or {}).get(source_index, 1)
            signature = tuple(
                (p["src_page_idx"], p["abs_x"], p["abs_y"], p["width"], p["height"],
                 bool(p["cell"].get("isRotated")), bool(p["cell"].get("isRotated180")))
                for p in values
            )
            if unique and signature in by_recipe:
                entries[by_recipe[signature]][1] += runs
            elif unique:
                by_recipe[signature] = len(entries)
                entries.append([values, runs])
            else:
                entries.extend([values, 1] for _ in range(runs))
        return ({i:entry[0] for i,entry in enumerate(entries)},
                {i:int(entry[1]) for i,entry in enumerate(entries)})



def build_sticker_grid_order(doc, settings, *, logical_page_count=None, repeat_template=False) -> StickerGridOrder:
    """Chốt cùng một lưới/placement; caller truyền lề hiệu dụng đã chừa dấu xén."""
    count = int(logical_page_count or doc.page_count)
    if count != doc.page_count and doc.page_count != 1:
        raise ValueError("Các thay đổi trang chưa được áp dụng vào PDF làm việc. Hãy thử lại khi xử lý trang hoàn tất.")
    page_sheet = settings.get("page_sheet_mode") is True
    cut_stack = page_sheet and settings.get("layoutType") == "cut_stacks"
    raw_tq = settings.get("targetQuantity")
    raw_tqbp = settings.get("targetQuantitiesByPage") or {}
    is_auto_fill = (
        (raw_tq is None or raw_tq == "" or int(raw_tq or 0) == 0)
        and not any(int(v or 0) > 0 for v in raw_tqbp.values())
    )
    quantities = ({i: 1 for i in range(count)} if cut_stack
                  else sticker_order_quantities(range(count), settings))
    dimensions, paths, genuine = {}, {}, []
    cut_type = settings.get("cutType", "default")
    from app.workers.sticker_homogeneous import page_has_die
    for index in range(count):
        page = doc[0 if doc.page_count == 1 else index]
        if page_sheet:
            from app.workers.mixed_guillotine_adapter import resolve_guillotine_geometry
            from app.workers.page_sheet_geometry import resolve_page_sheet_geometry
            sw, sh, _clip = resolve_guillotine_geometry(page, 0)
            geo = resolve_page_sheet_geometry(sw, sh, float(settings.get("bleed", 0) or 0) * MM)
            dimensions[index] = (geo.trim_width, geo.trim_height)
            paths[index] = None
            if index and any(abs(a-b) > .5 for a,b in zip(dimensions[0], dimensions[index])):
                raise ValueError("Dàn nhiều mẫu Bình nguyên tấm decal chỉ hỗ trợ các trang cùng kích thước thành phẩm sau khi trừ bleed.")
            continue
        own = _find_largest_die_path(page)
        if cut_type == "default" and page_has_die(page):
            genuine.append(index)
        path = own or resolve_default_page_die(page, settings.get("dieOffsetMm", 0))
        special = resolve_one_dao_trim(
            page, cut_type, settings.get("dieSizeMode", "die"), settings.get("dieOffsetMm", 0),
        )
        dimensions[index] = special or (float(path["rect"].width), float(path["rect"].height))
        paths[index] = path if cut_type == "default" else None
    master = genuine[0] if len(genuine) == 1 and count > 1 else None
    if master is not None:
        for index in range(count):
            if index != master:
                dimensions[index], paths[index] = dimensions[master], paths[master]
    width = float(settings["sheetWidth"]) * MM
    height = float(settings["sheetHeight"]) * MM
    left, right, top, bottom = [float(settings.get("margin" + side, 0) or 0) * MM
                                for side in ("Left", "Right", "Top", "Bottom")]
    bottom = max(bottom, float(settings.get("gripperMargin", 0) or 0) * MM)
    if settings.get("marginMode") == "include_marks" and settings.get("markType", "none") != "none":
        _ml_raw = settings.get("markLength")
        mark_len = float(5.0 if _ml_raw is None else _ml_raw) * MM
        _mo_raw = settings.get("markOffset")
        mark_off = float(3.0 if _mo_raw is None else _mo_raw) * MM
        mark_space = mark_len + mark_off
        left += mark_space
        right += mark_space
        top += mark_space
        bottom += mark_space
    gap_x, gap_y = [float(settings.get(name, 0) or 0) * MM for name in ("gapX", "gapY")]
    usable_w, usable_h = width - left - right, height - top - bottom
    cell_w = max(dimensions[index][0] for index in quantities)
    cell_h = max(dimensions[index][1] for index in quantities)
    if min(cell_w, cell_h, usable_w, usable_h) <= 0:
        raise ValueError("Khổ tem hoặc vùng in không hợp lệ.")
    pont = settings.get("pontConfig") if settings.get("pontType", "none") != "none" else None
    zones = calculate_forbidden_zones(pont, {"left": left, "right": right, "top": top, "bottom": bottom}, width, height)
    align = str(settings.get("align") or "center")
    total = sum(quantities.values())
    candidates = []
    optimal_single = (not page_sheet and count == 1
                      and settings.get("gridStrategy") in ("optimal_auto", "optimal_portrait", "optimal_landscape"))
    if optimal_single:
        # BE.06: giữ bộ xếp tối ưu, chỉ tách kế hoạch số lượng khỏi sức chứa.
        from app.workers.nup_sticker import compute_sticker_layout_for_page
        shape = settings.get("detectedShapesByPage") or {}
        props = settings.get("detectedShapeParamsByPage") or {}
        optimized = compute_sticker_layout_for_page(
            doc[0], usable_w, usable_h, gap_x, gap_y, strategy="optimal_auto",
            shape_type_override=shape.get("0",shape.get(0)),
            shape_props_override=props.get("0",props.get(0)),
            bleed_pt=float(settings.get("bleed",0) or 0)*MM,
            cut_type=cut_type, die_size_mode=settings.get("dieSizeMode","die"),
            die_offset_mm=settings.get("dieOffsetMm",0),
            secondary_gap=(float(settings.get("fillBlockGap",0) or 0)*MM
                           if cut_type=="one_dao" and settings.get("fillBlockGap") else None),
            alternate_rotation=settings.get("alternateRotation","none"),
        )
        raw_candidates = [{
            **optimized, "cells":optimized.get("items",[]),
            "width":optimized.get("widthUsed",0), "height":optimized.get("heightUsed",0),
        }]
    elif page_sheet and settings.get("gridStrategy") in ("optimal_auto", "optimal_portrait", "optimal_landscape"):
        opt_strat = settings.get("gridStrategy", "optimal_auto")
        split_gap = (float(settings.get("fillBlockGap", 0) or 0) * MM
                     if settings.get("fillBlockGap") else None)
        optimized = solve_optimal_layout(
            usable_w, usable_h, cell_w, cell_h, gap_x, gap_y,
            strategy=opt_strat, secondary_gap=split_gap,
        )
        raw_candidates = [{**optimized, "width": optimized["overallWidth"], "height": optimized["overallHeight"]}]
    elif settings.get("gridStrategy") == "manual":
        from app.workers.nup_layout_solver import solve_manual
        cols, rows = int(settings.get("cols",0) or 0), int(settings.get("rows",0) or 0)
        if cols < 1 or rows < 1:
            raise ValueError("Lưới thủ công cần số cột và số dòng lớn hơn 0.")
        raw = solve_manual(cell_w,cell_h,gap_x,gap_y,cols,rows)
        if raw["overallWidth"] > usable_w + .01 or raw["overallHeight"] > usable_h + .01:
            raise ValueError("Lưới thủ công vượt vùng giấy sử dụng. Hãy giảm số cột hoặc số dòng.")
        raw_candidates = [{**raw, "width":raw["overallWidth"], "height":raw["overallHeight"]}]
    else:
        raw_candidates = [solve_grid(usable_w, usable_h, cell_h if rotated else cell_w,
                                    cell_w if rotated else cell_h, gap_x, gap_y, rotated)
                          for rotated in (False, True)]
    for raw in raw_candidates:
        rotated = bool(raw.get("isRotated"))
        raw = apply_alternate_rotation(
            raw,
            settings.get("alternateRotation", "none"),
            settings.get("alternateRotationAlignment", settings.get("alternate_rotation_alignment", "foot_to_foot")),
        )
        bx = left if "left" in align else width - right - raw["width"] if "right" in align else left + (usable_w - raw["width"]) / 2
        by = top if "top" in align else height - bottom - raw["height"] if "bottom" in align else top + (usable_h - raw["height"]) / 2
        slots = []
        for cell in raw["cells"]:
            x, y = bx + cell["x"], by + cell["y"]
            bounds = box(x, height - y - cell["height"], x + cell["width"], height - y)
            if any(bounds.intersection(zone).area > 1e-9 for zone in zones):
                continue
            slots.append({**cell, "abs_x": x, "top_y": y})
        if slots:
            candidates.append(((math.ceil(total / len(slots)), rotated, -len(slots)), raw, slots))
    if not candidates:
        had_raw_cells = any(bool(raw.get("cells")) for raw in raw_candidates)
        if had_raw_cells and zones:
            raise ValueError(
                "Lưới không thể đặt vừa tem do va chạm với dấu boong/ốc bế ở các góc. "
                "Hãy kiểm tra vị trí boong hoặc bật tùy chọn 'Bỏ xử lý va chạm'."
            )
        raise ValueError("Lưới đơn giản không đặt vừa tem sau khi chừa boong/lề. Hãy tăng khổ giấy hoặc kiểm tra thiết lập.")
    _, raw, slots = min(candidates, key=lambda value: value[0])
    capacity = len(slots)
    if optimal_single and total < capacity and not zones:
        # Căn giữa lượng thực trên một tờ, không làm thay đổi sức chứa hình học.
        used = slots[:total]
        x0,y0 = min(c["abs_x"] for c in used),min(c["top_y"] for c in used)
        x1 = max(c["abs_x"]+c["width"] for c in used)
        y1 = max(c["top_y"]+c["height"] for c in used)
        dx,dy = left+(usable_w-(x1-x0))/2-x0,top+(usable_h-(y1-y0))/2-y0
        for cell in used:
            cell["abs_x"] += dx
            cell["top_y"] += dy
    if repeat_template:
        quantities = {0: capacity}
        total = capacity
    elif page_sheet and count == 1 and is_auto_fill and not cut_stack:
        quantities = {0: capacity}
        total = capacity
    placements: dict[int, list[dict[str, Any]]] = {}
    position = 0
    ordered = ((index for sheet in build_cut_stack_sheets(count,capacity,fill_sheet=True) for index in sheet)
               if cut_stack else (index for index,quantity in quantities.items() for _ in range(quantity)))
    for index in ordered:
        tw, th = dimensions[index]
        slot = slots[position % capacity]
        rotated = bool(slot.get("isRotated"))
        pw, ph = (th, tw) if rotated else (tw, th)
        x = slot["abs_x"] + (slot["width"] - pw) / 2
        y = slot["top_y"] + (slot["height"] - ph) / 2
        cell = {**slot, "width": pw, "height": ph, "pageIdx": index, "blockId": index}
        placement = {
            "cluster_idx": 0, "cell": cell, "src_page_idx": index,
            "abs_x": x, "abs_y": height - y - ph, "original_cell_y": y,
            "width": pw, "height": ph, "_simple_grid_order": True, "_pont_collision_resolved": True,
        }
        placements.setdefault(position // capacity, []).append(placement)
        position += 1
    # Cùng vị trí/cùng trang nguồn trong job mới được gộp thành bố cục đại diện.
    templates, by_recipe = [], {}
    for sheet_index, values in placements.items():
        key = tuple(value["src_page_idx"] for value in values)
        if key in by_recipe:
            templates[by_recipe[key]]["runCount"] += 1
            continue
        cells = []
        from app.workers.nup_artwork import die_polylines_for_placement
        for value in values:
            cell = {**value["cell"], "absX": value["abs_x"], "absY": value["abs_y"]}
            path = paths[value["src_page_idx"]]
            if path:
                cell["diePolylines"] = die_polylines_for_placement(
                    path["items"], path["rect"], value["abs_x"], value["original_cell_y"],
                    cell["isRotated"], cell.get("isRotated180", False),
                )
            cells.append(cell)
        by_recipe[key] = len(templates)
        templates.append({
            "cells": cells, "totalItems": len(cells), "overallWidth": width, "overallHeight": height,
            "physicalSheetIndex": sheet_index, "runCount": 1, "absPlacement": True,
        })
    counts = Counter(value["src_page_idx"] for values in placements.values() for value in values)
    if not cut_stack and counts != quantities:
        raise ValueError("Lưới chưa đáp ứng đúng số lượng từng loại.")
    preview = {
        "success": True, "strategyUsed": "cut_stacks" if cut_stack else settings.get("gridStrategy","simple_auto"), "absPlacement": True,
        "isMixedPreview": True, "cells": templates[0]["cells"], "sheets": templates,
        "totalItems": templates[0]["totalItems"], "capacity":capacity, "overallWidth": width, "overallHeight": height,
        "sheetsNeeded": len(placements), "placedByPage": {str(k): v for k, v in counts.items()},
        "orderSummary": {"templateCount": len(templates), "physicalSheetCount": len(placements),
                         "requestedCount": (0 if (page_sheet and count == 1 and is_auto_fill) else total), "placedCount": position},
    }
    layout = {"cells": slots, "totalItems": capacity, "overallWidth": raw["width"],
              "overallHeight": raw["height"], "strategyUsed": settings.get("gridStrategy","simple_auto")}
    return StickerGridOrder(layout, placements, preview, master, requested_by_page=quantities)

def uses_sticker_manual_repeat(settings) -> bool:
    return (
        bool(settings.get("isDieCutMode")) and settings.get("imposerMode") != "cnc"
        and not settings.get("page_sheet_mode") and settings.get("gridStrategy") == "manual"
        and (settings.get("layoutType") == "repeat" or settings.get("taskMode") in ("step_repeat", "sr"))
    )


class _SinglePageDocument:
    """View chỉ đọc một trang thật, giữ nguyên tài nguyên và hệ tọa độ nguồn."""
    page_count = 1

    def __init__(self, page):
        self.page = page

    def __getitem__(self, index):
        if index != 0:
            raise IndexError(index)
        return self.page


def build_sticker_manual_repeat_order(doc, settings, *, logical_page_count=None) -> StickerGridOrder:
    """BE.03: mỗi trang S&R dùng đúng hàng/cột; lưu số lần in thay vì nở bản sao."""
    from copy import deepcopy
    count = int(logical_page_count or doc.page_count)
    if count != doc.page_count and doc.page_count != 1:
        raise ValueError("Các thay đổi trang chưa được áp dụng vào PDF làm việc. Hãy thử lại khi xử lý trang hoàn tất.")
    default = int(settings.get("targetQuantity", 0) or 0)
    overrides = settings.get("targetQuantitiesByPage") or {}
    auto_fill = default == 0 and not any(int(v or 0) > 0 for v in overrides.values())
    placements, runs_by_sheet, templates, requested = {}, {}, [], {}
    from app.workers.sticker_homogeneous import page_has_die
    genuine = ([i for i in range(doc.page_count) if page_has_die(doc[i])]
               if settings.get("cutType","default") == "default" else [])
    master = genuine[0] if len(genuine) == 1 and doc.page_count > 1 else None
    capacity = 0
    overall_w = overall_h = 0.0
    for page_index in range(count):
        quantity = int(overrides.get(str(page_index), overrides.get(page_index, default)) or 0)
        if quantity <= 0 and not auto_fill:
            continue
        single_settings = {
            **settings, "taskMode":"nup", "layoutType":"sequential",
            "targetQuantity":1, "targetQuantitiesByPage":{},
        }
        geometry_index = master if master is not None else (0 if doc.page_count == 1 else page_index)
        order = build_sticker_grid_order(
            _SinglePageDocument(doc[geometry_index]), single_settings, repeat_template=True,
        )
        template = deepcopy(order.placements[0])
        for value in template:
            value["src_page_idx"] = page_index
            value["cell"].update(pageIdx=page_index, blockId=page_index)
        index = len(placements)
        placements[index] = template
        run_count = max(1, math.ceil(quantity / len(template)))
        runs_by_sheet[index] = run_count
        capacity = max(capacity, len(template))
        overall_w = max(overall_w, order.layout["overallWidth"])
        overall_h = max(overall_h, order.layout["overallHeight"])
        requested[page_index] = quantity if quantity > 0 else len(template)
        sheet = deepcopy(order.preview["sheets"][0])
        for cell in sheet["cells"]:
            cell.update(pageIdx=page_index, blockId=page_index)
        sheet.update(physicalSheetIndex=index, runCount=run_count)
        templates.append(sheet)
    if not placements:
        raise ValueError("Không có mẫu nào có số lượng cần in.")
    physical = sum(runs_by_sheet.values())
    produced = {int(s["cells"][0]["pageIdx"]):len(s["cells"])*int(s["runCount"]) for s in templates}
    preview = {
        "success":True,"strategyUsed":"manual","absPlacement":True,"isMixedPreview":True,
        **{key:templates[0][key] for key in ("cells","totalItems","overallWidth","overallHeight")},
        "sheets":templates,"sheetsNeeded":physical,"placedByPage":{str(k):v for k,v in produced.items()},
        "orderSummary":{"templateCount":len(templates),"physicalSheetCount":physical,
                        "requestedCount":sum(requested.values()),"placedCount":sum(produced.values())},
    }
    return StickerGridOrder({"cells":[],"totalItems":capacity,"strategyUsed":"manual",
                             "overallWidth":overall_w,"overallHeight":overall_h},
                            placements,preview,master,run_counts=runs_by_sheet,requested_by_page=requested)
