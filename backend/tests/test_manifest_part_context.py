"""PERF (audit 2026-09-07 §TEMPERF.3): context khuôn phải bất biến và dùng thật."""

from __future__ import annotations

import copy
from dataclasses import FrozenInstanceError, fields, replace
from types import SimpleNamespace

import numpy as np
import pikepdf
import pypdfium2 as pdfium
import pytest

from app.core import nesting_preview_capacity as preview
from app.core.pdfium_lock import pdfium_guard
from app.workers import nup_artwork as artwork
from app.workers import nup_clip_shape as clip
from app.workers import nesting_imposition_render as writer
from app.workers.imposition_pdf_form import DIE_STRIPPED_FORM_VARIANT, PT_PER_MM
from app.workers.nesting_imposition_render import render_production_nesting
from tests.test_nesting_imposition_render import (
    LOCATOR, SHEET_H_MM, _make_full_ink_source, _manifest, _pose, _production,
)


@pytest.fixture()
def scene(tmp_path):
    source = tmp_path / "source.pdf"
    _make_full_ink_source(source)
    production = _production(source, quantity=8)
    manifest = _manifest(production, poses=[_pose(30 + index * 4, 45, 23.5) for index in range(8)])
    return source, production, manifest


def _prepare(part, production, side="cut"):
    factory = getattr(artwork, "prepare_manifest_part_context", None)
    assert callable(factory), "Cần factory context bất biến dùng chung preview/writer"
    return factory(part=part, side=side, render_bundle_hash=production.render_bundle_hash)


def _resolve(part, production, occurrence, side="cut", **overrides):
    kwargs = dict(
        part=part, placement=occurrence, side=side,
        sheet_frame=production.render_bundle["sheetFrames"][side],
        render_bundle_hash=production.render_bundle_hash,
    )
    kwargs.update(overrides)
    return artwork.resolve_manifest_artwork_placement(**kwargs)


def _project(production, manifest):
    job = SimpleNamespace(sheet_height_mm=SHEET_H_MM, parts=[SimpleNamespace(part_id="tem", page_index=0)])
    session = SimpleNamespace(solved=SimpleNamespace(production_request=production, manifest=manifest))
    return preview._project_sheet_cells(job, session)


def _payload(production):
    return dict(engineRequest=production.engine_request, renderBundle=production.render_bundle,
                renderBundleHash=production.render_bundle_hash)


@pytest.mark.parametrize("placement_count", [1, 8])
def test_preview_freezes_polygons_once_per_used_part(scene, monkeypatch, placement_count):
    _, production, manifest = scene
    manifest["placements"] = manifest["placements"][:placement_count]
    calls = []
    original = clip._manifest_ring
    def counted(*args, **kwargs):
        calls.append(kwargs["field"])
        return original(*args, **kwargs)
    monkeypatch.setattr(clip, "_manifest_ring", counted)
    cells = _project(production, manifest)
    assert len(cells) == placement_count
    assert len(calls) == 4, "Clip và CUT có một outer/một hole, chỉ parse một lần/khuôn"


@pytest.mark.parametrize("placement_count", [1, 8])
def test_writer_freezes_polygons_once_per_used_part_side(scene, monkeypatch, tmp_path, placement_count):
    source, production, manifest = scene
    manifest["placements"] = manifest["placements"][:placement_count]
    manifest["stats"]["placedCount"] = placement_count
    calls = []
    original = clip._manifest_ring
    def counted(*args, **kwargs):
        calls.append(kwargs["field"])
        return original(*args, **kwargs)
    monkeypatch.setattr(clip, "_manifest_ring", counted)
    result = render_production_nesting(
        production_request=_payload(production), manifest=manifest,
        source_paths={LOCATOR: source}, output_path=tmp_path / "output.pdf",
    )
    assert result.page_count == 2
    assert len(calls) == 6, "Front clip + CUT clip/contour không được parse theo từng ô"


def test_prepared_context_has_same_scalar_and_geometry_contract(scene):
    _, production, manifest = scene
    part = production.render_bundle["parts"][0]
    for side in ("front", "cut"):
        context = _prepare(part, production, side)
        for occurrence in manifest["placements"]:
            assert _resolve(context, production, occurrence, side) == _resolve(part, production, occurrence, side)
    context = _prepare(part, production)
    assert isinstance(context.cut_contour, clip.FrozenManifestPolygon)
    assert context.cut_contour.holes


