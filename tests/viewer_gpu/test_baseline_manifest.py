"""Bộ kiểm thử tính toàn vẹn của Fixture và Provenance cho Viewer GPU (Mốc G0.1a).

Bảo đảm quy tắc của §7 & §12:
- Fixture sai hash lập tức bị từ chối (fail-closed).
- Không được báo PASS khi thiếu bằng chứng hoặc thiếu mốc thời gian.
- Metric chưa quan sát phải được ghi rõ là 'unobserved'.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import subprocess
import sys

import pytest

ROOT_DIR = Path(__file__).resolve().parents[2]
FIXTURES_JSON = ROOT_DIR / "tests" / "viewer_gpu" / "fixtures.json"
SUMMARIZE_SCRIPT = ROOT_DIR / "scripts" / "viewer_gpu" / "summarize_baseline.py"
sys.path.insert(0, str(ROOT_DIR / "scripts" / "viewer_gpu"))
from summarize_baseline import analyze_run, summarize_metric_list


def test_fixtures_catalog_structure():
    assert FIXTURES_JSON.exists(), f"Không tìm thấy file fixtures: {FIXTURES_JSON}"
    with open(FIXTURES_JSON, "r", encoding="utf-8") as f:
        data = json.load(f)

    assert data.get("schema") == "viewer-gpu-fixtures-v1"
    fixtures = data.get("fixtures", [])
    assert len(fixtures) >= 1

    r01 = next((f for f in fixtures if f.get("id") == "R01"), None)
    assert r01 is not None, "Fixture R01 bắt buộc phải có trong catalog"
    assert r01["name"] == "CMNM2026 - Giay moi_BLUE - in.pdf"
    assert len(r01["expected_sha256"]) == 64
    assert int(r01["expected_size_bytes"]) == 17869243
    assert r01["page"] == 1
    assert r01["baseline_trace_id"] == "Vmug8p305-zncw82"
    assert len(r01["baseline_snapshot_sha256"]) == 64
    assert len(r01["clips"]) >= 3
    assert "metrics_baseline" in r01


def test_fixture_r01_hash_integrity_on_disk():
    with open(FIXTURES_JSON, "r", encoding="utf-8") as f:
        data = json.load(f)
    r01 = next(f for f in data["fixtures"] if f["id"] == "R01")

    # Tìm file thực tế trên đĩa
    found_path = None
    for loc in r01.get("standard_locations", []):
        p = Path(loc)
        if p.exists():
            found_path = p
            break

    if not found_path:
        pytest.skip("File PDF R01 chưa có trên máy này tại standard_locations; bỏ qua kiểm tra đĩa thực tế.")

    hasher = hashlib.sha256()
    with open(found_path, "rb") as f:
        while chunk := f.read(65536):
            hasher.update(chunk)

    actual_hash = hasher.hexdigest().lower()
    assert actual_hash == r01["expected_sha256"].lower(), (
        f"Hash của file {found_path} ({actual_hash}) không khớp expected_sha256 ({r01['expected_sha256']})"
    )
    assert found_path.stat().st_size == r01["expected_size_bytes"]


def test_summarize_metric_list_separates_unobserved():
    # Khi danh sách rỗng, status bắt buộc là unobserved và các mốc là None
    empty_summary = summarize_metric_list([])
    assert empty_summary["status"] == "unobserved"
    assert empty_summary["p50"] is None
    assert empty_summary["p95"] is None
    assert empty_summary["min"] is None
    assert empty_summary["max"] is None

    # Khi có dữ liệu, status là observed và tính đúng quantile
    sample_summary = summarize_metric_list([10.0, 20.0, 30.0, 40.0, 50.0])
    assert sample_summary["status"] == "observed"
    assert sample_summary["p50"] == 30.0
    assert sample_summary["min"] == 10.0
    assert sample_summary["max"] == 50.0


def test_analyze_run_verifies_fixture_and_criteria(tmp_path: Path):
    # Tạo run_dir giả lập với manifest và hardware
    run_dir = tmp_path / "run_test_valid"
    run_dir.mkdir()

    manifest_valid = {
        "schema_version": 1,
        "run_id": "test_run_valid",
        "created_utc": "2026-09-25T00:00:00Z",
        "fixture": {
            "id": "R01",
            "name": "CMNM2026 - Giay moi_BLUE - in.pdf",
            "path": "C:\\test\\CMNM2026.pdf",
            "sha256": "95f38cf429fe7dd7c6500043ce308fd2e87e80a2290217d428fe0c68c6098184",
            "size_bytes": 17869243,
            "page": 1,
        },
        "git": {"commit": "dummy_commit", "branch": "test", "is_dirty": False},
        "binaries": {"worker_executable": None, "pdfium_dll": None},
        "snapshot_file": None,
    }
    hardware_sample = {
        "schema_version": 1,
        "captured_utc": "2026-09-25T00:00:00Z",
        "os": {"caption": "Windows 11"},
        "cpu": {"name": "Test CPU", "number_of_logical_processors": 16},
        "memory": {"total_ram_gb": 32.0, "free_ram_gb": 16.0, "ram_tier": ">=16GB"},
        "gpus": [{"name": "RTX 3060", "driver_version": "500.0"}],
        "display": {"primary_width": 1920, "primary_height": 1080},
    }

    with open(run_dir / "manifest.json", "w", encoding="utf-8") as f:
        json.dump(manifest_valid, f)
    with open(run_dir / "hardware.json", "w", encoding="utf-8") as f:
        json.dump(hardware_sample, f)

    summary = analyze_run(run_dir, FIXTURES_JSON)
    assert summary["fixture_hash_verified"] is True
    assert summary["overall_status"] == "G0_BASELINE_CAPTURED"
    assert summary["criteria"]["G0_fixture_provenance_integrity"]["verdict"] == "PASSED"
    # Các tiêu chí chưa đo phải là unobserved
    assert summary["criteria"]["P01_compositor_warm_work_16ms"]["verdict"] == "unobserved"
    assert summary["criteria"]["P02_camera_response_33ms"]["verdict"] == "unobserved"


def test_analyze_run_rejects_corrupted_hash(tmp_path: Path):
    run_dir = tmp_path / "run_test_corrupted"
    run_dir.mkdir()

    manifest_corrupted = {
        "schema_version": 1,
        "run_id": "test_run_corrupted",
        "fixture": {
            "id": "R01",
            "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
        },
        "snapshot_file": None,
    }
    hardware_sample = {
        "schema_version": 1,
        "memory": {"ram_tier": ">=16GB"},
    }

    with open(run_dir / "manifest.json", "w", encoding="utf-8") as f:
        json.dump(manifest_corrupted, f)
    with open(run_dir / "hardware.json", "w", encoding="utf-8") as f:
        json.dump(hardware_sample, f)

    summary = analyze_run(run_dir, FIXTURES_JSON)
    assert summary["fixture_hash_verified"] is False
    assert summary["overall_status"] == "FIXTURE_HASH_MISMATCH"
    assert summary["criteria"]["G0_fixture_provenance_integrity"]["verdict"] == "FAILED"
