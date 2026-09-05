import os
import time

import pytest

from app.core import perf_sampler
from app.config import settings


@pytest.fixture(autouse=True)
def _runtime_dev(monkeypatch):
    monkeypatch.setattr(settings, "DEV_MODE", True)


def test_proc_rss_reads_positive_for_current_process():
    rss = perf_sampler._proc_rss_mb(os.getpid())
    assert rss is not None
    assert rss > 0


def test_proc_rss_returns_none_for_invalid_pid():
    assert perf_sampler._proc_rss_mb(0) is None
    assert perf_sampler._proc_rss_mb(-1) is None


def test_dir_size_sums_files(tmp_path):
    (tmp_path / "a.bin").write_bytes(b"x" * (1024 * 1024))
    (tmp_path / "b.bin").write_bytes(b"y" * (512 * 1024))

    size = perf_sampler._dir_size_mb(str(tmp_path))

    assert size is not None
    assert 1.4 < size < 1.6


def test_dir_size_none_for_missing_path():
    assert perf_sampler._dir_size_mb("") is None
    assert perf_sampler._dir_size_mb("/no/such/dir/prynx") is None


def test_sampler_noop_when_disabled(monkeypatch):
    monkeypatch.delenv("PRYNX_PERF", raising=False)
    sampler = perf_sampler.ProcessRssSampler(os.getpid(), interval_ms=50)
    sampler.start()
    sampler.stop()
    assert sampler.peak_mb is None


def test_sampler_records_peak_when_enabled(monkeypatch):
    monkeypatch.setenv("PRYNX_PERF", "1")
    sampler = perf_sampler.ProcessRssSampler(os.getpid(), interval_ms=50)
    sampler.start()
    time.sleep(0.2)
    sampler.stop()
    assert sampler.peak_mb is not None
    assert sampler.peak_mb > 0


def test_write_job_perf_noop_when_disabled(monkeypatch, tmp_path):
    monkeypatch.delenv("PRYNX_PERF", raising=False)
    monkeypatch.setenv("PRYNX_PERF_DIR", str(tmp_path))
    perf_sampler.write_job_perf({"job": "nup", "duration_s": 1.0})
    assert not (tmp_path / "job_perf.log").exists()


def test_write_job_perf_appends_when_enabled(monkeypatch, tmp_path):
    monkeypatch.setenv("PRYNX_PERF", "1")
    monkeypatch.setenv("PRYNX_PERF_DIR", str(tmp_path))
    perf_sampler.write_job_perf({"job": "nup", "job_id": "abc123", "duration_s": 1.5, "peak_rss_mb": 42.0})

    log = tmp_path / "job_perf.log"
    assert log.exists()
    content = log.read_text(encoding="utf-8")
    assert "[JOBPERF]" in content
    assert "job=nup" in content
    assert "job_id=abc123" in content
    assert "peak_rss_mb=42.0" in content


def test_write_job_perf_skips_none_fields(monkeypatch, tmp_path):
    monkeypatch.setenv("PRYNX_PERF", "1")
    monkeypatch.setenv("PRYNX_PERF_DIR", str(tmp_path))
    perf_sampler.write_job_perf({"job": "nup", "peak_rss_mb": None, "output_mb": 3.2})

    content = (tmp_path / "job_perf.log").read_text(encoding="utf-8")
    assert "peak_rss_mb" not in content
    assert "output_mb=3.2" in content


def test_process_tree_pids_includes_all_descendants(monkeypatch):
    monkeypatch.setattr(
        perf_sampler,
        "_process_parent_map",
        lambda: {10: [11, 12], 11: [13], 99: [100]},
    )

    assert perf_sampler._process_tree_pids(10) == {10, 11, 12, 13}


def test_process_tree_rss_sums_live_descendants(monkeypatch):
    monkeypatch.setattr(perf_sampler, "_process_tree_pids", lambda _pid: {10, 11, 12})
    readings = {10: 10.0, 11: 20.0, 12: None}
    monkeypatch.setattr(perf_sampler, "_proc_rss_mb", lambda pid: readings[pid])

    assert perf_sampler._process_tree_rss_mb(10) == 30.0


def test_sampler_tracks_peak_job_temp_usage(monkeypatch, tmp_path):
    monkeypatch.setattr(perf_sampler, "_process_tree_rss_mb", lambda _pid: 25.0)
    pattern = str(tmp_path / "chunk-*.pdf")
    sampler = perf_sampler.ProcessRssSampler(123, temp_patterns=(pattern,))

    (tmp_path / "chunk-1.pdf").write_bytes(b"x" * 1024 * 1024)
    sampler._sample()
    (tmp_path / "chunk-2.pdf").write_bytes(b"y" * 2 * 1024 * 1024)
    sampler._sample()

    assert sampler.peak_mb == 25.0
    assert sampler.peak_temp_mb == 3.0
    assert sampler.sample_count == 2


def test_perf_stages_records_deltas_and_total(monkeypatch):
    readings = iter((10.0, 10.25, 10.75))
    monkeypatch.setattr(perf_sampler.time, "monotonic", lambda: next(readings))

    stages = perf_sampler.PerfStages()
    assert stages.mark("render_s") == 0.25

    assert stages.finish() == {"render_s": 0.25, "engine_total_s": 0.75}


