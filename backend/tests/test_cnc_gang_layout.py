"""
Property tests cho build_cnc_gang_layout (CNC gang — die-shape-detection-ssot).

- Property 11: xếp gang KHÔNG tệ hơn bin-pack chữ nhật (ở đây: bằng, vì gang wrap
  build_cnc_front_layout) → số mẫu/tờ == bản chữ nhật.
- RC-5 fix: mỗi cell + placement MANG THEO shapeType/poly đúng theo trang.

Feature: die-shape-detection-ssot
"""
from hypothesis import given, settings, strategies as st

from app.workers.cnc_layout import build_cnc_gang_layout, build_cnc_front_layout
from app.workers.die_detection import DetectedShape, Trim
from app.workers.shape_types import ShapeType


def _mk_shape(page, w, h, t=ShapeType.RECTANGLE):
    return DetectedShape(page=page, type=t, props={}, trim=Trim(w, h),
                         poly=((0, 0), (w, 0), (w, h), (0, h)),
                         source='vector', confidence=1.0)


# Feature: die-shape-detection-ssot, Property 11: Xếp gang không tệ hơn bin-pack chữ nhật
@given(
    n=st.integers(min_value=1, max_value=4),
    data=st.data(),
)
@settings(max_examples=40)
def test_gang_count_equals_rect_packing(n, data):
    items = []
    page_dims_qty = []
    for i in range(n):
        w = data.draw(st.floats(min_value=40.0, max_value=200.0))
        h = data.draw(st.floats(min_value=40.0, max_value=200.0))
        q = data.draw(st.integers(min_value=0, max_value=20))
        items.append((_mk_shape(i, w, h), q))
        page_dims_qty.append((i, w, h, q))

    gang = build_cnc_gang_layout(items, 320.0, 450.0, 3.0)
    rect = build_cnc_front_layout(page_dims_qty, 320.0, 450.0, 3.0)

    # Cùng thuật toán packing → số mẫu/tờ bằng nhau (⇒ không nhỏ hơn — R8.5).
    assert gang['items_per_sheet'] == rect['items_per_sheet']
    assert len(gang['cells']) == len(rect['cells'])


# RC-5: shape metadata gắn đúng theo trang vào cells + placements.
def test_gang_attaches_per_page_shape_metadata():
    items = [
        (_mk_shape(0, 50, 50, ShapeType.CIRCLE_ELLIPSE), 10),
        (_mk_shape(2, 80, 40, ShapeType.RECTANGLE), 10),
        (_mk_shape(4, 70, 70, ShapeType.HEXAGON), 10),
    ]
    res = build_cnc_gang_layout(items, 320.0, 450.0, 3.0)
    by_page = {0: 'CIRCLE_ELLIPSE', 2: 'RECTANGLE', 4: 'HEXAGON'}

    assert res['items_per_sheet'] > 0
    for cell in res['cells']:
        pi = cell.get('pageIdx')
        if pi in by_page:
            assert cell.get('shapeType') == by_page[pi]
            assert isinstance(cell.get('poly'), list)
    for pl in res['placements']:
        pi = pl.get('src_page_idx')
        if pi in by_page:
            assert pl.get('shapeType') == by_page[pi]
            assert pl['cell'].get('shapeType') == by_page[pi]


def test_gang_empty_input():
    res = build_cnc_gang_layout([], 320.0, 450.0, 3.0)
    assert res['items_per_sheet'] == 0 and res['cells'] == []
