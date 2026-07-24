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

import concurrent.futures
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


class _CaptureAllPool:
    """Run every chunk inline so tests can inspect all precalculated sheets."""

    def __init__(self, *args, **kwargs):
        pass

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def map(self, fn, args_list):
        for args in args_list:
            fn(args)
        raise _StopEngine()


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
        # args[37] = chunk_precalc_placements; tail = homogeneous_mode, master_idx, page_sheet_mode
        captured["precalc"] = args[37]
        captured["homogeneous_mode"] = args[-3]
        captured["master_idx"] = args[-2]
        captured["page_sheet_mode"] = args[-1]
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
    assert captured.get("page_sheet_mode") is False

    # (b) auto-fill chia đều thành khối liền theo mẫu; master = loại đầu.
    precalc = captured["precalc"]
    assert set(precalc.keys()) == {0}, "4 trang (gồm master) / 8 ô → đúng 1 tờ"
    sheet0 = precalc[0]
    src_pages = [pl["src_page_idx"] for pl in sheet0]
    assert src_pages == [0, 0, 1, 1, 2, 2, 3, 3], f"src_page_idx sai/không đúng thứ tự: {src_pages}"
    # Master (trang 0) CŨNG là nội dung in — tem loại đầu có artwork + khuôn.
    assert 0 in src_pages
    # mỗi placement có toạ độ tuyệt đối đã căn giữa (finalize_placements)
    for pl in sheet0:
        assert "abs_x" in pl and "abs_y" in pl and "original_cell_y" in pl


def test_one_dao_page_mode_does_not_use_homogeneous_clip(monkeypatch):
    """1 Dao theo kích thước trang phải bỏ qua khuôn master có sẵn.

    Nếu homogeneous còn bật, process_chunk sẽ tạo homogeneous_clip từ artwork bbox
    và place_one_artwork return sớm trước nhánh clip chữ nhật theo kích thước trang.
    """
    n_pages = 2
    find_calls = {"n": 0}

    def _fake_find_die(_src_page):
        idx = find_calls["n"]
        find_calls["n"] += 1
        if idx == 0:
            return {
                "rect": pdf_lib.Rect(20.0, 20.0, 120.0, 100.0),
                "items": [], "color": (0, 1, 1, 0), "width": 0.5,
            }
        return None

    monkeypatch.setattr(nup_engine, "_find_largest_die_path", _fake_find_die)
    monkeypatch.setattr(nup_engine, "compute_sticker_layout_for_page", _canned_layout)

    die_calls = {"n": 0}
    def _fake_page_has_die(_pg):
        idx = die_calls["n"]
        die_calls["n"] += 1
        return idx == 0
    monkeypatch.setattr(sh, "page_has_die", _fake_page_has_die)

    captured = {}
    def _capture_chunk(args):
        captured["precalc"] = args[37]
        captured["homogeneous_mode"] = args[-3]
        captured["master_idx"] = args[-2]
        captured["page_sheet_mode"] = args[-1]
        raise _StopEngine()
    monkeypatch.setattr(nup_engine, "process_chunk", _capture_chunk)

    with tempfile.TemporaryDirectory() as td:
        src = os.path.join(td, "src.pdf")
        out = os.path.join(td, "out.pdf")
        _make_blank_pdf(src, n_pages)
        settings = {
            "isDieCutMode": True,
            "sheetWidth": 320, "sheetHeight": 450,
            "targetQuantity": 0, "targetQuantitiesByPage": {},
            "detectedShapesByPage": {"0": "CIRCLE_ELLIPSE"},
            "gridStrategy": "optimal_auto",
            "groupingStrategy": "maximize_area",
            "pontType": "none",
            "cutType": "one_dao",
            "dieSizeMode": "page",
            "dieOffsetMm": 0,
        }
        with pytest.raises(_StopEngine):
            nup_engine.run_nup_engine(src, out, settings, job_id="t-one-dao-page")

    assert captured["homogeneous_mode"] is False
    assert captured["master_idx"] is None
    assert captured["page_sheet_mode"] is False
    sheet0 = captured["precalc"][0]
    assert len({(p["width"], p["height"], p["cell"]["isRotated"]) for p in sheet0}) == 1
    src_order = [p["src_page_idx"] for p in sheet0]
    assert src_order == sorted(src_order)
    assert set(src_order) == {0, 1}
    assert abs(src_order.count(0) - src_order.count(1)) <= 1


