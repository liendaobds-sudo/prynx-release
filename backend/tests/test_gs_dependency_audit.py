"""Chính sách timeout, sandbox, privacy và provenance của gate corpus no-GS."""

from __future__ import annotations

import copy
import json
import os
import shutil
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO))

from scripts import gs_dependency_audit as audit  # noqa: E402


class _NoReplyConnection:
    def __init__(self):
        self.sent = []
        self.polled_with = None
        self.closed = False

    def send(self, value):
        self.sent.append(value)

    def poll(self, timeout):
        self.polled_with = timeout
        return False

    def close(self):
        self.closed = True


class _LiveProcess:
    pid = 43210
    exitcode = None

    def is_alive(self):
        return True


class _OutcomeConnection(_NoReplyConnection):
    def poll(self, timeout):
        self.polled_with = timeout
        return True

    def recv(self):
        return {
            "kind": "outcome",
            "outcome": {
                "status": "OK",
                "detail": "",
                "gs_calls": 0,
                "seconds": 0.1,
                "extra": {},
            },
        }


def _prepare_fake_timeout_runner(tmp_path: Path, monkeypatch):
    root = (tmp_path / "workspaces").resolve()
    workspace = (root / "worker-fake").resolve()
    workspace.mkdir(parents=True)
    runner = audit._OperationRunner(workspace_root=root)
    runner._workspace = workspace
    runner._parent_connection = _NoReplyConnection()
    runner._process = _LiveProcess()
    monkeypatch.setattr(runner, "_start_worker", lambda: None)
    stopped = []
    monkeypatch.setattr(audit, "_terminate_process_tree", stopped.append)
    source = tmp_path / "fixture.pdf"
    source.write_bytes(b"%PDF-1.4\n%%EOF")
    return runner, workspace, stopped, source


def test_operation_timeout_stops_tree_and_parent_removes_workspace(
    monkeypatch, tmp_path: Path
):
    runner, workspace, stopped, source = _prepare_fake_timeout_runner(
        tmp_path, monkeypatch
    )
    connection = runner._parent_connection
    process = runner._process

    outcome = runner.run("pdfx:x1a", str(source), timeout_seconds=0.25)

    assert outcome.status == "TIMEOUT"
    assert "0.25 giây" in outcome.detail
    assert connection.polled_with == 0.25
    assert stopped == [process]
    assert connection.closed
    assert runner._process is None
    assert not workspace.exists()


def test_cleanup_failure_overrides_success_or_timeout_with_terminal_error(
    monkeypatch, tmp_path: Path
):
    runner, workspace, _stopped, source = _prepare_fake_timeout_runner(
        tmp_path, monkeypatch
    )
    monkeypatch.setattr(
        runner,
        "_cleanup_workspace",
        lambda: "không dọn được workspace cô lập (PermissionError)",
    )

    outcome = runner.run("preflight", str(source), timeout_seconds=0.01)

    assert outcome.status == "ERROR"
    assert outcome.extra["original_status"] == "TIMEOUT"
    assert "không dọn được workspace" in outcome.detail
    shutil.rmtree(workspace)

    runner, workspace, _stopped, source = _prepare_fake_timeout_runner(
        tmp_path, monkeypatch
    )
    runner._parent_connection = _OutcomeConnection()
    monkeypatch.setattr(
        runner,
        "_cleanup_workspace",
        lambda: "không dọn được workspace cô lập (PermissionError)",
    )
    outcome = runner.run("preflight", str(source), timeout_seconds=1.0)
    assert outcome.status == "ERROR"
    assert outcome.extra["original_status"] == "OK"
    shutil.rmtree(workspace)


