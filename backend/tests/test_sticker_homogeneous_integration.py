"""Integration test cho nhánh ĐỒNG NHẤT trong nup_engine (sticker-homogeneous-nup, Task 6).

Mô phỏng (monkeypatch) một bộ tem: trang 0 CÓ khuôn (master) + trang 1..N chỉ có
nội dung (không khuôn), ở chế độ "Dàn nhiều mẫu" (auto-fill). Xác nhận:

  (a) Đi NHÁNH MỚI đồng nhất: ``build_homogeneous_layout`` ĐƯỢC gọi,
      ``solve_auto_fill_mixed`` KHÔNG gọi.
  (b) Mỗi ô (placement) mang ĐÚNG ``src_page_idx`` của trang nội dung (cuốn chiếu
      theo thứ tự 1→N), không có ô rỗng được render.

Chạy: backend/venv/Scripts/python.exe -m pytest tests/test_sticker_homogeneous_integration.py
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
    """Dừng run_nup_engine ngay sau khi dựng placements (tránh chạy merge/save)."""


def _make_blank_pdf(path: str, n_pages: int) -> None:
    doc = pdf_lib.open()
    for _ in range(n_pages):
        doc.new_page(width=300.0, height=300.0)
    doc.save(path)
    doc.close()


def _canned_layout(*_a, **_k):
    """Layout nesting 'so le' giả lập — 8 ô (đủ chứa 3 nội dung trên 1 tờ)."""
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


def test_homogeneous_branch_routing_and_src_page_idx(monkeypatch):
    n_pages = 4  # trang 0 = master (khuôn), trang 1,2,3 = nội dung

    # ── Tín hiệu has_die: chỉ trang ĐẦU TIÊN (p_idx=0) có đường bế ──
    _call = {"n": 0}

    def _fake_find_die(_src_page):
        idx = _call["n"]
        _call["n"] += 1
        if idx == 0:
            return {
                "rect": pdf_lib.Rect(0.0, 0.0, 100.0, 80.0),
                "items": [],
                "color": (0, 1, 1, 0),
                "width": 0.5,
            }
        return None

    monkeypatch.setattr(nup_engine, "_find_largest_die_path", _fake_find_die)
    monkeypatch.setattr(nup_engine, "compute_sticker_layout_for_page", _canned_layout)

    # ── Tín hiệu ĐÁNG TIN page_has_die: chỉ trang 0 có đường bế thật (master) ──
    _dcall = {"n": 0}

    def _fake_page_has_die(_pg):
        idx = _dcall["n"]; _dcall["n"] += 1
        return idx == 0

    monkeypatch.setattr(sh, "page_has_die", _fake_page_has_die)

    # ── Spy: build_homogeneous_layout (wrap bản gốc) + solve_auto_fill_mixed ──
    spy = {"build_hom": 0, "auto_fill": 0}
    _orig_build = sh.build_homogeneous_layout

    def _spy_build(*a, **k):
        spy["build_hom"] += 1
        return _orig_build(*a, **k)

    monkeypatch.setattr(sh, "build_homogeneous_layout", _spy_build)

    def _spy_auto_fill(*a, **k):
        spy["auto_fill"] += 1
        return {"placements": []}

    monkeypatch.setattr(bin_packing, "solve_auto_fill_mixed", _spy_auto_fill)

    # ── Bắt placements qua process_chunk rồi dừng engine ──
    captured = {}

    def _capture_chunk(args):
        # args[37] = chunk_precalc_placements ; args[-2] = homogeneous_mode ; args[-1] = master_idx
        captured["precalc"] = args[37]
        captured["homogeneous_mode"] = args[-2]
        captured["master_idx"] = args[-1]
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
            nup_engine.run_nup_engine(src, out, settings, job_id="t-hom")

    # (a) routing: nhánh đồng nhất, KHÔNG bin-pack trộn
    assert spy["build_hom"] == 1, "build_homogeneous_layout phải được gọi đúng 1 lần"
    assert spy["auto_fill"] == 0, "solve_auto_fill_mixed KHÔNG được gọi ở nhánh đồng nhất"
    assert captured.get("homogeneous_mode") is True
    assert captured.get("master_idx") == 0

    # (b) mỗi ô mang đúng src_page_idx nội dung (cuốn chiếu 1→N), không render ô rỗng
    precalc = captured["precalc"]
    assert set(precalc.keys()) == {0}, "3 nội dung / 8 ô → đúng 1 tờ"
    sheet0 = precalc[0]
    src_pages = [pl["src_page_idx"] for pl in sheet0]
    assert src_pages == [1, 2, 3], f"src_page_idx sai/không đúng thứ tự: {src_pages}"
    # không ô nào trỏ về master (master chỉ là khuôn, không phải nội dung)
    assert 0 not in src_pages
    # mỗi placement có toạ độ tuyệt đối đã căn giữa (finalize_placements)
    for pl in sheet0:
        assert "abs_x" in pl and "abs_y" in pl and "original_cell_y" in pl


def test_homogeneous_active_with_quantities_not_autofill(monkeypatch):
    """Regression: chế độ đồng nhất PHẢI chạy khi nhập SỐ LƯỢNG khác nhau (không auto-fill).

    Kịch bản user: 'tạo khuôn trang đầu' rồi bình tem bế với số lượng/trang khác nhau.
    Trước đây cổng ``is_auto_fill`` chặn → mỗi trang xếp độc lập (tem đầu lệch tem sau).
    Nay đồng nhất chạy bất kể số lượng; nội dung giãn round-robin theo số lượng.
    """
    n_pages = 4  # trang 0 = master, trang 1,2,3 = nội dung

    _call = {"n": 0}

    def _fake_find_die(_src_page):
        idx = _call["n"]; _call["n"] += 1
        if idx == 0:
            return {"rect": pdf_lib.Rect(0.0, 0.0, 100.0, 80.0),
                    "items": [], "color": (0, 1, 1, 0), "width": 0.5}
        return None

    monkeypatch.setattr(nup_engine, "_find_largest_die_path", _fake_find_die)
    monkeypatch.setattr(nup_engine, "compute_sticker_layout_for_page", _canned_layout)

    _dcall = {"n": 0}

    def _fake_page_has_die(_pg):
        idx = _dcall["n"]; _dcall["n"] += 1
        return idx == 0

    monkeypatch.setattr(sh, "page_has_die", _fake_page_has_die)

    spy = {"build_hom": 0, "auto_fill": 0}
    _orig_build = sh.build_homogeneous_layout

    def _spy_build(*a, **k):
        spy["build_hom"] += 1
        return _orig_build(*a, **k)

    monkeypatch.setattr(sh, "build_homogeneous_layout", _spy_build)

    def _spy_auto_fill(*a, **k):
        spy["auto_fill"] += 1
        return {"placements": []}

    monkeypatch.setattr(bin_packing, "solve_auto_fill_mixed", _spy_auto_fill)

    captured = {}

    def _capture_chunk(args):
        captured["precalc"] = args[37]
        captured["homogeneous_mode"] = args[-2]
        captured["master_idx"] = args[-1]
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
            # SỐ LƯỢNG khác nhau theo trang → is_auto_fill = False (đây là mấu chốt test).
            "targetQuantitiesByPage": {"1": 2, "2": 1, "3": 1},
            "detectedShapesByPage": {"0": "CIRCLE_ELLIPSE"},
            "gridStrategy": "optimal_auto",
            "groupingStrategy": "maximize_area",
            "pontType": "none",
        }
        with pytest.raises(_StopEngine):
            nup_engine.run_nup_engine(src, out, settings, job_id="t-hom-qty")

    # Đồng nhất VẪN chạy dù KHÔNG auto-fill (đây là fix chính).
    assert spy["build_hom"] == 1, "đồng nhất phải chạy khi có số lượng"
    assert spy["auto_fill"] == 0
    assert captured.get("homogeneous_mode") is True
    assert captured.get("master_idx") == 0

    # Nội dung giãn theo số lượng, round-robin: page1×2, page2×1, page3×1 → [1,2,3,1].
    sheet0 = captured["precalc"][0]
    src_pages = [pl["src_page_idx"] for pl in sheet0]
    assert sorted(src_pages) == [1, 1, 2, 3], f"số lượng theo trang sai: {src_pages}"
    assert 0 not in src_pages  # master chỉ là khuôn


# ─── Property 7: Fallback an toàn (≥2 khuôn / 0 khuôn → đường cũ) ─────────────

def test_fallback_two_dies_uses_old_binpack(monkeypatch):
    """≥2 trang có khuôn → KHÔNG đồng nhất → đi đường bin-pack trộn cũ (Property 7 / Req 8.1)."""
    n_pages = 3  # cả 3 trang đều có khuôn → ≥2 khuôn → fallback

    def _fake_find_die_all(_src_page):
        return {
            "rect": pdf_lib.Rect(0.0, 0.0, 100.0, 80.0),
            "items": [], "color": (0, 1, 1, 0), "width": 0.5,
        }

    monkeypatch.setattr(nup_engine, "_find_largest_die_path", _fake_find_die_all)
    monkeypatch.setattr(nup_engine, "compute_sticker_layout_for_page", _canned_layout)
    # ≥2 trang có đường bế THẬT → khác khuôn → mixed (page_has_die=True mọi trang).
    monkeypatch.setattr(sh, "page_has_die", lambda _pg: True)

    spy = {"build_hom": 0, "auto_fill": 0}
    _orig_build = sh.build_homogeneous_layout

    def _spy_build(*a, **k):
        spy["build_hom"] += 1
        return _orig_build(*a, **k)

    monkeypatch.setattr(sh, "build_homogeneous_layout", _spy_build)

    def _spy_auto_fill(*a, **k):
        spy["auto_fill"] += 1
        return {"placements": [{"x": 0.0, "y": 0.0, "w": 100.0, "h": 80.0,
                                "page_idx": 0, "is_rotated": False}]}

    monkeypatch.setattr(bin_packing, "solve_auto_fill_mixed", _spy_auto_fill)

    captured = {}

    def _capture_chunk(args):
        captured["homogeneous_mode"] = args[-2]
        raise _StopEngine()

    monkeypatch.setattr(nup_engine, "process_chunk", _capture_chunk)

    with tempfile.TemporaryDirectory() as td:
        src = os.path.join(td, "src.pdf")
        out = os.path.join(td, "out.pdf")
        _make_blank_pdf(src, n_pages)
        settings = {
            "isDieCutMode": True, "sheetWidth": 320, "sheetHeight": 450,
            "targetQuantity": 0, "targetQuantitiesByPage": {},
            "detectedShapesByPage": {"0": "CIRCLE_ELLIPSE", "1": "CIRCLE_ELLIPSE", "2": "CIRCLE_ELLIPSE"},
            "gridStrategy": "optimal_auto", "groupingStrategy": "maximize_area",
            "pontType": "none",
        }
        with pytest.raises(_StopEngine):
            nup_engine.run_nup_engine(src, out, settings, job_id="t-fallback")

    # ≥2 khuôn → KHÔNG đi nhánh đồng nhất; đi bin-pack trộn cũ.
    assert spy["build_hom"] == 0, "≥2 khuôn không được vào nhánh đồng nhất"
    assert spy["auto_fill"] == 1, "phải dùng solve_auto_fill_mixed (đường cũ)"
    assert captured.get("homogeneous_mode") is False


def test_fallback_no_die_uses_old_binpack(monkeypatch):
    """0 trang có khuôn → KHÔNG đồng nhất → đường cũ (Property 7 / Req 8.1)."""
    n_pages = 2

    monkeypatch.setattr(nup_engine, "_find_largest_die_path", lambda _p: None)
    monkeypatch.setattr(nup_engine, "compute_sticker_layout_for_page", _canned_layout)
    # 0 trang có đường bế thật → mixed/cũ.
    monkeypatch.setattr(sh, "page_has_die", lambda _pg: False)

    spy = {"build_hom": 0, "auto_fill": 0}

    def _spy_build(*a, **k):
        spy["build_hom"] += 1
        return sh.HomogeneousLayout((), 0, sh.ShapeType.CUSTOM, {}, 0, 0, (), 0)

    monkeypatch.setattr(sh, "build_homogeneous_layout", _spy_build)

    def _spy_auto_fill(*a, **k):
        spy["auto_fill"] += 1
        return {"placements": [{"x": 0.0, "y": 0.0, "w": 100.0, "h": 80.0,
                                "page_idx": 0, "is_rotated": False}]}

    monkeypatch.setattr(bin_packing, "solve_auto_fill_mixed", _spy_auto_fill)
    monkeypatch.setattr(nup_engine, "process_chunk", lambda args: (_ for _ in ()).throw(_StopEngine()))

    with tempfile.TemporaryDirectory() as td:
        src = os.path.join(td, "src.pdf")
        out = os.path.join(td, "out.pdf")
        _make_blank_pdf(src, n_pages)
        settings = {
            "isDieCutMode": True, "sheetWidth": 320, "sheetHeight": 450,
            "targetQuantity": 0, "targetQuantitiesByPage": {},
            "detectedShapesByPage": {}, "gridStrategy": "optimal_auto",
            "groupingStrategy": "maximize_area", "pontType": "none",
        }
        with pytest.raises(_StopEngine):
            nup_engine.run_nup_engine(src, out, settings, job_id="t-nodie")

    assert spy["build_hom"] == 0
    assert spy["auto_fill"] == 1