def test_homogeneous_active_with_quantities_not_autofill(monkeypatch):
    """Fixed quantity vẫn là dàn nhiều mẫu, không biến thành S&R từng loại.

    Kịch bản user: 'tạo khuôn trang đầu' rồi bình tem bế với số lượng/trang khác nhau.
    qty 16/16/8/8, C=8 → 6 tờ mixed, đúng tổng quantity từng artwork.
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
        captured.setdefault("precalc", {}).update(args[37])
        captured["homogeneous_mode"] = args[-3]
        captured["master_idx"] = args[-2]
        captured["page_sheet_mode"] = args[-1]
        return b""

    monkeypatch.setattr(nup_engine, "process_chunk", _capture_chunk)
    monkeypatch.setattr(concurrent.futures, "ProcessPoolExecutor", _CaptureAllPool)
    # 1 core → 1 chunk (tránh ProcessPool pickle local _capture_chunk).
    monkeypatch.setattr(os, "cpu_count", lambda: 2)

    with tempfile.TemporaryDirectory() as td:
        src = os.path.join(td, "src.pdf")
        out = os.path.join(td, "out.pdf")
        _make_blank_pdf(src, n_pages)
        settings = {
            "isDieCutMode": True,
            "sheetWidth": 320,
            "sheetHeight": 450,
            "targetQuantity": 0,
            # Fixed qty cho bốn artwork, gồm trang master (0).
            "targetQuantitiesByPage": {"0": 16, "1": 16, "2": 8, "3": 8},
            "exportUniqueSheets": True,
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
    assert captured.get("page_sheet_mode") is False

    pre = captured["precalc"]
    assert sorted(pre.keys()) == list(range(6))
    counts = {i: 0 for i in range(4)}
    for placements in pre.values():
        assert 1 <= len(placements) <= 8
        for pl in placements:
            counts[pl["src_page_idx"]] += 1
    assert counts == {0: 16, 1: 16, 2: 8, 3: 8}
    assert any(len({pl["src_page_idx"] for pl in placements}) > 1
               for placements in pre.values())


def test_homogeneous_mixed_uses_global_target_quantity(monkeypatch):
    """Bug: targetQuantity global bị bỏ qua (chỉ đọc targetQuantitiesByPage).

    Bốn artwork × 100, C=8 → 50 tờ mixed và đúng 100 con mỗi loại.
    """
    n_pages = 4
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

    captured = {}

    def _capture_chunk(args):
        captured.setdefault("precalc", {}).update(args[37])
        return b""

    monkeypatch.setattr(nup_engine, "process_chunk", _capture_chunk)
    monkeypatch.setattr(concurrent.futures, "ProcessPoolExecutor", _CaptureAllPool)
    monkeypatch.setattr(os, "cpu_count", lambda: 2)

    with tempfile.TemporaryDirectory() as td:
        src = os.path.join(td, "src.pdf")
        out = os.path.join(td, "out.pdf")
        _make_blank_pdf(src, n_pages)
        settings = {
            "isDieCutMode": True,
            "sheetWidth": 320, "sheetHeight": 450,
            "targetQuantity": 100,  # global — trước đây bị bỏ qua
            "targetQuantitiesByPage": {},
            "exportUniqueSheets": True,
            "detectedShapesByPage": {"0": "CIRCLE_ELLIPSE"},
            "gridStrategy": "optimal_auto",
            "groupingStrategy": "maximize_area",
            "pontType": "none",
        }
        with pytest.raises(_StopEngine):
            nup_engine.run_nup_engine(src, out, settings, job_id="t-hom-global-qty")

    pre = captured["precalc"]
    assert len(pre) == 50
    counts = {i: 0 for i in range(4)}
    for placements in pre.values():
        for pl in placements:
            counts[pl["src_page_idx"]] += 1
    assert counts == {0: 100, 1: 100, 2: 100, 3: 100}


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
        captured["homogeneous_mode"] = args[-3]
        captured["page_sheet_mode"] = args[-1]
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
    assert captured.get("page_sheet_mode") is False


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


# ─── Regression: nhánh ĐỒNG NHẤT phải XOAY tem (không co theo bề rộng ô) ──────


class _FakeOutPage:
    """out_page giả: ghi lại mọi lần show_pdf_page (để kiểm tham số rotate)."""

    def __init__(self):
        self.calls = []

    def show_pdf_page(self, rect, src_doc, page_idx, rotate=0, clip=None,
                      keep_proportion=False, out_clip=None, mirror_x=False, mirror_y=False):
        self.calls.append({
            "rect": rect, "page_idx": page_idx, "rotate": rotate,
            "clip": clip, "keep_proportion": keep_proportion,
        })


class _FakeSrcDoc:
    """src_doc giả: chỉ cần index được (nhánh đồng nhất không dùng src_page)."""

    def __getitem__(self, _idx):
        return object()


def test_one_dao_page_clip_is_exact_trim_even_at_outer_sheet_edge():
    """Tem sát lề không được nới clip thêm bleed trong page-sized 1 Dao."""
    from app.workers.nup_artwork import resolve_die_output_clip

    trim = pdf_lib.Rect(10.0, 20.0, 110.0, 100.0)
    bleed = pdf_lib.Rect(4.0, 14.0, 116.0, 106.0)
    # Mô phỏng ô ngoài cùng: logic block cũ cũng trả full bleed ở mọi mép ngoài.
    outer_clip = pdf_lib.Rect(4.0, 14.0, 116.0, 106.0)

    actual = resolve_die_output_clip(trim, bleed, outer_clip, "one_dao", "page")
    assert (actual.x0, actual.y0, actual.x1, actual.y1) == (10.0, 20.0, 110.0, 100.0)


def test_existing_die_mode_keeps_outer_bleed_clip():
    """Không làm đổi hành vi bù xén của chế độ lấy khuôn có sẵn."""
    from app.workers.nup_artwork import resolve_die_output_clip

    trim = pdf_lib.Rect(10.0, 20.0, 110.0, 100.0)
    bleed = pdf_lib.Rect(4.0, 14.0, 116.0, 106.0)
    outer_clip = pdf_lib.Rect(4.0, 14.0, 116.0, 106.0)

    actual = resolve_die_output_clip(trim, bleed, outer_clip, "one_dao", "die")
    assert (actual.x0, actual.y0, actual.x1, actual.y1) == (4.0, 14.0, 116.0, 106.0)


def _place_homogeneous(is_rotated: bool, is_rotated_180: bool = False):
    """Gọi place_one_artwork ở nhánh đồng nhất với cờ xoay cho trước → trả call ghi được."""
    from app.workers.nup_artwork import place_one_artwork

    out_page = _FakeOutPage()
    # Ô DỌC (rộng 80, cao 100) — tem nguồn NGANG cần xoay 90° để lồng khít.
    p = {
        "cell": {"width": 80.0, "height": 100.0,
                 "isRotated": is_rotated, "isRotated180": is_rotated_180,
                 "blockId": 0},
        "cluster_idx": 0,
        "src_page_idx": 1,
        "abs_x": 10.0,
        "original_cell_y": 20.0,
    }
    hom_clip = pdf_lib.Rect(0.0, 0.0, 100.0, 80.0)  # bbox artwork NGANG (rộng>cao)
    place_one_artwork(
        out_page, _FakeSrcDoc(), p,
        bleed_pt=0.0, is_die_cut=True, cut_type="one_dao",
        separate_cut_page=False, local_stripped_pages=set(),
        job_id="t", diecut_geom_cache={}, die_items_cache={},
        max_geom_cache=8, block_bbox={}, clip_off_x=0.0, clip_off_y=0.0,
        find_largest_die_path=lambda _p: None,
        homogeneous_clip=hom_clip,
    )
    return out_page.calls


def test_homogeneous_rotated_cell_passes_rotate90():
    """Ô xoay (tem ngang → ô dọc) PHẢI truyền rotate=90, KHÔNG chỉ co-khít.

    Regression: nhánh đồng nhất trước đây short-circuit với keep_proportion=True mà
    bỏ qua cờ xoay → tem ngang bị CO theo bề rộng ô dọc thay vì xoay 90° (tem sai
    kích thước). Test này FAIL trước sửa (rotate=0), PASS sau sửa (rotate=90).
    """
    calls = _place_homogeneous(is_rotated=True)
    assert len(calls) == 1
    assert calls[0]["rotate"] == 90, (
        f"ô xoay phải truyền rotate=90, nhận {calls[0]['rotate']} "
        "(tem bị co theo bề rộng thay vì xoay — bug bình tem chung khuôn)"
    )
    # Vẫn giữ co-khít + clip để căn tâm vào khuôn.
    assert calls[0]["keep_proportion"] is True
    assert calls[0]["clip"] is not None


def test_homogeneous_unrotated_cell_no_rotate():
    """Ô KHÔNG xoay → rotate=0 (giữ hành vi co-khít căn tâm cũ)."""
    calls = _place_homogeneous(is_rotated=False)
    assert len(calls) == 1
    assert calls[0]["rotate"] == 0


def test_homogeneous_place_strips_die_from_master_before_show(monkeypatch):
    """Regression: loại đầu (trang master) có nét khuôn → PHẢI strip trước place.

    Trước đây nhánh homogeneous short-circuit show_pdf_page mà bỏ strip → khuôn sót
    trên tờ in loại 1. Các loại khác không có nét bế nên sạch.
    """
    from app.workers import nup_artwork as art

    strip_calls = {"n": 0}

    def _fake_strip(page_or_xobj, target_color, die_names_lower=None, target_spot=None):
        strip_calls["n"] += 1
        return True

    monkeypatch.setattr(art, "strip_color_from_stream", _fake_strip)

    class _FakePikePage:
        def contents_coalesce(self):
            return None

        def get(self, key):
            if key == "/Contents":
                return object()  # truthy → vào nhánh strip content
            if key == "/Resources":
                return None
            return None

    class _FakePikePdf:
        pages = [_FakePikePage()]

    class _SrcDocWithPdf:
        _pdf = _FakePikePdf()

        def __getitem__(self, _idx):
            return object()

    out_page = _FakeOutPage()
    p = {
        "cell": {"width": 80.0, "height": 100.0,
                 "isRotated": False, "isRotated180": False, "blockId": 0},
        "cluster_idx": 0,
        "src_page_idx": 0,  # master = loại đầu
        "abs_x": 10.0,
        "original_cell_y": 20.0,
    }
    stripped = set()
    art.place_one_artwork(
        out_page, _SrcDocWithPdf(), p,
        bleed_pt=0.0, is_die_cut=True, cut_type="default",
        separate_cut_page=True, local_stripped_pages=stripped,
        job_id="t-strip", diecut_geom_cache={}, die_items_cache={
            "t-strip_0": {
                "items": [], "rect": pdf_lib.Rect(0, 0, 50, 40),
                "color": (0, 1, 1, 0), "width": 0.5, "spot_name": "CutContour",
            }
        },
        max_geom_cache=8, block_bbox={}, clip_off_x=0.0, clip_off_y=0.0,
        find_largest_die_path=lambda _p: None,
        homogeneous_clip=pdf_lib.Rect(0.0, 0.0, 50.0, 40.0),
    )
    assert strip_calls["n"] >= 1, (
        "homogeneous place master PHẢI gọi strip đường bế trước show_pdf_page "
        f"(nhận {strip_calls['n']} lần — khuôn sót trên tờ in loại đầu)"
    )
    assert 0 in stripped
    assert len(out_page.calls) == 1  # vẫn place artwork sau strip


def test_homogeneous_rotated180_cell_passes_rotate180():
    """Ô lật 180 → rotate=180."""
    calls = _place_homogeneous(is_rotated=False, is_rotated_180=True)
    assert len(calls) == 1
    assert calls[0]["rotate"] == 180
