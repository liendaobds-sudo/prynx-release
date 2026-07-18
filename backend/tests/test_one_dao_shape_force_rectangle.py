"""C2 — 1 Dao: resolve_one_dao_trim + force RECTANGLE policy in layout_compute."""
from __future__ import annotations

import inspect
from types import SimpleNamespace

from app.workers.nup_diecut import resolve_one_dao_trim
from app.workers.sticker_imposer_pkg import layout_compute as lc


def test_resolve_one_dao_trim_only_when_one_dao_page():
    page = SimpleNamespace(rect=SimpleNamespace(width=200.0, height=100.0))

    assert resolve_one_dao_trim(page, "multi", "page", 0) is None
    assert resolve_one_dao_trim(page, "one_dao", "die", 0) is None

    trim = resolve_one_dao_trim(page, "one_dao", "page", 0)
    assert trim is not None
    tw, th = trim
    assert abs(tw - 200.0) < 0.01
    assert abs(th - 100.0) < 0.01

    # offset +1mm expands both dimensions
    trim2 = resolve_one_dao_trim(page, "one_dao", "page", 1.0)
    assert trim2[0] > 200.0
    assert trim2[1] > 100.0


def test_layout_compute_source_forces_rectangle_for_one_dao():
    src = inspect.getsource(lc)
    assert "_is_one_dao" in src or "one_dao" in src
    assert "RECTANGLE" in src
