from __future__ import annotations

import threading

import pytest

from app.core import office_job_runner as runner


PDF_BYTES = b"%PDF-1.4\n" + b"0" * 64


class InlineProcess:
    pid = 321
    exitcode = 0

    def __init__(self, *, target, args, daemon):
        assert daemon is False
        self.target = target
        self.args = args
        self.alive = False

    def start(self):
        self.target(*self.args)

    def is_alive(self):
        return self.alive

    def join(self, timeout=None):
        return None

    def terminate(self):
        self.alive = False

    def kill(self):
        self.alive = False


class BlockingProcess(InlineProcess):
    def __init__(self, *, target, args, daemon):
        super().__init__(target=target, args=args, daemon=daemon)
        self.alive = True
        self.exitcode = None

    def start(self):
        return None


class CrashProcess(InlineProcess):
    exitcode = 7

    def start(self):
        return None


def test_office_job_success_replaces_atomically_and_cleans_temp(monkeypatch, tmp_path):
    source = tmp_path / "source.docx"
    output = tmp_path / "output.pdf"
    source.write_bytes(b"docx")
    output.write_bytes(b"old-output")

    def fake_convert(_source, partial, _layout, owned_pid_path=None):
        assert owned_pid_path
        with open(owned_pid_path, "w", encoding="ascii") as pid_file:
            pid_file.write("123\n")
        with open(partial, "wb") as pdf_file:
            pdf_file.write(PDF_BYTES)
        return partial

    monkeypatch.setattr(runner.multiprocessing, "Process", InlineProcess)
    monkeypatch.setattr(runner, "convert_office_file", fake_convert)

    result = runner.run_office_job(str(source), str(output))

    assert result == str(output)
    assert output.read_bytes() == PDF_BYTES
    assert list(tmp_path.glob("*.partial.pdf")) == []
    assert list(tmp_path.glob("*.state.json")) == []
    assert list(tmp_path.glob("*.owned-pids")) == []


def test_worker_failure_keeps_existing_output_and_cleans_partial(monkeypatch, tmp_path):
    source = tmp_path / "source.docx"
    output = tmp_path / "output.pdf"
    source.write_bytes(b"docx")
    output.write_bytes(b"existing")

    def fake_convert(_source, partial, _layout, owned_pid_path=None):
        with open(partial, "wb") as pdf_file:
            pdf_file.write(b"partial")
        raise ValueError("file có mật khẩu")

    monkeypatch.setattr(runner.multiprocessing, "Process", InlineProcess)
    monkeypatch.setattr(runner, "convert_office_file", fake_convert)

    with pytest.raises(ValueError, match="mật khẩu"):
        runner.run_office_job(str(source), str(output))

    assert output.read_bytes() == b"existing"
    assert list(tmp_path.glob("output.pdf.*")) == []


def test_cancel_stops_running_process_and_keeps_terminal_phase(monkeypatch, tmp_path):
    source = tmp_path / "source.docx"
    output = tmp_path / "output.pdf"
    source.write_bytes(b"docx")
    control = runner.OfficeJobControl(60)
    phases: list[str] = []
    stopped: list[str] = []

    class CancelAfterStart(BlockingProcess):
        def start(self):
            control.cancel()

    def fake_terminate(
        process, owned_pid_path, join_timeout=1.0, owned_pid_grace_timeout=0.0
    ):
        assert owned_pid_grace_timeout == 3.0
        stopped.append(owned_pid_path)
        process.alive = False
        return True

    monkeypatch.setattr(runner.multiprocessing, "Process", CancelAfterStart)
    monkeypatch.setattr(runner, "_terminate_process_tree", fake_terminate)

    with pytest.raises(runner.OfficeJobCancelled):
        runner.run_office_job(
            str(source),
            str(output),
            control=control,
            phase_callback=phases.append,
        )

    assert stopped
    assert phases[-1] == "cancelled"
    assert not output.exists()
    assert list(tmp_path.glob("output.pdf.*")) == []


