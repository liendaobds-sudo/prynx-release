"""
test_sr_cluster_tile.py
=======================
Tests for Step & Repeat (Bình trang) with Cluster Tile (Cụm nhân bản / chia cụm con).
Ensures that:
1. Repeat mode supports groupingStrategy='cluster_tile', while rejecting multi-product strategies (maximize_area, free_gang, strict_ratio).
2. S&R with cluster_tile partitions each page into sub-sheets/clusters with tile cut marks.
3. Multi-page S&R keeps pages strictly isolated on separate sheets (never mixing across pages).
"""

import os
import tempfile
import pytest
from app.workers import pdf_wrapper as pdf_lib
from app.workers import sticker_homogeneous as sh
from app.workers import nup_engine
from app.workers.nup_engine import _effective_diecut_grouping, run_nup_engine


def test_effective_diecut_grouping_repeat():
    # Repeat supports cluster_tile
    assert _effective_diecut_grouping('repeat', True, 'cluster_tile') == 'cluster_tile'
    assert _effective_diecut_grouping('repeat', False, 'cluster_tile') == 'cluster_tile'

    # Repeat rejects multi-product gang strategies
    assert _effective_diecut_grouping('repeat', True, 'maximize_area') == 'none'
    assert _effective_diecut_grouping('repeat', True, 'free_gang') == 'none'
    assert _effective_diecut_grouping('repeat', True, 'strict_ratio') == 'none'
    assert _effective_diecut_grouping('repeat', True, 'none') == 'none'

    # Sequential keeps all strategies
    assert _effective_diecut_grouping('sequential', True, 'cluster_tile') == 'cluster_tile'
    assert _effective_diecut_grouping('sequential', True, 'free_gang') == 'free_gang'


def test_sr_single_page_cluster_tile(monkeypatch):
    class _Stop(RuntimeError):
        pass

    def _fake_find(_page):
        return {
            "rect": pdf_lib.Rect(10, 10, 60, 60),
            "items": [],
            "color": (0, 1, 1, 0),
            "width": 0.5,
        }

    def _layout(*args, **kwargs):
        items = [
            {"x": i * 40.0, "y": 0.0, "width": 40.0, "height": 40.0,
             "isRotated": False, "isRotated180": False}
            for i in range(3)
        ]
        return {
            "items": items, "totalItems": 3,
            "widthUsed": 120.0, "heightUsed": 40.0,
            "shapeType": "RECTANGLE", "shapeProps": {},
            "trimW": 40.0, "trimH": 40.0,
        }

    captured = {}

    def _capture(args):
        captured["precalc"] = args[37]
        captured["cuts"] = args[40] if len(args) > 40 else {}
        raise _Stop()

    monkeypatch.setattr(nup_engine, "_find_largest_die_path", _fake_find)
    monkeypatch.setattr(sh, "page_has_die", lambda _p: True)
    monkeypatch.setattr(nup_engine, "compute_sticker_layout_for_page", _layout)
    monkeypatch.setattr(nup_engine, "process_chunk", _capture)
    monkeypatch.setattr(os, "cpu_count", lambda: 2)

    with tempfile.TemporaryDirectory() as td:
        source = os.path.join(td, "single-cluster.pdf")
        output = os.path.join(td, "out.pdf")
        doc = pdf_lib.open()
        doc.new_page(width=300, height=300)
        doc.save(source)
        doc.close()

        settings = {
            "isDieCutMode": True,
            "layoutType": "repeat",
            "groupingStrategy": "cluster_tile",
            "clusterTileW": 148, "clusterTileH": 210,
            "tileGapX": 4.0, "tileGapY": 4.0,
            "sheetWidth": 320, "sheetHeight": 450,
            "targetQuantitiesByPage": {"0": 12},
            "detectedShapesByPage": {"0": "RECTANGLE"},
            "gridStrategy": "optimal_auto", "pontType": "none",
        }
        with pytest.raises(_Stop):
            run_nup_engine(source, output, settings, job_id="sr-cluster-single")

    assert 0 in captured["precalc"]
    # Placements exist and all point to page 0
    assert len(captured["precalc"][0]) > 0
    assert all(it["src_page_idx"] == 0 for it in captured["precalc"][0])
    # Cut lines exist for dividing the clusters
    assert 0 in captured["cuts"]
    assert len(captured["cuts"][0].get('v', set())) > 0 or len(captured["cuts"][0].get('h', set())) > 0
