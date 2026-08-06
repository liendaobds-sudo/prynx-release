"""Dựng cells preview cho bin-pack "dàn nhiều mẫu" (Branch C của /preview-layout).

Tách khỏi `routes/imposition.py` (file đã chạm trần ratchet) — logic thuần hình
học, không chạm PDFium, không chạm request.

[MULTI-SHEET PREVIEW FIX 2026-08-06] Khi số mẫu vượt sức chứa MỘT tờ, packer mở
thêm TỜ MẪU; `placements` chỉ giữ tờ đầu cho caller cũ. Preview phải dựng ĐỦ mọi
tờ, nếu không xưởng chỉ thấy tờ đầu trong khi bản xuất có đủ.
"""
from __future__ import annotations

import logging
from typing import Any, Callable, Dict, List, Sequence, Tuple

logger = logging.getLogger(__name__)


def sheet_groups_from_bin_pack(bp_result: Dict[str, Any]) -> List[List[dict]]:
    """Lấy danh sách placements THEO TỪNG TỜ MẪU; luôn ≥1 nhóm."""
    groups = [s['placements'] for s in (bp_result.get('sheets') or [])]
    return groups or [bp_result.get('placements') or []]


def build_mixed_preview_sheet(
    placements: Sequence[dict],
    *,
    usable_w: float,
    usable_h: float,
    margin_left: float,
    margin_bottom: float,
    margin_top: float,
    die_geo_by_page: Dict[int, Any],
    die_polylines_for_placement: Callable[..., Any],
) -> Tuple[List[dict], float, float]:
    """Dựng cells toạ độ TUYỆT ĐỐI cho MỘT tờ mẫu (căn giữa riêng theo tờ đó).

    Khớp export (`_finalize_sheet_centering`, nup_engine): packer trả top-left
    (y-down), căn giữa rồi flip → abs bottom-up sheet space. Đường bế THẬT
    per-cell dùng toạ độ TOP-DOWN trang đích để nhất quán với S&R.
    """
    max_x = max((q['x'] + q['w'] for q in placements), default=0.0)
    max_bottom = max((q['y'] + q['h'] for q in placements), default=0.0)
    x_off = margin_left + (usable_w - max_x) / 2 if max_x < usable_w else margin_left
    y_off = margin_bottom + (usable_h - max_bottom) / 2 if max_bottom < usable_h else margin_bottom

    cells: List[dict] = []
    ov_w = 0.0
    ov_h = 0.0
    for p in placements:
        abs_x = x_off + p['x']
        abs_y = y_off + (max_bottom - p['y'] - p['h'])
        cell = {
            'x': p['x'],
            'y': p['y'],
            'absX': abs_x,
            'absY': abs_y,
            'width': p['w'],
            'height': p['h'],
            'isRotated': p['is_rotated'],
            'isRotated180': False,
            'pageIdx': p['page_idx'],
        }
        geo = die_geo_by_page.get(p['page_idx'])
        if geo is not None:
            ay_td = (usable_h + margin_bottom + margin_top) - abs_y - p['h']
            try:
                cell['diePolylines'] = die_polylines_for_placement(
                    geo[0], geo[1], abs_x, ay_td,
                    is_rotated=p['is_rotated'],
                    is_rotated_180=False,
                )
            except Exception as exc:
                logger.debug("mixed die polylines build failed: %s", exc)
        cells.append(cell)
        ov_w = max(ov_w, abs_x + p['w'])
        ov_h = max(ov_h, abs_y + p['h'])
    return cells, ov_w, ov_h


def build_mixed_preview_sheets(
    bp_result: Dict[str, Any],
    **kwargs: Any,
) -> List[Dict[str, Any]]:
    """Dựng MỌI tờ mẫu → [{cells, overallWidth, overallHeight}, ...]."""
    out: List[Dict[str, Any]] = []
    for group in sheet_groups_from_bin_pack(bp_result):
        cells, w, h = build_mixed_preview_sheet(group, **kwargs)
        out.append({"cells": cells, "overallWidth": w, "overallHeight": h})
    return out
