"""Hồi quy classic Binder2: tham số worker và đường Alpha không phụ thuộc Viewer."""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import asdict
import hashlib
import json
from pathlib import Path
import sys
import time

if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import cv2
import numpy as np
import pikepdf
import pytest

from app.workers import sticker_engine as engine_module
from app.core import sticker_sheet_session as sessions
from app.workers.sticker_cutline_preview import build_sticker_cutline_preview
from app.workers.sticker_sheet_export import snapshot_classic_cutline_preview
from app.workers.sticker_source_inspector import inspect_sticker_source
from app.workers.sticker_source_pipeline import (
    build_classic_alpha_page_contour,
    detect_sticker_source,
)
from test_sticker_engine_e2e import _parse_cut_machine_paths


ROOT = Path(__file__).resolve().parents[2]
BINDER2 = ROOT / "test" / "Binder2.pdf"


def _geometry(denoise=30.0, offset=0.0, fill_holes=True):
    return dict(
        cut_mode="original", offset_mm=offset, bleed_mm=0.0,
        corner_style="preserve", fill_holes=fill_holes,
        cutline_smoothness=50.0, cutline_fidelity=50.0,
        curve_tension=50.0, cutline_denoise=denoise, min_detail_area_mm2=1.0,
    )


def _synthetic_pdf(path, *, hole=False):
    """Hai trang Alpha có point lẻ, không phụ thuộc corpus riêng của khách."""
    height, width = 340, 440
    with pikepdf.Pdf.new() as pdf:
        for index in range(2):
            alpha = np.zeros((height, width), dtype=np.uint8)
            if index == 0:
                cv2.ellipse(alpha, (220, 170), (175, 135), 0, 0, 360, 255, -1, cv2.LINE_AA)
            else:
                angles = np.linspace(0, 2 * np.pi, 240, endpoint=False)
                radius = 110 + 22 * np.cos(3 * angles)
                points = np.rint(np.column_stack((
                    220 + 1.3 * radius * np.cos(angles), 170 + radius * np.sin(angles),
                ))).astype(np.int32)
                cv2.fillPoly(alpha, [points], 255, lineType=cv2.LINE_AA)
            if hole:
                cv2.circle(alpha, (220, 170), 25, 0, -1, cv2.LINE_AA)
            rgb = np.full((height, width, 3), (75, 155, 210), dtype=np.uint8)
            mask = pdf.make_stream(alpha.tobytes())
            mask.Type = pikepdf.Name.XObject
            mask.Subtype = pikepdf.Name.Image
            mask.Width, mask.Height = width, height
            mask.ColorSpace = pikepdf.Name.DeviceGray
            mask.BitsPerComponent = 8
            image = pdf.make_stream(rgb.tobytes())
            image.Type = pikepdf.Name.XObject
            image.Subtype = pikepdf.Name.Image
            image.Width, image.Height = width, height
            image.ColorSpace = pikepdf.Name.DeviceRGB
            image.BitsPerComponent = 8
            image.SMask = mask
            page = pdf.add_blank_page(page_size=(123.4567, 95.4321))
            page.Resources = pikepdf.Dictionary(XObject=pikepdf.Dictionary(Im0=image))
            page.Contents = pdf.make_stream(b"q 123.4567 0 0 95.4321 0 0 cm /Im0 Do Q")
        pdf.save(path)
    return path


@contextmanager
def _source_session(source, session_root):
    previous_root = sessions.SESSION_ROOT
    sessions.SESSION_ROOT = session_root
    session = None
    try:
        session = sessions.create_source_session(
            source_path=source, original_name=source.name,
            inspection=inspect_sticker_source(str(source), source.name),
        )
        yield session
    finally:
        if session is not None:
            sessions.close_session(session.session_id)
        sessions.SESSION_ROOT = previous_root


