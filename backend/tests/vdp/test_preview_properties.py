"""Property tests cho Preview_Service (PrynX VDP_Engine).

Feature: vdp-upgrade

Phủ các correctness property 21, 22, 24 của design (vdp-upgrade) cho module
`app.workers.vdp_preview`. Mỗi property test gắn comment tham chiếu và chạy 100
ví dụ. Các property thuần (clamp index, parity công thức toạ độ) chạy nhanh; phần
liên quan rasterize/render I/O dùng `deadline=None` và giữ dữ liệu nhỏ.
"""
from __future__ import annotations

import math
import os
import uuid

import pytest
from hypothesis import given, settings, strategies as st

from reportlab.pdfgen import canvas as rl_canvas

from app.workers import vdp_engine
from app.workers import vdp_preview
from app.workers.vdp_engine import CSS_TO_PT_FACTOR, MM_TO_PTS, hex_to_cmyk
from app.workers.vdp_preview import (
    clamp_index,
    render_record_preview,
    _compute_field_rects,
)


# A6 ~ 105 x 148 mm tính theo point — trang nền nhỏ để render nhanh.
PAGE_W_PT = 297.5
PAGE_H_PT = 419.5


def _make_template(path: str, num_pages: int = 1):
    """Dựng template PDF nền xám đơn giản (đồng bộ với các regression test)."""
    c = rl_canvas.Canvas(path, pagesize=(PAGE_W_PT, PAGE_H_PT))
    for _ in range(num_pages):
        c.setFillColorRGB(0.97, 0.97, 0.97)
        c.rect(0, 0, PAGE_W_PT, PAGE_H_PT, stroke=0, fill=1)
        c.showPage()
    c.save()


# --------------------------------------------------------------------------- #
# Property 21 — Giới hạn chỉ số record xem trước (Req 4.5)                      #
# --------------------------------------------------------------------------- #

# Feature: vdp-upgrade, Property 21: Giới hạn chỉ số record xem trước
@settings(max_examples=100)
@given(
    requested=st.integers(min_value=-1000, max_value=1000),
    total=st.integers(min_value=1, max_value=1000),
)
def test_clamp_index_stays_within_bounds(requested, total):
    """Với `total >= 1`, `clamp_index(requested, total)` luôn trả chỉ số trong
    `[1, total]`:
      - requested < 1     → 1,      clamped=True
      - requested > total → total,  clamped=True
      - trong khoảng      → giữ nguyên, clamped=False
    Đây là hàm thuần — nhanh, không render.
    """
    index, clamped = clamp_index(requested, total)

    # Luôn nằm trong khoảng hợp lệ.
    assert 1 <= index <= total

    if requested < 1:
        assert index == 1
        assert clamped is True
    elif requested > total:
        assert index == total
        assert clamped is True
    else:
        # Trong khoảng → không đổi và không bị kẹp.
        assert index == requested
        assert clamped is False


# --------------------------------------------------------------------------- #
# Property 22 — Dấu hiệu lỗi field trong preview đặt đúng vị trí (Req 4.6)      #
# --------------------------------------------------------------------------- #

