"""Fault injection cho hợp đồng direct-path §REV.13."""

from __future__ import annotations

import asyncio
import multiprocessing
from pathlib import Path

import pytest
from fastapi import HTTPException

from app.api.routes import imposition, pdf_tools
from app.core.source_revision import (
    SOURCE_REVISION_CHANGED_MESSAGE,
    SourceRevisionChangedError,
    assert_source_fingerprint,
    capture_source_fingerprint,
)


class _TrackingSlot:
    def __init__(self) -> None:
        self.releases = 0

    def release(self) -> None:
        self.releases += 1


def _mutate(path: Path) -> None:
    """Đổi cả size lẫn mtime để fault injection không phụ thuộc độ phân giải FS."""
    with path.open("ab") as stream:
        stream.write(b"-revision-moi")


def _queued_nup_job(output_path: Path, fingerprint) -> dict:
    return {
        "status": "queued",
        "progress": "0/1",
        "report": "",
        "error": None,
        "output_path": str(output_path),
        "artifact_lease": None,
        "created_at": 1.0,
        "completed_at": None,
        "cancel_requested": False,
        "process": None,
        "pid": None,
        "source_fingerprint": fingerprint,
    }


def test_source_fingerprint_normalizes_path_and_detects_mutation(tmp_path):
    source = tmp_path / "source.pdf"
    source.write_bytes(b"%PDF-1.7\n")

    expected = capture_source_fingerprint(source.parent / "." / source.name)
    assert Path(expected.normalized_path) == source.resolve()
    assert expected.size == source.stat().st_size
    assert expected.mtime_ns == source.stat().st_mtime_ns
    assert_source_fingerprint(expected)

    _mutate(source)
    with pytest.raises(SourceRevisionChangedError, match="đã thay đổi"):
        assert_source_fingerprint(expected)


def test_nup_mutated_while_queued_fails_before_process_and_removes_output(
    monkeypatch,
    tmp_path,
):
    source = tmp_path / "queued-source.pdf"
    source.write_bytes(b"%PDF-1.7\n")
    expected = capture_source_fingerprint(source)
    _mutate(source)

    output = tmp_path / "nup_11111111.pdf"
    output.write_bytes(b"unpublished")
    job_id = "queued-stale"
    slot = _TrackingSlot()

    class ProcessMustNotStart:
        def __init__(self, **_kwargs):
            raise AssertionError("Nguồn stale không được spawn process")

    monkeypatch.setattr(multiprocessing, "Process", ProcessMustNotStart)
    monkeypatch.setattr(imposition, "_NUP_SUBMISSION_SLOTS", slot)
    monkeypatch.setattr(imposition.settings, "RESULTS_DIR", str(tmp_path))
    monkeypatch.setattr(imposition, "_cleanup_nup_chunk_files", lambda _job_id: None)
    imposition.nup_jobs[job_id] = _queued_nup_job(output, expected)
    try:
        imposition._spawn_nup_process(
            str(source), str(output), {}, job_id, expected
        )
        job = imposition.nup_jobs[job_id]
        assert job["status"] == "failed"
        assert job["artifact_lease"] is None
        assert job["error"] == SOURCE_REVISION_CHANGED_MESSAGE
        assert not output.exists()
        assert slot.releases == 1
    finally:
        imposition.nup_jobs.pop(job_id, None)


@pytest.mark.parametrize("mutate_during_run", [False, True])
def test_nup_rechecks_source_before_publish(
    monkeypatch,
    tmp_path,
    mutate_during_run,
):
    source = tmp_path / "running-source.pdf"
    source.write_bytes(b"%PDF-1.7\n")
    expected = capture_source_fingerprint(source)
    output = tmp_path / "nup_22222222.pdf"
    job_id = f"run-{int(mutate_during_run)}"
    state_path = tmp_path / f"nup_state_{job_id}.txt"
    slot = _TrackingSlot()

    class FakeProcess:
        pid = 4321
        exitcode = 0

        def __init__(self, *, target, args, daemon):
            assert target is imposition._nup_process_worker
            assert args[-1] == expected
            assert daemon is False

        def start(self):
            return None

        def join(self):
            output.write_bytes(b"%PDF-output")
            if mutate_during_run:
                _mutate(source)
            state_path.write_text("completed|||ok", encoding="utf-8")

    monkeypatch.setattr(multiprocessing, "Process", FakeProcess)
    monkeypatch.setattr(imposition, "_NUP_SUBMISSION_SLOTS", slot)
    monkeypatch.setattr(imposition.tempfile, "gettempdir", lambda: str(tmp_path))
    monkeypatch.setattr(imposition.settings, "RESULTS_DIR", str(tmp_path))
    monkeypatch.setattr(imposition, "_cleanup_nup_chunk_files", lambda _job_id: None)
    monkeypatch.setattr(imposition, "create_artifact_lease", lambda *_args: "a" * 64)
    imposition.nup_jobs[job_id] = _queued_nup_job(output, expected)
    try:
        imposition._spawn_nup_process(
            str(source), str(output), {}, job_id, expected
        )
        job = imposition.nup_jobs[job_id]
        if mutate_during_run:
            assert job["status"] == "failed"
            assert job["artifact_lease"] is None
            assert not output.exists()
        else:
            assert job["status"] == "completed"
            assert job["artifact_lease"] == "a" * 64
            assert output.exists()
        assert slot.releases == 1
    finally:
        output.unlink(missing_ok=True)
        state_path.unlink(missing_ok=True)
        imposition.nup_jobs.pop(job_id, None)


