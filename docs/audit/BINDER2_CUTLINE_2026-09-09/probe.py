"""Kiểm Binder2 qua luồng classic; không sửa source hoặc gọi mô hình AI.

Chạy bằng backend/venv/Scripts/python.exe từ gốc repo. Mỗi biến thể giữ toàn bộ
13 trang; chỉ trang Viewer số 1 nhận snapshot, đúng hợp đồng classic hiện tại.
"""

from __future__ import annotations

import argparse
from dataclasses import asdict
import hashlib
import json
import math
from pathlib import Path
from io import BytesIO
import subprocess
import sys
import tempfile
import time
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path[:0] = [str(ROOT / "backend"), str(ROOT / "backend" / "tests")]

import pikepdf
from PIL import Image, ImageDraw

from app.core import sticker_sheet_session as sessions
from app.workers.sticker_source_inspector import inspect_sticker_source
from app.workers.sticker_source_pipeline import detect_sticker_source
from app.workers.sticker_cutline_preview import build_sticker_cutline_preview
from app.workers.sticker_sheet_export import snapshot_classic_cutline_preview
from app.workers.sticker_engine import StickerEngine, _PT_PER_MM
import app.workers.sticker_engine as engine_module
from app.workers.cutline_geometry import build_bezier_segments_path_stream
from app.workers.cutline_machine_path import analyze_machine_path, cubic_segments_from_tuples
from test_sticker_engine_e2e import _parse_cut_machine_paths, _read_all_content


SOURCE = ROOT / "test" / "Binder2.pdf"
OUTPUT = ROOT / "output" / "pdf" / "Binder2-cutline-test-2026-09-09"
POPLER = Path(
    "C:/Users/Khanh Pham/.cache/codex-runtimes/codex-primary-runtime/"
    "dependencies/native/poppler/Library/bin"
)


