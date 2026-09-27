"""Tổng hợp bằng chứng sau vá V27.R; không khởi chạy hoặc điều khiển app."""
from __future__ import annotations

import csv
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
OUT = Path(__file__).resolve().parent


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    pdfs = []
    for name in ("cache-fix-outline-final.json", "cache-fix-desktop-final.json"):
        path = OUT / name
        result = json.loads(path.read_text(encoding="utf-8"))
        rows = result["samples"]
        assert len(rows) == 32 and result["idle_checks"] == 3840
        assert result["recoveries"] == 0
        assert all(row["different_bytes"] == 0 for row in rows)
        assert result["input_sha256"] == sha(Path(result["pdf"]))
        pdfs.append({"artifact": name, "artifact_sha256": sha(path),
                     "pdf": result["pdf"], "input_sha256": result["input_sha256"],
                     "cameras": len(rows), "refinements": sum(row["refinements"] for row in rows),
                     "max_refinements_per_camera": max(row["refinements"] for row in rows),
                     "idle_checks": result["idle_checks"], "recoveries": 0, "different_bytes": 0})
    before_path = OUT / "roi-regression-before/roi-parity.csv"
    after_path = OUT / "roi-regression-after/roi-parity.csv"
    before = list(csv.DictReader(before_path.open()))
    after = list(csv.DictReader(after_path.open()))
    assert len(before) == len(after) == 18
    roi = []
    for old, new in zip(before, after):
        assert all(old[key] == new[key] for key in ("camera", "x", "y", "w", "h"))
        assert old["different_bytes"] == new["different_bytes"] == "0"
        roi.append({"camera": int(old["camera"]), "rect": [int(old[k]) for k in ("x", "y", "w", "h")],
                    "before": {k: int(old[k]) for k in ("roi_us", "encode_us", "coverage_bytes")},
                    "after": {k: int(new[k]) for k in ("roi_us", "encode_us", "coverage_bytes")},
                    "different_bytes": 0})
    paths = ["desktop/src-tauri/src/viewport/" + name for name in (
        "detail_cache.rs", "refinement.rs", "refinement_policy.rs", "refinement_liveness_tests.rs", "presenter.rs")]
    paths += ["viewer_gpu/src/retained_renderer.rs", "viewer_gpu/src/resident_present.rs", "viewer_gpu/tests/scene_startup.rs"]
    report = {
        "scope": "V27.R1-R4 source + auto + headless artifact; no GUI/scanout acceptance",
        "sources": [{"path": path, "sha256": sha(ROOT / path)} for path in paths],
        "icc_fogra39_sha256": sha(ROOT / "backend/app/assets/icc/FOGRA39.icc"),
        "native_test_exe_sha256": sha(ROOT / ".tmp/viewer-v27-target/debug/deps/app_lib-c877fe415894fd10.exe"),
        "gpu_test_exe_sha256": sha(ROOT / "viewer_gpu/target/debug/deps/viewer_gpu-44c12d49b0845e83.exe"),
        "verified_test_results": {"viewport": {"passed":54,"ignored":6,"gui_tests_explicitly_excluded":9},
            "viewer_gpu_suite": {"passed":49,"ignored":5}, "render_worker": {"passed":53,"ignored":9},
            "ignored_probes_run_separately": ["PDF liveness, outline + Desktop", "18 ROI pixel parity", "PPE RGB/late-fallback crop/rotation"],
            "cargo_check_lib_examples": "passed", "golden_updates": 0},
        "pdf_liveness": pdfs, "roi_pairs": roi,
        "roi_csv_sha256": {"before": sha(before_path), "after": sha(after_path)},
        "notes": ["Timings are single before/after headless kernel samples, not displayed FPS.",
                  "PDF liveness harness uses production policy/cache/Refiner, not native HWND surface or GPU batch scheduler.",
                  "Scissor parity has a separate 123-layer GPU test, including fractional pan, rotation and shear.",
                  "Native app binary/session changed externally during work; no app-control or restart command was issued.",
                  "No cap on workers/quality/cache entry count; existing RAM/VRAM byte budget retained."],
    }
    target = OUT / "cache-regression-fixes-results.json"
    target.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"pdf_liveness": pdfs, "roi_pairs": len(roi), "tests": report["verified_test_results"]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
