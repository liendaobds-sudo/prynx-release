"""Đo live fitter HEAD/current trên cùng flower, không ghi source production."""
from __future__ import annotations

import ast
from dataclasses import asdict
import hashlib
import json
import math
from pathlib import Path
import subprocess
import sys
import time
import types

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "backend"))
import numpy as np
import scipy.interpolate  # noqa: F401
from shapely.geometry import Polygon
from app.workers import sticker_engine as engine
from app.workers.cutline_machine_path import analyze_machine_path, cubic_segments_from_tuples


def main():
    relative = "backend/app/workers/sticker_engine.py"
    head = subprocess.check_output(["git", "show", "HEAD:" + relative], cwd=ROOT).decode("utf-8")
    parsed = ast.parse(head)
    node = next(node for node in parsed.body if isinstance(node, ast.FunctionDef)
                and node.name == "_fit_alpha_live_tuned_paths")
    namespace = dict(engine.__dict__)
    exec(compile(ast.Module(body=[node], type_ignores=[]), "<HEAD-live-fitter>", "exec"), namespace)
    old = namespace[node.name]
    new = engine._fit_alpha_live_tuned_paths
    output = {
        "scope": "N=1/lượt, HEAD function namespace riêng và dependency hiện tại chung; import scipy ngoài timer; không HTTP/Tauri/PDF",
        "head_commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT).decode().strip(),
        "current_engine_sha256": hashlib.sha256((ROOT / relative).read_bytes()).hexdigest(),
        "records": [],
    }
    for lobes, radius, amplitude in ((12, 20., 5.), (3, 8., 1.)):
        theta = np.linspace(0., 2. * math.pi, 400, endpoint=False)
        radii = radius + amplitude * np.cos(lobes * theta)
        reference = Polygon(np.column_stack((radii * np.cos(theta), radii * np.sin(theta))) * engine._PT_PER_MM)
        options = dict(total_offset_pts=0., mm_to_pts=engine._PT_PER_MM,
                       source_pixel_mm=25.4 / 300., cutline_smoothness=50,
                       cutline_fidelity=50, curve_tension=0)
        row = {"fixture": f"flower{lobes}", "points": 400,
               "radius_mm": radius, "amplitude_mm": amplitude, "options": options}
        for label, function in (("before", old), ("after", new)):
            started = time.perf_counter()
            result = function(reference, reference, **options)
            wall = time.perf_counter() - started
            geometry, paths, budget = result
            metrics = [asdict(analyze_machine_path(
                cubic_segments_from_tuples(path), mm_to_units=engine._PT_PER_MM,
                smooth_join_threshold_degrees=1., short_segment_threshold_mm=.25,
                samples_per_cubic=128,
            )) for path in paths]
            row[label] = {
                "seconds": wall, "segments": sum(len(path) for path in paths),
                "maximum_curvature_jump_per_mm": max(m["maximum_curvature_jump_per_mm"] or 0. for m in metrics),
                "maximum_join_angle_degrees": max(m["maximum_join_angle_degrees"] or 0. for m in metrics),
                "measured_sampled_hausdorff_mm": reference.boundary.hausdorff_distance(geometry.boundary) / engine._PT_PER_MM,
                "budget_mm": budget, "metrics": metrics,
                "control_points_sha256": hashlib.sha256(json.dumps(paths).encode()).hexdigest(),
            }
            print(json.dumps({"fixture": row["fixture"], "phase": label,
                              **{key: value for key, value in row[label].items() if key != "metrics"}}), flush=True)
        # Một lượt đếm riêng, không dùng thời gian wrapper làm benchmark wall.
        counts, durations = {}, {}
        traced = dict(engine.__dict__)
        for name in ("_smooth_closed_ring_source_scale", "_remove_short_alpha_anchor_edges",
                     "_periodic_smoothing_spline_segments", "_catmull_rom_bezier_segments",
                     "_alpha_live_machine_path_is_safe", "_geometry_within_hausdorff_budget",
                     "_alpha_candidate_motion_rank"):
            original = traced[name]
            def wrapped(*args, _name=name, _original=original, **kwargs):
                started = time.perf_counter()
                try:
                    return _original(*args, **kwargs)
                finally:
                    counts[_name] = counts.get(_name, 0) + 1
                    durations[_name] = durations.get(_name, 0.) + time.perf_counter() - started
            traced[name] = wrapped
        traced_function = types.FunctionType(new.__code__, traced, new.__name__, new.__defaults__, new.__closure__)
        traced_function.__kwdefaults__ = new.__kwdefaults__
        traced_result = traced_function(reference, reference, **options)
        row["separate_instrumented_pass"] = {
            "calls": counts, "inclusive_seconds_do_not_sum": durations,
            "same_controls_as_after": hashlib.sha256(json.dumps(traced_result[1]).encode()).hexdigest() == row["after"]["control_points_sha256"],
        }
        output["records"].append(row)
    assert output["current_engine_sha256"] == hashlib.sha256((ROOT / relative).read_bytes()).hexdigest(), "Source engine thay đổi giữa probe"
    destination = Path(__file__).with_name("live_fitter_before_after.json")
    destination.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    print(destination, flush=True)


if __name__ == "__main__":
    main()
