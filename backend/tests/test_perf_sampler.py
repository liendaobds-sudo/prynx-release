import os
import time

from app.core import perf_sampler


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
