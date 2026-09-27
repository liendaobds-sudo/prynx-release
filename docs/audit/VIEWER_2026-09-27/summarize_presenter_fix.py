"""Chốt A/B cùng Presenter thật; không suy thời gian surface ẩn thành FPS."""
from collections import defaultdict
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
OUT = Path(__file__).resolve().parent


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def compact(path):
    value = json.loads(path.read_text(encoding="utf-8"))
    final = value["final"]
    assert value["foreground_unchanged"] and value["production_presenter"]
    assert final["presents"] == value["idle"]["presents"]
    assert final["refinements"] == value["idle"]["refinements"]
    return {"artifact": str(path.relative_to(OUT)), "artifact_sha256": sha(path),
            "mode": value["ab_mode"], "input_sha256": value["input_sha256"],
            "exe_sha256": value.get("exe_sha256"),
            "stationary_ms": value["stationary_ms"], "input_duration_ms": value["input_duration_ms"],
            "settle_after_input_ms": value["settle_after_input_ms"],
            "presenter_cpu_ms": final["presenter_cpu_us"] / 1000,
            "presents": final["presents"], "refinements": final["refinements"],
            "idle_error_reported": value.get("idle_error_reported")}


controlled = [compact(p) for p in sorted(OUT.glob("presenter-ab-*/result.json"))]
final = [compact(p) for p in sorted(OUT.glob("presenter-final-*/result.json"))]
assert len(controlled) == 6 and len(final) == 4
assert len({v["exe_sha256"] for v in final}) == 1 and final[0]["exe_sha256"]
assert all(v["idle_error_reported"] for v in final)
groups = defaultdict(list)
for row in final:
    groups[row["input_sha256"]].append(row)
for rows in groups.values():
    assert len(rows) == 2
    by_mode = {r["mode"]: r for r in rows}
    assert by_mode["cooperative"]["settle_after_input_ms"] < by_mode["legacy"]["settle_after_input_ms"]
    assert by_mode["cooperative"]["stationary_ms"] < by_mode["legacy"]["stationary_ms"]
paths = ["desktop/src-tauri/src/viewport/presenter.rs", "desktop/src-tauri/src/viewport/presenter_runtime_tests.rs"]
report = {
    "scope": "V27.R7: actual Presenter/refiner/GPU-credit/compositor on owned invisible surface, not live user HWND/scanout",
    "controlled_desktop_runs": controlled,
    "final_same_binary_two_documents": final,
    "sources_after": [{"path": p, "sha256": sha(ROOT / p)} for p in paths],
    "native_test_exe_sha256": sha(ROOT / ".tmp/viewer-v27-target/debug/deps/app_lib-c877fe415894fd10.exe"),
    "live_baseline_evidence_sha256": sha(OUT / "presenter-live-before.json"),
    "verify": {"viewport_tests_passed": 57, "viewport_tests_ignored": 7,
               "legacy_probe_failures_expected": True, "gpu_idle_error_without_new_input": "passed",
               "cargo_check_lib_examples": "passed", "user_application_control_or_global_input": False,
               "owned_hidden_hwnd_surface_test": True},
    "limits": ["120 synthetic cameras use absolute16.667ms deadlines; timings start after scene/renderer preparation.",
               "Settled means actual Presenter completed latest camera, drained refine credit and presented; not physical monitor scanout.",
               "Desktop runs improve Presenter CPU; outline final run uses more active CPU (906.25->1093.75ms) to finish sooner.",
               "No worker/quality/cache caps or ICC changes. Sub16GiB hardware timing unmeasured.",
               "Initial presenter-before/after probes had cadence drift and separate builds; kept but excluded from acceptance.",
               "ROI fragmentation and FE camera-mirror fanout remain separate follow-up work, not silently changed."],
}
(OUT / "presenter-fix-results.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"final_runs": final, "verify": report["verify"]}, ensure_ascii=False, indent=2))