class _StickerRequest:
    def __init__(self, source: Path):
        self.source = source

    async def form(self):
        return {
            "file_path": str(self.source),
            "rectangle_mode": "true",
            "cut_mode": "original",
            "bleed_mm": "1",
        }


def _install_fake_sticker_runtime(monkeypatch, tmp_path, source, *, mutate_in_engine):
    from app.workers import page_space_canonicalization, sticker_engine

    calls = {"engine": 0}

    class FakeEngine:
        def __init__(self, dpi=300):
            self.dpi = dpi

        def process_pdf(self, input_path, output_path, **_kwargs):
            calls["engine"] += 1
            Path(output_path).write_bytes(b"%PDF-sticker")
            if mutate_in_engine:
                _mutate(source)
            return True, {"pages": [{"page": 1}]}

    monkeypatch.setattr(sticker_engine, "StickerEngine", FakeEngine)
    monkeypatch.setattr(
        page_space_canonicalization,
        "canonicalize_page_space_file",
        lambda path, _job_id: (path, False),
    )
    monkeypatch.setattr(pdf_tools, "RESULTS_DIR", str(tmp_path))
    monkeypatch.setattr(pdf_tools, "_safe_watermark", lambda *_args: None)
    return calls


def test_sticker_direct_path_mutated_while_waiting_returns_409(
    monkeypatch,
    tmp_path,
):
    source = tmp_path / "sticker-wait.pdf"
    source.write_bytes(b"%PDF-1.7\n")
    calls = _install_fake_sticker_runtime(
        monkeypatch, tmp_path, source, mutate_in_engine=False
    )

    async def mutate_after_admission(_kind, function, *args, **kwargs):
        _mutate(source)
        return function(*args, **kwargs)

    monkeypatch.setattr(
        pdf_tools, "run_scheduled_in_threadpool", mutate_after_admission
    )
    with pytest.raises(HTTPException) as caught:
        asyncio.run(pdf_tools.sticker_dieline_endpoint(_StickerRequest(source), {}))

    assert caught.value.status_code == 409
    assert caught.value.detail == SOURCE_REVISION_CHANGED_MESSAGE
    assert calls["engine"] == 0
    assert not list(tmp_path.glob("sticker_*.pdf"))


@pytest.mark.parametrize("mutate_in_engine", [False, True])
def test_sticker_direct_path_rechecks_before_response(
    monkeypatch,
    tmp_path,
    mutate_in_engine,
):
    source = tmp_path / f"sticker-run-{int(mutate_in_engine)}.pdf"
    source.write_bytes(b"%PDF-1.7\n")
    calls = _install_fake_sticker_runtime(
        monkeypatch, tmp_path, source, mutate_in_engine=mutate_in_engine
    )

    async def run_now(_kind, function, *args, **kwargs):
        return function(*args, **kwargs)

    monkeypatch.setattr(pdf_tools, "run_scheduled_in_threadpool", run_now)

    if mutate_in_engine:
        with pytest.raises(HTTPException) as caught:
            asyncio.run(
                pdf_tools.sticker_dieline_endpoint(_StickerRequest(source), {})
            )
        assert caught.value.status_code == 409
        assert caught.value.detail == SOURCE_REVISION_CHANGED_MESSAGE
        assert not list(tmp_path.glob("sticker_*.pdf"))
    else:
        response = asyncio.run(
            pdf_tools.sticker_dieline_endpoint(_StickerRequest(source), {})
        )
        assert Path(response.path).exists()
        assert response.headers["x-sticker-output-path"] == str(
            Path(response.path).resolve()
        )
        Path(response.path).unlink(missing_ok=True)
    assert calls["engine"] == 1
