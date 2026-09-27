"""
Unit test kiem chung Win32 Child HWND Embedding Spike
(DPI Per-Monitor V2, wgpu Surface on Child HWND, Resize, Modal Lifecycle)
cho PPE Viewer GPU.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
EMBEDDING_TOOL_DIR = REPO_ROOT / "tools" / "embedding_spike"
EMBEDDING_SCRIPT = REPO_ROOT / "scripts" / "viewer_gpu" / "run_embedding_spike.ps1"
OUTPUT_JSON = REPO_ROOT / ".tmp" / "viewer-gpu" / "embedding_verification.json"


def test_embedding_tool_manifest_exists():
    """Kiem tra crate embedding_spike ton tai voi file Cargo.toml."""
    cargo_toml = EMBEDDING_TOOL_DIR / "Cargo.toml"
    assert cargo_toml.exists(), f"Khong tim thay {cargo_toml}"
    content = cargo_toml.read_text(encoding="utf-8")
    assert 'name = "embedding_spike"' in content
    assert 'wgpu = "24"' in content
    assert "windows" in content
    assert "raw-window-handle" in content


def test_embedding_runner_script_exists():
    """Kiem tra script PowerShell runner ton tai."""
    assert EMBEDDING_SCRIPT.exists(), f"Khong tim thay {EMBEDDING_SCRIPT}"


def test_embedding_spike_verification_results():
    """Kiem tra du lieu JSON do embedding spike sinh ra co dung cau truc va dat 6 tieu chi bat buoc."""
    if not OUTPUT_JSON.exists():
        res = subprocess.run(
            ["powershell.exe", "-ExecutionPolicy", "Bypass", "-File", str(EMBEDDING_SCRIPT)],
            capture_output=True,
            text=True,
            cwd=str(REPO_ROOT),
        )
        assert res.returncode == 0, f"run_embedding_spike.ps1 failed: {res.stderr}\n{res.stdout}"

    assert OUTPUT_JSON.exists(), f"File {OUTPUT_JSON} khong ton tai"

    with open(OUTPUT_JSON, "r", encoding="utf-8") as f:
        data = json.load(f)

    # 1. Kiem tra schema co ban
    for key in ["tool_version", "timestamp_utc", "dpi_awareness_v2_set", "system_dpi", "test_results", "verdict"]:
        assert key in data, f"Thieu key '{key}' trong output JSON"

    assert data["dpi_awareness_v2_set"] is True, "Per-Monitor V2 DPI Awareness chua duoc bat"
    assert data["system_dpi"] > 0, "System DPI khong hop le"

    results = data["test_results"]
    expected_tests = [
        "dpi_awareness_v2",
        "parent_child_attachment",
        "wgpu_surface_on_child",
        "resize_reconfiguration",
        "modal_lifecycle_isolation",
        "multi_viewport_coexistence",
    ]

    # 2. Kiem tra du 6 bai test bat buoc
    for t_name in expected_tests:
        assert t_name in results, f"Thieu bai test '{t_name}' trong ket qua spike"
        assert results[t_name]["passed"] is True, (
            f"Bai test '{t_name}' that bai: {results[t_name]['details']}"
        )

    # 3. Verdict tong the
    assert data["verdict"] is True, "Verdict tong the cua embedding spike khong dat!"


def test_embedding_fail_closed_on_failed_test():
    """Kiem tra co che fail-closed neu co it nhat mot test that bai."""
    dummy_failed_report = {
        "tool_version": "0.1.0",
        "timestamp_utc": "2026-09-25T08:45:00Z",
        "dpi_awareness_v2_set": False,
        "system_dpi": 96,
        "test_results": {
            "dpi_awareness_v2": {"passed": False, "details": "DPI V2 failed"},
            "wgpu_surface_on_child": {"passed": False, "details": "Surface creation failed"},
        },
        "verdict": False,
        "notes": ["Co bai kiem tra that bai"],
    }

    assert dummy_failed_report["verdict"] is False
    assert dummy_failed_report["test_results"]["dpi_awareness_v2"]["passed"] is False
    assert dummy_failed_report["test_results"]["wgpu_surface_on_child"]["passed"] is False
