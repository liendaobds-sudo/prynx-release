"""Hồi quy độ phản hồi của route tạo đường cắt Sticker Dieline."""

import asyncio
import shutil
import threading
import time

import pikepdf
import pytest
from fastapi import HTTPException

from app.api.routes import pdf_tools
from app.core import system_memory as sm
from app.workers import sticker_engine, sticker_page_canvas, vdp_engine


def _make_source_pdf(path) -> None:
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(100, 100))
    pdf.save(path)
    pdf.close()


class _FakeRequest:
    def __init__(self, source_path):
        self._source_path = source_path

    async def form(self):
        return {"file_path": str(self._source_path)}


def _prepare_route(monkeypatch, tmp_path, engine_class, restore_canvas) -> None:
    monkeypatch.setattr(sticker_engine, "StickerEngine", engine_class)
    monkeypatch.setattr(
        sticker_page_canvas,
        "restore_sticker_page_canvas",
        restore_canvas,
    )
    monkeypatch.setattr(pdf_tools, "RESULTS_DIR", str(tmp_path))
    monkeypatch.setattr(pdf_tools, "_safe_watermark", lambda *_args: None)
    monkeypatch.setattr(
        pdf_tools,
        "_STICKER_JOB_SEMAPHORE",
        threading.BoundedSemaphore(1),
    )


@pytest.mark.asyncio
async def test_sticker_engine_va_restore_khong_khoa_event_loop(monkeypatch, tmp_path):
    source = tmp_path / "source.pdf"
    _make_source_pdf(source)
    engine_started = threading.Event()
    release_engine = threading.Event()
    worker_threads: dict[str, int] = {}

    class SlowEngine:
        def __init__(self, dpi=300):
            self.dpi = dpi

        def process_pdf(self, input_path, output_path, **_kwargs):
            worker_threads["engine"] = threading.get_ident()
            engine_started.set()
            if not release_engine.wait(timeout=1.0):
                raise RuntimeError("Test không nhả được engine giả lập")
            shutil.copyfile(input_path, output_path)
            return True, {"pages": [{"page": 1}]}

    def fake_restore(*_args, **_kwargs):
        worker_threads["restore"] = threading.get_ident()

    _prepare_route(monkeypatch, tmp_path, SlowEngine, fake_restore)
    event_loop_thread = threading.get_ident()
    task = asyncio.create_task(
        pdf_tools.sticker_dieline_endpoint(_FakeRequest(source), license_info={})
    )

    try:
        assert await asyncio.wait_for(
            asyncio.to_thread(engine_started.wait, 0.8), timeout=0.9
        )
        heartbeat_started = time.perf_counter()
        await asyncio.wait_for(asyncio.sleep(0.01), timeout=0.20)
        assert time.perf_counter() - heartbeat_started < 0.15
    finally:
        release_engine.set()

    response = await asyncio.wait_for(task, timeout=2.0)
    assert worker_threads["engine"] != event_loop_thread
    assert worker_threads["restore"] == worker_threads["engine"]
    assert response.headers["X-Sticker-Output-Path"].lower().endswith(".pdf")


@pytest.mark.asyncio
async def test_sticker_exception_luon_nha_slot(monkeypatch, tmp_path):
    source = tmp_path / "source.pdf"
    _make_source_pdf(source)

    class FlakyEngine:
        calls = 0

        def __init__(self, dpi=300):
            self.dpi = dpi

        def process_pdf(self, input_path, output_path, **_kwargs):
            type(self).calls += 1
            if type(self).calls == 1:
                raise RuntimeError("Lỗi giả lập")
            shutil.copyfile(input_path, output_path)
            return True, {"pages": [{"page": 1}]}

    _prepare_route(monkeypatch, tmp_path, FlakyEngine, lambda *_args, **_kwargs: None)

    with pytest.raises(HTTPException) as exc_info:
        await pdf_tools.sticker_dieline_endpoint(_FakeRequest(source), license_info={})
    assert exc_info.value.status_code == 500

    response = await asyncio.wait_for(
        pdf_tools.sticker_dieline_endpoint(_FakeRequest(source), license_info={}),
        timeout=2.0,
    )
    assert FlakyEngine.calls == 2
    assert response.headers["X-Sticker-Output-Path"].lower().endswith(".pdf")


@pytest.fixture
def gia_lap_ram(monkeypatch):
    """Ép bộ đọc RAM trả (tổng, khả dụng) theo MiB."""

    def _set(total_mb, available_mb):
        monkeypatch.setattr(
            sm, "read_memory_status_mb", lambda: (total_mb, available_mb)
        )

    return _set


@pytest.mark.parametrize(
    ("total_mb", "available_mb", "expected_workers"),
    [
        (6 * 1024.0, 4 * 1024.0, 1),
        (12 * 1024.0, 6 * 1024.0, 2),
        (32 * 1024.0, 1024.0, 15),
    ],
)
def test_vdp_dung_policy_ram_tren_duong_engine(
    gia_lap_ram,
    monkeypatch,
    total_mb,
    available_mb,
    expected_workers,
):
    """Planner mà ``run_vdp_engine`` dùng phải giữ đúng ba tier phần cứng."""
    gia_lap_ram(total_mb, available_mb)
    monkeypatch.setattr(sm.os, "cpu_count", lambda: 16)
    monkeypatch.delenv("PRYNX_VDP_WORKERS", raising=False)

    workers, _chunk_size, _reason = vdp_engine._plan_vdp_parallelism(1500)

    assert workers == expected_workers


def test_vdp_env_override_thang_auto_detect(gia_lap_ram, monkeypatch):
    gia_lap_ram(6 * 1024.0, 4 * 1024.0)
    monkeypatch.setattr(sm.os, "cpu_count", lambda: 16)
    monkeypatch.setenv("PRYNX_VDP_WORKERS", "4")

    workers, _chunk_size, reason = vdp_engine._plan_vdp_parallelism(1500)

    assert workers == 4
    assert "PRYNX_VDP_WORKERS=4" in reason