def test_real_worker_reads_sandbox_env_and_recovers_after_timeout(
    monkeypatch, tmp_path: Path
):
    fixture = (
        REPO
        / "backend"
        / "tests"
        / "preflight_fixtures"
        / "pdfs"
        / "17_tac_heavy_cmyk.pdf"
    )
    assert fixture.is_file()
    original_bytes = fixture.read_bytes()
    root = tmp_path / "real-workers"
    before_env = {name: os.environ.get(name) for name in audit.WORKER_ENV_KEYS}
    observed = []

    with audit._OperationRunner(workspace_root=root) as runner:
        original_cleanup = runner._cleanup_workspace

        def inspect_then_cleanup():
            workspace = runner._workspace
            if workspace is not None:
                observed.append(
                    {
                        "marker": (workspace / ".worker-env-ready").is_file(),
                        "output_log": (workspace / "worker-output.log").is_file(),
                        "opaque_input": (workspace / "input.pdf").is_file(),
                        "results": (workspace / "results").is_dir(),
                        "uploads": (workspace / "uploads").is_dir(),
                        "temp": (workspace / "temp").is_dir(),
                        "desktop_contract": (
                            "PRYNX_TOKEN_SOURCE"
                            in (workspace / ".worker-env-ready").read_text(
                                encoding="ascii"
                            )
                        ),
                    }
                )
            return original_cleanup()

        monkeypatch.setattr(runner, "_cleanup_workspace", inspect_then_cleanup)
        timed_out = runner.run("preflight", str(fixture), timeout_seconds=0.001)
        recovered = runner.run("preflight", str(fixture), timeout_seconds=30.0)

    assert timed_out.status == "TIMEOUT"
    assert recovered.status == "OK"
    assert fixture.read_bytes() == original_bytes
    assert len(observed) == 2
    assert all(all(record.values()) for record in observed)
    assert not list(root.iterdir())
    assert {name: os.environ.get(name) for name in audit.WORKER_ENV_KEYS} == before_env


def test_resume_is_operation_granular_and_artifact_hides_corpus_identity(
    monkeypatch, tmp_path: Path, capsys
):
    secret_name = "KHACH_HANG_MAT_2026.pdf"
    pdf = (tmp_path / secret_name).resolve()
    pdf.write_bytes(b"%PDF-1.4\n%%EOF")
    fingerprint = "a" * 64
    corpus_key = audit._opaque_corpus_key(0, fingerprint)
    original_results = {
        corpus_key: {
            "done": {"status": "OK", "detail": "", "seconds": 1.0},
            "timed": {"status": "TIMEOUT", "detail": "quá hạn", "seconds": 180.0},
            "partial": {"detail": "phiên trước bị ngắt"},
        }
    }
    artifact = tmp_path / "audit.json"
    audit._write_artifact(
        artifact,
        original_results,
        [corpus_key],
        fingerprint=fingerprint,
    )
    results, resumed, message = audit._load_resume_results(
        artifact,
        expected_fingerprint=fingerprint,
        expected_corpus_keys=[corpus_key],
    )
    assert resumed
    assert "tái dùng" in message

    class _FakeRunner:
        def __init__(self):
            self.calls = []

        def run(self, name, path, timeout_seconds):
            self.calls.append((name, path, timeout_seconds))
            return audit.Outcome(
                "ERROR",
                f"lỗi tại {path}; file={Path(path).name}",
                seconds=0.1,
                extra={"warning": f"file:///{path}"},
            )

    runner = _FakeRunner()
    snapshots = []
    monkeypatch.setattr(
        audit,
        "_write_artifact",
        lambda _out, current, _keys, _fingerprint, _summary=None: snapshots.append(
            copy.deepcopy(current)
        ),
    )

    audit._measure_operations(
        [(corpus_key, pdf)],
        [("done", None), ("timed", None), ("partial", None), ("missing", None)],
        results,
        resume=True,
        out_path=artifact,
        runner=runner,
        timeout_seconds=23.0,
        fingerprint=fingerprint,
    )

    assert [call[0] for call in runner.calls] == ["partial", "missing"]
    assert len(snapshots) == 2
    assert snapshots[0][corpus_key]["partial"]["status"] == "ERROR"
    assert "missing" not in snapshots[0][corpus_key]
    assert snapshots[1][corpus_key]["missing"]["status"] == "ERROR"

    audit._write_artifact(artifact, results, [corpus_key], fingerprint)
    combined = capsys.readouterr().out + artifact.read_text(encoding="utf-8")
    assert secret_name not in combined
    assert str(pdf) not in combined
    assert str(tmp_path) not in combined
    payload = json.loads(artifact.read_text(encoding="utf-8"))
    assert payload["corpus"] == [corpus_key]
    assert list(payload["files"]) == [corpus_key]


