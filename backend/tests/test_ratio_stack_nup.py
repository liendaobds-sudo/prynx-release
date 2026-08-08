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


def _canned_layout_20(*_a, **_k):
    """Lưới 20 ô (5×4) để khóa ca thực tế 72 mẫu."""
    cells = []
    for i in range(20):
        r = i // 5
        c = i % 5
        cells.append({
            "c": c, "r": r,
            "x": float(c * 60), "y": float(r * 60),
            "width": 50.0, "height": 50.0, "isRotated": False,
        })
    return {
        "totalItems": 20, "cells": cells,
        "overallWidth": 290.0, "overallHeight": 230.0,
        "cols": 5, "rows": 4, "isRotated": False, "strategyUsed": "canned",
    }


def _run_capture(monkeypatch, n_pages, settings, layout_factory=_canned_layout_8, *, return_args=False):
    """Chạy engine (ép 1-chunk inline), chặn ở process_chunk, trả precalc (args[37])."""
    captured = {}

    def _capture_chunk(args):
        captured["args"] = args
        captured["precalc"] = args[37]
        raise _StopEngine()

    # Ép 1 chunk inline: cpu_count=2 → available_cores=1; layout tất định 8 ô.
    monkeypatch.setattr(os, "cpu_count", lambda: 2)
    monkeypatch.setattr(nup_engine, "solve_optimal_layout", layout_factory)
    monkeypatch.setattr(nup_engine, "process_chunk", _capture_chunk)

    with tempfile.TemporaryDirectory() as td:
        src = os.path.join(td, "src.pdf")
        out = os.path.join(td, "out.pdf")
        _make_blank_pdf(src, n_pages)
        with pytest.raises(_StopEngine):
            nup_engine.run_nup_engine(src, out, settings, job_id="t-ratio")
    return captured.get("args") if return_args else captured.get("precalc")


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


def test_no_cut_marks_preserve_explicit_zero_secondary_gap(monkeypatch):
    """Không dấu xén + hở tem 0 phải giữ khe L-shape = 0, không rơi về khe chia cọc."""
    settings = _base_settings(
        targetQuantity=1,
        markType="none",
        gapX=0,
        gapY=0,
        splitGap=0,
        clusterGap=12,
    )
    args = _run_capture(monkeypatch, 1, settings, return_args=True)

    assert args[45] == pytest.approx(0)


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


def test_ratio_stack_72_mau_tu_dong_sang_4_to_mau(monkeypatch):
    """72 loại × 110, sức chứa 20 → 20+20+20+12; không mất loại nào."""
    settings = _base_settings(
        targetQuantity=110,
        exportUniqueSheets=True,
    )
    precalc = _run_capture(
        monkeypatch, 72, settings, layout_factory=_canned_layout_20
    )

    assert sorted(precalc) == [0, 1, 2, 3]
    assert [len(precalc[i]) for i in range(4)] == [20, 20, 20, 12]
    pages_by_sheet = [
        [placement["src_page_idx"] for placement in precalc[i]]
        for i in range(4)
    ]
    assert pages_by_sheet == [
        list(range(0, 20)),
        list(range(20, 40)),
        list(range(40, 60)),
        list(range(60, 72)),
    ]


def test_ratio_stack_planner_giu_nguyen_ca_vua_mot_to():
    """Planner nhiều tờ không đổi phân bổ tỷ lệ cũ khi mọi loại đã vừa tờ."""
    from app.workers.nup_layout_solver import (
        compute_ratio_stack_alloc,
        compute_ratio_stack_templates,
    )

    legacy = compute_ratio_stack_alloc(8, [10, 2, 4])
    templates = compute_ratio_stack_templates(8, [10, 2, 4])

    assert len(templates) == 1
    assert templates[0]["cellsPerPage"] == legacy["cellsPerPage"]
    assert templates[0]["nSheets"] == legacy["nSheets"]
    assert templates[0]["unplaced"] == legacy["unplaced"]