def _snapshot(session, source, page_number, geometry):
    page = session.pages[page_number]
    if page.stage == "inspected":
        sessions.begin_source_detection(session.session_id, page_number=page_number)
        detected = detect_sticker_source(
            session, strategy="alpha", page_number=page_number, preview_only=True,
        )
        sessions.promote_source_session(
            session.session_id, analysis=detected.analysis,
            analysis_source=detected.source_image, boundary_source=detected.boundary_source,
            strategy_confidence=detected.strategy_confidence,
            needs_review=detected.needs_review, dpi=detected.dpi, source_page=page_number,
            vector_geometry_ref=detected.vector_geometry_ref, warnings=list(detected.warnings),
        )
    dpi = page.manifest["dpi"]
    preview = build_sticker_cutline_preview(
        session, page_number=page_number, base_revision=page.manifest["mask_revision"],
        edits=[], dpi=dpi[0], dpi_y=dpi[1], **geometry,
    )
    return snapshot_classic_cutline_preview(
        session, source_path=source, page_number=page_number,
        expected_revision=preview["mask_revision"], expected_fingerprint=preview["fingerprint"],
        **geometry,
    )


def _cut_hashes(path):
    rows = []
    with pikepdf.Pdf.open(path) as pdf:
        for page in pdf.pages:
            paths = _parse_cut_machine_paths(page)
            payload = json.dumps([[asdict(segment) for segment in ring] for ring in paths],
                                 sort_keys=True).encode("ascii")
            rows.append(hashlib.sha256(payload).hexdigest())
    return rows


def _export(source, output, geometry, snapshots=None):
    kwargs = dict(geometry)
    success, meta = engine_module.StickerEngine(dpi=300).process_pdf(
        input_path=str(source), output_path=str(output), remove_white_bg=True,
        draw_cut_contour=True, shape_mode="auto_safe", alpha_corner_policy="adaptive",
        approved_contour_overrides=snapshots, **kwargs,
    )
    assert success, meta
    return meta


@pytest.mark.parametrize("denoise", [0.0, 30.0, 70.0])
def test_classic_fanout_giu_muc_khu_rang_cua(tmp_path, monkeypatch, denoise):
    source = tmp_path / "six_pages.pdf"
    with pikepdf.Pdf.new() as pdf:
        for _ in range(6):
            pdf.add_blank_page(page_size=(72, 72))
        pdf.save(source)
    forwarded = []

    def capture_parallel(self, *args, **kwargs):
        forwarded.append(kwargs)
        return True, {}

    monkeypatch.setattr(engine_module, "_n_pages_should_parallelize", lambda *a, **kw: True)
    monkeypatch.setattr(engine_module.StickerEngine, "_process_parallel", capture_parallel)
    success, _ = engine_module.StickerEngine().process_pdf(
        input_path=str(source), output_path=str(tmp_path / "result.pdf"),
        cutline_denoise=denoise,
    )
    assert success
    assert len(forwarded) == 1
    assert forwarded[0].get("cutline_denoise") == denoise


def _write_binder2_artifacts(directory, simplify_mm=0.0):
    """Xuất bộ nghiệm thu riêng, không ghi đè PDF/bằng chứng trước sửa."""
    from app.workers.cutline_machine_path import analyze_machine_path

    directory.mkdir(parents=True, exist_ok=True)
    source_hash = hashlib.sha256(BINDER2.read_bytes()).hexdigest()
    evidence = {"source_sha256": source_hash, "simplify_mm": simplify_mm, "cases": []}
    with _source_session(BINDER2, directory / "sessions") as session:
        for denoise in (30.0, 70.0):
            geometry = _geometry(denoise)
            geometry["cutline_simplify_mm"] = simplify_mm
            snapshots = {page: _snapshot(session, BINDER2, page, geometry) for page in (1, 5)}
            expected_hashes = None
            for viewer in (None, 1, 5):
                output = directory / f"Binder2_denoise{denoise:g}_viewer{viewer or 0}.pdf"
                start = time.perf_counter()
                overrides = None if viewer is None else {viewer - 1: snapshots[viewer]}
                _export(BINDER2, output, geometry, overrides)
                elapsed = time.perf_counter() - start
                hashes = _cut_hashes(output)
                if expected_hashes is None:
                    expected_hashes = hashes
                assert hashes == expected_hashes, "Đổi trang Viewer làm thay quỹ đạo của tài liệu"
                rows = []
                with pikepdf.Pdf.open(output) as pdf:
                    assert len(pdf.pages) == 13
                    for page_number, page in enumerate(pdf.pages, 1):
                        paths = _parse_cut_machine_paths(page)
                        metrics = [analyze_machine_path(
                            path, mm_to_units=engine_module._PT_PER_MM,
                            smooth_join_threshold_degrees=1.0,
                            short_segment_threshold_mm=0.25, samples_per_cubic=64,
                        ) for path in paths]
                        rows.append({
                            "page": page_number, "paths": len(paths),
                            "lines": sum(item.line_segment_count for item in metrics),
                            "cubics": sum(item.cubic_segment_count for item in metrics),
                            "short_below_0_25mm": sum(item.short_segment_count for item in metrics),
                            "min_length_mm": min(
                                (item.minimum_segment_length_mm for item in metrics
                                 if item.minimum_segment_length_mm is not None), default=None,
                            ),
                            "cut_path_sha256": hashes[page_number - 1],
                        })
                record = {"denoise": denoise, "viewer": viewer, "pdf": str(output),
                          "seconds": elapsed, "pages": rows}
                evidence["cases"].append(record)
                (directory / "evidence.json").write_text(
                    json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8",
                )
                print(json.dumps(record, ensure_ascii=True), flush=True)
    assert hashlib.sha256(BINDER2.read_bytes()).hexdigest() == source_hash
    evidence["source_unchanged"] = True
    evidence["viewer_independent"] = True
    (directory / "evidence.json").write_text(
        json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8",
    )


