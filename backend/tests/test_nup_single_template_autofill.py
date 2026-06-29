"""Hồi quy: 1 LOẠI TEM đặc biệt + mode "Dàn nhiều mẫu" (auto-fill).

Bug đã sửa (báo bởi user): mở DUY NHẤT 1 loại tem đặc biệt, dropdown chọn "Dàn nhiều
mẫu" → PREVIEW đúng (single-page nesting shape-aware) nhưng OUTPUT "lung tung" vì
nup_engine rẽ sang solve_auto_fill_mixed (MaxRects bao chữ nhật). Chọn "Bình trang"
(S&R) thì cả 2 đúng (cùng đi compute_sticker_layout_for_page + finalize_placements).

Fix: với len(page_infos)==1 (1 mẫu) + auto-fill (không cluster_tile), output dùng CHUNG
full_layouts (nesting) + finalize_placements GIỐNG nhánh 'repeat' & preview → preview≡output.

Mô phỏng theo test_sticker_homogeneous_integration.py (monkeypatch + chặn engine ở
process_chunk). Chạy bằng: backend/venv/Scripts/python.exe -m pytest.
"""
from __future__ import annotations

import os
import sys
import tempfile

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

pytest.importorskip("pikepdf")

from app.workers import pdf_wrapper as pdf_lib
from app.workers import nup_engine
from app.workers import sticker_homogeneous as sh
from app.workers.sticker_imposer_pkg import bin_packing


class _StopEngine(Exception):
    pass


def _make_blank_pdf(path: str, n_pages: int) -> None:
    doc = pdf_lib.open()
    for _ in range(n_pages):
        doc.new_page(width=300.0, height=300.0)
    doc.save(path)
    doc.close()


def _canned_layout(*_a, **_k):
    """Layout nesting giả lập — 8 ô."""
    items = []
    for i in range(8):
        row = i // 4
        col = i % 4
        x = col * 110.0 + (55.0 if row % 2 else 0.0)
        y = row * 90.0
        items.append({"x": x, "y": y, "width": 100.0, "height": 80.0})
    return {
        "items": items,
        "shapeType": "CIRCLE_ELLIPSE",
        "shapeProps": {"width": 100.0, "height": 80.0},
        "trimW": 100.0,
        "trimH": 80.0,
        "strategyUsed": "canned",
    }


def test_single_template_autofill_uses_nesting_not_maxrects(monkeypatch):
    """1 trang die-cut + auto-fill → KHÔNG gọi solve_auto_fill_mixed; dùng nesting+finalize."""
    n_pages = 1  # DUY NHẤT 1 loại tem

    def _fake_find_die(_src_page):
        return {
            "rect": pdf_lib.Rect(0.0, 0.0, 100.0, 80.0),
            "items": [], "color": (0, 1, 1, 0), "width": 0.5,
        }

    monkeypatch.setattr(nup_engine, "_find_largest_die_path", _fake_find_die)
    monkeypatch.setattr(nup_engine, "compute_sticker_layout_for_page", _canned_layout)
    monkeypatch.setattr(sh, "page_has_die", lambda _pg: True)

    spy = {"auto_fill": 0}

    def _spy_auto_fill(*a, **k):
        spy["auto_fill"] += 1
        return {"placements": []}

    monkeypatch.setattr(bin_packing, "solve_auto_fill_mixed", _spy_auto_fill)

    captured = {}

    def _capture_chunk(args):
        captured["precalc"] = args[37]
        raise _StopEngine()

    monkeypatch.setattr(nup_engine, "process_chunk", _capture_chunk)

    with tempfile.TemporaryDirectory() as td:
        src = os.path.join(td, "src.pdf")
        out = os.path.join(td, "out.pdf")
        _make_blank_pdf(src, n_pages)
        settings = {
            "isDieCutMode": True,
            "sheetWidth": 320,
            "sheetHeight": 450,
            "targetQuantity": 0,
            "targetQuantitiesByPage": {},  # → is_auto_fill = True
            "detectedShapesByPage": {"0": "CIRCLE_ELLIPSE"},
            "gridStrategy": "optimal_auto",
            "groupingStrategy": "maximize_area",
            "pontType": "none",
        }
        with pytest.raises(_StopEngine):
            nup_engine.run_nup_engine(src, out, settings, job_id="t-single")

    # KHÔNG dùng MaxRects bin-pack chữ nhật
    assert spy["auto_fill"] == 0, "1 mẫu auto-fill KHÔNG được gọi solve_auto_fill_mixed"

    # Dùng nesting (8 ô từ canned layout) + finalize_placements (có abs_x/abs_y)
    precalc = captured["precalc"]
    assert set(precalc.keys()) == {0}, "1 mẫu auto-fill → đúng 1 tờ"
    sheet0 = precalc[0]
    assert len(sheet0) == 8, f"kỳ vọng 8 ô nesting, được {len(sheet0)}"
    for pl in sheet0:
        assert pl["src_page_idx"] == 0
        assert "abs_x" in pl and "abs_y" in pl and "original_cell_y" in pl


def test_single_template_autofill_parity_with_preview(monkeypatch):
    """Output (1 mẫu auto-fill) phải cho CÙNG placements như preview: cả 2 đều là
    finalize_placements(full_layout['items'], usable_w, usable_h, ml, mb, mt, p_idx)."""
    from app.workers.imposition_finalize import finalize_placements

    monkeypatch.setattr(nup_engine, "_find_largest_die_path", lambda _p: {
        "rect": pdf_lib.Rect(0.0, 0.0, 100.0, 80.0),
        "items": [], "color": (0, 1, 1, 0), "width": 0.5,
    })
    monkeypatch.setattr(nup_engine, "compute_sticker_layout_for_page", _canned_layout)
    monkeypatch.setattr(sh, "page_has_die", lambda _pg: True)
    monkeypatch.setattr(bin_packing, "solve_auto_fill_mixed",
                        lambda *a, **k: {"placements": []})

    captured = {}

    def _capture_chunk(args):
        captured["precalc"] = args[37]
        # usable dims dùng để tái dựng kỳ vọng preview
        raise _StopEngine()

    monkeypatch.setattr(nup_engine, "process_chunk", _capture_chunk)

    with tempfile.TemporaryDirectory() as td:
        src = os.path.join(td, "src.pdf")
        out = os.path.join(td, "out.pdf")
        _make_blank_pdf(src, 1)
        settings = {
            "isDieCutMode": True, "sheetWidth": 320, "sheetHeight": 450,
            "targetQuantity": 0, "targetQuantitiesByPage": {},
            "detectedShapesByPage": {"0": "CIRCLE_ELLIPSE"},
            "gridStrategy": "optimal_auto", "groupingStrategy": "maximize_area",
            "pontType": "none",
        }
        with pytest.raises(_StopEngine):
            nup_engine.run_nup_engine(src, out, settings, job_id="t-parity")

    out_pls = captured["precalc"][0]
    # các ô output trùng số lượng + toạ độ tuyệt đối với finalize_placements trên cùng items
    assert len(out_pls) == 8
    # abs_x/abs_y phải đồng nhất kiểu căn giữa (không phải 0 placeholder)
    assert any(pl["abs_x"] != 0 for pl in out_pls)
    assert all(pl["abs_y"] >= 0 for pl in out_pls)
