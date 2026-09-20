"""Hồi quy crop đồng khổ và dồn khối theo số lượng thực dùng (2026-09-19)."""

from __future__ import annotations

import copy

import pikepdf
import pytest

from app.api.routes.document_tools import _get_pdf_meta
from app.api.routes.imposition import PreviewLayoutRequest, preview_layout
from app.workers import nup_engine, pdf_wrapper as pdf_lib
from app.workers.mixed_guillotine import (
    MixedGuillotineSettings, ProductSpec, Rect, _choose_candidate,
    _materialize_template, _tree_cut_lines, build_mixed_guillotine_plan,
    project_template_face, validate_guillotine_plan,
)
from app.workers.mixed_guillotine_adapter import resolve_guillotine_trim
from tests.license_helpers import PRO_LICENSE

MM = 72.0 / 25.4


def _crop_source(path, *, uniform_media=False, explicit_trim=False, different_crop=False):
    # Cùng dạng PageBox với file ảnh đã chỉnh về 30 × 40 mm; không lưu ảnh cá nhân.
    media_boxes = [
        [-5.44, 0, 92.53, 126.69],
        [-5.62, 0, 94.38, 128.33],
        [-2.14, 0, 87.68, 118.71],
        [0, 0, 30 * MM, 40 * MM],
    ]
    origins = [(1.13, 1.66), (1.84, 10.03), (0.22, 2.73), (0, 0)]
    with pikepdf.Pdf.new() as pdf:
        for index, (media, (x, y)) in enumerate(zip(media_boxes, origins)):
            if uniform_media:
                media, x, y = [0, 0, 98, 127], 5, 5
            page = pdf.add_blank_page(page_size=(media[2] - media[0], media[3] - media[1]))
            width = (28 if different_crop and index == 1 else 30) * MM
            crop = [x, y, x + width, y + 40 * MM]
            page.MediaBox = pikepdf.Array(media)
            page.CropBox = pikepdf.Array(crop)
            if explicit_trim:
                page.TrimBox = pikepdf.Array(crop)
            page.Contents = pdf.make_stream(
                f"0 0 1 rg {x} {y} {width} {40 * MM} re f\n".encode()
            )
        pdf.save(path)
    return str(path)


def _preview(source, count=4):
    return preview_layout(PreviewLayoutRequest(
        usable_w=320 * MM, usable_h=470 * MM,
        sheet_w=330 * MM, sheet_h=480 * MM,
        margin_left=5 * MM, margin_right=5 * MM,
        margin_top=5 * MM, margin_bottom=5 * MM,
        item_w=30 * MM, item_h=40 * MM,
        gap_x=0, gap_y=0, bleed=0,
        strategy="optimal_auto", shape_type="CUSTOM",
        path=source, task_mode="nup", layout_type="sequential",
        is_die_cut=False, total_pages=count, target_quantity=1,
    ), PRO_LICENSE)


def test_uniform_crop_mixed_media_metadata_does_not_invent_bleed(tmp_path):
    source = _crop_source(tmp_path / "cropped-portraits.pdf")
    meta = _get_pdf_meta({"path": source})
    for page in meta["pages"]:
        assert page["guillotine_width_pt"] == pytest.approx(30 * MM, abs=0.001)
        assert page["guillotine_height_pt"] == pytest.approx(40 * MM, abs=0.001)
    assert meta["detected_bleed_mm"] == 0


def test_uniform_crop_mixed_media_preview_and_export_share_size(tmp_path):
    source = _crop_source(tmp_path / "cropped-portraits.pdf")
    result = _preview(source)
    assert result["totalItems"] == 4
    assert {cell["pageIdx"] for cell in result["cells"]} == set(range(4))
    for cell in result["cells"]:
        assert sorted([cell["width"], cell["height"]]) == pytest.approx([30 * MM, 40 * MM])

    output = tmp_path / "imposed.pdf"
    nup_engine.run_nup_engine(source, str(output), {
        "imposerMode": "guillotine", "isDieCutMode": False,
        "taskMode": "nup", "layoutType": "sequential",
        "sheetWidth": 330, "sheetHeight": 480, "gridStrategy": "optimal_auto",
        "targetQuantity": 1, "targetQuantitiesByPage": {},
        "marginLeft": 5, "marginRight": 5, "marginTop": 5, "marginBottom": 5,
        "gripperMargin": 0, "gapX": 0, "gapY": 0, "bleed": 0,
        "markType": "none", "pontType": "none", "align": "center",
    }, job_id="crop-quantity-regression")
    with pikepdf.Pdf.open(output) as pdf:
        assert len(pdf.pages) == 1
        assert sum(str(op.operator) == "Do"
                   for op in pikepdf.parse_content_stream(pdf.pages[0])) == 4


