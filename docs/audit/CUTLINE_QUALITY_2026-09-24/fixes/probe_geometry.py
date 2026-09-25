"""Đối chứng core trên nguồn bất biến, không sửa source production/PDF đầu vào."""
from __future__ import annotations

import argparse
import ast
import copy
from dataclasses import asdict
import hashlib
import json
from pathlib import Path
import runpy
import subprocess
import sys
import time
import types
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[4]
HERE = Path(__file__).parent
sys.path[:0] = [str(ROOT / "backend"), str(ROOT / "backend/tests")]
import app.workers.cutline_cubic_simplify as cubic


def head_source(relative):
    return subprocess.check_output(["git", "show", "HEAD:" + relative], cwd=ROOT).decode("utf-8")


def quality():
    previous = runpy.run_path(str(HERE.parent / "geometry/probe.py"))
    # CUT24.04 đổi live fitter song song. Cố định fixture theo engine HEAD lúc audit.
    engine = previous["engine"]
    parsed = ast.parse(head_source("backend/app/workers/sticker_engine.py"))
    function = next(node for node in parsed.body if isinstance(node, ast.FunctionDef)
                    and node.name == "_fit_alpha_live_tuned_paths")
    namespace = dict(engine.__dict__)
    exec(compile(ast.Module(body=[function], type_ignores=[]), "<audit-live-baseline>", "exec"), namespace)
    with patch.object(engine, function.name, namespace[function.name]):
        result = {"gate": previous["hard_gate"](),
                  "gate_safe": previous["hard_gate"](scale=3.),
                  "seam": previous["seam"](),
                  "span": previous["span_limit"]()}
    destination = HERE / "geometry_after.json"
    destination.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(destination, flush=True)
    print(json.dumps(result), flush=True)


def capture():
    from app.workers.sticker_engine import StickerEngine
    captures = []
    def record(groups, **options):
        captures.append({"groups": copy.deepcopy(groups), "options": options})
        count = sum(len(r) for g in groups for r in [g["exterior"], *g.get("interiors", [])])
        return groups, dict(before_segments=count, after_segments=count, changed=False, maximum_error_bound_mm=0.)
    source = ROOT / "test/Binder2.pdf"
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    with patch.object(cubic, "simplify_cubic_path_groups", record):
        StickerEngine(dpi=300).process_pdf(str(source), "", _page_subset=[11],
            cut_mode="original", offset_mm=2., bleed_mm=0., corner_style="preserve",
            curve_tension=50., remove_white_bg=True, shape_mode="auto_safe",
            alpha_corner_policy="adaptive", cutline_denoise=30., cutline_simplify_mm=.1,
            draw_cut_contour=True, fill_holes=True)
    assert captures and digest == hashlib.sha256(source.read_bytes()).hexdigest()
    result = {"source_sha256": digest, "captures": captures}
    destination = HERE / "core_capture_p12.json"
    destination.write_text(json.dumps(result), encoding="utf-8")
    print(destination, [sum(len(r) for g in row["groups"] for r in [g["exterior"], *g.get("interiors", [])]) for row in captures], flush=True)


def core(baseline=False):
    saved = {}
    try:
        if baseline:
            # Đổi module chỉ trong process probe, không chép đè file production.
            for short in ("cutline_fair_seed", "cutline_fair_simplify", "cutline_global_simplify", "cutline_cubic_simplify"):
                name = "app.workers." + short
                saved[name] = sys.modules.get(name)
                module = types.ModuleType(name)
                module.__file__ = str(ROOT / ("backend/app/workers/" + short + ".py"))
                sys.modules[name] = module
                exec(compile(head_source("backend/app/workers/" + short + ".py"), "<audit-core-before>", "exec"), module.__dict__)
        active = sys.modules["app.workers.cutline_cubic_simplify"]
        captured = json.loads((HERE / "core_capture_p12.json").read_text(encoding="utf-8"))
        records = []
        started, cpu_started = time.perf_counter(), time.process_time()
        for record in captured["captures"]:
            groups, stats = active.simplify_cubic_path_groups(record["groups"], **record["options"])
            records.append({"groups": groups, "stats": stats})
        result = {"baseline": baseline, "seconds": time.perf_counter()-started,
                  "cpu_seconds": time.process_time()-cpu_started, "records": records}
        label = "before" if baseline else "after"
        destination = HERE / ("core_p12_" + label + ".json")
        destination.write_text(json.dumps(result), encoding="utf-8")
        print(json.dumps({key: value for key, value in result.items() if key != "records"}), flush=True)
        print(json.dumps([row["stats"] for row in records]), flush=True)
    finally:
        for name, module in saved.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("quality", "capture", "core"))
    parser.add_argument("--baseline", action="store_true")
    args = parser.parse_args()
    if args.mode == "core":
        core(args.baseline)
    else:
        globals()[args.mode]()