def test_scrubber_fails_closed_for_windows_posix_unc_and_pdf_names(tmp_path: Path):
    corpus = tmp_path / "Customer Secret.pdf"
    text = audit._scrub_text(
        f"A={corpus}; B=C:\\Private\\job.pdf; C=/home/user/secret.pdf; "
        r"D=\\server\share\client.pdf E=standalone.pdf",
        [corpus],
    )
    assert "Customer Secret.pdf" not in text
    assert "job.pdf" not in text
    assert "secret.pdf" not in text
    assert "client.pdf" not in text
    assert "standalone.pdf" not in text
    with pytest.raises(ValueError, match="không mờ"):
        audit._write_artifact(
            tmp_path / "unsafe.json",
            {"client.pdf": {}},
            ["client.pdf"],
            "fingerprint",
        )


def test_resume_rejects_legacy_stale_invalid_or_wrong_corpus(tmp_path: Path):
    artifact = tmp_path / "audit.json"
    current_key = audit._opaque_corpus_key(0, "current")
    stale_results = {current_key: {"preflight": {"status": "OK"}}}

    artifact.write_text(
        '{"files":{"legacy.pdf":{"preflight":{"status":"OK"}}}}',
        encoding="utf-8",
    )
    loaded, resumed, message = audit._load_resume_results(artifact, "current")
    assert not resumed and loaded == {} and "schema" in message

    audit._write_artifact(artifact, stale_results, [current_key], fingerprint="stale")
    loaded, resumed, message = audit._load_resume_results(artifact, "current")
    assert not resumed and loaded == {} and "Fingerprint" in message

    audit._write_artifact(
        artifact,
        stale_results,
        [current_key],
        fingerprint="current",
        provenance_valid=False,
    )
    loaded, resumed, message = audit._load_resume_results(artifact, "current")
    assert not resumed and loaded == {} and "không hợp lệ" in message

    audit._write_artifact(artifact, stale_results, [current_key], fingerprint="current")
    loaded, resumed, message = audit._load_resume_results(
        artifact,
        "current",
        [audit._opaque_corpus_key(1, "current")],
    )
    assert not resumed and loaded == {} and "corpus" in message


def test_fingerprint_tracks_source_corpus_operation_timeout_config_and_env(
    monkeypatch, tmp_path: Path
):
    source = tmp_path / "engine.py"
    corpus = tmp_path / "fixture.pdf"
    source.write_text("ENGINE = 1\n", encoding="utf-8")
    corpus.write_bytes(b"%PDF-1.4\nA\n%%EOF")
    monkeypatch.setattr(audit, "_runtime_distribution_facts", lambda: ["pkg==1"])
    monkeypatch.setattr(audit, "_runtime_platform_facts", lambda: ["machine:x64"])
    monkeypatch.setattr(audit, "_fingerprint_environment_facts", lambda: ["ENV=A"])

    def fingerprint(*, operation="preflight", timeout=180.0, config="A"):
        return audit._build_provenance_fingerprint(
            [corpus],
            [operation],
            operation_timeout_seconds=timeout,
            source_files=[source],
            runtime_config={"ICC_PROFILE_DIR": config},
        )

    baseline = fingerprint()
    assert baseline == fingerprint()
    source.write_text("ENGINE = 2\n", encoding="utf-8")
    assert fingerprint() != baseline
    source.write_text("ENGINE = 1\n", encoding="utf-8")
    corpus.write_bytes(b"%PDF-1.4\nB\n%%EOF")
    assert fingerprint() != baseline
    corpus.write_bytes(b"%PDF-1.4\nA\n%%EOF")
    assert fingerprint(operation="softproof") != baseline
    assert fingerprint(timeout=30.0) != baseline
    assert fingerprint(config="B") != baseline

    monkeypatch.setattr(audit, "_fingerprint_environment_facts", lambda: ["ENV=B"])
    assert fingerprint() != baseline
    monkeypatch.setattr(audit, "_fingerprint_environment_facts", lambda: ["ENV=A"])
    monkeypatch.setattr(audit, "_runtime_distribution_facts", lambda: ["pkg==2"])
    assert fingerprint() != baseline