@pytest.mark.parametrize("denoise", [0.0, 30.0, 70.0])
@pytest.mark.parametrize("offset", [-0.3, 0.0, 0.3])
def test_alpha_direct_giu_cung_roi_dpi_va_cubic_voi_preview(tmp_path, denoise, offset):
    source = _synthetic_pdf(tmp_path / "alpha.pdf", hole=True)
    geometry = _geometry(denoise, offset, fill_holes=False)
    with _source_session(source, tmp_path / "sessions") as session:
        snapshot = _snapshot(session, source, 2, geometry)
        with pikepdf.Pdf.open(source) as pdf:
            direct = build_classic_alpha_page_contour(str(source), 1, pdf.pages[1], **geometry)
        assert direct is not None
        assert direct.dpi == snapshot["dpi"]
        assert np.array_equal(direct.alpha, snapshot["alpha"])
        assert direct.path_groups == snapshot["path_groups"]
        assert sum(len(group["interiors"]) for group in direct.path_groups) == 1


@pytest.mark.parametrize("cut_mode,bleed", [("original", 0.0), ("original", 2.0), ("bleed", 2.0)])
def test_pdf_alpha_khong_doi_lenh_cat_khi_doi_trang_viewer(tmp_path, cut_mode, bleed):
    source = _synthetic_pdf(tmp_path / "alpha.pdf")
    geometry = _geometry()
    geometry.update(cut_mode=cut_mode, bleed_mm=bleed)
    with _source_session(source, tmp_path / "sessions") as session:
        snapshots = {page: _snapshot(session, source, page, geometry) for page in (1, 2)}
        results = []
        for active in (None, 1, 2):
            output = tmp_path / f"viewer_{active}.pdf"
            overrides = None if active is None else {active - 1: snapshots[active]}
            _export(source, output, geometry, overrides)
            results.append(_cut_hashes(output))
        assert results[0] == results[1] == results[2]


@pytest.mark.skipif(not BINDER2.is_file(), reason="Corpus Binder2 riêng không có trên máy này")
@pytest.mark.parametrize("page_number", [1, 5, 7, 8])
def test_binder2_trang_alpha_lien_giu_chinh_path_preview(tmp_path, page_number):
    geometry = _geometry()
    with _source_session(BINDER2, tmp_path / "sessions") as session:
        snapshot = _snapshot(session, BINDER2, page_number, geometry)
        with pikepdf.Pdf.open(BINDER2) as pdf:
            direct = build_classic_alpha_page_contour(
                str(BINDER2), page_number - 1, pdf.pages[page_number - 1], **geometry,
            )
        assert direct is not None
        assert np.array_equal(direct.alpha, snapshot["alpha"])
        assert direct.path_groups == snapshot["path_groups"]


