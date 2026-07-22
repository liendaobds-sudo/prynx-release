from app.api.routes import compare


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

    def submit(self, fn, job_id):
        self.calls.append((fn, job_id))
        if self.error:
            raise self.error


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
    assert executor.calls == [(compare.run_comparison_sync, "job-1")]
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
