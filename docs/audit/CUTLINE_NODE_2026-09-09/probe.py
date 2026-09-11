"""Probe audit độc lập; không thay đổi mã tạo đường cắt của sản phẩm.

Chạy bằng backend/venv/Scripts/python.exe từ gốc repo. PDF trung gian nằm trong
TemporaryDirectory và được xóa sau khi đã đọc lại lệnh CutContour.
"""

from __future__ import annotations

from dataclasses import asdict
import copy
import hashlib
import json
import math
from pathlib import Path
import sys
import subprocess
import tempfile
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT / "backend" / "tests"))

import cv2
import numpy as np
import pikepdf
from shapely.geometry import LineString, Polygon

import app.workers.sticker_engine as engine
from app.workers.cutline_geometry import sample_bezier_segments
from app.workers.cutline_machine_path import (
    analyze_machine_path,
    cubic_segments_from_tuples,
)
import test_sticker_engine_e2e as fixtures
import test_sticker_cutline_preview as preview_fixtures
from app.workers.sticker_cutline_preview import build_sticker_cutline_preview
from app.workers.sticker_sheet_export import export_sticker_sheet_document


def metrics(paths):
    return [asdict(analyze_machine_path(
        path,
        mm_to_units=engine._PT_PER_MM,
        smooth_join_threshold_degrees=1.0,
        short_segment_threshold_mm=0.25,
        samples_per_cubic=128,
    )) for path in paths]


def flower_probe(lobes, base_radius, amplitude):
    angles = np.linspace(0.0, 2.0 * math.pi, 400, endpoint=False)
    radii = base_radius + amplitude * np.cos(lobes * angles)
    reference = Polygon(np.column_stack((
        radii * np.cos(angles), radii * np.sin(angles),
    )) * engine._PT_PER_MM)
    kwargs = dict(
        total_offset_pts=0.0,
        mm_to_pts=engine._PT_PER_MM,
        source_pixel_mm=25.4 / 300.0,
        cutline_smoothness=50,
        cutline_fidelity=50,
        curve_tension=0,
    )

    def describe(result):
        geometry, paths, budget = result
        quality = engine._alpha_final_cutline_quality(
            paths,
            reference_geometry=reference,
            fitted_geometry=geometry,
            alpha_geometry=reference,
            total_offset_pts=0.0,
            mm_to_pts=engine._PT_PER_MM,
            source_pixel_mm=25.4 / 300.0,
            fit_mode="live-bezier",
        )
        return {
            "budget_mm": budget,
            "measured_hausdorff_mm": reference.boundary.hausdorff_distance(
                geometry.boundary,
            ) / engine._PT_PER_MM,
            "quality": quality,
            "metrics": metrics([cubic_segments_from_tuples(path) for path in paths]),
        }

    current = engine._fit_alpha_live_tuned_paths(reference, reference, **kwargs)
    # Chỉ trong process probe: bỏ ứng viên G1 để nhìn ứng viên C2 phía sau.
    # Đây là đối chứng thứ tự chọn, KHÔNG phải bản vá hay thuật toán đề nghị ship.
    with patch.object(engine, "_catmull_rom_bezier_segments", return_value=[]):
        c2_only = engine._fit_alpha_live_tuned_paths(reference, reference, **kwargs)
    return {
        "input": {"lobes": lobes, "base_radius_mm": base_radius,
                  "amplitude_mm": amplitude, "points": 400},
        "current": describe(current),
        "later_c2_candidate": describe(c2_only),
    }


def circle_probe():
    scale = 300.0 / 25.4
    size = round(64.0 * scale)
    mask = np.zeros((size, size), dtype=np.uint8)
    center_px = round(32.0 * scale)
    radius_px = round(25.0 * scale)
    cv2.circle(mask, (center_px, center_px), radius_px, 255, -1, cv2.LINE_AA)
    result = engine.build_alpha_cutline_geometry(
        mask, dpi=300, cut_mode="original", corner_style="preserve",
        cutline_smoothness=50, cutline_fidelity=50, curve_tension=0,
    )
    baseline = LineString(sample_bezier_segments(
        result["paths"][0], samples_per_segment=256,
    ))
    # Candidate dùng hình tròn đã biết của fixture, không phải nhận dạng freeform.
    # Đo chênh với chính đường đã xuất, không tuyên bố giữ nguyên tuyệt đối.
    center = center_px * 72.0 / 300.0
    radius = radius_px * 72.0 / 300.0
    candidates = []
    for count in (4, 8):
        segments = []
        step = 2.0 * math.pi / count
        handle = 4.0 / 3.0 * math.tan(step / 4.0) * radius
        for index in range(count):
            first, last = index * step, (index + 1) * step
            p0 = (center + radius * math.cos(first), center + radius * math.sin(first))
            p3 = (center + radius * math.cos(last), center + radius * math.sin(last))
            p1 = (p0[0] - handle * math.sin(first), p0[1] + handle * math.cos(first))
            p2 = (p3[0] + handle * math.sin(last), p3[1] - handle * math.cos(last))
            segments.append((p0, p1, p2, p3))
        candidate = LineString(sample_bezier_segments(segments, samples_per_segment=512))
        candidates.append({
            "segments": count,
            "sampled_distance_to_current_mm": baseline.hausdorff_distance(candidate)
            / engine._PT_PER_MM,
            "metrics": metrics([cubic_segments_from_tuples(segments)]),
        })
    return {"current_quality": result["quality"], "candidates": candidates}


