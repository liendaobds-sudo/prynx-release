import asyncio
import os
import threading

from app.api.routes.imposition import (
    _PLAN_CANCEL_EVENTS,
    _PLAN_CANCEL_LOCK,
    cancel_plan_json,
    execute_plan_json,
)
from app.core.plan_executor import PlanExecutor


def test_execute_plan_json_can_return_native_output_path(monkeypatch, tmp_path):
    source = tmp_path / "source.pdf"
    source.write_bytes(b"%PDF-1.4\n%%EOF\n")
    output = tmp_path / "results" / "imposed.pdf"
    output.parent.mkdir()
    output.write_bytes(b"%PDF-1.4\n%%EOF\n")

    async def fake_execute(plan, source_override, cancel_event=None):
        assert source_override == os.path.abspath(source)
        assert cancel_event is not None
        return str(output)

    monkeypatch.setattr(PlanExecutor, "execute", fake_execute)
    result = asyncio.run(execute_plan_json({
        "plan": {"source_pdf_path": str(source)},
        "source_pdf_path": str(source),
        "return_output_path": True,
    }, license_info={}))

    assert result == {
        "success": True,
        "output_path": os.path.abspath(output),
        "output_filename": "imposed.pdf",
    }


def test_cancel_plan_json_sets_only_the_requested_job_event():
    first = threading.Event()
    second = threading.Event()
    with _PLAN_CANCEL_LOCK:
        _PLAN_CANCEL_EVENTS['job-a'] = first
        _PLAN_CANCEL_EVENTS['job-b'] = second
    try:
        result = asyncio.run(cancel_plan_json('job-b', license_info={}))
        assert result == {"success": True, "job_id": "job-b", "status": "cancel_requested"}
        assert second.is_set()
        assert not first.is_set()
    finally:
        with _PLAN_CANCEL_LOCK:
            _PLAN_CANCEL_EVENTS.pop('job-a', None)
            _PLAN_CANCEL_EVENTS.pop('job-b', None)
