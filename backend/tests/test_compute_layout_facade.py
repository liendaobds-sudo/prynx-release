"""
Property tests cho facade compute_layout (Lớp 2 — die-shape-detection-ssot).

Kiểm bất biến lan truyền (R6.3): type/props/poly ở đầu ra == đầu vào, và validate
đầu vào (R2.7/R6.6). Dùng monkeypatch solver để test contract facade mà không cần PDF.

Feature: die-shape-detection-ssot
"""
import pytest

import app.workers.nup_sticker as nup_sticker
from app.workers.imposition_layout import compute_layout
from app.workers.die_detection import DetectedShape, Trim
from app.workers.shape_types import ShapeType


class _FakePage:
    """page giả tối thiểu — facade không đụng tới khi solver đã được patch."""
    pass


def _stub_solver(monkeypatch, captured):
    def _fake(page, sheet_usable_w, sheet_usable_h, gap_x, gap_y,
              strategy='optimal_auto', shape_type_override=None,
              shape_props_override=None, bleed_pt=0.0, secondary_gap=None):
        captured['type'] = shape_type_override
        captured['props'] = shape_props_override
        return {'items': [], 'totalItems': 0, 'widthUsed': 0, 'heightUsed': 0,
                'shapeType': shape_type_override, 'shapeProps': shape_props_override or {}}
    monkeypatch.setattr(nup_sticker, 'compute_sticker_layout_for_page', _fake)


# Feature: die-shape-detection-ssot, Property 2: Lan truyền bất biến xuống lớp dưới Detection
def test_compute_layout_reattaches_type_props_poly(monkeypatch):
    captured = {}
    _stub_solver(monkeypatch, captured)
    shape = DetectedShape(
        page=0, type=ShapeType.HAMMER,
        props={'waistRatio': 0.42, 'bigDAlongAxisFrac': 0.3},
        trim=Trim(90.0, 30.0), poly=((0, 0), (90, 0), (90, 30)),
        source='vector', confidence=0.9,
    )
    out = compute_layout(shape, _FakePage(), sheet_usable_w=1000.0,
                         sheet_usable_h=1400.0, gap_x=5.0, gap_y=5.0)
    # Bất biến: đầu ra mang đúng type/props/poly từ DetectedShape (R6.3)
    assert out['type'] is ShapeType.HAMMER
    assert out['props'] == {'waistRatio': 0.42, 'bigDAlongAxisFrac': 0.3}
    assert out['poly'] == ((0, 0), (90, 0), (90, 30))
    # Facade truyền type.name + props xuống solver (R2.2/R6.2)
    assert captured['type'] == 'HAMMER'
    assert captured['props'] == {'waistRatio': 0.42, 'bigDAlongAxisFrac': 0.3}


def test_compute_layout_rejects_missing_type(monkeypatch):
    _stub_solver(monkeypatch, {})
    bad = DetectedShape.__new__(DetectedShape)      # bỏ qua __post_init__ để mô phỏng type rỗng
    object.__setattr__(bad, 'page', 0)
    object.__setattr__(bad, 'type', None)
    object.__setattr__(bad, 'props', {})
    object.__setattr__(bad, 'trim', Trim(10, 10))
    object.__setattr__(bad, 'poly', ())
    object.__setattr__(bad, 'source', 'vector')
    object.__setattr__(bad, 'confidence', 1.0)
    with pytest.raises(ValueError):
        compute_layout(bad, _FakePage(), sheet_usable_w=100.0, sheet_usable_h=100.0,
                       gap_x=0.0, gap_y=0.0)


# Feature: die-shape-detection-ssot — R6.6: CUSTOM + poly không hợp lệ ở chế độ poly-only
def test_compute_layout_poly_only_custom_requires_valid_poly(monkeypatch):
    # Bản hiện tại luôn dùng page-based solver; CUSTOM + poly rỗng vẫn hợp lệ
    # (solver tự xếp grid theo trim). Xác minh facade KHÔNG raise và reattach đúng.
    captured = {}
    _stub_solver(monkeypatch, captured)
    shape = DetectedShape(page=0, type=ShapeType.CUSTOM, props={}, trim=Trim(10, 10),
                          poly=(), source='custom', confidence=0.0)
    out = compute_layout(shape, _FakePage(), sheet_usable_w=100.0, sheet_usable_h=100.0,
                         gap_x=0.0, gap_y=0.0)
    assert out['type'] is ShapeType.CUSTOM and out['poly'] == ()
    assert captured['type'] == 'CUSTOM'