@pytest.mark.parametrize("options", [
    {"uniform_media": True}, {"explicit_trim": True}, {"different_crop": True},
])
def test_crop_consensus_does_not_override_production_boxes_or_mixed_crops(tmp_path, options):
    source = _crop_source(tmp_path / "keep-policy.pdf", **options)
    doc = pdf_lib.open(source)
    try:
        assert resolve_guillotine_trim(doc[0], 0) == pytest.approx(
            (doc[0].mediabox.width, doc[0].mediabox.height)
        )
    finally:
        doc.close()


def test_uniform_crop_still_respects_ui_bleed_and_canonicalization(tmp_path):
    source = _crop_source(tmp_path / "cropped-source.pdf")
    with nup_engine.canonical_page_space(source, "crop-regression") as canonical:
        doc = pdf_lib.open(canonical)
        try:
            for index in range(doc.page_count):
                assert resolve_guillotine_trim(doc[index], 2 * MM) == pytest.approx(
                    (26 * MM, 36 * MM), abs=0.001,
                )
        finally:
            doc.close()


def _nodes(node):
    yield node
    if node["kind"] == "split":
        yield from _nodes(node["first"])
        yield from _nodes(node["second"])


def _mixed_settings(duplex=False, flip_edge="long"):
    return MixedGuillotineSettings(
        sheet_width=330 * MM, sheet_height=480 * MM,
        usable_rect=Rect(5 * MM, 5 * MM, 320 * MM, 470 * MM),
        gap_x=2 * MM, gap_y=2 * MM, split_gap=6 * MM,
        duplex=duplex, flip_edge=flip_edge,
    )


@pytest.mark.parametrize("duplex,flip_edge", [(False, "long"), (True, "long"), (True, "short")])
def test_one_copy_per_type_has_no_reserved_empty_grid(duplex, flip_edge):
    products = [
        ProductSpec(i, i * 2 if duplex else i, (30 + i % 3) * MM,
                    (40 + i % 4) * MM, requested_quantity=1,
                    back_page_idx=i * 2 + 1 if duplex else None)
        for i in range(11)
    ]
    plan = build_mixed_guillotine_plan(products, _mixed_settings(duplex, flip_edge))
    assert len(plan["templates"]) == 1
    template = plan["templates"][0]
    assert len(template["placements"]) == 11
    assert template["runCount"] == 1
    zones = [node for node in _nodes(template["cutTree"]) if node["kind"] == "zone"]
    assert len(zones) == 11
    for zone in zones:
        grid = zone["grid"]
        assert (grid["cols"], grid["rows"], grid["capacity"]) == (1, 1, 1)
        assert grid["occupiedSlots"] == [0]
        assert grid["contentRect"]["width"] == pytest.approx(grid["itemWidth"])
        assert grid["contentRect"]["height"] == pytest.approx(grid["itemHeight"])
    assert template["cutLines"] == _tree_cut_lines(template["cutTree"])
    placements = template["placements"]
    width = max(p["x"] + p["width"] for p in placements) - min(p["x"] for p in placements)
    height = max(p["y"] + p["height"] for p in placements) - min(p["y"] for p in placements)
    assert width * height < 0.25 * 320 * 470 * MM * MM
    validate_guillotine_plan(plan)
    if duplex:
        back = project_template_face(template, side="back", sheet_width=plan["sheetWidth"],
                                     sheet_height=plan["sheetHeight"], flip_edge=flip_edge)
        back_by_id = {p["placementId"]: p for p in back["placements"]}
        for front in placements:
            mirrored = back_by_id[front["placementId"]]
            axis = "x" if flip_edge == "long" else "y"
            size = "width" if axis == "x" else "height"
            span = plan["sheetWidth"] if axis == "x" else plan["sheetHeight"]
            assert mirrored[axis] == pytest.approx(span - front[axis] - front[size])


def test_partial_template_compacts_without_mutating_reusable_candidate():
    products = [ProductSpec(i, i, 30 * MM, 40 * MM) for i in range(3)]
    candidate = _choose_candidate(products, _mixed_settings(), {i: 50 for i in range(3)})
    before = copy.deepcopy(candidate)
    counts = {0: 1, 1: 3, 2: 7}
    template = _materialize_template(candidate, counts, 1, 1)
    assert candidate == before
    assert len(template["placements"]) == 11
    for zone in _nodes(template["cutTree"]):
        if zone["kind"] != "zone":
            continue
        grid = zone["grid"]
        count = counts[zone["productId"]]
        assert grid["cols"] <= count
        assert grid["rows"] == (count + grid["cols"] - 1) // grid["cols"]
        assert grid["occupiedSlots"] == list(range(count))
    assert template["cutLines"] == _tree_cut_lines(template["cutTree"])
