"""Lưu chứng cứ R5/R6 từ phiên báo tệ hơn, không gửi input hoặc gọi GUI."""
import hashlib
import json
from pathlib import Path

import analyze_log as audit

ROOT = Path(__file__).resolve().parents[3]
OUT = Path(__file__).resolve().parent


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


# Windows đã tái dùng PID20492 sau rebuild; khóa cả epoch, không lấy phiên mới.
records, snapshot = audit.read_snapshot(ROOT / ".tmp/render-diagnostics/PrynX_RenderPerf.log", 20492, 1790467234736)
events = {"GPU_DIAG_NATIVE_POINTER", "GPU_DIAG_NATIVE_TOOL", "GPU_SCENE_READY", "GPU_SCENE_COMPILE", "viewer-render-source", "ui-long-task"}
selected = [r for r in records if r.event in events]
premature = [r for r in records if r.event == "GPU_SCENE_REFINE" and r.data.get("revision") == 4 and r.event_ms < 1790467318626]
assert premature and premature[0].data["draws"] == 382
selected += premature
ups = [r for r in records if r.event == "GPU_DIAG_NATIVE_POINTER" and r.data.get("action") == "up"]
interrupted = [r for r in ups if not r.data["dragging"] and (r.data["last_x"], r.data["last_y"]) != (r.data["x"], r.data["y"])]
assert len(interrupted) == 2
assert any(r.data["dragging"] for r in ups)
source_paths = ["desktop/src-tauri/src/viewport/" + name for name in ("win32_host.rs", "commands.rs", "presenter.rs")]
result = {
    "snapshot": snapshot,
    "scope": "before-patch runtime log / after-patch source and code-only tests; not post-patch GUI acceptance",
    "pan_ups": [{"line": r.line, "epoch_ms": r.event_ms, **r.data} for r in ups],
    "premature_revision4_frames": [{"line": r.line, "epoch_ms": r.event_ms, **r.data} for r in premature],
    "page2_ready_ms": 1790467318626,
    "sources_after": [{"path": p, "sha256": sha(ROOT / p)} for p in source_paths],
    "native_test_exe_sha256": sha(ROOT / ".tmp/viewer-v27-target/debug/deps/app_lib-c877fe415894fd10.exe"),
    "verification": {"red_before": ["tool_ipc_during_captured_pan_does_not_cut_off_motion", "scene_load_never_relabels_old_renderer_and_rejects_stale_commit"],
                     "lifecycle_after": "3 passed", "viewport_after": "57 passed / 6 ignored; 9 GUI tests excluded", "cargo_check_lib": "passed"},
}
(OUT / "input-scene-recheck.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
(OUT / "input-scene-recheck.evidence.log").write_text("\n".join(f"L{r.line}: {r.raw}" for r in sorted(selected, key=lambda r: r.line)) + "\n", encoding="utf-8")
print(json.dumps({"interrupted_pan": len(interrupted), "old_renderer_frames_before_page2_ready": len(premature), "verification": result["verification"]}, ensure_ascii=False))
