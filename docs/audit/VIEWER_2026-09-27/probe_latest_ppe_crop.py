"""Đối chứng PPE CPU qua worker sẵn có, không khởi động UI hoặc build."""
from __future__ import annotations

import json
import os
from pathlib import Path
import sys

from probe_workers import ACCURATE_PIPELINE, DISPLAY_PIPELINE, TILE_VERSION, Child, checkpoint, ppe_exchange, sha256_file, stamp


def main():
    root = Path(__file__).resolve().parents[3]
    pdf = Path(r"C:\Users\Khanh Pham\Desktop\PDF\CMNM2026 - Giay moi_BLUE - in.pdf")
    exe = root / "desktop/src-tauri/target/debug/pdf-inspector.exe"
    out = Path(__file__).parent / "independent-ppe-current-crop"
    out.mkdir(exist_ok=False)
    identity = stamp(pdf)
    exe_sha = sha256_file(exe)
    report = {"pdf": str(pdf), "pdf_sha256": sha256_file(pdf), "exe": str(exe), "exe_sha256": exe_sha,
              "requested_camera": {"zoom": 7.789235591888428, "pan_x": -5021.0181, "pan_y": -2460.3643, "viewport": [1292, 733]},
              "limitations": ["CPU reference only; not GPU/GUI screenshot or an end-to-end parity measurement.",
                              "PPE region coordinates are integer: x=5021,y=2460; subpixel camera phase is not represented.",
                              "Crop covers809px of paper; remaining viewport beyond page is not included."]}
    child = Child(exe, ["--prynx-render-worker"], 60)
    try:
        hello = {"message": "hello", "request_id": "r8-cpu-reference-hello", "parent_pid": os.getpid(),
                 "nonce": "r8-cpu-reference", "expected_app_version": "2.0.4", "expected_tile_cache_version": TILE_VERSION,
                 "expected_pipeline_identity": DISPLAY_PIPELINE}
        (reply, data), elapsed = child.bounded(lambda: ppe_exchange(child, 1, hello))
        assert reply.get("ok") and not data and reply.get("worker_pid") == child.proc.pid, reply
        request = {"message": "render", "request_id": "r8-cpu-reference-current", "owner_id": "r8-cpu-reference",
                   "session_owner_id": "r8-cpu-reference", "group_key": "r8-reference", "generation": 1,
                   "purpose": "interactive", "priority": 0, "document": identity, "page": 1, "rotation": 0,
                   "raster": {"kind": "dpi", "dpi": 560.824951171875, "clip": {"x": 5021, "y": 2460, "width": 809, "height": 733}},
                   "color": {"pipeline": "accurate", "profile_id": "fogra39", "intent": "relative"},
                   "pipeline_identity": ACCURATE_PIPELINE, "soundness": "color-verified", "format": None}
        (reply, data), elapsed = child.bounded(lambda: ppe_exchange(child, 2, request))
        assert reply.get("status") == "ready" and reply.get("pipeline_identity") == ACCURATE_PIPELINE, reply
        assert data.startswith(b"\x89PNG\r\n\x1a\n"), reply
        output = out / "ppe-cpu-page1-region.png"
        output.write_bytes(data)
        report.update({"worker_pid": child.proc.pid, "request": request, "response": reply, "wall_ms": elapsed,
                       "png": str(output), "png_sha256": sha256_file(output)})
        assert stamp(pdf) == identity and sha256_file(exe) == exe_sha, "Input hoặc EXE đổi trong probe"
        checkpoint(out / "result.json", report)
        print(json.dumps(report, ensure_ascii=False, indent=2))
    finally:
        child.close()


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