def sha256(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def machine_summary(paths):
    measured = [asdict(analyze_machine_path(
        path, mm_to_units=_PT_PER_MM, smooth_join_threshold_degrees=1.0,
        short_segment_threshold_mm=0.25, samples_per_cubic=64,
    )) for path in paths]
    gaps = [math.dist(segment.p0, segment.p3) / _PT_PER_MM
            for path in paths for segment in path]
    return {
        "paths": measured,
        "path_count": len(paths),
        "segments": sum(item["segment_count"] for item in measured),
        "lines": sum(item["line_segment_count"] for item in measured),
        "cubics": sum(item["cubic_segment_count"] for item in measured),
        "short_below_0_25mm": sum(item["short_segment_count"] for item in measured),
        "join_over_1deg": sum(item["discontinuous_join_count"] for item in measured),
        "min_anchor_gap_mm": min(gaps, default=None),
        "anchor_gap_below_0_1mm": sum(gap < 0.1 for gap in gaps),
    }


def contact_sheet(pdf_path, stem, *, render=True):
    prefix = OUTPUT / stem
    if render:
        subprocess.run([
            str(POPLER / "pdftoppm.exe"), "-scale-to", "400", "-png",
            str(pdf_path), str(prefix),
        ], check=True, capture_output=True)
    files = sorted(OUTPUT.glob(stem + "-*.png"))
    canvas = Image.new("RGB", (4 * 290, math.ceil(len(files) / 4) * 310), "#e8edf2")
    draw = ImageDraw.Draw(canvas)
    for index, path in enumerate(files):
        with Image.open(path) as source_image:
            tile = source_image.convert("RGB")
            tile.thumbnail((276, 278))
        left = (index % 4) * 290
        top = (index // 4) * 310
        canvas.paste(tile, (left + (290 - tile.width) // 2, top + 26))
        draw.text((left + 10, top + 7), f"Trang {index + 1}", fill="#1e293b")
    output = OUTPUT / f"{stem}_contact.png"
    canvas.save(output)
    return str(output)


def source_inventory():
    rows = []
    with pikepdf.Pdf.open(SOURCE) as pdf:
        for index, page in enumerate(pdf.pages, 1):
            images = []
            for name, obj in page.Resources.get("/XObject", {}).items():
                if str(obj.get("/Subtype", "")) == "/Image":
                    images.append({
                        "name": str(name), "width": int(obj.Width), "height": int(obj.Height),
                        "filter": str(obj.get("/Filter", "")), "smask": "/SMask" in obj,
                    })
            operators = [str(item.operator) for item in pikepdf.parse_content_stream(page)]
            rows.append({
                "page": index, "media_box": [float(value) for value in page.MediaBox],
                "rotate": int(page.get("/Rotate", 0)), "images": images,
                "operators": sorted(set(operators)),
            })
    return rows


def preview_all_pages(session, denoise, viewer_page):
    rows = []
    snapshot = None
    for number in range(1, session.page_count + 1):
        page = session.pages[number]
        record = {"page": number}
        start = time.perf_counter()
        try:
            if page.stage == "inspected":
                sessions.begin_source_detection(session.session_id, page_number=number)
                detected = detect_sticker_source(
                    session, strategy="alpha", model="birefnet-lite", alpha_threshold=128,
                    page_number=number, preview_only=True,
                )
                sessions.promote_source_session(
                    session.session_id, analysis=detected.analysis,
                    analysis_source=detected.source_image,
                    boundary_source=detected.boundary_source,
                    strategy_confidence=detected.strategy_confidence,
                    needs_review=detected.needs_review, dpi=detected.dpi,
                    source_page=number, vector_geometry_ref=detected.vector_geometry_ref,
                    warnings=list(detected.warnings), edge_background_rgb=detected.background_rgb,
                    edge_background_tolerance=detected.background_tolerance,
                )
            record["instances"] = len(page.manifest.get("instances", []))
            record["boundary_source"] = page.boundary_source
            if record["instances"] != 1:
                record["classic_status"] = "UI_REJECTS_MULTIPLE_INSTANCES"
            else:
                geometry = dict(
                    offset_mm=0.0, bleed_mm=0.0, cut_mode="original", corner_style="preserve",
                    fill_holes=True, curve_tension=50.0, cutline_denoise=denoise,
                    cutline_smoothness=50.0, cutline_fidelity=50.0, min_detail_area_mm2=1.0,
                )
                dpi = page.manifest.get("dpi") or [300.0, 300.0]
                preview = build_sticker_cutline_preview(
                    session, page_number=number, base_revision=page.manifest["mask_revision"],
                    edits=[], dpi=dpi[0], dpi_y=dpi[1], **geometry,
                )
                record["classic_status"] = "PREVIEW_READY"
                record["quality"] = preview["quality"]
                record["dpi"] = dpi
                cached = page.cutline_export_cache
                paths = []
                for instance in cached["instances"]:
                    for group in instance["path_groups"]:
                        for ring in [group["exterior"], *group.get("interiors", [])]:
                            paths.append(cubic_segments_from_tuples(ring))
                record["machine"] = machine_summary(paths)
                if number == viewer_page:
                    snapshot = snapshot_classic_cutline_preview(
                        session, source_path=SOURCE, page_number=number,
                        expected_revision=preview["mask_revision"],
                        expected_fingerprint=preview["fingerprint"], **geometry,
                    )
        except Exception as error:
            record["classic_status"] = "ERROR"
            record["error"] = f"{type(error).__name__}: {error}"
        record["seconds"] = time.perf_counter() - start
        rows.append(record)
        print(json.dumps({"phase": "preview", "denoise": denoise, "page": number,
            "status": record["classic_status"], "instances": record.get("instances"),
            "segments": record.get("machine", {}).get("segments")}, ensure_ascii=True), flush=True)
    return rows, snapshot


def export_classic(denoise, snapshot, viewer_page):
    suffix = "" if viewer_page == 1 else f"_viewer{viewer_page}"
    output = OUTPUT / f"Binder2_classic_denoise_{denoise:g}{suffix}.pdf"
    start = time.perf_counter()
    forwarded = []
    original_parallel = StickerEngine._process_parallel

    def observe_parallel(self, *args, **kwargs):
        forwarded.append({
            "denoise_present": "cutline_denoise" in kwargs,
            "denoise_value": kwargs.get("cutline_denoise"),
            "canonical_pages_zero_based": sorted(kwargs.get("approved_contour_overrides", {})),
        })
        return original_parallel(self, *args, **kwargs)
    # Giữ nguyên 13 trang, không truyền process_pages hoặc ép tuần tự.
    # Snapshot chỉ áp trang Viewer 1, không giả vờ mọi trang có canonical.
    with patch.object(StickerEngine, "_process_parallel", observe_parallel):
        success, metadata = StickerEngine(dpi=300).process_pdf(
            input_path=str(SOURCE), output_path=str(output), cut_mode="original",
            offset_mm=0.0, corner_style="preserve", bleed_mm=0.0, fill_holes=True,
            remove_white_bg=True, bleed_color_type="image", draw_cut_contour=True,
            rectangle_mode=False, cut_first_page_only=False, shape_mode="auto_safe",
            alpha_corner_policy="adaptive", curve_tension=50.0,
            cutline_denoise=denoise,
            approved_contour_overrides={viewer_page - 1: snapshot} if snapshot is not None else None,
        )
    if not success:
        raise RuntimeError(metadata)
    rows = []
    with pikepdf.Pdf.open(output) as pdf:
        assert len(pdf.pages) == 13
        for number, page in enumerate(pdf.pages, 1):
            content = _read_all_content(page)
            paths = _parse_cut_machine_paths(page) if b"/CutContour CS" in content else []
            path_bytes = json.dumps([[asdict(segment) for segment in path] for path in paths],
                                   sort_keys=True).encode("ascii")
            rows.append({"page": number, "canonical": number == viewer_page and snapshot is not None,
                         "cut_path_sha256": hashlib.sha256(path_bytes).hexdigest(),
                         **machine_summary(paths)})
        if snapshot is not None:
            with pikepdf.Pdf.open(SOURCE) as original:
                source_page = original.pages[viewer_page - 1]
                height = float(source_page.MediaBox[3] - source_page.MediaBox[1])
            expected = []
            for group in snapshot["path_groups"]:
                for ring in [group["exterior"], *group.get("interiors", [])]:
                    expected.extend(build_bezier_segments_path_stream(ring, height))
            expected = [line.strip() for line in expected if line.strip().endswith(" c")]
            content = _read_all_content(pdf.pages[viewer_page - 1]).split(b"/CutContour CS", 1)[1]
            actual = [line.strip().decode("ascii") for line in content.splitlines()
                      if line.strip().endswith(b" c")]
            assert actual == expected, "Trang Viewer không giữ chính cubic canonical đã duyệt"
    return {"path": str(output), "seconds": time.perf_counter() - start,
            "sha256": sha256(output), "metadata": metadata, "pages": rows,
            "parent_parallel_calls": forwarded,
            "contact": contact_sheet(output, f"cut_denoise_{denoise:g}{suffix}")}


def trace_worker_fallback(page_number):
    events = []
    original_round = engine_module._round_preserved_corners
    original_fit = engine_module._fit_preserved_contour_paths
    original_fallback = engine_module._preserved_contour_fallback_geometry

    def observe_round(geometry, *args, **kwargs):
        result = original_round(geometry, *args, **kwargs)
        events.append({"step": "round", "before_nodes": engine_module._polygon_node_count(geometry),
                       "after_nodes": engine_module._polygon_node_count(result)})
        return result

    def observe_fit(geometry, *args, **kwargs):
        result = original_fit(geometry, *args, **kwargs)
        events.append({"step": "fit", "accepted": result is not None})
        return result

    def observe_fallback(geometry, *args, **kwargs):
        result = original_fallback(geometry, *args, **kwargs)
        events.append({"step": "fallback", "before_nodes": engine_module._polygon_node_count(geometry),
                       "after_nodes": engine_module._polygon_node_count(result[0]),
                       "simplify_mm": result[1]})
        return result

    with patch.object(engine_module, "_round_preserved_corners", observe_round), \
         patch.object(engine_module, "_fit_preserved_contour_paths", observe_fit), \
         patch.object(engine_module, "_preserved_contour_fallback_geometry", observe_fallback):
        # Đây là chính entry worker dùng sau fan-out, không tạo PDF một-trang
        # đầu vào mới. Denoise=0 tái hiện default thực của payload đang bị rơi.
        result = StickerEngine(dpi=300).process_pdf(
            input_path=str(SOURCE), output_path="", cut_mode="original", offset_mm=0.0,
            corner_style="preserve", bleed_mm=0.0, fill_holes=True,
            remove_white_bg=True, bleed_color_type="image", draw_cut_contour=True,
            rectangle_mode=False, shape_mode="auto_safe", alpha_corner_policy="adaptive",
            curve_tension=50.0, cutline_denoise=0.0, _page_subset=[page_number - 1],
        )
    with pikepdf.Pdf.open(BytesIO(result[0])) as pdf:
        paths = _parse_cut_machine_paths(pdf.pages[0])
        path_bytes = json.dumps([[asdict(segment) for segment in path] for path in paths],
                               sort_keys=True).encode("ascii")
        path_hash = hashlib.sha256(path_bytes).hexdigest()
    baseline = json.loads(Path(__file__).with_name("evidence.json").read_text(encoding="utf-8"))
    expected_hash = baseline["variants"][0]["export"]["pages"][page_number - 1]["cut_path_sha256"]
    assert path_hash == expected_hash, "Worker probe không tái hiện đúng lệnh cắt baseline"
    return {"page": page_number, "events": events, "matches_full_export": True,
            "cut_path_sha256": path_hash, "machine": machine_summary(paths)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--denoise", nargs="+", type=float, default=[30.0, 70.0])
    parser.add_argument("--viewer-page", type=int, default=1)
    parser.add_argument("--trace-fallback-page", type=int)
    args = parser.parse_args()
    OUTPUT.mkdir(parents=True, exist_ok=True)
    original_hash = sha256(SOURCE)
    evidence = {"source": str(SOURCE), "source_sha256": original_hash,
                "viewer_page": args.viewer_page,
                "inventory": source_inventory(), "variants": [],
                "source_contact": contact_sheet(SOURCE, "source")}
    evidence_name = "evidence.json" if args.viewer_page == 1 else f"evidence_viewer{args.viewer_page}.json"
    destination = Path(__file__).with_name(evidence_name)

    def save():
        destination.write_text(json.dumps(evidence, ensure_ascii=False, indent=2, default=str), encoding="utf-8")

    save()
    with tempfile.TemporaryDirectory(prefix="binder2-classic-sessions-") as temporary:
        sessions.SESSION_ROOT = Path(temporary)
        inspection = inspect_sticker_source(str(SOURCE), SOURCE.name)
        evidence["inspection"] = inspection.to_manifest()
        assert inspection.page_count == 13 and all(page.has_alpha for page in inspection.pages)
        session = sessions.create_source_session(
            source_path=SOURCE, original_name=SOURCE.name, inspection=inspection,
        )
        try:
            for denoise in args.denoise:
                variant = {"denoise": denoise}
                evidence["variants"].append(variant)
                preview, snapshot = preview_all_pages(session, denoise, args.viewer_page)
                variant["preview"] = preview
                save()
                try:
                    variant["export"] = export_classic(denoise, snapshot, args.viewer_page)
                except Exception as error:
                    variant["export_error"] = f"{type(error).__name__}: {error}"
                    save()
                    raise
                save()
                print(json.dumps({"phase": "export", "denoise": denoise,
                    "segments": [page["segments"] for page in variant["export"]["pages"]]}, ensure_ascii=True), flush=True)
        finally:
            sessions.close_session(session.session_id)
    evidence["source_hash_unchanged"] = sha256(SOURCE) == original_hash
    assert evidence["source_hash_unchanged"]
    if args.trace_fallback_page:
        evidence["worker_trace"] = trace_worker_fallback(args.trace_fallback_page)
    save()
    print(json.dumps({"evidence": str(destination), "source_unchanged": True}), flush=True)


if __name__ == "__main__":
    main()