def test_helper_khong_doi_trang_co_vector_hoac_khong_alpha(tmp_path):
    source = _synthetic_pdf(tmp_path / "alpha.pdf")
    changed = tmp_path / "with_vector.pdf"
    with pikepdf.Pdf.open(source) as pdf:
        page = pdf.pages[0]
        page.Contents = pdf.make_stream(page.Contents.read_bytes() + b"\n0 0 10 10 re S\n")
        del pdf.pages[1].Resources.XObject.Im0["/SMask"]
        pdf.save(changed)
    with pikepdf.Pdf.open(changed) as pdf:
        for index, page in enumerate(pdf.pages):
            assert build_classic_alpha_page_contour(str(changed), index, page, **_geometry()) is None


@pytest.mark.parametrize("rectangle,remove_bg", [(True, True), (False, False)])
def test_engine_khong_chay_helper_khi_hop_dong_la_kho_trang(tmp_path, monkeypatch, rectangle, remove_bg):
    source = _synthetic_pdf(tmp_path / "alpha.pdf")

    def forbidden(*args, **kwargs):
        raise AssertionError("Không được bóc Alpha khi phải giữ nguyên khổ trang")

    monkeypatch.setattr("app.workers.sticker_source_pipeline.build_classic_alpha_page_contour", forbidden)
    success, _ = engine_module.StickerEngine().process_pdf(
        input_path=str(source), output_path=str(tmp_path / "pagebox.pdf"),
        rectangle_mode=rectangle, remove_white_bg=remove_bg,
    )
    assert success


@pytest.mark.parametrize("shape", ["force_circle", "force_rect", "force_triangle"])
def test_engine_khong_ghi_de_hinh_nguoi_dung_chon(tmp_path, monkeypatch, shape):
    source = _synthetic_pdf(tmp_path / "alpha.pdf")

    def forbidden(*args, **kwargs):
        raise AssertionError("Không được thay hình ép bằng silhouette Alpha")

    monkeypatch.setattr("app.workers.sticker_source_pipeline.build_classic_alpha_page_contour", forbidden)
    success, _ = engine_module.StickerEngine().process_pdf(
        input_path=str(source), output_path=str(tmp_path / "forced.pdf"),
        remove_white_bg=True, shape_mode=shape,
    )
    assert success


def test_khong_coi_vung_nho_bi_filter_la_nguon_mot_tem(tmp_path):
    source = _synthetic_pdf(tmp_path / "alpha.pdf")
    changed = tmp_path / "island.pdf"
    with pikepdf.Pdf.open(source) as pdf:
        mask = pdf.pages[0].Resources.XObject.Im0.SMask
        alpha = np.frombuffer(mask.read_bytes(), dtype=np.uint8).reshape((340, 440)).copy()
        alpha[4:10, 4:10] = 255
        mask.write(alpha.tobytes())
        pdf.save(changed)
    with pikepdf.Pdf.open(changed) as pdf:
        assert build_classic_alpha_page_contour(str(changed), 0, pdf.pages[0], **_geometry()) is None


@pytest.mark.parametrize("failure", ["unsafe", "empty"])
def test_alpha_da_nhan_dien_khong_duoc_ne_guard_bang_legacy(tmp_path, monkeypatch, failure):
    from app.workers.sticker_source_pipeline import StickerSourcePipelineError

    source = _synthetic_pdf(tmp_path / "alpha.pdf")

    def rejected(*args, **kwargs):
        if failure == "unsafe":
            raise engine_module.UnsafeCutlineGeometryError("Quỹ đạo chưa an toàn")
        return None

    monkeypatch.setattr(engine_module, "build_alpha_cutline_geometry", rejected)
    with pikepdf.Pdf.open(source) as pdf, pytest.raises(StickerSourcePipelineError):
        build_classic_alpha_page_contour(str(source), 0, pdf.pages[0], **_geometry())


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--artifact-dir", type=Path, required=True)
    parser.add_argument("--simplify-mm", type=float, default=0.0)
    options = parser.parse_args()
    _write_binder2_artifacts(options.artifact_dir.resolve(), options.simplify_mm)
