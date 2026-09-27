"""Chốt bằng chứng log + probe cache, không chạm ứng dụng đang chạy."""
from __future__ import annotations

from collections import Counter
import hashlib
import json
from pathlib import Path
import subprocess

import analyze_log as audit

ROOT = Path(__file__).resolve().parents[3]
OUT = Path(__file__).resolve().parent


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    # Bằng chứng này thuộc snapshot LỖI trước vá. Không chạy probe binary cũ
    # rồi gắn hash source mới và vô tình báo rằng bản sửa vẫn có lỗi.
    baseline_cache = "f19912525414fb5928cd87ce702dc4ab9fa0b31d11f000915898fcd1e945e2c8"
    if digest(ROOT / "desktop/src-tauri/src/viewport/detail_cache.rs") != baseline_cache:
        raise SystemExit("Source đã đổi sau baseline; chạy các regression/liveness tests mới, không ghi đè bằng chứng trước vá.")
    records, snapshot = audit.read_snapshot(ROOT / ".tmp/render-diagnostics/PrynX_RenderPerf.log", 17540)
    # Hai cửa sổ cố định của phiên người dùng, không đuổi theo vòng lặp đang append.
    heavy = [r for r in records if 1790464438005 <= r.event_ms <= 1790464443575]
    idle = [r for r in records if 1790464610300 <= r.event_ms <= 1790464854349]
    heavy_detail = [r for r in heavy if r.event == "GPU_SCENE_REFINE" and not r.data["overview"] and not r.data["partial"]]
    heavy_tiny = [r for r in heavy if r.event == "GPU_SCENE_REFINE" and (r.data["raster_w"], r.data["raster_h"]) == (3, 5)]
    idle_refines = [r for r in idle if r.event == "GPU_SCENE_REFINE"]
    idle_frames = [r for r in idle if r.event == "GPU_FRAME_TIMING"]
    assert len(idle_refines) == 11556
    assert {(r.data["raster_w"], r.data["raster_h"]) for r in idle_refines} == {(12, 3)}
    assert not [r for r in idle if r.event == "GPU_INPUT_RECEIVED"]
    assert {r.data["entries"] for r in idle if r.event == "GPU_DETAIL_CACHE"} == {123}
    assert len(heavy_detail) == 6 and len(heavy_tiny) == 31
    probe = subprocess.run(
        [str(ROOT / ".tmp/viewer-v27-cache-repro.exe")], cwd=ROOT,
        capture_output=True, text=True, encoding="utf-8", timeout=20,
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
    assert probe.returncode == 0, probe.stderr
    assert "integer_control converged=true steps=2" in probe.stdout
    assert "fractional_pan converged=false repeated_region_after_insert=[0, 0, 3, 5]" in probe.stdout
    assert "same_origin_small_crop retained_full=false entries=1 bytes=60" in probe.stdout
    sources = [
        "desktop/src-tauri/src/viewport/detail_cache.rs",
        "desktop/src-tauri/src/viewport/presenter.rs",
        "desktop/src-tauri/src/viewport/refinement.rs",
        "viewer_gpu/src/retained_renderer.rs", "viewer_gpu/src/resident_present.rs",
        "docs/audit/VIEWER_2026-09-27/repro_detail_cache_convergence.rs",
    ]
    prior = json.loads((OUT / "fixes-results.json").read_text(encoding="utf-8"))
    evidence = {}
    for r in records:
        if r.line == snapshot["selected_host"]["line"] or r.event in ("viewer-render-source", "GPU_SCENE_COMPILE", "GPU_SCENE_WIRE", "GPU_SCENE_READY"):
            evidence[r.line] = r.raw
    for r in heavy:
        if r.event in ("GPU_SCENE_REFINE", "GPU_DETAIL_CACHE", "GPU_SCENE_REFINE_CANCEL", "ui-long-task"):
            evidence[r.line] = r.raw
    for r in idle[:12] + idle[-12:]:
        evidence[r.line] = r.raw
    result = {
        "scope": "diagnosis_only; no application changes/control/restart; no scanout assertion",
        "snapshot": snapshot,
        "running_binary_sha256": digest(ROOT / "desktop/src-tauri/target/debug/pdf-inspector.exe"),
        "sources": [{"path": path, "sha256": digest(ROOT / path)} for path in sources],
        "prior_result_present": bool(prior),
        "heavy_window_ms": [1790464438005, 1790464443575],
        "heavy_identity": "Giay moi_BLUE - in.pdf on Desktop, NOT the outlined test fixture",
        "heavy_detail_encode_ms": audit.summary(r.data["encode_us"] / 1000 for r in heavy_detail),
        "heavy_3x5_encode_ms": audit.summary(r.data["encode_us"] / 1000 for r in heavy_tiny),
        "heavy_3x5_coverage_bytes": sorted({r.data["coverage_bytes"] for r in heavy_tiny}),
        "idle_window_ms": [1790464610300, 1790464854349],
        "idle_identity": "Another document, page 2/revision 12; not the Giay moi sample",
        "idle_counts": dict(Counter(r.event for r in idle)),
        "idle_cache_actions": dict(Counter(r.data["action"] for r in idle if r.event == "GPU_DETAIL_CACHE")),
        "idle_cache_entries": 123,
        "idle_frame_cpu_ms": audit.summary((r.data["acquire_us"] + r.data["encode_submit_us"] + r.data["call_present_us"]) / 1000 for r in idle_frames),
        "probe_stdout": probe.stdout,
        "probe_stderr": probe.stderr,
        "limits": [
            "Probe uses current cache source and existing compiled dependencies, not the running process internals.",
            "Fractional matrix is a synthetic reproducer; native logs round pan and omit exact ROI coordinates.",
            "ready_us/request_age_us measures age of last FrameRequest, NOT individual refinement duration.",
            "No exact raster proof or scanout capture for the live reported blurry region.",
            "Synthetic iteration limit32 is a diagnostic bound, not a proposed production cap.",
        ],
    }
    (OUT / "cache-regression-evidence.log").write_text("\n".join(f"L{line}: {evidence[line]}" for line in sorted(evidence)) + "\n", encoding="utf-8")
    (OUT / "cache-regression-diagnosis.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"host_pid": snapshot["selected_host"]["pid"], "heavy_detail_encode_ms": result["heavy_detail_encode_ms"], "heavy_3x5_encode_ms": result["heavy_3x5_encode_ms"], "idle_counts": result["idle_counts"], "source_probe": probe.stdout}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
