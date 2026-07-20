"""Single-mold Step & Repeat: 1 trang có path bế + N trang artwork.

Khi nest từng trang, trang không bế rơi về MediaBox và mất cutline.
Engine phải nhận đúng 1 genuine master → kế thừa trim + nest master cho mọi loại.
"""
from __future__ import annotations

import os
import tempfile

import pytest

from app.workers import nup_engine
from app.workers import pdf_wrapper as pdf_lib
from app.workers import sticker_homogeneous as sh


def _resolve_single_mold_master(genuine_die_by_page: dict) -> int | None:
    """Mirror logic nup_engine Step1 — pure helper for unit test."""
    masters = [p for p, v in genuine_die_by_page.items() if v]
    if len(masters) != 1:
        return None
    return masters[0]


def _apply_master_trim(
    page_infos: list[tuple],
    genuine_die_by_page: dict,
    trim_by_page: dict,
    master_idx: int,
) -> list[tuple]:
    m_tw, m_th = trim_by_page[master_idx]
    out = []
    for p_idx, qty, tw, th in page_infos:
        if p_idx != master_idx and not genuine_die_by_page.get(p_idx, False):
            trim_by_page[p_idx] = (m_tw, m_th)
            out.append((p_idx, qty, m_tw, m_th))
        else:
            out.append((p_idx, qty, tw, th))
    return out


def test_single_genuine_master_detected():
    genuine = {0: True, 1: False, 2: False, 3: False}
    assert _resolve_single_mold_master(genuine) == 0


def test_zero_or_multi_master_no_inherit():
    assert _resolve_single_mold_master({0: False, 1: False}) is None
    assert _resolve_single_mold_master({0: True, 1: True, 2: False}) is None
    assert _resolve_single_mold_master({0: True}) == 0  # 1 master ok even if only 1 entry


def test_content_pages_get_master_trim_not_page_size():
    # Master die 50×50; content pages wrongly measured as full page 595×842
    page_infos = [
        (0, 100, 50.0, 50.0),
        (1, 100, 595.0, 842.0),
        (2, 100, 595.0, 842.0),
    ]
    genuine = {0: True, 1: False, 2: False}
    trim_by_page = {0: (50.0, 50.0), 1: (595.0, 842.0), 2: (595.0, 842.0)}
    master = _resolve_single_mold_master(genuine)
    assert master == 0
    patched = _apply_master_trim(page_infos, genuine, trim_by_page, master)
    assert patched[0] == (0, 100, 50.0, 50.0)
    assert patched[1] == (1, 100, 50.0, 50.0)
    assert patched[2] == (2, 100, 50.0, 50.0)
    assert trim_by_page[1] == (50.0, 50.0)
    assert trim_by_page[2] == (50.0, 50.0)


def test_two_genuine_dies_not_patched():
    # Multi-mold: mỗi trang giữ trim riêng
    genuine = {0: True, 1: True, 2: False}
    assert _resolve_single_mold_master(genuine) is None


def test_repeat_worker_skips_recompute_when_precalculated():
    from app.workers.nup_process_chunk import _should_recompute_repeat_layout

    assert _should_recompute_repeat_layout('repeat', None) is True
    assert _should_recompute_repeat_layout('repeat', {}) is False
    assert _should_recompute_repeat_layout('repeat', {0: []}) is False
    assert _should_recompute_repeat_layout('sequential', None) is False


def test_repeat_rejects_cluster_grouping_but_multi_nup_keeps_it():
    from app.workers.nup_engine import _effective_diecut_grouping

    assert _effective_diecut_grouping('repeat', True, 'cluster_tile') == 'none'
    assert (
        _effective_diecut_grouping('sequential', True, 'cluster_tile')
        == 'cluster_tile'
    )
    assert _effective_diecut_grouping('repeat', False, 'cluster_tile') == 'cluster_tile'


def test_repeat_master_in_middle_nests_once_and_reuses_cut_master(monkeypatch):
    class _Stop(RuntimeError):
        pass

    find_calls = {"n": 0}

    def _fake_find(_page):
        idx = find_calls["n"]
        find_calls["n"] += 1
        if idx == 1:
            return {
                "rect": pdf_lib.Rect(10, 10, 60, 60),
                "items": [],
                "color": (0, 1, 1, 0),
                "width": 0.5,
            }
        return None

    die_calls = {"n": 0}

    def _fake_has_die(_page):
        idx = die_calls["n"]
        die_calls["n"] += 1
        return idx == 1

    layout_calls = {"n": 0}

    def _layout(*args, **kwargs):
        layout_calls["n"] += 1
        items = [
            {"x": i * 50.0, "y": 0.0, "width": 50.0, "height": 50.0,
             "isRotated": False, "isRotated180": False}
            for i in range(4)
        ]
        return {
            "items": items, "totalItems": 4,
            "widthUsed": 200.0, "heightUsed": 50.0,
            "shapeType": "CIRCLE_ELLIPSE", "shapeProps": {},
            "trimW": 50.0, "trimH": 50.0,
        }

    captured = {}

    def _capture(args):
        captured["precalc"] = args[37]
        captured["homogeneous_mode"] = args[-2]
        captured["master_idx"] = args[-1]
        raise _Stop()

    monkeypatch.setattr(nup_engine, "_find_largest_die_path", _fake_find)
    monkeypatch.setattr(sh, "page_has_die", _fake_has_die)
    monkeypatch.setattr(nup_engine, "compute_sticker_layout_for_page", _layout)
    monkeypatch.setattr(nup_engine, "process_chunk", _capture)
    monkeypatch.setattr(os, "cpu_count", lambda: 2)

    with tempfile.TemporaryDirectory() as td:
        source = os.path.join(td, "master-middle.pdf")
        output = os.path.join(td, "out.pdf")
        doc = pdf_lib.open()
        for _ in range(3):
            doc.new_page(width=300, height=300)
        doc.save(source)
        doc.close()

        settings = {
            "isDieCutMode": True,
            "layoutType": "repeat",
            "groupingStrategy": "cluster_tile",
            "sheetWidth": 320, "sheetHeight": 450,
            "targetQuantitiesByPage": {"0": 4, "1": 4, "2": 4},
            "detectedShapesByPage": {
                "0": "CIRCLE_ELLIPSE", "1": "CIRCLE_ELLIPSE", "2": "CIRCLE_ELLIPSE",
            },
            "detectedShapeParamsByPage": {
                "0": {"inheritedFromPage": 1},
                "1": {"diameter": 50},
                "2": {"inheritedFromPage": 1},
            },
            "gridStrategy": "optimal_auto", "pontType": "none",
        }
        with pytest.raises(_Stop):
            nup_engine.run_nup_engine(source, output, settings, job_id="master-middle")

    assert layout_calls["n"] == 1
    assert captured["homogeneous_mode"] is False
    assert captured["master_idx"] == 1
    assert sorted(captured["precalc"]) == [0, 1, 2]
    assert all(len(captured["precalc"][sheet]) == 4 for sheet in range(3))
    assert [captured["precalc"][sheet][0]["src_page_idx"] for sheet in range(3)] == [0, 1, 2]
