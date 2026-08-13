from concurrent.futures import Future
from pathlib import Path
import threading

import pytest

from app import database
from app.api.routes import compare


@pytest.fixture(autouse=True)
def _clear_compare_controls():
    with compare._COMPARE_JOBS_LOCK:
        compare._COMPARE_CONTROLS.clear()
    yield
    with compare._COMPARE_JOBS_LOCK:
        compare._COMPARE_CONTROLS.clear()


class _Slots:
    def __init__(self, acquired=True):
        self.acquired = acquired
        self.release_count = 0

    def acquire(self, blocking=False):
        assert blocking is False
        return self.acquired

    def release(self):
        self.release_count += 1


class _Executor:
    def __init__(self, error=None):
        self.error = error
        self.calls = []

    def submit(self, fn, *args):
        self.calls.append((fn, *args))
        if self.error:
            raise self.error
        return Future()


def test_local_compare_queue_rejects_without_creating_a_worker(monkeypatch):
    slots = _Slots(acquired=False)
    executor = _Executor()
    monkeypatch.setattr(compare, "_COMPARE_SUBMISSION_SLOTS", slots)
    monkeypatch.setattr(compare, "_COMPARE_EXECUTOR", executor)

    assert compare.submit_comparison_local("job-full") is False
    assert executor.calls == []
    assert slots.release_count == 0


def test_local_compare_queue_submits_to_fixed_executor(monkeypatch):
    slots = _Slots()
    executor = _Executor()
    monkeypatch.setattr(compare, "_COMPARE_SUBMISSION_SLOTS", slots)
    monkeypatch.setattr(compare, "_COMPARE_EXECUTOR", executor)

    assert compare.submit_comparison_local("job-1") is True
    assert len(executor.calls) == 1
    fn, job_id, cancel_event = executor.calls[0]
    assert fn is compare.run_comparison_sync
    assert job_id == "job-1"
    assert cancel_event.is_set() is False
    assert slots.release_count == 0


def test_local_compare_queue_releases_reservation_when_submit_fails(monkeypatch):
    slots = _Slots()
    executor = _Executor(RuntimeError("executor stopped"))
    monkeypatch.setattr(compare, "_COMPARE_SUBMISSION_SLOTS", slots)
    monkeypatch.setattr(compare, "_COMPARE_EXECUTOR", executor)

    try:
        compare.submit_comparison_local("job-error")
    except RuntimeError as exc:
        assert str(exc) == "executor stopped"
    else:
        raise AssertionError("expected submit failure")

    assert slots.release_count == 1


def test_local_compare_future_callback_releases_reservation_once(monkeypatch):
    slots = _Slots()
    executor = _Executor()
    monkeypatch.setattr(compare, "_COMPARE_SUBMISSION_SLOTS", slots)
    monkeypatch.setattr(compare, "_COMPARE_EXECUTOR", executor)

    assert compare.submit_comparison_local("job-done") is True
    assert executor.calls

    control = compare._COMPARE_CONTROLS["job-done"]
    submitted_future = control[1]
    assert submitted_future is not None
    submitted_future.set_result(None)

    assert slots.release_count == 1
    assert "job-done" not in compare._COMPARE_CONTROLS


def test_submit_handles_future_that_finishes_before_registry_update(monkeypatch):
    class _ImmediateExecutor:
        def submit(self, fn, *args):
            future = Future()
            future.set_result(None)
            return future

    slots = _Slots()
    monkeypatch.setattr(compare, "_COMPARE_SUBMISSION_SLOTS", slots)
    monkeypatch.setattr(compare, "_COMPARE_EXECUTOR", _ImmediateExecutor())

    assert compare.submit_comparison_local("job-immediate") is True
    assert slots.release_count == 1
    assert "job-immediate" not in compare._COMPARE_CONTROLS


def test_local_compare_worker_does_not_release_slot_directly(monkeypatch):
    slots = _Slots()
    monkeypatch.setattr(compare, "_COMPARE_SUBMISSION_SLOTS", slots)

    def fail_session_init():
        raise RuntimeError("database unavailable")

    monkeypatch.setattr(database, "SessionLocal", fail_session_init)
    compare.run_comparison_sync("job-init-error")

    # Slot thuộc lifecycle của Future callback, không thuộc worker body — tránh
    # double-release khi queued Future.cancel() cũng kích hoạt callback.
    assert slots.release_count == 0