def test_timeout_stops_process_and_is_not_overwritten_by_failed(monkeypatch, tmp_path):
    source = tmp_path / "source.docx"
    output = tmp_path / "output.pdf"
    source.write_bytes(b"docx")
    phases: list[str] = []
    stopped = []

    class ExpiredControl:
        cancel_event = threading.Event()

        @staticmethod
        def expired():
            return True

    def fake_terminate(
        process, owned_pid_path, join_timeout=1.0, owned_pid_grace_timeout=0.0
    ):
        assert owned_pid_grace_timeout == 3.0
        stopped.append(process.pid)
        process.alive = False
        return True

    monkeypatch.setattr(runner.multiprocessing, "Process", BlockingProcess)
    monkeypatch.setattr(runner, "_terminate_process_tree", fake_terminate)

    with pytest.raises(runner.OfficeJobTimedOut):
        runner.run_office_job(
            str(source),
            str(output),
            control=ExpiredControl(),  # type: ignore[arg-type]
            phase_callback=phases.append,
        )

    assert stopped == [321]
    assert phases[-1] == "timed_out"
    assert list(tmp_path.glob("output.pdf.*")) == []


def test_child_crash_is_terminal_and_cleans_temp(monkeypatch, tmp_path):
    source = tmp_path / "source.docx"
    output = tmp_path / "output.pdf"
    source.write_bytes(b"docx")
    monkeypatch.setattr(runner.multiprocessing, "Process", CrashProcess)

    with pytest.raises(RuntimeError, match="mã 7"):
        runner.run_office_job(str(source), str(output))

    assert list(tmp_path.glob("output.pdf.*")) == []


def test_terminate_targets_only_owned_pids(monkeypatch, tmp_path):
    pid_file = tmp_path / "owned-pids"
    pid_file.write_text("1001\n1002\n1001\ninvalid\n", encoding="ascii")
    killed: list[int] = []
    process = InlineProcess(target=lambda: None, args=(), daemon=False)
    process.alive = False

    monkeypatch.setattr(runner, "_kill_pid_tree", killed.append)

    assert runner._terminate_process_tree(process, str(pid_file)) is True
    assert killed == [1001, 1002]


def test_terminate_rescans_owned_pid_published_while_worker_stops(monkeypatch, tmp_path):
    pid_file = tmp_path / "owned-pids"
    killed: list[int] = []
    process = BlockingProcess(target=lambda: None, args=(), daemon=False)

    def fake_kill(pid: int) -> None:
        killed.append(pid)
        if pid == process.pid:
            pid_file.write_text("9876\n", encoding="ascii")
            process.alive = False

    monkeypatch.setattr(runner.os, "name", "nt")
    monkeypatch.setattr(runner, "_kill_pid_tree", fake_kill)

    assert runner._terminate_process_tree(process, str(pid_file)) is True
    assert killed == [321, 9876]


def test_terminate_waits_for_owned_pid_publication_before_killing_worker(monkeypatch, tmp_path):
    pid_file = tmp_path / "owned-pids"
    killed: list[int] = []

    class PublishingProcess(BlockingProcess):
        def is_alive(self):
            if not pid_file.exists():
                pid_file.write_text("9876\n", encoding="ascii")
            return self.alive

    process = PublishingProcess(target=lambda: None, args=(), daemon=False)

    def fake_kill(pid: int) -> None:
        killed.append(pid)
        if pid == process.pid:
            process.alive = False

    monkeypatch.setattr(runner.os, "name", "nt")
    monkeypatch.setattr(runner, "_kill_pid_tree", fake_kill)

    assert runner._terminate_process_tree(
        process, str(pid_file), owned_pid_grace_timeout=1.0
    ) is True
    assert killed == [9876, 321]


def test_lease_can_be_extended():
    control = runner.OfficeJobControl(2)
    before = control.remaining_seconds()
    after = control.extend(5)

    assert before > 0
    assert after >= before + 4.5

def test_real_spawn_process_returns_terminal_error(tmp_path):
    """Chốt multiprocessing thật, không chỉ FakeProcess trong unit test."""
    source = tmp_path / "unsupported.txt"
    output = tmp_path / "output.pdf"
    source.write_text("unsupported", encoding="utf-8")

    with pytest.raises(ValueError, match="Định dạng không hỗ trợ"):
        runner.run_office_job(
            str(source),
            str(output),
            control=runner.OfficeJobControl(20),
        )

    assert not output.exists()
    assert list(tmp_path.glob("output.pdf.*")) == []
