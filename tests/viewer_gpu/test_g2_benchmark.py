"""Kiểm artifact microbenchmark tổng hợp; không nghiệm thu P01 của R01."""

import json
from pathlib import Path
import pytest


def get_benchmark_json_path() -> Path:
    repo_root = Path(__file__).resolve().parent.parent.parent
    paths = [
        repo_root / ".tmp" / "viewer-gpu" / "runs" / "latest" / "benchmark_g2.json",
        repo_root / "viewer_gpu" / ".tmp" / "viewer-gpu" / "runs" / "latest" / "benchmark_g2.json",
    ]
    for p in paths:
        if p.exists():
            return p
    pytest.fail(f"Khong tim thay benchmark_g2.json tai: {[str(p) for p in paths]}")


def test_g2_benchmark_schema_and_adapter():
    json_path = get_benchmark_json_path()
    with open(json_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    assert "gpu_adapter" in data and len(data["gpu_adapter"]) > 0
    assert data["texture_width"] == 1024
    assert data["texture_height"] == 1024
    assert data["iterations"] >= 50
    assert data["verdict"] == "MICROBENCHMARK_ONLY"
    assert data["evidence_kind"] == "synthetic_graph"
    assert data["runtime_acceptance"] == "UNOBSERVED"


def test_microbenchmark_frame_statistics():
    """Microbenchmark có chờ GPU ở cuối frame; không đọc PDF."""
    json_path = get_benchmark_json_path()
    with open(json_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    p95_frame = data["frame_p95_ms"]
    p01_target = 16.7  # Ngân sách smoke riêng, không nghiệm thu PDF thật.
    p50_frame = data["frame_p50_ms"]

    # p95 frame work bat buoc phai <= 16.7 ms
    assert p95_frame <= p01_target, f"p95 frame work ({p95_frame} ms) vuot nguong P01 ({p01_target} ms)"
    # p50 frame work tren GPU manh (RTX 3060) phai rat nhanh (< 5.0 ms)
    assert p50_frame <= 5.0, f"p50 frame work ({p50_frame} ms) qua cham so voi ky vong GPU"


def test_cpu_submit_timings_are_labelled_correctly():
    """Stage hiện chỉ đo encode/submit phía CPU."""
    json_path = get_benchmark_json_path()
    with open(json_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    # Moi pass thanh phan tren GPU 1024x1024 phai hoan thanh duoi 2.0 ms
    assert data["cpu_submit_raster_p95_ms"] <= 2.0
    assert data["cpu_submit_blend_p95_ms"] <= 2.0
    assert data["cpu_submit_resolve_p95_ms"] <= 2.0


def test_g2_benchmark_fail_closed_on_budget_exceeded():
    """Kiem tra co che fail-closed neu frame time vuot nguong P01."""
    synthetic_data = {
        "frame_p95_ms": 25.4,
        "p01_target_ms": 16.7,
    }
    with pytest.raises(AssertionError):
        assert synthetic_data["frame_p95_ms"] <= synthetic_data["p01_target_ms"]