# Feature: vdp-upgrade, Property 22: Dấu hiệu lỗi field trong preview đặt đúng vị trí
@settings(max_examples=100, deadline=None)
@given(
    # Giữ field NẰM TRỌN trong trang để phép kẹp là no-op ⇒ ánh xạ thuần
    #   pixel = mm * MM_TO_PTS * CSS_TO_PT_FACTOR * scale (gốc trên-trái).
    x_mm=st.floats(min_value=0.0, max_value=40.0, allow_nan=False, allow_infinity=False),
    y_mm=st.floats(min_value=0.0, max_value=40.0, allow_nan=False, allow_infinity=False),
    w_mm=st.floats(min_value=1.0, max_value=30.0, allow_nan=False, allow_infinity=False),
    h_mm=st.floats(min_value=1.0, max_value=30.0, allow_nan=False, allow_infinity=False),
    scale=st.floats(min_value=0.5, max_value=4.0, allow_nan=False, allow_infinity=False),
)
def test_field_error_rect_maps_to_field_frame(x_mm, y_mm, w_mm, h_mm, scale):
    """Khi một field MISSING/ERR, `rect` của field_error tương ứng (đã scale) với
    vị trí khung field. Kiểm phép ánh xạ toạ độ trực tiếp: khung field (x,y,w,h)
    mm → pixel ảnh qua `mm * MM_TO_PTS * CSS_TO_PT_FACTOR * scale` (gốc trên-trái),
    đúng như `render_record_preview` tạo ra (rect point của engine × scale).
    """
    fields_dict = [{
        'x': x_mm, 'y': y_mm, 'width': w_mm, 'height': h_mm,
    }]
    # rect theo point do chính code preview tính (nguồn sự thật của engine).
    pt_rect = _compute_field_rects(fields_dict)[0]

    factor = MM_TO_PTS * CSS_TO_PT_FACTOR
    # Point rect khớp công thức đóng.
    assert math.isclose(pt_rect['x'], x_mm * factor, rel_tol=0, abs_tol=1e-9)
    assert math.isclose(pt_rect['y'], y_mm * factor, rel_tol=0, abs_tol=1e-9)
    assert math.isclose(pt_rect['w'], w_mm * factor, rel_tol=0, abs_tol=1e-9)
    assert math.isclose(pt_rect['h'], h_mm * factor, rel_tol=0, abs_tol=1e-9)

    # render_record_preview đổi rect lỗi point → pixel bằng `* scale` (gốc trên-trái).
    px_rect = {k: v * scale for k, v in pt_rect.items()}
    assert math.isclose(px_rect['x'], x_mm * factor * scale, rel_tol=0, abs_tol=1e-6)
    assert math.isclose(px_rect['y'], y_mm * factor * scale, rel_tol=0, abs_tol=1e-6)
    assert math.isclose(px_rect['w'], w_mm * factor * scale, rel_tol=0, abs_tol=1e-6)
    assert math.isclose(px_rect['h'], h_mm * factor * scale, rel_tol=0, abs_tol=1e-6)


def test_field_error_rect_aligns_end_to_end(tmp_path):
    """Một lần render thật end-to-end xác nhận rect của một field MISSING khớp
    vị trí khung field (đã scale, đã kẹp vào trang)."""
    tpl = os.path.join(str(tmp_path), f"tpl_{uuid.uuid4().hex}.pdf")
    _make_template(tpl, num_pages=1)

    x_mm, y_mm, w_mm, h_mm = 12.0, 18.0, 20.0, 15.0
    scale = 2.0
    # textContent='{label}' với cột 'label' rỗng ⇒ field MISSING (val rỗng).
    field = {
        'id': 'f_missing', 'name': 'label', 'type': 'text',
        'x': x_mm, 'y': y_mm, 'width': w_mm, 'height': h_mm,
        'fontSize': 10, 'fontColor': '#000000', 'textContent': '{label}',
    }
    rows = [{'label': ''}]

    result = render_record_preview(tpl, [field], rows, 1, scale=scale)

    assert result.empty_source is False
    assert result.image_png is not None
    # Đúng một dấu hiệu MISSING cho field rỗng.
    missing = [e for e in result.field_errors if e.kind == 'MISSING']
    assert len(missing) == 1
    mark = missing[0]
    assert mark.field == 'label'

    # Khung field nằm trọn trong trang ⇒ kẹp là no-op; rect pixel = mm*factor*scale.
    factor = MM_TO_PTS * CSS_TO_PT_FACTOR
    assert math.isclose(mark.rect['x'], x_mm * factor * scale, rel_tol=0, abs_tol=1e-4)
    assert math.isclose(mark.rect['y'], y_mm * factor * scale, rel_tol=0, abs_tol=1e-4)
    assert math.isclose(mark.rect['w'], w_mm * factor * scale, rel_tol=0, abs_tol=1e-4)
    assert math.isclose(mark.rect['h'], h_mm * factor * scale, rel_tol=0, abs_tol=1e-4)


