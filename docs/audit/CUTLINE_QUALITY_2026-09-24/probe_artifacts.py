"""Đo engine hiện hành và đọc lại CUT trong PDF, không sửa nguồn sản phẩm."""
from __future__ import annotations

import argparse
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import platform
import sys
import time
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path[:0] = [str(ROOT / "backend"), str(ROOT / "backend/tests"),
                str(ROOT / "tmp/pdfs/fair-production-20260910")]
from run_artifacts import _read_record
from app.workers.sticker_engine import StickerEngine
from app.workers import cutline_cubic_simplify as reducer

HERE = Path(__file__).parent
OUTPUT = ROOT / "output/pdf/Cutline-quality-audit-2026-09-24"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--page", type=int, required=True)
    parser.add_argument("--tolerance", type=float, required=True)
    parser.add_argument("--mode", choices=["original", "round"], default="original")
    parser.add_argument("--auto", action="store_true")
    args = parser.parse_args()
    OUTPUT.mkdir(parents=True, exist_ok=True)
    name = f"Binder2_p{args.page}_{args.mode}_s{args.tolerance:.3f}" + ("_auto" if args.auto else "")
    destination = OUTPUT / f"{name}.pdf"
    evidence_path = HERE / f"{name}.json"
    if destination.exists() or evidence_path.exists():
        raise FileExistsError(name)
    source = ROOT / "test/Binder2.pdf"
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    captures, phases = [], []
    original, original_impl = reducer.simplify_cubic_path_groups, reducer._simplify_cubic_path_groups_impl

    def measured_impl(groups, **options):
        started = time.perf_counter()
        result = original_impl(groups, **options)
        phases.append({"seconds": time.perf_counter()-started, "options": options,
                       "stats": result[1]})
        return result

    def measured(groups, **options):
        captured = {"groups": deepcopy(groups), "options": options}
        started = time.perf_counter()
        result = original(groups, **options)
        captured.update(seconds=time.perf_counter()-started, stats=result[1])
        captures.append(captured)
        return result

    options = dict(cut_mode="original", offset_mm=2.0, bleed_mm=0.0,
                   corner_style="preserve", curve_tension=50.0)
    if args.mode == "round":
        options.update(cut_mode="bleed", offset_mm=0.0, bleed_mm=2.0,
                       corner_style="round", curve_tension=100.0)
    started, cpu_started = time.perf_counter(), time.process_time()
    with patch.object(reducer, "simplify_cubic_path_groups", measured), \
         patch.object(reducer, "_simplify_cubic_path_groups_impl", measured_impl):
        result = StickerEngine(dpi=300).process_pdf(
            str(source), "", _page_subset=[args.page-1], remove_white_bg=True,
            draw_cut_contour=True, alpha_corner_policy="adaptive", shape_mode="auto_safe",
            cutline_denoise=30.0, cutline_simplify_mm=args.tolerance,
            fill_holes=True, bleed_color_type="solid", cutline_simplify_auto=args.auto, **options)
    elapsed, cpu_elapsed = time.perf_counter()-started, time.process_time()-cpu_started
    assert isinstance(result[0], bytes), result
    with destination.open("xb") as stream:
        stream.write(result[0])
    pages, rings = _read_record(destination, [args.page])
    evidence = dict(source=str(source), source_sha256=digest, source_unchanged=(
        digest == hashlib.sha256(source.read_bytes()).hexdigest()),
        platform=platform.platform(), output=str(destination), page=args.page,
        tolerance_mm=args.tolerance, mode=args.mode, auto=args.auto, options=options,
        seconds=elapsed, cpu_seconds=cpu_elapsed, metadata=result[1],
        pages=pages, rings_mm=rings, reducer_captures=captures, phases=phases,
        source_hashes={str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest()
                       for p in (ROOT / "backend/app/workers").glob("cutline_*.py")})
    with evidence_path.open("x", encoding="utf-8") as stream:
        json.dump(evidence, stream, ensure_ascii=False, indent=2, default=str)
    print(json.dumps({"evidence": str(evidence_path), "seconds": elapsed,
        "nodes": pages[0]["nodes"], "ring_nodes": pages[0]["ring_nodes"],
        "phases": phases, "source_unchanged": evidence["source_unchanged"]}), flush=True)


if __name__ == "__main__":
    main()
