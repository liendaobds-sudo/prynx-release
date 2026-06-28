"""
Parity: đường PREVIEW (finalize_placements + resolve_pont_collisions_on_placements)
== đường EXPORT (finalize_placements + collision kiểu nup_process_chunk) cho cùng
input → preview == output ở mức placements tuyệt đối.
"""
from types import SimpleNamespace

import pytest

from app.workers.imposition_finalize import (
    finalize_placements, resolve_pont_collisions_on_placements,
)
from app.workers.pont_collision import (
    calculate_forbidden_zones, detect_collisions, smart_resolve_collisions, MM_TO_PTS,
)

SHEET_W = 1000.0
SHEET_H = 700.0
MARGIN = 0.0
USABLE_W = SHEET_W - 2 * MARGIN
USABLE_H = SHEET_H - 2 * MARGIN

PONT = {'shape': 'circle', 'size': 20.0, 'marginTop': 5.0, 'marginBottom': 5.0,
        'marginLeft': 5.0, 'marginRight': 5.0}


def _grid_items():
    # Lưới tem 90x70 lấp gần đầy → vài tem ở 4 góc sẽ đè vùng cấm boong.
    items = []
    w, h = 90.0, 70.0
    cols = int(USABLE_W // (w + 5))
    rowsn = int(USABLE_H // (h + 5))
    for r in range(rowsn):
        for c in range(cols):
            items.append({'x': c * (w + 5), 'y': r * (h + 5), 'width': w, 'height': h,
                          'isRotated': False, 'isRotated180': False})
    return items


def _export_collision(placements):
    """Sao y nup_process_chunk.py L463-522 (margins + zones + smart_resolve)."""
    margins = {
        'top': PONT['marginTop'] * MM_TO_PTS,
        'bottom': PONT['marginBottom'] * MM_TO_PTS,
        'left': PONT['marginLeft'] * MM_TO_PTS,
        'right': PONT['marginRight'] * MM_TO_PTS,
    }
    zones = calculate_forbidden_zones(PONT, margins, SHEET_W, SHEET_H)
    base_rect_pts = (0, 0, placements[0]['width'], placements[0]['height'])
    if not detect_collisions(placements, zones, None, base_rect_pts, SHEET_H):
        return placements
    return smart_resolve_collisions(placements, zones, None, base_rect_pts, SHEET_W, SHEET_H, margins)


def _key(p):
    return (round(p['abs_x'], 3), round(p['abs_y'], 3),
            p['cell'].get('isRotated', False), p['cell'].get('isRotated180', False))


def test_preview_export_placements_match():
    items = _grid_items()
    # Export
    exp_pl = finalize_placements(items, USABLE_W, USABLE_H, MARGIN, MARGIN, MARGIN, 0)
    exp_resolved = _export_collision(exp_pl)
    # Preview (helper)
    req = SimpleNamespace(pont_config=PONT, sheet_w=SHEET_W, sheet_h=SHEET_H,
                          margin_left=MARGIN, margin_bottom=MARGIN, margin_top=MARGIN)
    prev_pl = finalize_placements(items, USABLE_W, USABLE_H, MARGIN, MARGIN, MARGIN, 0)
    prev_resolved = resolve_pont_collisions_on_placements(prev_pl, req, base_poly=None)

    assert sorted(_key(p) for p in exp_resolved) == sorted(_key(p) for p in prev_resolved)
    assert len(exp_resolved) == len(prev_resolved)
    # Phải có loại tem (collision thực sự xảy ra → test có ý nghĩa)
    assert len(exp_resolved) < len(items)


def test_preview_no_pont_returns_centered_abs():
    items = _grid_items()
    req = SimpleNamespace(pont_config=None, sheet_w=SHEET_W, sheet_h=SHEET_H,
                          margin_left=MARGIN, margin_bottom=MARGIN, margin_top=MARGIN)
    pl = finalize_placements(items, USABLE_W, USABLE_H, MARGIN, MARGIN, MARGIN, 0)
    out = resolve_pont_collisions_on_placements(pl, req, base_poly=None)
    assert out == pl  # không boong → giữ nguyên
