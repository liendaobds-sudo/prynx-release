"""
Parity guard cho SSOT finalize_placements.

Bảo đảm finalize_placements:
  1) Tái tạo ĐÚNG công thức căn giữa CŨ của nup_engine nhánh `repeat` (golden tính tay).
  2) ĐỒNG NHẤT với cnc_render._build_placements (delegation identity).

Nếu ai đó đổi toán học finalize → test này gãy NGAY (vì đó là nguồn chân lý cho
preview == output).
"""
import pytest

from app.workers.imposition_affine import AffineContractError
from app.workers.imposition_finalize import finalize_placements
from app.workers.cnc_render import _build_placements


def _items():
    return [
        {'x': 0, 'y': 0, 'width': 100, 'height': 80, 'isRotated': False, 'isRotated180': False},
        {'x': 200, 'y': 100, 'width': 120, 'height': 60, 'isRotated': True, 'isRotated180': True},
        {'x': 50, 'y': 250, 'width': 90, 'height': 90, 'isRotated': False, 'isRotated180': True},
    ]


def _golden_old_nup_repeat(items, usable_w, usable_h, margin_left, margin_bottom,
                           margin_top, p_idx):
    """Bản sao NGUYÊN VĂN công thức inline cũ của nup_engine (trước khi tách)."""
    all_bottoms = [it.get('y', 0) + it.get('height', 0) for it in items]
    total_content_h = max(all_bottoms) if all_bottoms else 0.0
    max_x_used = max([it.get('x', 0) + it.get('width', 0) for it in items], default=0.0)
    x_off = margin_left + (usable_w - max_x_used) / 2 if max_x_used < usable_w else margin_left
    y_off = margin_bottom + (usable_h - total_content_h) / 2 if total_content_h < usable_h else margin_bottom
    out = []
    for item in items:
        rx = item.get('x', 0); ry = item.get('y', 0)
        iw = item.get('width', 0); ih = item.get('height', 0)
        abs_y = y_off + (total_content_h - ry - ih)
        out.append({
            'cluster_idx': 0,
            'cell': {'x': rx, 'y': ry, 'width': iw, 'height': ih,
                     'isRotated': item.get('isRotated', False),
                     'isRotated180': item.get('isRotated180', False)},
            'src_page_idx': p_idx,
            'abs_x': x_off + rx, 'abs_y': abs_y,
            'width': iw, 'height': ih,
            'original_cell_y': usable_w and (usable_h + margin_bottom + margin_top - abs_y - ih),
        })
    return out


PARAMS = [
    (1000.0, 600.0, 0, 0, 0, 5),
    (1000.0, 600.0, 30, 20, 10, 2),
    (200.0, 200.0, 5, 5, 5, 0),   # khối lớn hơn vùng in → ghim lề
]


@pytest.mark.parametrize("uw,uh,ml,mb,mt,pidx", PARAMS)
def test_finalize_matches_old_nup_repeat(uw, uh, ml, mb, mt, pidx):
    got = finalize_placements(_items(), uw, uh, ml, mb, mt, pidx)
    exp = _golden_old_nup_repeat(_items(), uw, uh, ml, mb, mt, pidx)
    assert len(got) == len(exp)
    for g, e in zip(got, exp):
        assert g['abs_x'] == pytest.approx(e['abs_x'])
        assert g['abs_y'] == pytest.approx(e['abs_y'])
        assert g['original_cell_y'] == pytest.approx(e['original_cell_y'])
        assert g['src_page_idx'] == e['src_page_idx']
        assert g['cell'] == e['cell']


@pytest.mark.parametrize("uw,uh,ml,mb,mt,pidx", PARAMS)
def test_build_placements_delegates(uw, uh, ml, mb, mt, pidx):
    got = finalize_placements(_items(), uw, uh, ml, mb, mt, pidx)
    via_cnc = _build_placements(_items(), uw, uh, ml, mb, mt, pidx)
    assert got == via_cnc


def test_empty():
    assert finalize_placements([], 1000, 600, 0, 0, 0, 0) == []


@pytest.mark.parametrize("builder", [finalize_placements, _build_placements])
@pytest.mark.parametrize(
    "field,value",
    [
        (
            "pose",
            {
                "rotationDeg": 13.372849,
                "translateXmm": 20.0,
                "translateYmm": 30.0,
            },
        ),
        ("rotationDeg", 13.372849),
        ("referencePointMm", [10.0, 12.0]),
        ("affineMm", [1.0, 0.0, 0.0, 1.0, 2.0, 3.0]),
    ],
)
def test_finalize_legacy_rejects_manifest_affine_fields(builder, field, value):
    item = {
        "x": 0.0,
        "y": 0.0,
        "width": 100.0,
        "height": 80.0,
        field: value,
    }
    with pytest.raises(AffineContractError, match="renderer affine"):
        builder([item], 1000.0, 600.0, 0.0, 0.0, 0.0, 0)


@pytest.mark.parametrize("builder", [finalize_placements, _build_placements])
def test_finalize_rejects_manifest_identity_when_pose_was_dropped(builder):
    partial_manifest = {
        "instanceId": "part-a#0001",
        "partId": "part-a",
        "sheetIndex": 0,
        "sourceRevision": "a" * 64,
    }

    with pytest.raises(AffineContractError, match="renderer affine"):
        builder(
            [partial_manifest],
            1000.0,
            600.0,
            0.0,
            0.0,
            0.0,
            0,
        )