def test_cancel_queued_compare_is_idempotent_and_releases_slot_once(monkeypatch):
    from app.database import SessionLocal
    from app.models.job import ComparisonJob, PageResult
    from app.config import settings

    slots = _Slots()
    executor = _Executor()
    monkeypatch.setattr(compare, "_COMPARE_SUBMISSION_SLOTS", slots)
    monkeypatch.setattr(compare, "_COMPARE_EXECUTOR", executor)

    db = SessionLocal()
    job = ComparisonJob(id="job-cancel-queued", job_type="version_compare")
    db.add(job)
    db.commit()
    db.add(PageResult(job_id=job.id, page_number=1, status="pass"))
    db.commit()
    stale_dir = Path(settings.RESULTS_DIR) / job.id
    stale_dir.mkdir(parents=True, exist_ok=True)
    (stale_dir / "stale.png").write_bytes(b"stale")
    try:
        assert compare.submit_comparison_local(job.id) is True
        first = compare.cancel_comparison_job(job.id, db, license_info={})
        second = compare.cancel_comparison_job(job.id, db, license_info={})

        assert first.cancelled is True
        assert first.status == "cancelled"
        assert second.cancelled is True
        assert second.status == "cancelled"
        assert slots.release_count == 1
        assert job.id not in compare._COMPARE_CONTROLS
        db.refresh(job)
        assert job.status == "cancelled"
        assert db.query(PageResult).filter(PageResult.job_id == job.id).count() == 0
        assert not stale_dir.exists()
    finally:
        db.delete(job)
        db.commit()
        db.close()


def test_cancel_does_not_overwrite_job_that_completed_during_request(monkeypatch):
    from app.database import SessionLocal
    from app.models.job import ComparisonJob

    db = SessionLocal()
    job = ComparisonJob(id="job-complete-race", job_type="version_compare", status="processing")
    db.add(job)
    db.commit()
    future = Future()
    event = threading.Event()
    with compare._COMPARE_JOBS_LOCK:
        compare._COMPARE_CONTROLS[job.id] = (event, future)

    class _RaceQuery:
        def filter(self, *args, **kwargs):
            return self

        def update(self, values, synchronize_session=False):
            # Mô phỏng engine thắng race và đã chuyển terminal trước UPDATE cancel.
            db.query(ComparisonJob).filter(ComparisonJob.id == job.id).update(
                {ComparisonJob.status: "completed"}, synchronize_session=False
            )
            return 0

    original_query = db.query
    update_calls = 0

    def query_with_race(*entities):
        nonlocal update_calls
        if entities == (ComparisonJob,):
            update_calls += 1
            if update_calls == 2:
                return _RaceQuery()
        return original_query(*entities)

    monkeypatch.setattr(db, "query", query_with_race)
    try:
        response = compare.cancel_comparison_job(job.id, db, license_info={})
        assert response.cancelled is False
        assert response.status == "completed"
        assert future.cancelled() is False
        db.expire_all()
        assert original_query(ComparisonJob).filter(ComparisonJob.id == job.id).one().status == "completed"
    finally:
        monkeypatch.setattr(db, "query", original_query)
        stored = db.query(ComparisonJob).filter(ComparisonJob.id == job.id).one()
        db.delete(stored)
        db.commit()
        db.close()


def test_cancel_running_job_waits_until_worker_cleanup_finishes():
    from app.database import SessionLocal
    from app.models.job import ComparisonJob

    class _RunningFuture:
        def __init__(self):
            self.waited = False

        def running(self):
            return True

        def done(self):
            return False

        def result(self):
            self.waited = True

    db = SessionLocal()
    job = ComparisonJob(id="job-cancel-running", job_type="version_compare", status="processing")
    db.add(job)
    db.commit()
    future = _RunningFuture()
    event = threading.Event()
    with compare._COMPARE_JOBS_LOCK:
        compare._COMPARE_CONTROLS[job.id] = (event, future)
    try:
        response = compare.cancel_comparison_job(job.id, db, license_info={})

        assert event.is_set()
        assert future.waited is True
        assert response.cancelled is True
        assert response.status == "cancelled"
    finally:
        stored = db.query(ComparisonJob).filter(ComparisonJob.id == job.id).one()
        db.delete(stored)
        db.commit()
        db.close()