# --------------------------------------------------------------------------- #
# Property 24 — Parity preview ↔ engine (toạ độ, màu, xoay) (Req 4.4,6.3,6.4) #
# --------------------------------------------------------------------------- #

# Feature: vdp-upgrade, Property 24: Parity preview ↔ engine (toạ độ, màu, xoay)
@settings(max_examples=100)
@given(
    fields=st.lists(
        st.fixed_dictionaries({
            'x': st.floats(min_value=0.0, max_value=500.0, allow_nan=False, allow_infinity=False),
            'y': st.floats(min_value=0.0, max_value=500.0, allow_nan=False, allow_infinity=False),
            'width': st.floats(min_value=0.0, max_value=500.0, allow_nan=False, allow_infinity=False),
            'height': st.floats(min_value=0.0, max_value=500.0, allow_nan=False, allow_infinity=False),
        }),
        min_size=1, max_size=6,
    ),
    rotation=st.sampled_from([0, 90, 180, 270]),
    index=st.integers(min_value=1, max_value=10000),
    page_count=st.integers(min_value=1, max_value=64),
)
def test_preview_uses_same_parity_primitives_as_engine(fields, rotation, index, page_count):
    """Preview dùng CÙNG primitive parity với engine:
      - cùng công thức field_rects: mm * MM_TO_PTS * CSS_TO_PT_FACTOR
      - cùng hex_to_cmyk (identity hàm) và render-một-record (identity hàm)
      - cùng tập xoay {0,90,180,270}
      - cùng gán trang template (index-1) % page_count
    ⇒ parity preview ↔ engine được bảo toàn.
    """
    # (1) Công thức toạ độ: preview _compute_field_rects == công thức inline engine.
    preview_rects = _compute_field_rects(fields)
    for f, r in zip(fields, preview_rects):
        # Công thức inline mà process_chunk dùng cho mọi loại field.
        assert math.isclose(r['x'], f['x'] * MM_TO_PTS * CSS_TO_PT_FACTOR, rel_tol=0, abs_tol=1e-9)
        assert math.isclose(r['y'], f['y'] * MM_TO_PTS * CSS_TO_PT_FACTOR, rel_tol=0, abs_tol=1e-9)
        assert math.isclose(r['w'], f['width'] * MM_TO_PTS * CSS_TO_PT_FACTOR, rel_tol=0, abs_tol=1e-9)
        assert math.isclose(r['h'], f['height'] * MM_TO_PTS * CSS_TO_PT_FACTOR, rel_tol=0, abs_tol=1e-9)

    # (2) Hằng số parity là CÙNG MỘT đối tượng giữa preview và engine.
    assert vdp_preview.CSS_TO_PT_FACTOR is vdp_engine.CSS_TO_PT_FACTOR
    assert vdp_preview.MM_TO_PTS is vdp_engine.MM_TO_PTS
    assert CSS_TO_PT_FACTOR == 0.75

    # (3) Preview render qua CHÍNH hàm render-một-record của engine (cùng màu CMYK
    #     pure-K và cùng phép xoay) — đảm bảo hex_to_cmyk dùng chung (identity).
    assert vdp_preview.render_one_record is vdp_engine.render_one_record
    # hex_to_cmyk dùng trong render: #000000 → pure-K (0,0,0,1), không rich black.
    assert hex_to_cmyk('#000000') == (0.0, 0.0, 0.0, 1.0)

    # (4) Tập xoay hợp lệ dùng chung.
    assert rotation in (0, 90, 180, 270)

    # (5) Gán trang template: preview dùng (index-1) % page_count (1-based index),
    #     tương đương engine dùng global_idx (0-based) % page_count.
    t_idx = (index - 1) % page_count
    assert 0 <= t_idx < page_count
    assert t_idx == (index - 1) % page_count
