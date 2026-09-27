"""Trích xuất và tổng hợp báo cáo hiệu năng baseline của Viewer GPU từ run directory.

Tuân thủ nghiêm ngặt quy tắc tại §7 và §12 của KE_HOACH_TRIEN_KHAI_PPE_VIEWER_GPU_2026-09-25.md:
- Phân biệt rõ ràng giữa các metric quan sát được (observed) và metric chưa quan sát (unobserved).
- Không tự ý điền số 0ms hoặc ngụy tạo pass khi thiếu dữ liệu mốc thời gian.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
from typing import Any, Dict, List, Optional


def load_json(path: Path) -> Any:
    if not path.exists():
        raise FileNotFoundError(f"Không tìm thấy file: {path}")
    with open(path, "r", encoding="utf-8-sig") as f:
        return json.load(f)


def calculate_quantile(values: List[float], q: float) -> Optional[float]:
    if not values:
        return None
    sorted_v = sorted(values)
    k = (len(sorted_v) - 1) * q
    f = int(k)
    c = f + 1
    if c < len(sorted_v):
        return round(sorted_v[f] + (k - f) * (sorted_v[c] - sorted_v[f]), 2)
    return round(sorted_v[f], 2)


def summarize_metric_list(values: List[float]) -> Dict[str, Any]:
    if not values:
        return {
            "status": "unobserved",
            "count": 0,
            "min": None,
            "p50": None,
            "p95": None,
            "max": None,
        }
    return {
        "status": "observed",
        "count": len(values),
        "min": round(min(values), 2),
        "p50": calculate_quantile(values, 0.5),
        "p95": calculate_quantile(values, 0.95),
        "max": round(max(values), 2),
    }


def analyze_run(run_dir: Path, fixtures_path: Path) -> Dict[str, Any]:
    manifest_file = run_dir / "manifest.json"
    hardware_file = run_dir / "hardware.json"

    manifest = load_json(manifest_file)
    hardware = load_json(hardware_file)
    fixtures_data = load_json(fixtures_path)

    fixture_id = manifest.get("fixture", {}).get("id", "R01")
    fixture_def = next(
        (f for f in fixtures_data.get("fixtures", []) if f.get("id") == fixture_id),
        None,
    )
    if not fixture_def:
        raise ValueError(f"Không tìm thấy định nghĩa fixture '{fixture_id}' trong {fixtures_path}")

    # Kiểm tra tính toàn vẹn hash của fixture
    actual_hash = manifest.get("fixture", {}).get("sha256", "").lower()
    expected_hash = fixture_def.get("expected_sha256", "").lower()
    hash_matched = bool(actual_hash and actual_hash == expected_hash)

    # Đọc snapshot log nếu được chỉ định
    snapshot_path_str = manifest.get("snapshot_file")
    snapshot_records: List[Dict[str, Any]] = []
    if snapshot_path_str:
        snap_path = Path(snapshot_path_str)
        if snap_path.exists():
            with open(snap_path, "r", encoding="utf-8", errors="ignore") as f:
                for line in f:
                    line = line.strip()
                    if line.startswith("{") and line.endswith("}"):
                        try:
                            snapshot_records.append(json.loads(line))
                        except json.JSONDecodeError:
                            pass

    # Thu thập các mốc thời gian từ trace records (nếu có)
    ipc_sends: List[float] = []
    ppe_renders: List[float] = []
    worker_totals: List[float] = []
    encode_pngs: List[float] = []
    fe_requests: List[float] = []

    for rec in snapshot_records:
        if "ipc_send_ms" in rec:
            ipc_sends.append(float(rec["ipc_send_ms"]))
        if "ppe_render_ms" in rec:
            ppe_renders.append(float(rec["ppe_render_ms"]))
        if "worker_total_ms" in rec:
            worker_totals.append(float(rec["worker_total_ms"]))
        if "encode_png_ms" in rec:
            encode_pngs.append(float(rec["encode_png_ms"]))
        if "total_ms" in rec and rec.get("message") == "render":
            worker_totals.append(float(rec["total_ms"]))

    # Nếu chưa có file snapshot log trong run hiện tại, trích xuất baseline tham chiếu từ fixtures.json
    baseline_ref = fixture_def.get("metrics_baseline", {})

    metrics_observed = {
        "ipc_send_ms": summarize_metric_list(ipc_sends),
        "ppe_render_ms": summarize_metric_list(ppe_renders),
        "worker_total_ms": summarize_metric_list(worker_totals),
        "encode_png_ms": summarize_metric_list(encode_pngs),
        "frontend_request_ms": summarize_metric_list(fe_requests),
    }

    # Bảng đánh giá các tiêu chí theo §6
    # G0.1a chỉ kiểm tra provenance, fixture integrity và môi trường; các tiêu chí runtime GPU đánh dấu unobserved
    criteria_eval = {
        "P01_compositor_warm_work_16ms": {
            "target": "p95 <= 16.7ms",
            "verdict": "unobserved",
            "reason": "Chưa chạy vòng compositor native wgpu/D3D12",
        },
        "P02_camera_response_33ms": {
            "target": "input -> present p95 <= 33ms",
            "verdict": "unobserved",
            "reason": "Chưa có native viewport presenter",
        },
        "P03_new_viewport_warm_100ms": {
            "target": "target accepted -> present p95 <= 100ms",
            "verdict": "unobserved",
            "reason": "Renderer GPU chưa triển khai (đang ở G0)",
        },
        "P04_last_input_stop_sharp_150ms": {
            "target": "last wheel -> sharp present p95 <= 150ms",
            "verdict": "unobserved",
            "reason": "Cần đo vòng lặp hoàn chỉnh tại G3",
        },
        "P07_pipeline_continuity": {
            "target": "0 blank frame, 0 seam, 0 commit sai revision",
            "verdict": "unobserved",
            "reason": "Chưa kích hoạt viewport surface",
        },
        "G0_fixture_provenance_integrity": {
            "target": "Khớp SHA-256 fixture R01 và có đầy đủ hardware/binary provenance",
            "verdict": "PASSED" if hash_matched else "FAILED",
            "reason": "SHA-256 R01 khớp 100% mỏ neo quy định" if hash_matched else "Sai lệch mã băm PDF",
        },
    }

    summary = {
        "schema_version": 1,
        "run_id": manifest.get("run_id"),
        "fixture_id": fixture_id,
        "fixture_hash_verified": hash_matched,
        "hardware_tier": hardware.get("memory", {}).get("ram_tier"),
        "metrics_observed": metrics_observed,
        "metrics_baseline_reference": baseline_ref,
        "criteria": criteria_eval,
        "overall_status": "G0_BASELINE_CAPTURED" if hash_matched else "FIXTURE_HASH_MISMATCH",
    }

    summary_file = run_dir / "summary.json"
    with open(summary_file, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2, ensure_ascii=False)

    return summary


def main():
    parser = argparse.ArgumentParser(description="Tổng hợp baseline Viewer GPU")
    parser.add_argument("--run-dir", type=Path, required=True, help="Đường dẫn thư mục run (.tmp/viewer-gpu/runs/...)")
    parser.add_argument("--fixtures-file", type=Path, default=None, help="Đường dẫn file fixtures.json")

    args = parser.parse_args()
    root_dir = Path(__file__).resolve().parents[2]
    fixtures_file = args.fixtures_file or (root_dir / "tests" / "viewer_gpu" / "fixtures.json")

    summary = analyze_run(args.run_dir, fixtures_file)

    print("=" * 60)
    print(f"BÁO CÁO TỔNG HỢP BASELINE VIEWER GPU — RUN: {summary['run_id']}")
    print("=" * 60)
    print(f"Fixture: {summary['fixture_id']} | Verified: {summary['fixture_hash_verified']}")
    print(f"RAM Tier: {summary['hardware_tier']}")
    print("-" * 60)
    print("ĐÁNH GIÁ TIÊU CHÍ (CRITERIA):")
    for k, v in summary["criteria"].items():
        print(f"  [{v['verdict']:<10}] {k}: {v['reason']}")
    print("-" * 60)
    print(f"Trạng thái tổng: {summary['overall_status']}")
    print(f"File kết quả: {args.run_dir / 'summary.json'}")
    print("=" * 60)

    if summary["overall_status"] != "G0_BASELINE_CAPTURED":
        sys.exit(1)


if __name__ == "__main__":
    main()