def test_context_owns_nested_values_and_cannot_be_constructed_or_replaced(scene):
    _, production, manifest = scene
    part = copy.deepcopy(production.render_bundle["parts"][0])
    context = _prepare(part, production)
    before = _resolve(context, production, manifest["placements"][0])
    part["referencePointMm"][0] += 999
    part["source"]["revision"] = "changed"
    part["pages"]["cut"]["pageBoxesMm"]["mediaBox"][2] += 10
    part["artworkClipPath"]["outer"][0][0] += 11
    part["cutContour"]["holes"][0][0][0] += 12
    assert _resolve(context, production, manifest["placements"][0]) == before
    assert context.cut_contour.holes[0][0][0] != part["cutContour"]["holes"][0][0][0]
    with pytest.raises(FrozenInstanceError):
        context.part_id = "wrong"
    with pytest.raises((TypeError, ValueError)):
        replace(context, part_id="wrong")
    with pytest.raises((TypeError, ValueError)):
        type(context)(**{field.name: getattr(context, field.name) for field in fields(context)})


@pytest.mark.parametrize("field,value", [
    ("partId", "wrong"), ("sourceRevision", "wrong"), ("instanceId", ""),
    ("sheetIndex", True), ("extra", True),
    ("pose", {"rotationDeg": 360, "translateXmm": 0, "translateYmm": 0}),
])
def test_prepared_context_still_validates_every_occurrence(scene, field, value):
    _, production, manifest = scene
    context = _prepare(production.render_bundle["parts"][0], production)
    occurrence = {**manifest["placements"][0], field: value}
    with pytest.raises(ValueError):
        _resolve(context, production, occurrence)


def test_context_is_bound_to_bundle_side_and_sheet_frame_validation(scene):
    _, production, manifest = scene
    context = _prepare(production.render_bundle["parts"][0], production)
    occurrence = manifest["placements"][0]
    with pytest.raises(ValueError):
        _resolve(context, production, occurrence, "front")
    with pytest.raises(ValueError):
        _resolve(context, production, {**occurrence, "sourceRevision": "other"}, render_bundle_hash="other")
    with pytest.raises(ValueError):
        _resolve(context, production, occurrence, sheet_frame=[1, 0, 0, 1, float("nan"), 0])


@pytest.mark.parametrize("mutation", ["clip", "cut", "frozen_cut", "binding", "source", "schema"])
def test_context_factory_rejects_invalid_used_geometry_and_binding(scene, mutation):
    _, production, _ = scene
    part = copy.deepcopy(production.render_bundle["parts"][0])
    if mutation == "clip":
        part["artworkClipPath"]["outer"] = [[0, 0], [1, 1]]
    elif mutation == "cut":
        part["cutContour"]["holes"][0][0][0] = float("nan")
    elif mutation == "frozen_cut":
        part["cutContour"] = clip.FrozenManifestPolygon(outer=[[0, 0], [1, 1]], holes=[])
    elif mutation == "binding":
        part["pages"]["cut"]["pageIndex"] = True
    elif mutation == "source":
        part["source"]["revision"] = "changed"
    else:
        part["trusted"] = True
    with pytest.raises(ValueError):
        _prepare(part, production)


def test_unused_fields_keep_raw_public_compatibility(scene):
    _, production, manifest = scene
    part = copy.deepcopy(production.render_bundle["parts"][0])
    part["packingFootprint"] = "unused"
    part["geometryHash"] = None
    part["dieDimensionsMm"] = "report-only"
    part["source"]["byteSize"] = "unused"
    part["source"]["pageCount"] = "unused"
    part["pages"]["back"] = {"unused": True}
    part["cutContour"] = {"unused": True}
    raw = _resolve(part, production, manifest["placements"][0], "front")
    assert _resolve(_prepare(part, production, "front"), production, manifest["placements"][0], "front") == raw
    # Raw seam ở side=cut chưa đọc contour; consumer transform mới chịu trách nhiệm.
    assert _resolve(part, production, manifest["placements"][0]).side == "cut"


def test_factory_refreezes_nominal_frozen_polygon_to_remove_alias(scene):
    _, production, _ = scene
    part = copy.deepcopy(production.render_bundle["parts"][0])
    mutable_outer = part["artworkClipPath"]["outer"]
    part["artworkClipPath"] = clip.FrozenManifestPolygon(outer=mutable_outer, holes=[])
    context = _prepare(part, production)
    mutable_outer[0][0] += 321
    assert isinstance(context.artwork_clip_path.outer, tuple)
    assert context.artwork_clip_path.outer[0][0] != mutable_outer[0][0]