def test_preview_sheet_builder_giu_toa_do_va_contract():
    """Helper tách khỏi route phải giữ canh phải/trên và contract nhiều tờ."""
    from app.workers.nup_layout_solver import (
        build_guillotine_preview_sheet,
        build_mixed_preview_response,
    )

    cells = [
        {"x": 0.0, "y": 0.0, "width": 10.0, "height": 20.0},
        {"x": 15.0, "y": 5.0, "width": 5.0, "height": 10.0,
         "isRotated": True},
    ]
    sheet = build_guillotine_preview_sheet(
        cells, [2, 2], usable_w=80.0, usable_h=60.0,
        margin_right=7.0, margin_top=11.0,
        sheet_w=100.0, sheet_h=90.0, align="right_top",
        run_count=3, physical_sheet_index=1,
    )

    assert [(c["absX"], c["absY"]) for c in sheet["cells"]] == [
        pytest.approx((73.0, 59.0)), pytest.approx((88.0, 64.0)),
    ]
    assert sheet["placedByPage"] == {"2": 2}
    assert sheet["runCount"] == 3
    assert sheet["physicalSheetIndex"] == 1

    result = build_mixed_preview_response(
        sheet, "ratio_stack", 3,
        output_pages_needed=6, template_sheets=[sheet],
    )
    assert result["templateCount"] == 1
    assert result["outputPagesNeeded"] == 6
    assert "sheets" not in result


def test_ratio_stack_preview_72_mau_co_du_4_to(tmp_path):
    """Preview phải cho lật đủ bốn tờ và báo tổng 440 lượt in."""
    from app.api.routes.imposition import PreviewLayoutRequest, preview_layout
    from tests.license_helpers import PRO_LICENSE

    source = str(tmp_path / "ratio-stack-72.pdf")
    _make_blank_pdf(source, 72)
    req = PreviewLayoutRequest(
        usable_w=1000.0,
        usable_h=800.0,
        item_w=200.0,
        item_h=200.0,
        gap_x=0.0,
        gap_y=0.0,
        strategy="optimal_auto",
        shape_type="RECTANGLE",
        sheet_w=1000.0,
        sheet_h=800.0,
        path=source,
        task_mode="nup",
        layout_type="ratio_stack",
        is_die_cut=False,
        page_sheet_mode=True,
        total_pages=72,
        target_quantity=110,
    )

    result = preview_layout(req, PRO_LICENSE)
    sheets = result["sheets"]

    assert result["templateCount"] == len(sheets) == 4
    assert result["sheetsNeeded"] == 440
    assert result["ratioUnplaced"] == []
    assert [sheet["totalItems"] for sheet in sheets] == [20, 20, 20, 12]
    assert [sheet["runCount"] for sheet in sheets] == [110, 110, 110, 110]
    assert {
        cell["pageIdx"]
        for sheet in sheets
        for cell in sheet["cells"]
    } == set(range(72))


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


def test_ratio_stack_duplex_cap_truoc_sau(monkeypatch):
    """ratio_stack 2 mặt: mỗi ĐƠN VỊ = cặp trang (2u trước | 2u+1 sau). Chia tỷ lệ
    theo đơn vị (SL trang chẵn), xuất 2 tờ CÙNG hình học ô: tờ 0 = mặt trước, tờ 1 = sau.

    4 trang → 2 đơn vị. SL: unit0(P0)=10, unit1(P2)=4 → capacity=8 chia 10:4 → cells=[6,2].
    Tờ 0 (trước): unit0×6 → P0, unit1×2 → P2  ⇒ [0,0,0,0,0,0,2,2]
    Tờ 1 (sau):   unit0×6 → P1, unit1×2 → P3  ⇒ [1,1,1,1,1,1,3,3]
    """
    settings = _base_settings(
        layoutType="ratio_stack",
        duplexFlow="double",
        targetQuantitiesByPage={"0": 10, "2": 4},
    )
    precalc = _run_capture(monkeypatch, 4, settings)
    assert precalc is not None
    assert sorted(precalc.keys()) == [0, 1], f"cần đúng 2 tờ F/B, keys={list(precalc.keys())}"
    front = [p["src_page_idx"] for p in precalc[0]]
    back = [p["src_page_idx"] for p in precalc[1]]
    assert front == [0, 0, 0, 0, 0, 0, 2, 2], f"mặt trước sai: {front}"
    assert back == [1, 1, 1, 1, 1, 1, 3, 3], f"mặt sau sai: {back}"
    # Cùng hình học ô (abs) giữa F/B — mirror do process_chunk, precalc giữ toạ độ giống.
    for a, b in zip(precalc[0], precalc[1]):
        assert abs(a["abs_x"] - b["abs_x"]) < 1e-6
        assert abs(a["abs_y"] - b["abs_y"]) < 1e-6