def test_create_comparison_job_local_mode_submits_and_returns_job_id(monkeypatch):
    """PERF (audit 2026-08-13 §RV.1): test đi hết đường tạo job local.

    Hai test cũ của route dừng ở 422/404 nên dòng local_mode bị xóa nhầm không
    bị bắt — ca này phải đi tới tận submit executor để giữ hợp đồng đó.
    """
    from app.database import SessionLocal
    from app.models.job import ComparisonJob, UploadedFile
    from app.schemas.job import CompareRequest

    slots = _Slots()
    executor = _Executor()
    monkeypatch.setattr(compare, "_COMPARE_SUBMISSION_SLOTS", slots)
    monkeypatch.setattr(compare, "_COMPARE_EXECUTOR", executor)
    monkeypatch.setattr(compare.settings, "DEV_MODE", True)

    db = SessionLocal()
    file_a = UploadedFile(filename="a.pdf", original_name="a.pdf", file_path="a.pdf", page_count=1)
    file_b = UploadedFile(filename="b.pdf", original_name="b.pdf", file_path="b.pdf", page_count=1)
    db.add_all([file_a, file_b])
    db.commit()
    db.refresh(file_a)
    db.refresh(file_b)
    job_id = None
    try:
        response = compare.create_comparison_job(
            CompareRequest(file_a_id=file_a.id, file_b_id=file_b.id),
            db=db,
            license_info={},
        )
        job_id = response.job_id

        assert job_id
        assert len(executor.calls) == 1
        assert executor.calls[0][1] == job_id
        assert job_id in compare._COMPARE_CONTROLS
        assert slots.release_count == 0
        stored = db.query(ComparisonJob).filter(ComparisonJob.id == job_id).one()
        assert stored.status == "pending"
    finally:
        if job_id:
            db.query(ComparisonJob).filter(ComparisonJob.id == job_id).delete(
                synchronize_session=False
            )
        db.delete(file_a)
        db.delete(file_b)
        db.commit()
        db.close()


def test_max_compare_pages_default_env_override_and_invalid_values(monkeypatch):
    """PERF (audit 2026-08-13 §PB-1/§PB-3): trần trang mặc định 1.000 (nâng từ 250
    sau khi đủ gate PB-3) + env override của người vận hành theo cả hai chiều."""
    monkeypatch.delenv("PRYNX_MAX_COMPARE_PAGES", raising=False)
    assert compare._max_compare_pages() == 1000

    monkeypatch.setenv("PRYNX_MAX_COMPARE_PAGES", "250")
    assert compare._max_compare_pages() == 250

    monkeypatch.setenv("PRYNX_MAX_COMPARE_PAGES", "2000")
    assert compare._max_compare_pages() == 2000

    monkeypatch.setenv("PRYNX_MAX_COMPARE_PAGES", "abc")
    assert compare._max_compare_pages() == 1000

    monkeypatch.setenv("PRYNX_MAX_COMPARE_PAGES", "-3")
    assert compare._max_compare_pages() == 1


def test_create_comparison_job_rejects_over_page_cap_with_actionable_message(monkeypatch):
    from fastapi import HTTPException
    from app.database import SessionLocal
    from app.models.job import ComparisonJob, UploadedFile
    from app.schemas.job import CompareRequest

    executor = _Executor()
    monkeypatch.setattr(compare, "_COMPARE_EXECUTOR", executor)
    monkeypatch.setattr(compare.settings, "DEV_MODE", True)
    monkeypatch.setenv("PRYNX_MAX_COMPARE_PAGES", "2")

    db = SessionLocal()
    file_a = UploadedFile(filename="a.pdf", original_name="a.pdf", file_path="a.pdf", page_count=3)
    file_b = UploadedFile(filename="b.pdf", original_name="b.pdf", file_path="b.pdf", page_count=1)
    db.add_all([file_a, file_b])
    db.commit()
    db.refresh(file_a)
    db.refresh(file_b)
    try:
        with pytest.raises(HTTPException) as error:
            compare.create_comparison_job(
                CompareRequest(file_a_id=file_a.id, file_b_id=file_b.id),
                db=db,
                license_info={},
            )

        assert error.value.status_code == 413
        assert "3 trang" in error.value.detail
        assert "trần 2 trang" in error.value.detail
        assert "chia nhỏ file PDF" in error.value.detail
        # Wording cũ "nâng cấp phần cứng" đã bị loại vì gây hiểu sai bản chất trần.
        assert "nâng cấp phần cứng" not in error.value.detail
        assert executor.calls == []
        assert (
            db.query(ComparisonJob)
            .filter(ComparisonJob.file_a_id == file_a.id)
            .count()
            == 0
        )
    finally:
        db.delete(file_a)
        db.delete(file_b)
        db.commit()
        db.close()