def _raw_reference_pdf(production, manifest, source, output):
    """Oracle giữ đường raw public: parse lại polygon mỗi placement như trước D."""
    bundle = production.render_bundle
    part = bundle["parts"][0]
    sheet = production.engine_request["sheet"]
    with pikepdf.Pdf.new() as doc:
        for side in bundle["outputSides"]:
            page = doc.add_blank_page(page_size=(sheet["widthMm"] * PT_PER_MM, sheet["heightMm"] * PT_PER_MM))
            cut_ops = ["q\n", writer._cut_stroke_prologue(bundle["cutStyle"], page=page)] if side == "cut" else []
            for occurrence in manifest["placements"]:
                resolved = _resolve(part, production, occurrence, side)
                if side == "cut":
                    rings = clip.transform_manifest_polygon_rings(
                        part["cutContour"], sheet_frame=resolved.sheet_frame,
                        pose=resolved.pose, reference_point_mm=resolved.reference_point_mm,
                        field="cutContour",
                    )
                    cut_ops.append(writer._cut_rings_stream(rings, origin=(0.0, 0.0)))
                else:
                    artwork.render_manifest_artwork(
                        doc, page, str(source), resolved,
                        form_variant=DIE_STRIPPED_FORM_VARIANT,
                        die_filter=bundle["cutStyle"]["sourceFilter"],
                    )
            if cut_ops:
                page.contents_add(pikepdf.Stream(doc, "".join([*cut_ops, "Q\n"]).encode("ascii")))
        doc.save(output)


def _raster_pages(path):
    pages = []
    with pdfium_guard():
        doc = pdfium.PdfDocument(path)
        try:
            for index in range(len(doc)):
                page = doc[index]
                try:
                    bitmap = page.render(scale=1.5)
                    try:
                        picture = bitmap.to_pil().convert("RGB")
                        try:
                            pages.append(np.array(picture))
                        finally:
                            picture.close()
                    finally:
                        bitmap.close()
                finally:
                    page.close()
        finally:
            doc.close()
    return pages


def test_preview_and_writer_keep_raw_coordinates_and_all_artifact_pixels(scene, tmp_path):
    source, production, manifest = scene
    part = production.render_bundle["parts"][0]
    expected_rings = []
    for occurrence in manifest["placements"]:
        resolved = _resolve(part, production, occurrence)
        expected_rings.append(clip.transform_manifest_polygon_rings(
            part["cutContour"], sheet_frame=resolved.sheet_frame,
            pose=resolved.pose, reference_point_mm=resolved.reference_point_mm,
            field="cutContour",
        ))
    cells = _project(production, manifest)
    for cell, rings in zip(cells, expected_rings, strict=True):
        expected = [
            [[x * PT_PER_MM, (SHEET_H_MM - y) * PT_PER_MM] for x, y in ring]
            for ring in rings
        ]
        assert np.asarray(cell["diePolylines"]) == pytest.approx(np.asarray(expected), abs=1e-12)
    before = tmp_path / "raw-reference.pdf"
    after = tmp_path / "prepared-writer.pdf"
    _raw_reference_pdf(production, manifest, source, before)
    render_production_nesting(
        production_request=_payload(production), manifest=manifest,
        source_paths={LOCATOR: source}, output_path=after,
    )
    for expected, actual in zip(_raster_pages(before), _raster_pages(after), strict=True):
        assert np.array_equal(actual, expected), "Mọi pixel artwork/CUT phải giữ nguyên, kể cả lỗ"


@pytest.mark.parametrize("field,value", [
    ("instanceId", ""), ("sourceRevision", "wrong"),
    ("pose", {"rotationDeg": 9, "translateXmm": True, "translateYmm": 0}),
])
def test_warm_context_does_not_hide_late_invalid_placement(scene, tmp_path, field, value):
    source, production, manifest = scene
    manifest["placements"][-1][field] = value
    with pytest.raises(ValueError):
        _project(production, manifest)
    output = tmp_path / "invalid.pdf"
    with pytest.raises(ValueError):
        render_production_nesting(
            production_request=_payload(production), manifest=manifest,
            source_paths={LOCATOR: source}, output_path=output,
        )
    assert not output.exists()


def test_unused_part_is_not_new_validation_gate(scene, tmp_path):
    source, production, manifest = scene
    unused = copy.deepcopy(production.render_bundle["parts"][0])
    unused.update(partId="unused", artworkClipPath=None, cutContour=None)
    production.render_bundle["parts"].append(unused)
    assert len(_project(production, manifest)) == len(manifest["placements"])
    result = render_production_nesting(
        production_request=_payload(production), manifest=manifest,
        source_paths={LOCATOR: source}, output_path=tmp_path / "unused.pdf",
    )
    assert result.page_count == 2
