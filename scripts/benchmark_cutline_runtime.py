"""Đo CUT trên PDF/nguồn cố định; chỉ ghi artifact vào thư mục được chỉ định.

Chạy bằng backend/venv/Scripts/python.exe, không sửa PDF nguồn hay log ứng dụng.
Capture tách khỏi timer lõi; profile không được dùng làm wall-time benchmark.
"""
from __future__ import annotations

import argparse
import contextlib
import copy
import cProfile
from dataclasses import asdict
import hashlib
import io
import json
import os
from pathlib import Path
import pstats
import re
import subprocess
import sys
import time
import types
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "backend"), str(ROOT / "backend/tests")]


def load_reference(ref):
    """Nạp baseline chỉ trong process probe, không chép đè working tree."""
    if not ref:
        return
    for short in ("cutline_fair_jacobian", "cutline_fair_simplify"):
        name = "app.workers." + short
        source = subprocess.check_output(
            ["git", "show", f"{ref}:backend/app/workers/{short}.py"], cwd=ROOT,
        ).decode("utf-8")
        module = types.ModuleType(name)
        module.__file__ = str(ROOT / "backend/app/workers" / (short + ".py"))
        sys.modules[name] = module
        exec(compile(source, module.__file__, "exec"), module.__dict__)


def prepare_child():
    """Worker benchmark không ghi lẫn số đo vào log phiên người dùng."""
    destination = os.environ.get("PRYNX_CUT_BENCH_OUT")
    if destination:
        import app.utils.cutline_debug_log as debug_log
        folder = Path(destination)
        debug_log.get_log_file_path = lambda: folder / "stages.log"
        sys.stdout = (folder / f"worker-{os.getpid()}.log").open("w", encoding="utf-8")
        load_reference(os.environ.get("PRYNX_CUT_BENCH_REF"))
        if os.environ.get("PRYNX_CUT_BENCH_MEMO_OFF") == "1":
            disable_job_reuse()
        if os.environ.get("PRYNX_CUT_BENCH_TRACE") == "1":
            trace_simplify(folder)


def disable_job_reuse():
    """Đối chứng riêng cache; giữ nguyên solver QR hiện tại và nguồn trên đĩa."""
    from functools import wraps
    from app.workers import cutline_simplify_memo as memo
    def legacy_scope(function):
        @wraps(function)
        def run(*args, **kwargs):
            supplied = kwargs.pop("_simplify_memo", None)
            kwargs.pop("_shared_simplify_memo", None)
            if supplied is None:
                return function(*args, **kwargs)
            with memo.simplify_memo_scope(supplied):
                return function(*args, **kwargs)
        return run
    memo.with_simplify_memo = legacy_scope
    memo.shared_simplify_job = lambda **kwargs: contextlib.nullcontext(None)


def trace_simplify(folder):
    """Ghi khóa hình học đầu vào, không sửa kết quả solver hay log của app."""
    from functools import wraps
    from app.workers import cutline_cubic_simplify as cubic
    from app.workers.cutline_simplify_memo import _rings
    original = cubic.simplify_cubic_path_groups
    @wraps(original)
    def traced(groups, **options):
        key = hashlib.sha256(json.dumps({"rings": _rings(groups), "options": options},
                                        sort_keys=True).encode()).hexdigest()
        started = time.perf_counter()
        result = original(groups, **options)
        with (folder / f"simplify-{os.getpid()}.jsonl").open("a", encoding="utf-8") as log:
            log.write(json.dumps({"key": key, "seconds": time.perf_counter() - started,
                                  "stats": result[1]}) + "\n")
        return result
    cubic.simplify_cubic_path_groups = traced


