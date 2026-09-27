"""
Unit test kiem chung Acceptance Runner va Acceptance Criteria v1 (P01 - P09)
cho PPE Viewer GPU Milestone G0.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from scripts.viewer_gpu.process_protocol_probe import verify_process_protocol
ACCEPTANCE_JSON = REPO_ROOT / "tests" / "viewer_gpu" / "acceptance-v1.json"
ACCEPTANCE_SCRIPT = REPO_ROOT / "scripts" / "viewer_gpu" / "run_acceptance.ps1"
RUNS_DIR = REPO_ROOT / ".tmp" / "viewer-gpu" / "runs"


def test_acceptance_criteria_manifest_exists_and_valid():
    """Kiem tra acceptance-v1.json chua day du tieu chi tu P01 den P09."""
    assert ACCEPTANCE_JSON.exists(), f"Khong tim thay {ACCEPTANCE_JSON}"

    with open(ACCEPTANCE_JSON, "r", encoding="utf-8") as f:
        data = json.load(f)

    assert data.get("name") == "acceptance-v1"
    assert data.get("reference_fixture") == "R01"

    criteria = data.get("criteria", {})
    for i in range(1, 10):
        code = f"P{i:02d}"
        assert code in criteria, f"Thieu tieu chi {code} trong acceptance-v1.json"
        assert "threshold" in criteria[code], f"Tieu chi {code} thieu threshold"
        assert "metric" in criteria[code], f"Tieu chi {code} thieu metric"

    # Kiem tra hardware invariants
    invariants = data.get("hardware_invariants", {})
    assert invariants.get("tier_ge_16gb_no_arbitrary_caps") is True
    assert invariants.get("zero_full_frame_gpu_readback") is True


def test_process_protocol_probe_invariants():
    """Kiem tra truc tiep cac bat bien cua process protocol va surface lease."""
    res = verify_process_protocol()
    assert res["verdict"] is True
    assert res["evidence_kind"] == "python_protocol_model"
    assert res["runtime_acceptance"] == "UNOBSERVED"
    assert res["zero_gpu_readback"] is True
    assert res["use_after_free_blocked"] is True
    assert res["stale_epoch_after_device_loss_blocked"] is True
    assert res["device_loss_recovery_successful"] is True


def test_acceptance_cli_rejects_missing_runtime_evidence(tmp_path):
    """Có probe/model xanh vẫn không được nghiệm thu khi chưa đo native PDF."""
    res = subprocess.run(
        [sys.executable, str(REPO_ROOT / 'scripts/viewer_gpu/validate_acceptance.py'), str(tmp_path)],
        capture_output=True, text=True, cwd=str(REPO_ROOT),
    )
    assert res.returncode == 50
    summary = json.loads((tmp_path / 'runtime-acceptance.json').read_text(encoding='utf-8'))
    assert summary['verdict'] is False
    assert summary['status'] == 'UNOBSERVED'
