"""Tests cho song song sticker: detect pool crash, cap worker, fallback tuần tự."""
import os
import sys
from concurrent.futures.process import BrokenProcessPool
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.workers import sticker_engine as se


def test_is_process_pool_crash_broken_process_pool():
    assert se._is_process_pool_crash(BrokenProcessPool("boom")) is True


def test_is_process_pool_crash_message():
    err = RuntimeError(
        "A process in the process pool was terminated abruptly "
        "while the future was running or pending."
    )
    assert se._is_process_pool_crash(err) is True
    assert se._is_process_pool_crash(ValueError("bad input")) is False


def _reset_hw_profile(monkeypatch=None):
    se._hw_profile_cache = None
    se._hw_profile_logged = False
    se._sticky_sequential_until = 0.0


def test_n_pages_should_parallelize_threshold(monkeypatch):
    monkeypatch.delenv("STICKER_FORCE_SEQUENTIAL", raising=False)
    _reset_hw_profile()
    assert se._n_pages_should_parallelize(5) is False
    assert se._n_pages_should_parallelize(6) is True


def test_n_pages_should_parallelize_force_sequential(monkeypatch):
    monkeypatch.setenv("STICKER_FORCE_SEQUENTIAL", "1")
    _reset_hw_profile()
    assert se._n_pages_should_parallelize(20) is False


def test_n_pages_should_parallelize_sticky_after_crash(monkeypatch):
    monkeypatch.delenv("STICKER_FORCE_SEQUENTIAL", raising=False)
    monkeypatch.setenv("STICKER_STICKY_SEQ_SEC", "600")
    _reset_hw_profile()
    se.get_sticker_hw_profile(refresh=True)
    se._mark_pool_crash_sticky()
    assert se._sticky_sequential_active() is True
    assert se._n_pages_should_parallelize(20) is False
    se._sticky_sequential_until = 0.0
    assert se._n_pages_should_parallelize(20) is True


@pytest.mark.parametrize(
    "ram_gb,cpu,want_workers,want_sticky_max",
    [
        (4, 4, 1, 900),
        (12, 8, 2, 600),
        (24, 8, 3, 300),
        (24, 4, 2, 300),
        (48, 16, 4, 60),
        (128, 24, 6, 0),
    ],
)
def test_auto_hw_profile_tiers(ram_gb, cpu, want_workers, want_sticky_max):
    """Auto-tune workers/sticky theo RAM+CPU (không cần env)."""
    p = se._auto_sticker_hw_profile(
        total_ram_mb=ram_gb * 1024.0,
        cpu_count=cpu,
    )
    # Xóa env override nếu process test có sẵn
    assert p["workers_src"] == "auto" or "STICKER_MAX_WORKERS" in os.environ
    if p["workers_src"] == "auto":
        assert p["max_workers"] == want_workers
    if p["sticky_src"] == "auto":
        assert p["sticky_seq_sec"] == want_sticky_max


def test_auto_hw_profile_env_override(monkeypatch):
    monkeypatch.setenv("STICKER_MAX_WORKERS", "5")
    monkeypatch.setenv("STICKER_STICKY_SEQ_SEC", "0")
    p = se._auto_sticker_hw_profile(total_ram_mb=4 * 1024, cpu_count=2)
    assert p["max_workers"] == 5
    assert p["sticky_seq_sec"] == 0.0
    assert p["workers_src"] == "env"
    assert p["sticky_src"] == "env"


def test_cap_sticker_workers_by_file_size(tmp_path, monkeypatch):
    p = tmp_path / "f.pdf"
    p.write_bytes(b"%PDF-1.4\n")

    def _size(path):
        # 1KB / 45MB / 90MB tùy path tag
        if path.endswith("large"):
            return 45 * 1024 * 1024
        if path.endswith("huge"):
            return 90 * 1024 * 1024
        return 1024

    monkeypatch.setattr(se.os.path, "getsize", _size)
    # RAM giả cao để không bị nhánh RAM override.
    monkeypatch.setattr(se, "_available_ram_mb", lambda: 16000.0)
    assert se._cap_sticker_workers(8, n_pages=10, input_path=str(p)) == 8
    assert se._cap_sticker_workers(8, n_pages=10, input_path="x/large") == 2
    assert se._cap_sticker_workers(8, n_pages=10, input_path="x/huge") == 1


def test_cap_sticker_workers_many_pages(tmp_path, monkeypatch):
    p = tmp_path / "many.pdf"
    p.write_bytes(b"%PDF-1.4\n")
    monkeypatch.setattr(se.os.path, "getsize", lambda path: 2048)
    monkeypatch.setattr(se, "_available_ram_mb", lambda: 16000.0)
    assert se._cap_sticker_workers(8, n_pages=50, input_path=str(p)) == 2


