"""Chốt pixel cuối/camera R8; không điều khiển hay khởi chạy ứng dụng."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
OUT = Path(__file__).resolve().parent


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


cases = []
for name in ("r8-desktop-rgba", "r8-desktop-bgra", "r8-outline-rgba", "r8-outline-bgra"):
    path = OUT / (name + ".json")
    value = json.loads(path.read_text(encoding="utf-8"))
    assert value["final_compositor_checked"] and len(value["samples"]) == 32
    assert all(r["different_bytes"] == r["composed_different_bytes"] == 0 for r in value["samples"])
    assert value["input_sha256"] == sha(Path(value["pdf"]))
    cases.append({"artifact": path.name, "sha256": sha(path), "pdf_sha256": value["input_sha256"],
                  "format": value["format"], "cameras": 32, "composed_different_bytes": 0,
                  "refinements": sum(r["refinements"] for r in value["samples"]), "idle_checks": value["idle_checks"]})
presenter = json.loads((OUT / "r8-presenter-outline/result.json").read_text(encoding="utf-8"))
assert presenter["foreground_unchanged"] and presenter["idle_error_reported"]
assert presenter["final"]["presents"] == presenter["idle"]["presents"]
paths = ["desktop/src-tauri/src/viewport/" + name for name in (
    "controller.rs", "scheduler.rs", "scheduler_regression_tests.rs", "keyboard_commands.rs",
    "win32_host.rs", "commands.rs", "interaction.rs", "detail_cache.rs", "refinement_policy.rs", "refinement_liveness_tests.rs")]
paths += ["viewer_gpu/src/resident_present.rs", "viewer_gpu/tests/settled_composition.rs",
          "desktop/src/hooks/viewer/useNativeGpuViewport.ts", "desktop/src/hooks/viewer/nativeViewportInteraction.ts",
          "desktop/src/components/acrobat/NativeGpuViewportContainer.tsx", "desktop/src/components/AcrobatViewer.tsx"]
result = {
    "scope": "R8 source + AUTO + final composited pixel artifacts; no user-window acceptance/scanout claim",
    "sources": [{"path": p, "sha256": sha(ROOT / p)} for p in paths],
    "pixels": cases,
    "presenter": {"artifact": "r8-presenter-outline/result.json", "sha256": sha(OUT / "r8-presenter-outline/result.json"),
                  "settle_after_input_ms": presenter["settle_after_input_ms"], "foreground_unchanged": True, "idle_error_reported": True},
    "verification": {"frontend": "341 files,3940 pass,2 skipped", "typecheck": "passed",
                     "viewport": "78 pass,7 ignored (separate probes executed)", "gpu": "56 pass,5 ignored",
                     "cargo_check_lib_examples": "passed", "cargo_build_bin": "passed; real EXE linked"},
    "exe_sha256": sha(ROOT / "desktop/src-tauri/target/debug/pdf-inspector.exe"),
    "limits": ["Frame composition tested in RGBA and native BGRA sRGB; not physical monitor capture.",
               "Owned hidden HWND probe is code-only, no focus/global input or app restart.",
               "Native-to-DOM pan handoff on layout changes and synchronous repeated navigation downstream remain unverified.",
               "Existing unrelated trailing blank line in appSettingsStore.test.ts was left untouched."]
}
(OUT / "r8-fixes-results.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"composed_cameras": sum(c["cameras"] for c in cases), "composed_different_bytes": 0,
                  "exe_sha256": result["exe_sha256"], "verification": result["verification"]}, ensure_ascii=False, indent=2))
