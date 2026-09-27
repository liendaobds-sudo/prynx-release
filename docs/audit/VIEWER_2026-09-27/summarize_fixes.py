"""Chốt số đo/artifact V27 từ output thật; không tự suy FPS hay trạng thái GUI."""
from pathlib import Path
import csv
import hashlib
import json
import math
import sys
from datetime import datetime

sys.stdout.reconfigure(encoding="utf-8")
folder = Path(__file__).resolve().parent
root = folder.parents[2]

def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            value.update(chunk)
    return value.hexdigest()

def stats(values):
    values = sorted(values)
    return {"n": len(values), "min_ms": values[0], "p50_ms": values[math.ceil(len(values)*.5)-1],
            "p95_ms": values[math.ceil(len(values)*.95)-1], "max_ms": values[-1]}

gpu = json.loads((folder / "optimized-gpu-default-final/gpu-probe.json").read_text(encoding="utf-8"))
ppe = json.loads((folder / "worker-after/worker-probe.json").read_text(encoding="utf-8"))
assert ppe["complete"] and not gpu["upload_probe_enabled"]
images = []
for run in range(3):
    for camera in range(2):
        before = folder / f"d2-before/run-{run}-camera-{camera}.rgba"
        after = folder / f"d2-after/run-{run}-camera-{camera}.rgba"
        assert digest(before) == digest(after)
        images.append({"run": run, "camera": camera, "identical": True, "sha256": digest(after)})
roi = list(csv.DictReader((folder / "roi-parity/roi-parity.csv").open()))
assert len(roi) == 12 and all(int(row["different_bytes"]) == 0 for row in roi)
gpu_first = digest(folder / "optimized-gpu-default-final/first-frame.rgba")
assert gpu_first == images[0]["sha256"]
png_hashes = {sample["png_sha256"] for run in ppe["ppe"] for sample in run["samples"]}
assert png_hashes == {"1ab7fe755cb5ebef7d15c5674ad2a0b8c358989d403c0b5258d3fda0c4fffe9b"}
baseline_manifest = json.loads((folder / "audit-manifest.json").read_text(encoding="utf-8"))
source_paths = [Path(row["path"]) for row in baseline_manifest["files"] if Path(row["path"]).suffix not in (".exe", ".pdf", ".icc")]
source_paths += [root / p for p in (
    "viewer_gpu/src/timing.rs", "viewer_gpu/src/lib.rs", "viewer_gpu/src/device.rs",
    "desktop/src-tauri/examples/viewer_audit_worker.rs",
    "desktop/src/components/workspace/nativeFallbackPolicy.ts",
)]
report = {
    "generated_at": datetime.now().astimezone().isoformat(),
    "scope": "source-auto-headless-artifact; GUI/displayed FPS unobserved by user instruction",
    "input_sha256": gpu["input_sha256"], "gpu_benchmark_exe_sha256": gpu["exe_sha256"],
    "gpu_first_frame_sha256": gpu_first,
    "warm_full_complete_ms": stats([s["completed_ms"] for s in gpu["samples"] if s["index"] > 0 and not s["partial"]]),
    "warm_partial_complete_ms": stats([s["completed_ms"] for s in gpu["samples"] if s["partial"]]),
    "cold_frame_complete_ms": gpu["samples"][0]["completed_ms"],
    "scene_wall_ms": gpu["scene_wall_ms"], "gpu_init_ms": gpu["gpu_init_ms"],
    "ppe_cold_ms": stats([r["samples"][0]["wire_request_wall_ms"] for r in ppe["ppe"]]),
    "ppe_warm_ms": stats([s["wire_request_wall_ms"] for r in ppe["ppe"] for s in r["samples"][1:]]),
    "full_image_pairs": images, "roi_pairs": len(roi), "roi_different_bytes": 0,
    "ppe_png_count": 9, "ppe_png_hashes": sorted(png_hashes),
    "source_snapshot": [{"path": str(path.relative_to(root)), "sha256": digest(path)} for path in dict.fromkeys(source_paths)],
    "limits": [
        "Đây là kernel headless, không phải HWND/displayed FPS hoặc A/B Acrobat.",
        "N nhỏ; percentile chỉ mô tả mẫu, không chứng nhận SLA P99.",
        "optimized-gpu-final là thử nghiệm staging có observer overhead, không phải đường production cuối.",
        "Không gộp timing debug chưa tối ưu với Cargo dev kernel opt-level=3.",
        "Không build/cài installer hoặc thao tác cửa sổ ứng dụng đang mở.",
    ],
}
(folder / "fixes-results.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps({key: report[key] for key in ("warm_full_complete_ms", "warm_partial_complete_ms", "cold_frame_complete_ms", "roi_pairs", "ppe_png_count")}, ensure_ascii=False))
