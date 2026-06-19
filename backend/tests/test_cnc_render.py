"""
Test cho cnc_render — phần kiểm chứng được không cần solver Rust:
  - Validation số trang lẻ khi bật 2 mặt.
  - Công thức _build_placements (căn giữa + original_cell_y).
  - Đối xứng Mặt sau (kết hợp mirror_layout + _build_placements).
"""
import io
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from app.workers import pdf_wrapper as pdf_lib
from app.workers.cnc_render import _build_placements, run_cnc_two_sided


def _make_plain_pdf(path, n_pages, w=320 * 2.83465, h=450 * 2.83465):
    doc = pdf_lib.open()
    for _ in range(n_pages):
        doc.new_page(width=w, height=h)
    buf = io.BytesIO()
    doc.save(buf, garbage=0, deflate=True)
    doc.close()
    with open(path, 'wb') as f:
        f.write(buf.getvalue())


# ──────────────────────────────────────────────────────────────────────────
# Validation số trang lẻ
# ──────────────────────────────────────────────────────────────────────────

def test_two_sided_odd_pages_raises(tmp_path):
    p = str(tmp_path / "odd.pdf")
    _make_plain_pdf(p, 3)
    out = str(tmp_path / "out.pdf")
    with pytest.raises(ValueError, match="CHẴN"):
        run_cnc_two_sided(p, out, {'cncTwoSided': True, 'sheetWidth': 320, 'sheetHeight': 450})


def test_empty_pdf_raises(tmp_path):
    p = str(tmp_path / "empty.pdf")
    _make_plain_pdf(p, 0)
    out = str(tmp_path / "out.pdf")
    with pytest.raises(ValueError):
        run_cnc_two_sided(p, out, {'cncTwoSided': True})


# ──────────────────────────────────────────────────────────────────────────
# _build_placements
# ──────────────────────────────────────────────────────────────────────────

USABLE_W = 1000.0
USABLE_H = 600.0


def _items():
    return [
        {'x': 0, 'y': 0, 'width': 100, 'height': 80},
        {'x': 200, 'y': 100, 'width': 100, 'height': 80},
    ]


def test_build_placements_basic():
    pls = _build_placements(_items(), USABLE_W, USABLE_H, 0, 0, 0, src_page_idx=5)
    assert len(pls) == 2
    for pl in pls:
        assert pl['src_page_idx'] == 5
        assert pl['cluster_idx'] == 0
        assert 'abs_x' in pl and 'original_cell_y' in pl


def test_build_placements_empty():
    assert _build_placements([], USABLE_W, USABLE_H, 0, 0, 0, 0) == []


def test_build_placements_centering_x():
    # max_x_used = 300 < usable_w=1000 → x_off = (1000-300)/2 = 350
    pls = _build_placements(_items(), USABLE_W, USABLE_H, 0, 0, 0, 0)
    assert pls[0]['abs_x'] == pytest.approx(350 + 0)
    assert pls[1]['abs_x'] == pytest.approx(350 + 200)
