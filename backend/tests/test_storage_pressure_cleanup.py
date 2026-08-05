"""Hồi quy cleanup high-watermark cho uploads/results."""

from collections import namedtuple
import os
import time

from app.core import cleanup


DiskUsage = namedtuple("DiskUsage", "total used free")


def _write(path, *, size=10, age_hours=3):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"x" * size)
    past = time.time() - age_hours * 3600
    os.utime(path, (past, past))
    return path


def _configure_roots(tmp_path, monkeypatch):
    uploads = tmp_path / "uploads"
    results = tmp_path / "results"
    uploads.mkdir()
    results.mkdir()
    monkeypatch.setattr(cleanup.settings, "UPLOAD_DIR", str(uploads))
    monkeypatch.setattr(cleanup.settings, "RESULTS_DIR", str(results))
    return uploads, results


def test_no_pressure_keeps_all_managed_files(tmp_path, monkeypatch):
    _uploads, results = _configure_roots(tmp_path, monkeypatch)
    managed = _write(results / "nup_0123abcd.pdf", age_hours=10)
    monkeypatch.setattr(cleanup, "minimum_free_disk_bytes", lambda _total: 100)
    monkeypatch.setattr(
        cleanup.shutil,
        "disk_usage",
        lambda _path: DiskUsage(10_000, 0, 100),
    )

    assert cleanup._cleanup_storage_pressure(time.time()) == (0, 0)
    assert managed.exists()


def test_pressure_only_removes_old_top_level_managed_artifacts(
    tmp_path, monkeypatch,
):
    uploads, results = _configure_roots(tmp_path, monkeypatch)
    vdp_id = "a" * 32
    safe = [
        _write(results / "nup_0123abcd.pdf", size=11, age_hours=3),
        _write(results / f"vdp_{vdp_id}.pdf", size=12, age_hours=3),
        _write(uploads / f"vdp_data_{vdp_id}.dat", size=13, age_hours=13),
        _write(uploads / f"vdp_template_{vdp_id}.pdf", size=14, age_hours=13),
        _write(
            uploads / "12345678-1234-1234-1234-1234567890ab_plan_input.pdf",
            size=15,
            age_hours=13,
        ),
    ]
    recent = _write(results / "nup_deadbeef.pdf", age_hours=1)
    sticker = _write(results / "sticker_0123abcd.pdf", age_hours=20)
    arbitrary = _write(results / "customer.pdf", age_hours=20)
    nested = _write(results / "job" / "nup_feedface.pdf", age_hours=20)
    monkeypatch.setattr(cleanup, "minimum_free_disk_bytes", lambda _total: 10_000)
    monkeypatch.setattr(cleanup, "_recovery_margin_bytes", lambda _total: 0)
    monkeypatch.setattr(
        cleanup.shutil,
        "disk_usage",
        lambda _path: DiskUsage(100_000, 100_000, 0),
    )

    deleted, freed = cleanup._cleanup_storage_pressure(time.time())

    assert deleted == len(safe)
    assert freed == sum(range(11, 16))
    assert all(not path.exists() for path in safe)
    assert recent.exists()
    assert sticker.exists()
    assert arbitrary.exists()
    assert nested.exists()


def test_pressure_deletes_oldest_first_and_stops_at_recovery_target(
    tmp_path, monkeypatch,
):
    _uploads, results = _configure_roots(tmp_path, monkeypatch)
    oldest = _write(results / "nup_00000001.pdf", size=6, age_hours=5)
    middle = _write(results / "nup_00000002.pdf", size=6, age_hours=4)
    newest = _write(results / "nup_00000003.pdf", size=6, age_hours=3)
    monkeypatch.setattr(cleanup, "minimum_free_disk_bytes", lambda _total: 10)
    monkeypatch.setattr(cleanup, "_recovery_margin_bytes", lambda _total: 0)
    monkeypatch.setattr(
        cleanup.shutil,
        "disk_usage",
        lambda _path: DiskUsage(100_000, 100_000, 0),
    )

    deleted, freed = cleanup._cleanup_storage_pressure(time.time())

    assert (deleted, freed) == (2, 12)
    assert not oldest.exists()
    assert not middle.exists()
    assert newest.exists()


def test_upload_created_by_current_sidecar_is_never_pressure_deleted(
    tmp_path, monkeypatch,
):
    uploads, _results = _configure_roots(tmp_path, monkeypatch)
    vdp_id = "b" * 32
    queued_input = _write(
        uploads / f"vdp_data_{vdp_id}.dat",
        size=20,
        age_hours=13,
    )
    # Sidecar đã chạy 24 giờ: file 13 giờ tuổi vẫn thuộc chính process này.
    monkeypatch.setattr(cleanup, "_CLEANUP_PROCESS_STARTED_AT", time.time() - 24 * 3600)
    monkeypatch.setattr(cleanup, "minimum_free_disk_bytes", lambda _total: 10_000)
    monkeypatch.setattr(cleanup, "_recovery_margin_bytes", lambda _total: 0)
    monkeypatch.setattr(
        cleanup.shutil,
        "disk_usage",
        lambda _path: DiskUsage(100_000, 100_000, 0),
    )

    assert cleanup._cleanup_storage_pressure(time.time()) == (0, 0)
    assert queued_input.exists()


def test_zero_reserve_disables_pressure_cleanup(tmp_path, monkeypatch):
    _uploads, results = _configure_roots(tmp_path, monkeypatch)
    managed = _write(results / "nup_0123abcd.pdf", age_hours=20)
    monkeypatch.setenv("PRYNX_MIN_FREE_DISK_MB", "0")
    monkeypatch.setattr(
        cleanup.shutil,
        "disk_usage",
        lambda _path: DiskUsage(100 * 1024**3, 100 * 1024**3, 0),
    )

    assert cleanup._cleanup_storage_pressure(time.time()) == (0, 0)
    assert managed.exists()


def test_delete_error_is_best_effort(tmp_path, monkeypatch):
    _uploads, results = _configure_roots(tmp_path, monkeypatch)
    managed = _write(results / "nup_0123abcd.pdf", age_hours=20)
    monkeypatch.setattr(cleanup, "minimum_free_disk_bytes", lambda _total: 10)
    monkeypatch.setattr(cleanup, "_recovery_margin_bytes", lambda _total: 0)
    monkeypatch.setattr(
        cleanup.shutil,
        "disk_usage",
        lambda _path: DiskUsage(100_000, 100_000, 0),
    )
    original_unlink = cleanup.Path.unlink

    def deny_managed(path, *args, **kwargs):
        if path == managed:
            raise PermissionError("locked")
        return original_unlink(path, *args, **kwargs)

    monkeypatch.setattr(cleanup.Path, "unlink", deny_managed)

    assert cleanup._cleanup_storage_pressure(time.time()) == (0, 0)
    assert managed.exists()


def test_orphan_cleanup_invokes_storage_pressure(tmp_path, monkeypatch):
    _configure_roots(tmp_path, monkeypatch)
    called = []
    monkeypatch.setattr(cleanup, "_cleanup_directory", lambda *_args: (0, 0))
    monkeypatch.setattr(cleanup, "_cleanup_os_temp_by_prefix", lambda *_args: (0, 0))
    monkeypatch.setattr(
        cleanup,
        "_cleanup_storage_pressure",
        lambda now: (called.append(now) or (0, 0)),
    )

    cleanup.cleanup_orphan_files()

    assert len(called) == 1
