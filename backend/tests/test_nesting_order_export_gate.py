"""Chốt không xuất thiếu đơn hàng qua cả phiên mới và manifest đã lưu."""

from types import SimpleNamespace as NS

import pytest

from app.workers import nup_true_shape_nesting as entry
from app.core import nesting_debug_trace, nesting_preview_session, nesting_production_pipeline, nesting_rollout


def _manifest(count=72):
    return {
        "validation": {"valid": True},
        "placements": [{"instanceId": f"i-{i}", "partId": f"p-{i}"} for i in range(count)],
        "unplaced": [{"instanceId": f"i-{i}", "partId": f"p-{i}"} for i in range(count, 72)],
        "stats": {"placedCount": count, "sheetCount": 8, "unplacedCount": 72 - count},
    }


def _call(monkeypatch, tmp_path, manifest, stored, calls, tool="sticker_imposer", intent="quantity_fulfillment"):
    job = NS(
        tool=tool, layout_intent=intent, max_sheets=72,
        parts=tuple(NS(part_id=f"p-{i}", quantity=1, page_index=i) for i in range(72)),
    )
    saved = NS(manifest=manifest, manifest_id="saved", production_request=NS())
    session = NS(solved=NS(manifest=manifest, production_request=NS()))
    monkeypatch.setattr(entry, "_cluster_ts_dbg", lambda *a, **k: None)
    monkeypatch.setattr(entry, "build_true_shape_nesting_job", lambda *a, **k: job)
    monkeypatch.setattr(entry, "_report_hash_for_job", lambda *a: "report")
    monkeypatch.setattr(entry, "_verify_reference_report_hash", lambda *a, **k: "report")
    monkeypatch.setattr(entry, "_report_override_for_job", lambda *a: None)
    monkeypatch.setattr(nesting_rollout, "true_shape_nesting_enabled", lambda: True)
    monkeypatch.setattr(nesting_debug_trace, "nesting_trace_enabled", lambda: False)
    monkeypatch.setattr(nesting_preview_session, "load_referenced_manifest", lambda *a, **k: saved if stored else None)
    monkeypatch.setattr(nesting_preview_session, "get_preview_session_store", lambda: NS(
        get_or_solve=lambda *a, **k: NS(session=session, reused=False),
    ))
    monkeypatch.setattr(nesting_production_pipeline, "render_stored_production_nesting",
                        lambda *a, **k: calls.append("render_stored"))
    monkeypatch.setattr(nesting_production_pipeline, "render_production_nesting_session",
                        lambda *a, **k: calls.append("render_session"))
    monkeypatch.setattr(nesting_production_pipeline, "commit_production_nesting_session",
                        lambda *a, **k: calls.append("commit"))
    settings = {"taskMode": "nup", "gridStrategy": "true_shape_nesting"}
    if stored:
        settings[nesting_preview_session.SESSION_REFERENCE_SETTING] = {"manifestId": "saved"}
    return entry.run_true_shape_nesting(
        "fixture.pdf", str(tmp_path / "output.pdf"), settings, progress_callback=lambda *a: None,
    )


@pytest.mark.parametrize("stored", [False, True])
def test_six_of_72_cannot_render_or_commit(monkeypatch, tmp_path, stored):
    calls = []
    with pytest.raises(ValueError, match="6/72"):
        _call(monkeypatch, tmp_path, _manifest(6), stored, calls)
    assert calls == []
    assert not (tmp_path / "output.pdf").exists()


@pytest.mark.parametrize("stored", [False, True])
def test_complete_order_keeps_existing_export_path(monkeypatch, tmp_path, stored):
    calls = []
    report = _call(monkeypatch, tmp_path, _manifest(), stored, calls)
    assert "72" in report
    assert calls == (["render_stored"] if stored else ["render_session", "commit"])


@pytest.mark.parametrize("tool,intent", [
    ("cnc_imposer", "quantity_fulfillment"),
    ("sticker_imposer", "autofill_single_sheet"),
])
def test_gate_does_not_change_other_workflows(monkeypatch, tmp_path, tool, intent):
    calls = []
    _call(monkeypatch, tmp_path, _manifest(6), False, calls, tool=tool, intent=intent)
    assert calls == ["render_session", "commit"]
