"""N-Up cắt xén nhiều mẫu CÙNG cỡ — chế độ 'ratio_stack' (chia tỷ lệ + xếp chồng).

Nghiệp vụ: dao xén guillotine chém cả chồng giấy. MỌI tờ phải GIỐNG HỆT nhau và
"cùng vị trí ô xuyên suốt cả chồng luôn là cùng một mẫu" → xén ra mỗi xấp một loại
sạch. Số ô mỗi mẫu theo TỶ LỆ số lượng.

Test kiểm nhánh 'ratio_stack' trong nup_engine (dựng precalculated_placements):
  - mỗi vị trí ô CỐ ĐỊNH 1 mẫu xuyên các tờ (mọi tờ giống hệt nhau);
  - số ô mỗi mẫu đúng tỷ lệ số lượng;
  - nhánh 'sequential' cũ KHÔNG đổi hành vi (regression).

Kỹ thuật test: nhánh guillotine chạy process_chunk qua ProcessPoolExecutor khi có
>1 chunk → tiến trình con KHÔNG thấy monkeypatch. Nên ép về đường 1-CHUNK INLINE:
patch os.cpu_count→2 (available_cores=1) + giữ n_sheets nhỏ (2..5) → 1 chunk chạy
serial, capture+raise hoạt động. Layout cố định (canned) để tất định.

Chạy: backend/venv/Scripts/python.exe -m pytest tests/test_ratio_stack_nup.py
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


class _StopEngine(Exception):
    pass


def _make_blank_pdf(path: str, n_pages: int) -> None:
    doc = pdf_lib.open()
    for _ in range(n_pages):
        doc.new_page(width=200.0, height=200.0)
    doc.save(path)
    doc.close()


def _canned_layout_8(*_a, **_k):
    """Lưới đều 8 ô (4×2) tất định — capacity=8 để n_sheets nhỏ, dễ kiểm."""
    cells = []
    for i in range(8):
        r = i // 4
        c = i % 4
        cells.append({
            "c": c, "r": r,
            "x": float(c * 60), "y": float(r * 60),
            "width": 50.0, "height": 50.0, "isRotated": False,
        })
    return {
        "totalItems": 8, "cells": cells,
        "overallWidth": 230.0, "overallHeight": 110.0,
        "cols": 4, "rows": 2, "isRotated": False, "strategyUsed": "canned",
    }


def _run_capture(monkeypatch, n_pages, settings):
    """Chạy engine (ép 1-chunk inline), chặn ở process_chunk, trả precalc (args[37])."""
    captured = {}

    def _capture_chunk(args):
        captured["precalc"] = args[37]
        raise _StopEngine()

    # Ép 1 chunk inline: cpu_count=2 → available_cores=1; layout tất định 8 ô.
    monkeypatch.setattr(os, "cpu_count", lambda: 2)
    monkeypatch.setattr(nup_engine, "solve_optimal_layout", _canned_layout_8)
    monkeypatch.setattr(nup_engine, "process_chunk", _capture_chunk)

    with tempfile.TemporaryDirectory() as td:
        src = os.path.join(td, "src.pdf")
        out = os.path.join(td, "out.pdf")
        _make_blank_pdf(src, n_pages)
        with pytest.raises(_StopEngine):
            nup_engine.run_nup_engine(src, out, settings, job_id="t-ratio")
    return captured.get("precalc")


def _base_settings(**over):
    s = {
        "isDieCutMode": False,
        "sheetWidth": 320,
        "sheetHeight": 450,
        "targetQuantity": 0,
        "targetQuantitiesByPage": {},
        "gridStrategy": "optimal_auto",
        "pontType": "none",
        "layoutType": "ratio_stack",
    }
    s.update(over)
    return s


def test_ratio_stack_moi_to_giong_het_nhau(monkeypatch):
    """Export-unique: chỉ 1 tờ mẫu; mỗi vị trí ô gán cố định 1 mẫu (template đồng nhất).

    capacity=8, qtys=[10,2,4] → cells≈[5,1,2], n_sheets=2 nhưng PDF chỉ 1 trang mẫu
    (máy in chạy N bản). Không còn precalc multi-sheet để so tờ-tờ.
    """
    settings = _base_settings(targetQuantitiesByPage={"0": 10, "1": 2, "2": 4})
    precalc = _run_capture(monkeypatch, 3, settings)

    assert precalc is not None and 0 in precalc, "cần tờ mẫu 0"
    assert list(precalc.keys()) == [0], f"export-unique chỉ 1 tờ, được keys={list(precalc.keys())}"

    sheet0 = precalc[0]
    assert len(sheet0) == 8, f"đủ capacity 8 ô, được {len(sheet0)}"

    # Mỗi vị trí (abs) xuất hiện đúng 1 lần; mỗi ô có src_page_idx hợp lệ.
    pos = [(round(p["abs_x"], 3), round(p["abs_y"], 3)) for p in sheet0]
    assert len(pos) == len(set(pos)), "hai ô không được trùng toạ độ"
    pages = {p["src_page_idx"] for p in sheet0}
    assert pages.issubset({0, 1, 2})
    assert len(pages) >= 2, "nhiều mẫu phải cùng nằm trên 1 tờ mẫu"


def test_ratio_stack_so_o_theo_ty_le(monkeypatch):
    """Số ô mỗi mẫu trên 1 tờ tỷ lệ với số lượng: mẫu 0 (10) > mẫu 2 (4) > mẫu 1 (2)."""
    settings = _base_settings(targetQuantitiesByPage={"0": 10, "1": 2, "2": 4})
    precalc = _run_capture(monkeypatch, 3, settings)

    sheet0 = precalc[0]
    counts = {}
    for p in sheet0:
        counts[p["src_page_idx"]] = counts.get(p["src_page_idx"], 0) + 1

    # Mẫu 0 nhiều ô nhất; mẫu 1 ít nhất nhưng >=1; mẫu 2 ở giữa.
    assert counts.get(0, 0) > counts.get(2, 0) > counts.get(1, 0) >= 1, f"counts={counts}"
    # Tổng ô = capacity.
    assert sum(counts.values()) == 8, f"tổng ô phải = capacity 8, được {counts}"


def test_ratio_stack_khong_dung_round_robin(monkeypatch):
    """Khác 'sequential': ô cùng mẫu nằm LIỀN nhau, KHÔNG xoay vòng 0,1,0,1."""
    settings = _base_settings(targetQuantitiesByPage={"0": 8, "1": 8})
    precalc = _run_capture(monkeypatch, 2, settings)

    sheet0 = precalc[0]
    pages_seq = [p["src_page_idx"] for p in sheet0]
    # Round-robin thuần sẽ là [0,1,0,1,...]; ratio_stack gom liền [0,0,0,0,1,1,1,1].
    switches = sum(1 for a, b in zip(pages_seq, pages_seq[1:]) if a != b)
    assert switches <= 1, f"ô cùng mẫu phải liền nhau (switches={switches}, seq={pages_seq})"


def test_sequential_lan_luot_theo_sl(monkeypatch):
    """Xếp lần lượt: trang0 × q0 rồi trang1 × q1 (KHÔNG xen kẽ 0,1,0,1).

    capacity=8, q=[8,8] → tờ 0 toàn mẫu 0, tờ 1 toàn mẫu 1.
    """
    settings = _base_settings(layoutType="sequential",
                              targetQuantitiesByPage={"0": 8, "1": 8})
    precalc = _run_capture(monkeypatch, 2, settings)

    assert precalc is not None and 0 in precalc and 1 in precalc
    sheet0 = [p["src_page_idx"] for p in precalc[0]]
    sheet1 = [p["src_page_idx"] for p in precalc[1]]
    assert sheet0 == [0] * 8, f"tờ 0 phải toàn mẫu 0, được {sheet0}"
    assert sheet1 == [1] * 8, f"tờ 1 phải toàn mẫu 1, được {sheet1}"


def test_sequential_trong_lap_day_1_to(monkeypatch):
    """SL trống → lấp ĐẦY 1 tờ (capacity ô), GOM THEO LOẠI A-A-A-A B-B-B-B (không
    xen kẽ 0,1,0,1). capacity=8, 2 loại → chia đều 4/4 khối liền."""
    settings = _base_settings(layoutType="sequential", targetQuantitiesByPage={})
    precalc = _run_capture(monkeypatch, 2, settings)
    assert precalc is not None and list(precalc.keys()) == [0], "đúng 1 tờ"
    pages = [p["src_page_idx"] for p in precalc[0]]
    assert len(pages) == 8, f"phải lấp đủ capacity 8, được {len(pages)}"
    assert pages == [0, 0, 0, 0, 1, 1, 1, 1], f"gom theo loại, được {pages}"


def test_duplex_trang_le_bi_chan(monkeypatch):
    """2 mặt + số trang lẻ → engine raise (không xếp lén)."""
    settings = _base_settings(
        layoutType="sequential",
        duplexFlow="double",
        targetQuantitiesByPage={},
    )
    with pytest.raises(ValueError, match="CHẴN"):
        _run_capture(monkeypatch, 5, settings)


def test_duplex_cut_stacks_bi_chan(monkeypatch):
    """cut_stacks + 2 mặt → chặn (mirror tờ lẻ phá collate)."""
    settings = _base_settings(
        layoutType="cut_stacks",
        duplexFlow="double",
        targetQuantitiesByPage={},
    )
    with pytest.raises(ValueError, match="2 mặt"):
        _run_capture(monkeypatch, 4, settings)


def test_duplex_ratio_stack_bi_chan(monkeypatch):
    """ratio_stack + 2 mặt → chặn."""
    settings = _base_settings(
        layoutType="ratio_stack",
        duplexFlow="double",
        targetQuantitiesByPage={"0": 10, "1": 10},
    )
    with pytest.raises(ValueError, match="2 mặt"):
        _run_capture(monkeypatch, 4, settings)


def test_sequential_duplex_cap_truoc_sau(monkeypatch):
    """2 mặt: cùng ô trên tờ chẵn = trang trước (2k), tờ lẻ = trang sau (2k+1).

    4 trang → 2 SP. capacity=8, SL trống lấp 1 mặt trước, GOM THEO LOẠI → 8 SP
    [0,0,0,0,1,1,1,1].
    Tờ 0 (trước): 0,0,0,0,2,2,2,2
    Tờ 1 (sau):   1,1,1,1,3,3,3,3
    """
    settings = _base_settings(
        layoutType="sequential",
        duplexFlow="double",
        targetQuantitiesByPage={},
    )
    precalc = _run_capture(monkeypatch, 4, settings)
    assert precalc is not None
    assert sorted(precalc.keys()) == [0, 1], f"cần đúng 2 tờ F/B, keys={list(precalc.keys())}"
    front = [p["src_page_idx"] for p in precalc[0]]
    back = [p["src_page_idx"] for p in precalc[1]]
    assert front == [0, 0, 0, 0, 2, 2, 2, 2], f"mặt trước sai: {front}"
    assert back == [1, 1, 1, 1, 3, 3, 3, 3], f"mặt sau sai: {back}"
    # Cùng hình học ô (abs) giữa F/B — mirror do process_chunk, precalc giữ toạ độ giống.
    for a, b in zip(precalc[0], precalc[1]):
        assert abs(a["abs_x"] - b["abs_x"]) < 1e-6
        assert abs(a["abs_y"] - b["abs_y"]) < 1e-6


def test_sequential_duplex_theo_sl_sp(monkeypatch):
    """2 mặt + SL theo SP (key trang chẵn): SP0×8, SP1×8 → tờ F0 toàn P0, B0 toàn P1, F1 toàn P2, B1 toàn P3."""
    settings = _base_settings(
        layoutType="sequential",
        duplexFlow="double",
        targetQuantitiesByPage={"0": 8, "2": 8},
    )
    precalc = _run_capture(monkeypatch, 4, settings)
    assert sorted(precalc.keys()) == [0, 1, 2, 3]
    assert [p["src_page_idx"] for p in precalc[0]] == [0] * 8
    assert [p["src_page_idx"] for p in precalc[1]] == [1] * 8
    assert [p["src_page_idx"] for p in precalc[2]] == [2] * 8
    assert [p["src_page_idx"] for p in precalc[3]] == [3] * 8


def test_cut_stacks_collation(monkeypatch):
    """Xếp chồng: sheet s, cell j → page = j * n_sheets + s.

    capacity=8, 16 trang → n_sheets=2.
    Tờ 0: pages 0,2,4,6,8,10,12,14
    Tờ 1: pages 1,3,5,7,9,11,13,15
    """
    settings = _base_settings(layoutType="cut_stacks", targetQuantitiesByPage={})
    precalc = _run_capture(monkeypatch, 16, settings)
    assert precalc is not None and 0 in precalc and 1 in precalc
    p0 = [p["src_page_idx"] for p in precalc[0]]
    p1 = [p["src_page_idx"] for p in precalc[1]]
    assert p0 == [0, 2, 4, 6, 8, 10, 12, 14], f"tờ 0 cut_stacks sai: {p0}"
    assert p1 == [1, 3, 5, 7, 9, 11, 13, 15], f"tờ 1 cut_stacks sai: {p1}"