def test_provenance_covers_exact_modules_pdfium_icc_distributions_and_platform(
    tmp_path: Path,
):
    icc_dir = tmp_path / "icc"
    icc_dir.mkdir()
    (icc_dir / "Custom.icc").write_bytes(b"icc-profile")
    labels = {
        label
        for label, _path in audit._provenance_source_files(
            {"ICC_PROFILE_DIR": str(icc_dir)}
        )
    }
    assert "scripts/gs_dependency_audit.py" in labels
    assert "backend/app/config.py" in labels
    assert "backend/requirements.txt" in labels
    assert "native/Cargo.lock" in labels
    assert "native/src/lib.rs" in labels
    assert "native/pdfium_lib/VERSION" in labels
    assert "print_engine/Cargo.lock" in labels
    assert "print_engine/src/lib.rs" in labels
    assert "runtime/module/pdfcompare_native/__init__.py" in labels
    assert any(
        label.startswith("runtime/module/pdfcompare_native/") and label.endswith(".pyd")
        for label in labels
    )
    assert "runtime/module/pypdfium2/__init__.py" in labels
    assert "runtime/module/pypdfium2_raw/pdfium.dll" in labels
    assert "runtime/python/base-executable" in labels
    assert any(label.startswith("runtime/icc/") for label in labels)

    distribution_facts = audit._runtime_distribution_facts()
    assert distribution_facts == audit._runtime_distribution_facts()
    distributions = "\n".join(distribution_facts)
    assert "pdfcompare-native==" in distributions
    assert "pypdfium2==" in distributions
    assert "RECORD:" in distributions
    platform_facts = audit._runtime_platform_facts()
    assert any(fact.startswith("machine:") for fact in platform_facts)
    assert any(fact.startswith("architecture:") for fact in platform_facts)


def test_timeout_blocks_gate():
    summary = {
        "ok": {"OK": 2},
        "refused": {"REFUSED": 1},
        "slow": {"TIMEOUT": 1},
    }
    assert audit._blocking_operations(summary) == ["slow"]


def test_windows_spawn_privacy_fingerprint_and_resume_contract_are_explicit():
    assert audit._operation_worker.__qualname__ == "_operation_worker"
    source = (REPO / "scripts" / "gs_dependency_audit.py").read_text(encoding="utf-8")
    assert 'multiprocessing.get_context("spawn")' in source
    assert '["taskkill", "/PID", str(pid), "/T", "/F"]' in source
    assert "DEFAULT_OPERATION_TIMEOUT_SECONDS = 180.0" in source
    assert 'FINGERPRINT_ALGORITHM = "sha256-content-v2"' in source
    assert "ARTIFACT_SCHEMA_VERSION = 3" in source
    assert '"schema_version": ARTIFACT_SCHEMA_VERSION' in source
    assert '"PRYNX_RELEASE_NATIVE_SITE"' in source
    for env_name in (
        "RESULTS_DIR",
        "UPLOAD_DIR",
        "TMP",
        "TEMP",
        "PRYNX_TOKEN_SOURCE",
    ):
        assert env_name in source

    release_qa = (REPO / "scripts" / "run_release_qa.ps1").read_text(encoding="utf-8")
    assert "gs_dependency_audit.py" in release_qa
    assert "--gate --resume --out" in release_qa