def test_perf_stages_gom_phase_lap_thanh_mot_ban_ghi(monkeypatch):
    """PERF-NEST-06: nhiều placement chỉ cộng số tổng, không sinh log từng lần."""

    monkeypatch.setenv("PRYNX_PERF", "1")
    readings = iter((10.0, 10.2, 10.5, 10.7, 11.1, 12.0))
    monkeypatch.setattr(perf_sampler.time, "monotonic", lambda: next(readings))

    stages = perf_sampler.PerfStages()
    first = perf_sampler.start_perf_stage()
    perf_sampler.finish_perf_stage(
        first,
        "writer_embed_s",
        count_name="writer_embed_calls",
    )
    second = perf_sampler.start_perf_stage()
    perf_sampler.finish_perf_stage(
        second,
        "writer_embed_s",
        count_name="writer_embed_calls",
    )
    perf_sampler.increment_perf_counter("writer_page_count", 3)

    result = stages.finish()
    assert result["writer_embed_s"] == pytest.approx(0.7)
    assert result["writer_embed_calls"] == 2
    assert result["writer_page_count"] == 3
    assert result["engine_total_s"] == 2.0


def test_perf_phase_tat_khong_doc_clock(monkeypatch):
    """PRYNX_PERF tắt phải dừng trước clock, kể cả counter aggregate."""

    monkeypatch.delenv("PRYNX_PERF", raising=False)

    def clock_khong_duoc_goi():
        raise AssertionError("không được đọc clock khi PRYNX_PERF tắt")

    monkeypatch.setattr(perf_sampler.time, "monotonic", clock_khong_duoc_goi)
    sample = perf_sampler.start_perf_stage()
    assert sample is None
    perf_sampler.finish_perf_stage(sample, "writer_embed_s")
    perf_sampler.increment_perf_counter("writer_page_count")


def test_perf_stages_dong_sai_thu_tu_khong_hoi_sinh_scope_cha(monkeypatch):
    """Scope con kết thúc sau không được phục hồi một scope cha đã đóng."""

    monkeypatch.setenv("PRYNX_PERF", "1")
    readings = iter(float(value) for value in range(20))
    monkeypatch.setattr(perf_sampler.time, "monotonic", lambda: next(readings))

    parent = perf_sampler.PerfStages()
    child = perf_sampler.PerfStages()
    parent.close()
    parent.close()  # idempotent
    child.close()

    assert perf_sampler.start_perf_stage() is None


def test_run_nup_engine_loi_canonicalize_van_dong_scope_perf(monkeypatch):
    """Lỗi trước try cũ là ca từng làm scope telemetry dính sang job sau."""

    from app.schemas import pont
    from app.workers import nup_engine

    monkeypatch.setenv("PRYNX_PERF", "1")
    monkeypatch.setattr(pont, "normalize_pont_settings", lambda value: value)
    monkeypatch.setattr(
        nup_engine,
        "_canonicalize_page_space",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("canonical lỗi")),
    )

    with pytest.raises(RuntimeError, match="canonical lỗi"):
        nup_engine.run_nup_engine("source.pdf", "output.pdf", {}, job_id="perf-fail")

    assert perf_sampler.start_perf_stage() is None


def test_run_nup_engine_khong_job_id_van_dong_scope_perf(monkeypatch):
    """Caller nội bộ không có job_id vẫn phải finish dù không ghi stage file."""

    from app.schemas import pont
    from app.workers import nup_engine

    monkeypatch.setenv("PRYNX_PERF", "1")
    monkeypatch.setattr(pont, "normalize_pont_settings", lambda value: value)
    monkeypatch.setattr(
        nup_engine,
        "_canonicalize_page_space",
        lambda source, _job_id: (source, False),
    )
    monkeypatch.setattr(nup_engine, "_run_nup_engine_impl", lambda *_args, **_kwargs: "ok")

    assert nup_engine.run_nup_engine("source.pdf", "output.pdf", {}, job_id=None) == "ok"
    assert perf_sampler.start_perf_stage() is None


def test_plan_executor_loi_som_van_dong_scope_perf(monkeypatch):
    """Booklet lỗi contract sớm không được để sampler active trong thread pool."""

    from app.core.plan_executor import PlanExecutionError, PlanExecutor

    monkeypatch.setenv("PRYNX_PERF", "1")
    with pytest.raises(PlanExecutionError):
        PlanExecutor._execute_sync({})

    assert perf_sampler.start_perf_stage() is None


def test_perf_stage_file_round_trip_is_gated(monkeypatch, tmp_path):
    path = tmp_path / "stages.json"
    monkeypatch.delenv("PRYNX_PERF", raising=False)
    perf_sampler.write_perf_stages(str(path), {"render_s": 1.5})
    assert not path.exists()

    monkeypatch.setenv("PRYNX_PERF", "1")
    perf_sampler.write_perf_stages(str(path), {"render_s": 1.5})
    assert perf_sampler.read_perf_stages(str(path)) == {"render_s": 1.5}


def test_read_perf_stages_ignores_invalid_values(tmp_path):
    path = tmp_path / "stages.json"
    path.write_text(
        '{"render_s": 1.25, "bad": "value", "flag": true}',
        encoding="utf-8",
    )

    assert perf_sampler.read_perf_stages(str(path)) == {"render_s": 1.25}
