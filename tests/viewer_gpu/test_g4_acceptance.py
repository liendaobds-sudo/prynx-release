"""Smoke runner GPU. Nghiệm thu G4 dùng validate_acceptance.py với evidence thật."""

import subprocess
from pathlib import Path
import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent.parent


def test_gpu_pipeline_smoke_runner():
    """Swatch/layout/enum smoke; không dùng kết quả làm Acrobat parity."""
    res = subprocess.run(
        [
            "cargo",
            "test",
            "--manifest-path",
            "viewer_gpu/Cargo.toml",
            "--test",
            "test_g4_acrobat_parity",
            "--",
            "--nocapture",
        ],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
    )
    assert res.returncode == 0, f"Acrobat Parity Test that bai:\nSTDOUT:\n{res.stdout}\nSTDERR:\n{res.stderr}"
    assert "test result: ok. 4 passed" in res.stdout


def test_texture_pool_smoke_runner():
    """Pool cùng kích thước; không dùng làm bằng chứng leak/soak dài."""
    res = subprocess.run(
        [
            "cargo",
            "test",
            "--manifest-path",
            "viewer_gpu/Cargo.toml",
            "--test",
            "test_g4_soak_leak",
            "--",
            "--nocapture",
        ],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
    )
    assert res.returncode == 0, f"Soak & Leak Test that bai:\nSTDOUT:\n{res.stdout}\nSTDERR:\n{res.stderr}"
    assert "Pool reuse smoke" in res.stdout
    assert "test result: ok. 1 passed" in res.stdout