def compare_pdfs(args):
    """Đọc PDF thật: đường cắt, ảnh/khổ trang và pixel artwork bỏ riêng CUT."""
    import numpy as np
    import pikepdf
    import pypdfium2 as pdfium
    from app.core.pdfium_lock import pdfium_guard
    from test_sticker_engine_e2e import _parse_cut_machine_paths, _read_all_content
    documents = [pikepdf.Pdf.open(path) for path in (args.before, args.after)]
    pixel_docs = []
    if args.exact_pixels:
        with pdfium_guard():
            pixel_docs = [pdfium.PdfDocument(str(path)) for path in (args.before, args.after)]
    report = {"before": str(args.before), "after": str(args.after), "pages": []}
    try:
        assert len(documents[0].pages) == len(documents[1].pages)
        images = [sorted(hashlib.sha256(obj.read_raw_bytes()).hexdigest()
                         for obj in doc.objects if isinstance(obj, pikepdf.Stream)
                         and str(obj.get("/Subtype", "")) == "/Image") for doc in documents]
        report["images_identical"] = images[0] == images[1]
        report["image_stream_count"] = len(images[0])
        for page_number, (before, after) in enumerate(zip(*[doc.pages for doc in documents]), 1):
            paths = [_parse_cut_machine_paths(page) for page in (before, after)]
            counts = [[len(ring) for ring in rings] for rings in paths]
            same_counts = counts[0] == counts[1]
            delta = None
            if same_counts:
                delta = max((np.linalg.norm(np.array([s.p0, s.p1, s.p2, s.p3])
                                            - np.array([t.p0, t.p1, t.p2, t.p3]), axis=1).max()
                             for a, b in zip(*paths) for s, t in zip(a, b)), default=0.) * 25.4 / 72
            row = dict(page=page_number, counts_before=counts[0], counts_after=counts[1],
                       control_hull_delta_mm=delta,
                       boxes_identical=all(list(before.obj[k]) == list(after.obj[k])
                                           for k in ("/MediaBox", "/CropBox", "/TrimBox")))
            if args.exact_pixels:
                pixels = []
                inspect = page_number in (1, len(documents[0].pages) // 2, len(documents[0].pages))
                for side, raster_doc in enumerate(pixel_docs):
                    with pdfium_guard():
                        raster_page = raster_doc[page_number - 1]
                        bitmap = raster_page.render(scale=150/72)
                        pixels.append(bitmap.to_numpy().copy())
                        png = bitmap.to_pil().copy() if inspect else None
                        bitmap.close()
                        raster_page.close()
                    if png is not None:
                        png.save(args.out / f"{args.label}-{'before' if side == 0 else 'after'}-p{page_number}.png")
                row["all_pixels_identical"] = np.array_equal(*pixels)
                assert row["all_pixels_identical"] and delta == 0 and same_counts
                report["pages"].append(row)
                continue
            # Giữ PDF trên đĩa nguyên vẹn; chỉ ẩn CUT trong bản sao bộ nhớ để
            # không nhầm vài pixel stroke thay đổi với hồi quy màu/artwork.
            artwork = []
            for side, (doc, page) in enumerate(zip(documents, (before, after))):
                original = page.Contents
                content = _read_all_content(page)
                hidden, replacements = re.subn(rb'/CutContour CS.*?\nS\nQ', b'Q', content, flags=re.S)
                assert replacements == 1
                page.Contents = doc.make_stream(hidden)
                buffer = io.BytesIO()
                doc.save(buffer)
                page.Contents = original
                with pdfium_guard():
                    raster_doc = pdfium.PdfDocument(buffer.getvalue())
                    raster_page = raster_doc[page_number - 1]
                    bitmap = raster_page.render(scale=150/72)
                    artwork.append(bitmap.to_numpy().copy())
                    bitmap.close()
                    raster_page.close()
                    raster_doc.close()
                if page_number in (3, 11, 12):
                    with pdfium_guard():
                        visible_doc = pdfium.PdfDocument(str((args.before, args.after)[side]))
                        visible_page = visible_doc[page_number - 1]
                        bitmap = visible_page.render(scale=200/72)
                        png = bitmap.to_pil().copy()
                        bitmap.close()
                        visible_page.close()
                        visible_doc.close()
                    png.save(args.out / f"{args.label}-{'before' if side == 0 else 'after'}-p{page_number}.png")
            row["artwork_pixels_identical"] = np.array_equal(*artwork)
            report["pages"].append(row)
        assert report["images_identical"]
        assert all(row["boxes_identical"] and row.get("all_pixels_identical", row.get("artwork_pixels_identical"))
                   for row in report["pages"])
        (args.out / (args.label + ".json")).write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(json.dumps({"pages": len(report["pages"]), "images_identical": report["images_identical"],
                          "exact_pixels": args.exact_pixels, "verified": True}), flush=True)
    finally:
        with pdfium_guard():
            for raster_doc in pixel_docs:
                raster_doc.close()
        for document in documents:
            document.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("capture", "core", "engine", "compare"))
    parser.add_argument("--source", type=Path, default=ROOT / "test/Binder2.pdf")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--label", required=True)
    parser.add_argument("--page", type=int, default=3)
    parser.add_argument("--capture", type=Path)
    parser.add_argument("--profile", action="store_true")
    parser.add_argument("--threads", type=int, default=1)
    parser.add_argument("--workers", type=int)
    parser.add_argument("--ref")
    parser.add_argument("--before", type=Path)
    parser.add_argument("--after", type=Path)
    parser.add_argument("--no-simplify", action="store_true")
    parser.add_argument("--bleed-mm", type=float, default=2.)
    parser.add_argument("--trace-simplify", action="store_true")
    parser.add_argument("--exact-pixels", action="store_true")
    parser.add_argument("--memo-off", action="store_true")
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    if args.mode == "compare":
        compare_pdfs(args)
        return
    os.environ["PRYNX_CUT_BENCH_OUT"] = str(args.out.resolve())
    os.environ["PRYNX_CUT_BENCH_REF"] = args.ref or ""
    os.environ["PRYNX_CUT_BENCH_TRACE"] = "1" if args.trace_simplify else "0"
    os.environ["PRYNX_CUT_BENCH_MEMO_OFF"] = "1" if args.memo_off else "0"
    if args.workers:
        os.environ["STICKER_MAX_WORKERS"] = str(args.workers)
    load_reference(args.ref)
    if args.memo_off:
        disable_job_reuse()
    import app.workers.cutline_cubic_simplify as cubic
    from app.workers.sticker_engine import StickerEngine
    from app.workers.numerical_worker_threads import numerical_thread_budget
    import app.utils.cutline_debug_log as debug_log
    if args.trace_simplify:
        trace_simplify(args.out)
        import logging
        memo_logger = logging.getLogger("app.workers.cutline_simplify_memo")
        memo_logger.setLevel(logging.INFO)
        memo_logger.addHandler(logging.FileHandler(args.out / "memo.log", encoding="utf-8"))

    source_hash = hashlib.sha256(args.source.read_bytes()).hexdigest()
    options = dict(cut_mode="bleed", offset_mm=0., bleed_mm=args.bleed_mm,
                   corner_style="preserve", curve_tension=50.,
                   cutline_denoise=30., cutline_simplify_mm=.1,
                   cutline_simplify_auto=True, alpha_corner_policy="adaptive",
                   remove_white_bg=False, fill_holes=True,
                   bleed_color_type="solid", shape_mode="auto_safe",
                   cut_first_page_only=False)
    if args.no_simplify:
        options.update(cutline_simplify_mm=0., cutline_simplify_auto=False)
    captures = []

    def record(groups, **settings):
        captures.append({"groups": copy.deepcopy(groups), "options": settings})
        count = sum(len(ring) for group in groups
                    for ring in [group["exterior"], *group.get("interiors", [])])
        return groups, dict(before_segments=count, after_segments=count,
                            changed=False, maximum_error_bound_mm=0.)

    profile = cProfile.Profile() if args.profile else None
    with contextlib.ExitStack() as stack:
        log = stack.enter_context((args.out / (args.label + ".log")).open("w", encoding="utf-8"))
        stack.enter_context(contextlib.redirect_stdout(log))
        stack.enter_context(patch.object(debug_log, "get_log_file_path", lambda: args.out / "stages.log"))
        stack.enter_context(numerical_thread_budget(args.threads))
        if args.mode == "capture":
            stack.enter_context(patch.object(cubic, "simplify_cubic_path_groups", record))
        if profile:
            profile.enable()
        started, cpu_started = time.perf_counter(), time.process_time()
        if args.mode == "core":
            captured = json.loads(args.capture.read_text(encoding="utf-8"))
            records = []
            for row in captured["captures"]:
                groups, stats = cubic.simplify_cubic_path_groups(row["groups"], **row["options"])
                records.append({"groups": groups, "stats": stats})
        else:
            output = args.out / (args.label + ".pdf")
            extra = {"_page_subset": [args.page - 1]} if args.mode == "capture" else {}
            engine_result = StickerEngine(dpi=300).process_pdf(
                str(args.source), str(output), **options, **extra,
            )
            assert engine_result[0], engine_result[1]
        elapsed, cpu_elapsed = time.perf_counter() - started, time.process_time() - cpu_started
        if profile:
            profile.disable()
            profile.dump_stats(str(args.out / (args.label + ".pstats")))
            pstats.Stats(profile, stream=log).strip_dirs().sort_stats("cumulative").print_stats(40)
    assert source_hash == hashlib.sha256(args.source.read_bytes()).hexdigest()
    result = dict(mode=args.mode, label=args.label, source_sha256=source_hash,
                  seconds=elapsed, cpu_seconds=cpu_elapsed, profiled=args.profile,
                  page=args.page, threads=args.threads, workers=args.workers,
                  options=options, ref=args.ref, memo_off=args.memo_off)
    if args.mode == "capture":
        result["captures"] = captures
    elif args.mode == "core":
        result["records"] = records
    else:
        import pikepdf
        from test_sticker_engine_e2e import _parse_cut_machine_paths
        with pikepdf.Pdf.open(output) as pdf:
            result["cut_paths"] = [[[asdict(s) for s in ring]
                                     for ring in _parse_cut_machine_paths(page)] for page in pdf.pages]
        result["simplification"] = [page.get("cutline_simplification")
                                     for page in engine_result[1].get("pages", [])]
    destination = args.out / (args.label + ".json")
    destination.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    print(json.dumps({k: v for k, v in result.items() if k not in ("captures", "records", "cut_paths", "options", "simplification")}), flush=True)
    print(destination, flush=True)


if __name__ == "__main__":
    main()
elif __name__ == "__mp_main__":
    prepare_child()