def artifact_probe():
    records = []
    with tempfile.TemporaryDirectory(prefix="prynx-cutline-node-audit-") as directory:
        directory = Path(directory)
        for name, make_fixture, options in (
            ("circle_300", lambda path: fixtures._make_page_touching_circle_pdf(
                path, transparent=True), {"corner_style": "round"}),
            ("wavy_shell_300", fixtures._make_wavy_shell_alpha_pdf,
             {"corner_style": "preserve", "alpha_corner_policy": "adaptive",
              "alpha_source_pixel_mm": 25.4 / 300.0}),
            ("notched_72", fixtures._make_low_dpi_notched_alpha_pdf,
             {"corner_style": "preserve", "alpha_corner_policy": "adaptive",
              "alpha_source_pixel_mm": 25.4 / 72.0}),
        ):
            source = directory / f"{name}.pdf"
            output = directory / f"{name}_cut.pdf"
            make_fixture(str(source))
            success, metadata = engine.StickerEngine(dpi=300).process_pdf(
                input_path=str(source), output_path=str(output),
                cut_mode="alpha", offset_mm=0.0, bleed_mm=0.0,
                fill_holes=True, remove_white_bg=False,
                draw_cut_contour=True, shape_mode="contour", **options,
            )
            if not success:
                raise RuntimeError((name, metadata))
            with pikepdf.Pdf.open(output) as pdf:
                paths = fixtures._parse_cut_machine_paths(pdf.pages[0])
                records.append({
                    "fixture": name,
                    "options": options,
                    "output_sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
                    "pages": len(pdf.pages),
                    "path_count": len(paths),
                    "metrics": metrics(paths),
                })
    return records


def denoise_artifact_probe():
    with tempfile.TemporaryDirectory(prefix="prynx-cutline-denoise-audit-") as directory:
        session = preview_fixtures._session(Path(directory))
        options = dict(
            dpi=100.0, dpi_y=100.0, offset_mm=0.0, bleed_mm=0.0,
            cut_mode="original", corner_style="preserve", fill_holes=True,
            cutline_smoothness=50.0, cutline_fidelity=50.0,
            curve_tension=50.0, min_detail_area_mm2=1.0,
        )
        preview = build_sticker_cutline_preview(
            session, page_number=1, base_revision=3, edits=[],
            cutline_denoise=50.0, **options,
        )
        before = copy.deepcopy(session.pages[1].cutline_export_cache)
        session.pages[1].stage = "mask-ready"
        output = export_sticker_sheet_document(
            session,
            pages=[dict(source_page=1, expected_revision=3, edits=[], **options)],
            page_order=[1], output_format="pdf", crop_to_sticker=False,
            bleed_color_type="solid", preserve_existing_cut=False, **options,
        )
        with pikepdf.Pdf.open(output.path) as pdf:
            paths = fixtures._parse_cut_machine_paths(pdf.pages[0])
            after = session.pages[1].cutline_export_cache
            previous_boundary = LineString(sample_bezier_segments(
                before["instances"][0]["path_groups"][0]["exterior"],
                samples_per_segment=256,
            ))
            current_boundary = LineString(sample_bezier_segments(
                after["instances"][0]["path_groups"][0]["exterior"],
                samples_per_segment=256,
            ))
            renderer = Path(
                "C:/Users/Khanh Pham/.cache/codex-runtimes/"
                "codex-primary-runtime/dependencies/native/poppler/Library/bin/pdftoppm.exe"
            )
            subprocess.run([
                str(renderer), "-f", "1", "-singlefile", "-r", "300", "-png",
                str(output.path), str(Path(__file__).with_name("denoise-output")),
            ], check=True, capture_output=True)
            return {
                "requested_denoise": 50.0,
                "preview_segments": preview["segment_count"],
                "pdf_metrics": metrics(paths),
                "cache_after_segments": after["quality"]["segment_count"],
                "export_requested_denoise": after["requested_cutline_denoise"],
                "path_groups_equal": before["instances"][0]["path_groups"]
                == after["instances"][0]["path_groups"],
                "sampled_preview_to_refit_distance_mm": previous_boundary.hausdorff_distance(
                    current_boundary,
                ) / engine._PT_PER_MM,
                "pages": len(pdf.pages),
                "bytes": output.path.stat().st_size,
            }


def main():
    evidence = {
        "note": "Probe source/artifact tổng hợp, chưa phải runtime Tauri/máy bế.",
        "source_sha256": {
            name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
            for name in (
                "backend/app/workers/sticker_engine.py",
                "backend/app/workers/cutline_geometry.py",
                "backend/app/workers/cutline_machine_path.py",
            )
        },
        "flowers": [flower_probe(3, 8, 1), flower_probe(12, 20, 5)],
        "circle": circle_probe(),
        "artifacts": artifact_probe(),
        "denoise_artifact": denoise_artifact_probe(),
    }
    destination = Path(__file__).with_name("evidence.json")
    destination.write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({
        "evidence": str(destination),
        "flower_segments": [
            [item["current"]["metrics"][0]["segment_count"],
             item["later_c2_candidate"]["metrics"][0]["segment_count"]]
            for item in evidence["flowers"]
        ],
        "artifact_segments": [item["metrics"][0]["segment_count"]
                              for item in evidence["artifacts"]],
        "denoise_artifact": evidence["denoise_artifact"],
    }, ensure_ascii=True, indent=2), flush=True)


if __name__ == "__main__":
    main()
