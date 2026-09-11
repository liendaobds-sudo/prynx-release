"""Đo session PPE thật; không sửa PDF, cấu hình app hay source production."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import statistics
import sys
import time

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "backend"))

import pdfcompare_native
import pikepdf
from app.core.print_engine.facade import open_softproof_session
from app.core.system_memory import read_memory_status_mb


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def snapshot(paths: list[Path]) -> dict:
    return {str(path): digest(path) for path in paths}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pdf", nargs=2, action="append", required=True)
    parser.add_argument("--pages", nargs="+", type=int, default=[1, 2, 3, 4])
    parser.add_argument("--repeats", type=int, default=4)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    sources = {label: Path(path).resolve() for label, path in args.pdf}
    production = [ROOT / name for name in [
        "print_engine/src/pdf.rs", "print_engine/src/content/interp.rs",
        "print_engine/src/session.rs", "print_engine/src/page.rs",
        "backend/app/workers/sticker_engine.py",
        "desktop/src-tauri/src/pdf_engine/render_worker.rs",
        "desktop/src/hooks/viewer/useTileRenderer.ts",
    ]]
    caps = pdfcompare_native.ppe_capabilities()
    library = next(Path(pdfcompare_native.__file__).parent.glob("*.pyd"))
    report = {
        "scope": "native-session-only; excludes UI, IPC, PNG encode, OS-cold and HTTP admission",
        "utc_started": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "machine": {"platform": platform.platform(), "python": sys.version, "logical_cpu": os.cpu_count(), "memory_mib_start": read_memory_status_mb()},
        "native": {"path": str(library), "sha256": digest(library), "build_identity": caps.get("build_identity"), "source_revision": caps.get("source_revision"), "source_dirty": caps.get("source_dirty"), "build_profile": caps.get("build_profile")},
        "source_hashes_before": snapshot(list(sources.values())),
        "production_hashes_before": snapshot(production),
        "config": {"dpi": 96, "profile": "fogra39", "intent": 1, "simulate_overprint": False, "optional_content_usage": "view", "render_annotations": True, "cache_budget": "facade hardware default", "render_budget": "facade hardware default"},
        "documents": {}, "samples": [],
    }
    sessions = {}
    generations = {label: 0 for label in sources}
    args.output.parent.mkdir(parents=True, exist_ok=True)

    def checkpoint() -> None:
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    try:
        for label, path in sources.items():
            with pikepdf.Pdf.open(path) as pdf:
                page_info = []
                for index, page in enumerate(pdf.pages, 1):
                    operations = list(pikepdf.parse_content_stream(page))
                    top_forms = []
                    for name, obj in page.Resources.get("/XObject", {}).items():
                        if obj.get("/Subtype") == "/Form":
                            top_forms.append({"name": str(name), "id": obj.objgen, "decoded_bytes": len(obj.read_bytes())})
                    page_info.append({"page": index, "top_Do": sum(str(op.operator) == "Do" for op in operations), "MediaBox": list(map(float, page.MediaBox)), "forms": top_forms})
            owner = f"audit-session:{label}"
            started = time.perf_counter()
            sessions[label] = open_softproof_session(str(path), owner_id=owner, optional_content_usage="view", render_annotations=True)
            report["documents"][label] = {"path": str(path), "bytes": path.stat().st_size, "page_info": page_info, "session_open_wall_ms": (time.perf_counter() - started) * 1000, "session": sessions[label].open_info}
        checkpoint()

        for page in args.pages:
            for repeat in range(args.repeats):
                # Đảo thứ tự xen kẽ để không luôn đo một nhánh sau khi máy nóng.
                order = list(sources) if repeat % 2 == 0 else list(reversed(sources))
                for label in order:
                    generations[label] += 1
                    before_cpu = time.process_time()
                    started = time.perf_counter()
                    result = sessions[label].render(
                        owner_id=f"audit-session:{label}", request_generation=generations[label],
                        pdf_path=str(sources[label]), cmyk_profile_id="fogra39", render_intent=1,
                        page_num=page, dpi=96, simulate_overprint=False,
                    )
                    wall = (time.perf_counter() - started) * 1000
                    cpu = (time.process_time() - before_cpu) * 1000
                    row = {"document": label, "page": page, "repeat": repeat, "state": "first-render-in-session" if repeat == 0 else "warm-resource-reraster", "wall_ms": wall, "cpu_ms": cpu, "timings_ms": result["timings_ms"], "cache": result["cache"], "width": result["width"], "height": result["height"], "rgb_sha256": hashlib.sha256(result["rgb"]).hexdigest(), "ink_unsound": result["ink_unsound"], "degraded": result["degraded"]}
                    report["samples"].append(row)
                    print(json.dumps({k: row[k] for k in ["document", "page", "repeat", "wall_ms", "cpu_ms", "timings_ms", "ink_unsound"]}, ensure_ascii=False), flush=True)
                    checkpoint()
        report["summary"] = []
        for label in sources:
            for page in args.pages:
                rows = [r for r in report["samples"] if r["document"] == label and r["page"] == page]
                warm = rows[1:]
                report["summary"].append({"document": label, "page": page, "first_ms": rows[0]["wall_ms"], "warm_n": len(warm), "warm_median_ms": statistics.median(r["wall_ms"] for r in warm) if warm else None, "warm_range_ms": [min(r["wall_ms"] for r in warm), max(r["wall_ms"] for r in warm)] if warm else None, "warm_raster_median_ms": statistics.median(r["timings_ms"]["raster"] for r in warm) if warm else None, "stable_rgb": len({r["rgb_sha256"] for r in rows}) == 1, "clean": not any(r["ink_unsound"] for r in rows)})
    finally:
        for label, session in sessions.items():
            session.close(f"audit-session:{label}")
        report["source_hashes_after"] = snapshot(list(sources.values()))
        report["production_hashes_after"] = snapshot(production)
        report["machine"]["memory_mib_end"] = read_memory_status_mb()
        checkpoint()
    assert report["source_hashes_before"] == report["source_hashes_after"]
    assert report["production_hashes_before"] == report["production_hashes_after"]
    print(json.dumps({"summary": report["summary"]}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
