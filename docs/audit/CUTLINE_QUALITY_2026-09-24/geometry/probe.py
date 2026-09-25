"""Probe audit hình học độc lập; không sửa mã sản phẩm hoặc PDF nguồn."""
from __future__ import annotations

from dataclasses import asdict
import json
import math
import ast
import inspect
from pathlib import Path
import runpy
import sys
import time
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[4]
sys.path[:0] = [str(ROOT / "backend"), str(ROOT / "backend" / "tests")]

import numpy as np
from shapely.geometry import Polygon
import app.workers.sticker_engine as engine
import app.workers.cutline_cubic_simplify as cubic
import app.workers.cutline_global_simplify as global_fit
import app.workers.cutline_fair_simplify as fair_fit
from app.workers.cutline_geometry import _linear_cubic_segment
from app.workers.cutline_polyline_reduction import split_cubic
from app.workers.cutline_fair_verify import verify_fair_ring
from test_cutline_cubic_simplify import _circle, _split_ring, _metric, _sample, _dense_distance


def flowers():
    previous = runpy.run_path(str(ROOT / "docs/audit/CUTLINE_NODE_2026-09-09/probe.py"))
    return {"flower12": previous["flower_probe"](12, 20, 5),
            "flower3": previous["flower_probe"](3, 8, 1)}


def regular_polygon(count=128):
    angles = np.linspace(0, 2 * math.pi, count, endpoint=False)
    points = [(30 * math.cos(a), 30 * math.sin(a)) for a in angles]
    points.append(points[0])
    return tuple(_linear_cubic_segment(a, b) for a, b in zip(points, points[1:]))


def describe_ring(source, result, stats):
    return {"stats": stats, "metrics": asdict(_metric(result)),
            "sampled_distance_mm": _dense_distance(_sample(source), _sample(result))}


def span_limit():
    # Cùng đồ thị, chỉ đối chứng số span được xét; không đổi code/guard.
    saved = global_fit._shortest_path
    records = []
    for count in (128, 256):
        source = regular_polygon(count)
        groups = [{"exterior": list(source), "interiors": []}]
        record = {"source_segments": count}
        for label, cap in (("current", None), ("all_spans", count)):
            started = time.perf_counter()
            def unbounded(n, candidate_at, **kwargs):
                return saved(n, candidate_at, max_span=cap)
            if cap is None:
                result, stats = cubic.simplify_cubic_path_groups(groups, tolerance_mm=.05, mm_to_units=1., preview_fast=True)
            else:
                with patch.object(global_fit, "_shortest_path", unbounded):
                    result, stats = cubic.simplify_cubic_path_groups(groups, tolerance_mm=.05, mm_to_units=1., preview_fast=True)
            # Dữ liệu fixture này dùng mm; đổi pt để oracle test sẵn đo đúng mm.
            converted_source = [tuple((x * engine._PT_PER_MM, y * engine._PT_PER_MM) for x, y in c) for c in source]
            converted_result = [tuple((x * engine._PT_PER_MM, y * engine._PT_PER_MM) for x, y in c) for c in result[0]["exterior"]]
            record[label] = describe_ring(converted_source, converted_result, stats)
            record[label]["elapsed_s"] = time.perf_counter() - started
        records.append(record)
    return records


def seam():
    source = _split_ring(_circle(), 3)
    records = []
    for shift in (0, 1, 3, 5):
        shifted = source[shift:] + source[:shift]
        started = time.perf_counter()
        result, stats = cubic.simplify_cubic_path_groups([{"exterior": shifted, "interiors": []}], tolerance_mm=.05)
        item = describe_ring(shifted, result[0]["exterior"], stats)
        item.update(shift=shift, elapsed_s=time.perf_counter() - started)
        if shift == 1:
            original = _circle()
            left, right = split_cubic(original[0], .125)
            exact = [right, *original[1:], left]
            verified = verify_fair_ring(np.asarray(shifted) / engine._PT_PER_MM,
                                       np.asarray(exact) / engine._PT_PER_MM,
                                       tolerance_mm=.05)
            item["same_start_exact_candidate"] = {
                "segments": len(exact), "start_equal": exact[0][0] == shifted[0][0],
                "verification": asdict(verified)}
        records.append(item)
    return records


def hard_gate_ab():
    return hard_gate(ab=True)


def hard_gate_safe():
    return hard_gate(ab=True, scale=3.)


def hard_gate(ab=False, scale=1.):
    # Một quỹ đạo G1 duy nhất, hai biểu diễn do chia de Casteljau chính xác.
    angles = np.linspace(0., 2 * math.pi, 400, endpoint=False)
    radii = 8. + np.cos(3 * angles)
    reference = Polygon(np.column_stack((radii * np.cos(angles), radii * np.sin(angles))) * engine._PT_PER_MM)
    baseline = engine._fit_alpha_live_tuned_paths(reference, reference, total_offset_pts=0.,
        mm_to_pts=engine._PT_PER_MM, source_pixel_mm=25.4/300.,
        cutline_smoothness=50, cutline_fidelity=50, curve_tension=0)[1][0]
    baseline = [tuple((x * scale, y * scale) for x, y in curve) for curve in baseline]
    records = []
    for levels in ((3,) if ab else (0, 3)):
        source = _split_ring(baseline, levels)
        started = time.perf_counter()
        result, stats = cubic.simplify_cubic_path_groups([{"exterior": source, "interiors": []}], tolerance_mm=.1)
        record = describe_ring(source, result[0]["exterior"], stats)
        record.update(levels=levels, scale=scale, elapsed_s=time.perf_counter() - started)
        if ab:
            # Chỉ loại guard số lượng trong hàm nạp bộ nhớ; giữ toàn bộ solver/verifier.
            syntax = ast.parse(inspect.getsource(fair_fit._fair_refit_ring_impl))
            class RemoveNodeGate(ast.NodeTransformer):
                def visit_Compare(self, node):
                    if (isinstance(node.left, ast.Call) and isinstance(node.left.func, ast.Name)
                        and node.left.func.id == "len" and len(node.ops) == 1
                        and isinstance(node.ops[0], ast.Gt)
                        and isinstance(node.comparators[0], ast.Constant)
                        and node.comparators[0].value == 100):
                        return ast.copy_location(ast.Constant(value=False), node)
                    return node
            syntax = ast.fix_missing_locations(RemoveNodeGate().visit(syntax))
            namespace = dict(fair_fit.__dict__)
            exec(compile(syntax, "<audit-no-node-gate>", "exec"), namespace)
            started = time.perf_counter()
            with patch.object(fair_fit, "_fair_refit_ring_impl", namespace["_fair_refit_ring_impl"]):
                result_ab, stats_ab = cubic.simplify_cubic_path_groups([{"exterior": source, "interiors": []}], tolerance_mm=.1)
            record["without_node_gate"] = describe_ring(source, result_ab[0]["exterior"], stats_ab)
            record["without_node_gate"]["elapsed_s"] = time.perf_counter() - started
        records.append(record)
    return records


if __name__ == "__main__":
    mode = sys.argv[1]
    result = globals()[mode]()
    target = Path(__file__).with_name(mode + ".json")
    target.write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
    print(str(target))
    print(json.dumps(result, ensure_ascii=True))