def test_ratio_stack_duplex_o_cung_don_vi_lien_nhau(monkeypatch):
    """ratio_stack 2 mặt: ô cùng đơn vị nằm LIỀN nhau (không round-robin) trên cả 2 mặt.

    6 trang → 3 đơn vị. SL trống → chia đều capacity 8 cho 3 đơn vị.
    """
    settings = _base_settings(
        layoutType="ratio_stack",
        duplexFlow="double",
        targetQuantitiesByPage={},
    )
    precalc = _run_capture(monkeypatch, 6, settings)
    assert sorted(precalc.keys()) == [0, 1]
    front = [p["src_page_idx"] for p in precalc[0]]
    back = [p["src_page_idx"] for p in precalc[1]]
    # Mặt trước chỉ chứa trang chẵn (0,2,4); mặt sau chỉ trang lẻ (1,3,5).
    assert set(front).issubset({0, 2, 4}), f"mặt trước phải toàn trang chẵn: {front}"
    assert set(back).issubset({1, 3, 5}), f"mặt sau phải toàn trang lẻ: {back}"
    # Ô cùng đơn vị liền nhau: đếm số lần đổi đơn vị ≤ số đơn vị - 1.
    front_units = [p // 2 for p in front]
    switches = sum(1 for a, b in zip(front_units, front_units[1:]) if a != b)
    assert switches <= 2, f"ô cùng đơn vị phải liền nhau (switches={switches}, {front_units})"
    # Mặt sau = mặt trước + 1 (cặp trang), cùng vị trí ô.
    for f, b in zip(front, back):
        assert b == f + 1, f"ô mặt sau phải là trang kế mặt trước: F={f} B={b}"


def test_ratio_stack_duplex_le_bi_chan(monkeypatch):
    """ratio_stack 2 mặt + số trang LẺ → vẫn chặn (cần cặp trang trước/sau)."""
    settings = _base_settings(
        layoutType="ratio_stack",
        duplexFlow="double",
        targetQuantitiesByPage={},
    )
    with pytest.raises(ValueError, match="CHẴN"):
        _run_capture(monkeypatch, 5, settings)


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


# ═══════════════ CHIA CỌC THEO LOẠI (cluster_type) ═══════════════
# Kích hoạt khi layoutType='ratio_stack' + clusterMode∈{row,column} (dàn nhiều loại +
# chia cọc → LUÔN mỗi cọc 1 loại; bỏ nút clusterDistribution thừa).
#
# MÔ HÌNH: giải lưới ĐẦY ĐỦ tờ (_canned_layout_8 = 4 cột × 2 hàng), rồi chia CỘT (mode
# 'column') / HÀNG (mode 'row') cho mỗi loại theo TỶ LỆ SL — bề rộng cọc ∝ SL. Mỗi dải =
# 1 band (cluster_idx). MỌI loại nằm CÙNG 1 tờ mẫu (không nhân bản kiểu tờ).

def _cluster_settings(**over):
    s = _base_settings(
        layoutType="ratio_stack",
        clusterMode="column",
        clusterGap=0,
    )
    s.update(over)
    return s


def test_cluster_type_moi_coc_1_loai(monkeypatch):
    """2 loại SL đều, mode column, lưới 4 cột → chia 2:2. Band 0 = loại 0, band 1 = loại 1.

    Lưới đầy đủ 8 ô (4 cột × 2 hàng). Mọi loại cùng 1 tờ → tổng vẫn 8 ô (KHÔNG nhân đôi).
    """
    settings = _cluster_settings(targetQuantitiesByPage={"0": 100, "1": 100})
    precalc = _run_capture(monkeypatch, 2, settings)

    assert precalc is not None and 0 in precalc, "cần tờ mẫu 0"
    sheet0 = precalc[0]
    assert len(sheet0) == 8, f"lưới đầy đủ 8 ô (mọi loại cùng 1 tờ), được {len(sheet0)}"

    # Mỗi band (cluster_idx) chỉ chứa 1 loại.
    by_cluster = {}
    for p in sheet0:
        by_cluster.setdefault(p["cluster_idx"], set()).add(p["src_page_idx"])
    assert by_cluster[0] == {0}, f"band 0 phải thuần loại 0, được {by_cluster.get(0)}"
    assert by_cluster[1] == {1}, f"band 1 phải thuần loại 1, được {by_cluster.get(1)}"
    # SL đều → mỗi loại 2 cột × 2 hàng = 4 ô.
    counts = {}
    for p in sheet0:
        counts[p["src_page_idx"]] = counts.get(p["src_page_idx"], 0) + 1
    assert counts == {0: 4, 1: 4}, f"SL đều → 4 ô/loại, được {counts}"


def test_cluster_type_be_rong_theo_ty_le(monkeypatch):
    """Bề rộng cọc (số cột) tỷ lệ SL. A(300)/B(100) tỷ lệ 3:1, 4 cột → A 3 cột, B 1 cột.

    A: 3 cột × 2 hàng = 6 ô; B: 1 cột × 2 hàng = 2 ô.
    """
    settings = _cluster_settings(targetQuantitiesByPage={"0": 300, "1": 100})
    precalc = _run_capture(monkeypatch, 2, settings)
    sheet0 = precalc[0]

    counts = {}
    for p in sheet0:
        counts[p["src_page_idx"]] = counts.get(p["src_page_idx"], 0) + 1
    assert counts.get(0) == 6, f"loại 0 (SL cao) phải 6 ô (3 cột), được {counts}"
    assert counts.get(1) == 2, f"loại 1 phải 2 ô (1 cột), được {counts}"


def test_cluster_type_moi_loai_1_band(monkeypatch):
    """Mỗi loại nằm gọn trong 1 band riêng (cluster_idx) — không xé lẻ qua ranh cọc."""
    settings = _cluster_settings(targetQuantitiesByPage={"0": 300, "1": 100})
    precalc = _run_capture(monkeypatch, 2, settings)
    sheet0 = precalc[0]

    # Mỗi band chỉ 1 loại; mỗi loại chỉ 1 band.
    band_of_type = {}
    type_of_band = {}
    for p in sheet0:
        t, b = p["src_page_idx"], p["cluster_idx"]
        band_of_type.setdefault(t, set()).add(b)
        type_of_band.setdefault(b, set()).add(t)
    for t, bands in band_of_type.items():
        assert len(bands) == 1, f"loại {t} bị xé qua nhiều band: {bands}"
    for b, types in type_of_band.items():
        assert len(types) == 1, f"band {b} chứa nhiều loại: {types}"


def test_cluster_type_gutter_offset(monkeypatch):
    """Rãnh dao (cluster_gap) → band phải tách nhau. Band phải nằm bên phải band trái + gap."""
    _gap_mm = 10.0
    settings = _cluster_settings(
        clusterGap=_gap_mm,
        targetQuantitiesByPage={"0": 100, "1": 100},
    )
    precalc = _run_capture(monkeypatch, 2, settings)
    sheet0 = precalc[0]

    # abs_x nhỏ nhất của mỗi band.
    minx = {}
    for p in sheet0:
        ci = p["cluster_idx"]
        minx[ci] = min(minx.get(ci, 1e9), p["abs_x"])
    assert minx[1] > minx[0], f"band 1 phải bên phải band 0: minx={minx}"


def test_cluster_type_row_mode(monkeypatch):
    """Mode 'row' chia HÀNG theo tỷ lệ. Lưới 2 hàng, 2 loại đều → mỗi loại 1 hàng (band)."""
    settings = _cluster_settings(
        clusterMode="row",
        targetQuantitiesByPage={"0": 100, "1": 100},
    )
    precalc = _run_capture(monkeypatch, 2, settings)
    sheet0 = precalc[0]

    by_cluster = {}
    for p in sheet0:
        by_cluster.setdefault(p["cluster_idx"], set()).add(p["src_page_idx"])
    # 2 hàng chia 2 loại → mỗi hàng 1 loại (band 0, band 1).
    assert by_cluster.get(0) == {0}, f"band 0 (hàng) phải loại 0, được {by_cluster.get(0)}"
    assert by_cluster.get(1) == {1}, f"band 1 (hàng) phải loại 1, được {by_cluster.get(1)}"


def test_cluster_type_duplex_2_to(monkeypatch):
    """2 mặt: 2 tờ front/back. Cọc giữ loại; mặt trước=2u, mặt sau=2u+1."""
    settings = _cluster_settings(
        duplexFlow="double",
        targetQuantitiesByPage={"0": 100, "2": 100},
    )
    # 4 trang → 2 đơn vị (cặp 0/1, 2/3). 2 loại → 2 band → 2 tờ F/B.
    precalc = _run_capture(monkeypatch, 4, settings)
    assert sorted(precalc.keys()) == [0, 1], f"2 mặt = 2 tờ, được {list(precalc.keys())}"

    front, back = precalc[0], precalc[1]
    fc = {}
    bc = {}
    for p in front:
        fc.setdefault(p["cluster_idx"], set()).add(p["src_page_idx"])
    for p in back:
        bc.setdefault(p["cluster_idx"], set()).add(p["src_page_idx"])
    # Mặt trước: band 0 = đơn vị 0 (trang 0), band 1 = đơn vị 1 (trang 2).
    assert fc[0] == {0} and fc[1] == {2}, f"mặt trước sai: {fc}"
    # Mặt sau: trang lẻ tương ứng (0→1, 2→3).
    assert bc[0] == {1} and bc[1] == {3}, f"mặt sau sai: {bc}"
    # Cùng hình học ô giữa F/B (mirror do process_chunk).
    for a, b in zip(front, back):
        assert abs(a["abs_x"] - b["abs_x"]) < 1e-6
        assert abs(a["abs_y"] - b["abs_y"]) < 1e-6


# ═══════════════ HELPER compute_cluster_type_alloc (parity preview≡output) ═══════════════
# Engine (nup_engine) VÀ preview (routes/imposition.py) đều gọi CÙNG helper này với cùng
# tham số → test helper tất định = chốt chặn parity logic (bài học "preview ≠ output").
# Chữ ký MỚI: compute_cluster_type_alloc(total_lines, lines_cross, qtys) → {linesPerType, nSheets, unplaced}.

def test_cluster_type_alloc_be_rong_theo_ty_le():
    """A(1000)/B(200) tỷ lệ 5:1, 6 dòng (cột) → A 5 dòng, B 1 dòng."""
    from app.workers.nup_layout_solver import compute_cluster_type_alloc
    r = compute_cluster_type_alloc(total_lines=6, lines_cross=2, qtys=[1000, 200])
    lpt = r['linesPerType']
    assert lpt[0] == 5, f"loại 0 phải 5 dòng: {lpt}"
    assert lpt[1] == 1, f"loại 1 phải 1 dòng: {lpt}"


def test_cluster_type_alloc_min_1_dong():
    """Loại SL rất thấp vẫn được ≥1 dòng (min 1 dòng/loại có SL>0)."""
    from app.workers.nup_layout_solver import compute_cluster_type_alloc
    r = compute_cluster_type_alloc(total_lines=4, lines_cross=2, qtys=[1000, 5])
    lpt = r['linesPerType']
    assert lpt[1] >= 1, f"loại SL thấp vẫn phải ≥1 dòng: {lpt}"


def test_cluster_type_alloc_so_to_theo_loai_thieu_nhat():
    """Số tờ = max theo loại. 2 dòng, cross=2, A(80)/B(40): A 1 dòng×2=2ô→40 tờ; B 1 dòng→20 tờ → 40."""
    from app.workers.nup_layout_solver import compute_cluster_type_alloc
    r = compute_cluster_type_alloc(total_lines=2, lines_cross=2, qtys=[80, 40])
    assert r['nSheets'] == 40, f"số tờ = max(40,20)=40: {r}"


def test_cluster_type_alloc_loai_sl_zero_khong_dong():
    """Loại SL=0 không được cấp dòng."""
    from app.workers.nup_layout_solver import compute_cluster_type_alloc
    r = compute_cluster_type_alloc(total_lines=4, lines_cross=2, qtys=[100, 0, 100])
    lpt = r['linesPerType']
    assert lpt[1] == 0, f"loại SL=0 không nhận dòng: {lpt}"


def test_cluster_type_alloc_sl_trong_chia_deu():
    """SL trống (mọi loại=0) → CHIA ĐỀU dòng, lấp đầy 1 tờ (KHÔNG trả rỗng → preview trắng).

    Bug thật: helper cũ lọc active=SL>0 → SL trống ra [0,0,0] → cells rỗng → 'Chưa có
    dữ liệu bố cục'. Khớp hành vi ratio_stack 'Trống = tự động lấp đầy 1 tờ'.
    """
    from app.workers.nup_layout_solver import compute_cluster_type_alloc
    # 3 loại, 3 dòng, SL trống → mỗi loại 1 dòng (chia đều), 1 tờ mẫu.
    r = compute_cluster_type_alloc(total_lines=3, lines_cross=2, qtys=[0, 0, 0])
    assert r['linesPerType'] == [1, 1, 1], f"SL trống phải chia đều: {r['linesPerType']}"
    assert r['nSheets'] == 1, f"SL trống → 1 tờ mẫu: {r['nSheets']}"
    assert sum(r['linesPerType']) > 0, "KHÔNG được trả toàn 0 (gây preview trắng)"