def test_create_comparison_job_rejects_when_disk_certainly_low(monkeypatch):
    from fastapi import HTTPException
    from app.core.disk_space_guard import InsufficientDiskSpaceError
    from app.database import SessionLocal
    from app.models.job import ComparisonJob, UploadedFile
    from app.schemas.job import CompareRequest

    executor = _Executor()
    monkeypatch.setattr(compare, "_COMPARE_EXECUTOR", executor)
    monkeypatch.setattr(compare.settings, "DEV_MODE", True)

    def refuse(job_label, output_path, temp_path, estimate):
        assert estimate.output_bytes > 0
        raise InsufficientDiskSpaceError(
            "Không đủ dung lượng đĩa để so sánh PDF: cần trống ít nhất 1.00 GB."
        )

    monkeypatch.setattr(compare, "ensure_job_disk_space", refuse)

    db = SessionLocal()
    file_a = UploadedFile(filename="a.pdf", original_name="a.pdf", file_path="a.pdf", page_count=1)
    file_b = UploadedFile(filename="b.pdf", original_name="b.pdf", file_path="b.pdf", page_count=1)
    db.add_all([file_a, file_b])
    db.commit()
    db.refresh(file_a)
    db.refresh(file_b)
    try:
        with pytest.raises(HTTPException) as error:
            compare.create_comparison_job(
                CompareRequest(file_a_id=file_a.id, file_b_id=file_b.id),
                db=db,
                license_info={},
            )

        assert error.value.status_code == 413
        assert "Không đủ dung lượng đĩa" in error.value.detail
        assert executor.calls == []
        assert (
            db.query(ComparisonJob)
            .filter(ComparisonJob.file_a_id == file_a.id)
            .count()
            == 0
        )
    finally:
        db.delete(file_a)
        db.delete(file_b)
        db.commit()
        db.close()


def test_second_cancel_after_future_already_cancelled_stays_idempotent():
    """PERF (audit 2026-08-13 §RV.2): future đã CANCELLED → result() ném
    CancelledError (BaseException). Endpoint hủy thứ hai không được chết 500."""
    from concurrent.futures import Future
    from app.database import SessionLocal
    from app.models.job import ComparisonJob

    db = SessionLocal()
    job = ComparisonJob(id="job-cancel-race-twice", job_type="version_compare", status="processing")
    db.add(job)
    db.commit()
    future = Future()
    assert future.cancel() is True
    event = threading.Event()
    with compare._COMPARE_JOBS_LOCK:
        compare._COMPARE_CONTROLS[job.id] = (event, future)
    try:
        response = compare.cancel_comparison_job(job.id, db, license_info={})

        assert event.is_set()
        assert response.cancelled is True
        assert response.status == "cancelled"
    finally:
        stored = db.query(ComparisonJob).filter(ComparisonJob.id == job.id).one()
        db.delete(stored)
        db.commit()
        db.close()


def test_cancel_orphan_local_job_cleans_partial_output(tmp_path, monkeypatch):
    """PERF (audit 2026-08-13 §RV.3): backend restart giữa chừng — DB còn job
    processing nhưng registry RAM trống. Hủy phải tự dọn row/artifact dở dang."""
    from app.config import settings
    from app.database import SessionLocal
    from app.models.job import ComparisonJob, PageResult

    monkeypatch.setattr(compare.settings, "DEV_MODE", True)
    monkeypatch.setattr(settings, "RESULTS_DIR", str(tmp_path / "orphan-results"))

    db = SessionLocal()
    job = ComparisonJob(id="job-orphan-restart", job_type="version_compare", status="processing")
    db.add(job)
    db.commit()
    db.add(PageResult(job_id=job.id, page_number=1, status="pass"))
    db.commit()
    stale_dir = Path(settings.RESULTS_DIR) / job.id
    stale_dir.mkdir(parents=True, exist_ok=True)
    (stale_dir / "page_1_diff.png").write_bytes(b"partial")
    try:
        response = compare.cancel_comparison_job(job.id, db, license_info={})

        assert response.cancelled is True
        assert response.status == "cancelled"
        db.expire_all()
        stored = db.query(ComparisonJob).filter(ComparisonJob.id == job.id).one()
        assert stored.status == "cancelled"
        assert db.query(PageResult).filter(PageResult.job_id == job.id).count() == 0
        assert not stale_dir.exists()
    finally:
        db.query(PageResult).filter(PageResult.job_id == job.id).delete(
            synchronize_session=False
        )
        db.query(ComparisonJob).filter(ComparisonJob.id == job.id).delete(
            synchronize_session=False
        )
        db.commit()
        db.close()