def test_cap_sticker_workers_by_ram(tmp_path, monkeypatch):
    p = tmp_path / "f.pdf"
    p.write_bytes(b"%PDF-1.4\n")
    monkeypatch.setattr(se.os.path, "getsize", lambda path: 1024)
    # Trang SRA3 ~320×450mm ≈ 907×1276 pt; 300 DPI ~ nặng.
    monkeypatch.setattr(se, "_available_ram_mb", lambda: 1200.0)
    capped = se._cap_sticker_workers(
        8, n_pages=12, input_path=str(p),
        page_w_pt=907.0, page_h_pt=1276.0, dpi=300, light_path=False,
    )
    assert capped <= 2
    # RAM rất thấp → 1
    monkeypatch.setattr(se, "_available_ram_mb", lambda: 500.0)
    assert se._cap_sticker_workers(8, n_pages=12, input_path=str(p)) == 1


def test_estimate_worker_ram_light_path_lighter():
    heavy = se._estimate_worker_ram_mb(900, 1200, 300, light_path=False)
    light = se._estimate_worker_ram_mb(900, 1200, 300, light_path=True)
    assert light < heavy


def test_process_parallel_falls_back_on_pool_crash(tmp_path, monkeypatch):
    """Pool chết → orchestrator chạy lại chunk in-process, không ném ra ngoài."""
    pikepdf = pytest.importorskip("pikepdf")
    pytest.importorskip("pypdfium2")

    # PDF tối thiểu 2 trang blank (đủ cho 2 chunk giả lập).
    src = tmp_path / "multi.pdf"
    pdf = pikepdf.Pdf.new()
    for _ in range(2):
        page = pdf.add_blank_page(page_size=(200, 200))
        page.Contents = pdf.make_stream(b"0 0 0 rg 20 20 160 160 re f\n")
    pdf.save(str(src))
    out = str(tmp_path / "out.pdf")

    engine = se.StickerEngine(dpi=72)
    fake_chunk_result = (
        0,
        (b"%PDF-1.4 fake", [{"width_mm": 10.0, "height_mm": 10.0}], [], True),
    )

    call_modes = []

    def fake_run(args_list, n_workers, use_pool):
        call_modes.append(use_pool)
        if use_pool:
            raise BrokenProcessPool(
                "A process in the process pool was terminated abruptly "
                "while the future was running or pending."
            )
        # Sequential: trả 1 chunk giả đủ để merge path chạy — nhưng merge cần PDF thật.
        # Thay vì mock merge, mock toàn bộ _run để sequential trả bytes PDF 1 trang.
        real_pdf = pikepdf.Pdf.new()
        real_pdf.add_blank_page(page_size=(100, 100))
        buf = __import__("io").BytesIO()
        real_pdf.save(buf)
        return [
            (i, (buf.getvalue(), [{"width_mm": 10.0, "height_mm": 10.0}], [], True))
            for i, _ in enumerate(args_list)
        ]

    # Ép plan có >1 worker/chunk để đi vào nhánh pool.
    monkeypatch.setattr(se, "_cap_sticker_workers", lambda *a, **k: 2)
    monkeypatch.setattr(engine, "_run_sticker_chunks", fake_run)

    success, meta = engine._process_parallel(
        input_path=str(src),
        output_path=out,
        cut_mode="none",
        offset_mm=0.0,
        corner_style="miter",
        cut_color=(0, 1, 0, 0),
        bleed_mm=0.0,
        fill_holes=True,
        remove_white_bg=False,
        bleed_color_type="image",
        solid_bleed_color=(255, 255, 255),
        draw_cut_contour=False,
        rectangle_mode=True,
        edge_bite_mm=0.0,
        cut_first_page_only=False,
        shape_mode="contour",
    )

    assert success is True
    assert call_modes == [True, False], "phải thử pool rồi fallback sequential"
    assert os.path.exists(out) and os.path.getsize(out) > 0
    assert "pages" in meta


def test_process_parallel_raises_clear_error_if_fallback_also_fails(tmp_path, monkeypatch):
    pikepdf = pytest.importorskip("pikepdf")
    pytest.importorskip("pypdfium2")

    src = tmp_path / "multi.pdf"
    pdf = pikepdf.Pdf.new()
    for _ in range(2):
        pdf.add_blank_page(page_size=(200, 200))
    pdf.save(str(src))
    out = str(tmp_path / "out.pdf")

    engine = se.StickerEngine(dpi=72)

    def always_fail(args_list, n_workers, use_pool):
        if use_pool:
            raise BrokenProcessPool("terminated abruptly")
        raise RuntimeError("page rasterize boom")

    monkeypatch.setattr(se, "_cap_sticker_workers", lambda *a, **k: 2)
    monkeypatch.setattr(engine, "_run_sticker_chunks", always_fail)

    with pytest.raises(RuntimeError) as ei:
        engine._process_parallel(
            input_path=str(src),
            output_path=out,
            cut_mode="none",
            offset_mm=0.0,
            corner_style="miter",
            cut_color=(0, 1, 0, 0),
            bleed_mm=0.0,
            fill_holes=True,
            remove_white_bg=False,
            bleed_color_type="image",
            solid_bleed_color=(255, 255, 255),
            draw_cut_contour=False,
            rectangle_mode=True,
            edge_bite_mm=0.0,
            cut_first_page_only=False,
            shape_mode="contour",
        )
    msg = str(ei.value)
    assert "Process Parallel Workers" in msg
    assert "sequential retry also failed" in msg
