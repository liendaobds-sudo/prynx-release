from __future__ import annotations

import hashlib

import pdfcompare_native
import pikepdf
import pytest
from pypdf import PdfReader

from app.api.routes.imposition import (
    PreviewLayoutBatchRequest,
    preview_layouts_batch,
)
from app.workers import nup_engine, pdf_wrapper as pdf_lib
from tests.license_helpers import PRO_LICENSE
from app.workers.page_sheet_geometry import resolve_page_sheet_geometry


MM_TO_PT = 2.83465

PONT_CONFIG = {
    "shape": "circle",
    "size": 5.0,
    "thickness": 0.5,
    "marginTop": 7.0,
    "marginBottom": 7.0,
    "marginLeft": 7.0,
    "marginRight": 7.0,
    "disableCollision": True,
    "layerName": "Marks_Model_",
    "groupName": "MarkLine",
    "itemName": "MKLINE",
}


def _make_layered_page(
    path,
    *,
    width_mm: float = 154,
    height_mm: float = 216,
    artwork_rect=(20, 20, 180, 120),
    cut_rect=(18, 18, 184, 124),
) -> None:
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(
        page_size=(width_mm * MM_TO_PT, height_mm * MM_TO_PT),
    )
    ocg = pdf.make_indirect(pikepdf.Dictionary({
        "/Type": pikepdf.Name("/OCG"),
        "/Name": pikepdf.String("Artwork"),
    }))
    pdf.Root["/OCProperties"] = pikepdf.Dictionary({
        "/OCGs": pikepdf.Array([ocg]),
        "/D": pikepdf.Dictionary({
            "/Order": pikepdf.Array([ocg]),
            "/ON": pikepdf.Array([ocg]),
            "/OFF": pikepdf.Array([]),
        }),
    })
    tint_transform = pikepdf.Dictionary({
        "/FunctionType": 2,
        "/Domain": pikepdf.Array([0, 1]),
        "/C0": pikepdf.Array([0, 0, 0, 0]),
        "/C1": pikepdf.Array([0, 1, 0, 0]),
        "/N": 1,
    })

    artwork_x, artwork_y, artwork_w, artwork_h = artwork_rect
    clip_w = width_mm * MM_TO_PT - 20
    clip_h = height_mm * MM_TO_PT - 20
    artwork_stream = (
        b"/OC /Artwork BDC\n"
        + f"q\n10 10 {clip_w} {clip_h} re W n\n".encode("ascii")
        + b"/GSalpha gs\n"
        + b"0 0 0 1 k\n"
        + (
            f"{artwork_x} {artwork_y} {artwork_w} {artwork_h} re f\n"
        ).encode("ascii")
        + b"Q\nEMC\n"
    )
    artwork_form = pikepdf.Stream(pdf, artwork_stream)
    artwork_form["/Type"] = pikepdf.Name("/XObject")
    artwork_form["/Subtype"] = pikepdf.Name("/Form")
    artwork_form["/BBox"] = pikepdf.Array([
        0, 0, width_mm * MM_TO_PT, height_mm * MM_TO_PT,
    ])
    artwork_form["/Resources"] = pikepdf.Dictionary({
        "/Properties": pikepdf.Dictionary({"/Artwork": ocg}),
        "/ExtGState": pikepdf.Dictionary({
            "/GSalpha": pikepdf.Dictionary({
                "/Type": pikepdf.Name("/ExtGState"),
                "/CA": 0.75,
                "/ca": 0.75,
                "/BM": pikepdf.Name("/Multiply"),
            }),
        }),
    })

    cut_x, cut_y, cut_w, cut_h = cut_rect
    page.Resources = pikepdf.Dictionary({
        "/XObject": pikepdf.Dictionary({"/FmArtwork": artwork_form}),
        "/ColorSpace": pikepdf.Dictionary({
            "/CutContour": pikepdf.Array([
                pikepdf.Name("/Separation"),
                pikepdf.Name("/CutContour"),
                pikepdf.Name("/DeviceCMYK"),
                tint_transform,
            ]),
        }),
    })
    page.Contents = pikepdf.Stream(
        pdf,
        (
            b"q /FmArtwork Do Q\n"
            + (
                f"/CutContour CS 1 SCN "
                f"{cut_x} {cut_y} {cut_w} {cut_h} re S\n"
            ).encode("ascii")
        ),
    )
    # Deliberately conflicting boxes: page-sheet geometry follows MediaBox
    # and the bleed value entered by the user.
    page.TrimBox = pikepdf.Array([10, 10, 300, 400])
    page.BleedBox = pikepdf.Array([5, 5, 320, 420])
    pdf.save(path)
    pdf.close()


def _settings(**overrides):
    settings = {
        "page_sheet_mode": True,
        "isDieCutMode": True,  # backend must override this before every gate
        "sheetWidth": 310,
        "sheetHeight": 434,
        "layoutType": "repeat",
        "gridStrategy": "manual",
        "cols": 2,
        "rows": 2,
        "targetQuantity": 4,
        "targetQuantitiesByPage": {},
        "bleed": 3,
        "gapX": 0,
        "gapY": 0,
        "marginTop": 0,
        "marginBottom": 0,
        "marginLeft": 0,
        "marginRight": 0,
        "markType": "none",
        "pontType": "none",
        "pontConfig": None,
        "cutType": "one_dao",
        # page_sheet_mode must force this on even if stale profile state is off.
        "separateCutPage": False,
        "pontsOnCutFile": True,
        "duplexFlow": "double",
    }
    settings.update(overrides)
    return settings


def _vector_paths(path, page_index):
    doc = pdf_lib.open(str(path))
    try:
        return doc[page_index].extract_vector_paths()
    finally:
        doc.close()


def _matching_path_count(paths, width, height, *, tolerance=1.0):
    return sum(
        abs(path["rect"].width - width) <= tolerance
        and abs(path["rect"].height - height) <= tolerance
        for path in paths
    )


def _count_circle_ponts(paths):
    pont_size = PONT_CONFIG["size"] * MM_TO_PT
    return sum(
        path.get("fill") is not None
        and abs(path["rect"].width - pont_size) <= 1.0
        and abs(path["rect"].height - pont_size) <= 1.0
        for path in paths
    )


def test_resolver_uses_only_source_size_and_user_bleed():
    geo = resolve_page_sheet_geometry(154 * MM_TO_PT, 216 * MM_TO_PT, 3 * MM_TO_PT)
    assert geo.trim_width / MM_TO_PT == pytest.approx(148)
    assert geo.trim_height / MM_TO_PT == pytest.approx(210)

    same_input = resolve_page_sheet_geometry(154 * MM_TO_PT, 216 * MM_TO_PT, 0)
    assert same_input.trim_width / MM_TO_PT == pytest.approx(154)
    assert same_input.trim_height / MM_TO_PT == pytest.approx(216)


@pytest.mark.parametrize("bleed", [-1, float("nan"), float("inf"), 77])
def test_resolver_rejects_invalid_bleed(bleed):
    with pytest.raises(ValueError, match="Bleed|bleed"):
        resolve_page_sheet_geometry(154, 216, bleed)


def test_normalization_forces_separate_cut_and_preserves_pont_configuration():
    pont_config = dict(PONT_CONFIG)
    normalized, enabled = nup_engine._normalize_page_sheet_settings(
        _settings(
            pontType="corner",
            pontConfig=pont_config,
            pontsOnCutFile=False,
            separateCutPage=False,
        ),
    )
    assert enabled is True
    assert normalized["isDieCutMode"] is False
    assert normalized["cutType"] == "default"
    assert normalized["separateCutPage"] is True
    assert normalized["pontType"] == "corner"
    assert normalized["pontConfig"] == pont_config
    assert normalized["pontsOnCutFile"] is False
    assert normalized["duplexFlow"] == "normal"

    with pytest.raises(ValueError, match="CNC"):
        nup_engine._normalize_page_sheet_settings(_settings(imposerMode="cnc"))
    with pytest.raises(ValueError, match="CNC"):
        nup_engine._normalize_page_sheet_settings(_settings(taskMode="cnc_imposer"))


def test_page_sheet_separates_print_and_cut_preserving_source_form_resources(tmp_path):
    source = tmp_path / "layered-source.pdf"
    output = tmp_path / "page-sheet-out.pdf"
    _make_layered_page(source)
    before_hash = hashlib.sha256(source.read_bytes()).hexdigest()

    with pikepdf.open(source) as source_pdf:
        source_page_stream = source_pdf.pages[0].Contents.read_bytes()
        source_artwork_form = (
            source_pdf.pages[0].Resources["/XObject"]["/FmArtwork"]
        )
        source_artwork_stream = source_artwork_form.read_bytes()
        source_spot = source_pdf.pages[0].Resources["/ColorSpace"]["/CutContour"]
        assert str(source_spot[1]) == "/CutContour"

    nup_engine.run_nup_engine(
        str(source),
        str(output),
        _settings(),
        job_id="page-sheet-2x2",
    )

    # The worker may strip its in-memory print copy, but the input file and its
    # original page/Form streams must remain byte-for-byte intact on disk.
    assert hashlib.sha256(source.read_bytes()).hexdigest() == before_hash
    with pikepdf.open(source) as source_pdf:
        assert source_pdf.pages[0].Contents.read_bytes() == source_page_stream
        assert (
            source_pdf.pages[0]
            .Resources["/XObject"]["/FmArtwork"]
            .read_bytes()
            == source_artwork_stream
        )

    with pikepdf.open(output) as pdf:
        assert len(pdf.pages) == 2
        print_page, cut_page = pdf.pages

        print_instructions = pikepdf.parse_content_stream(print_page)
        assert sum(
            str(instruction.operator) == "Do"
            for instruction in print_instructions
        ) == 4
        assert sum(
            str(instruction.operator) == "W"
            for instruction in print_instructions
        ) == 4

        top_forms = [
            obj
            for _, obj in print_page.Resources.get("/XObject", {}).items()
            if str(obj.get("/Subtype", "")) == "/Form"
        ]
        assert len(top_forms) == 1
        page_form = top_forms[0]
        assert b"/FmArtwork Do" in page_form.read_bytes()
        # The precise stripper intentionally keeps color selection and path
        # construction tokens, then removes only the paint operator. That
        # preserves resources while making the contour non-printing.
        paint_operators = {"S", "s", "f", "F", "f*", "B", "B*", "b", "b*"}
        assert not any(
            str(instruction.operator) in paint_operators
            for instruction in pikepdf.parse_content_stream(page_form)
        )

        # Removing the print-only CutContour operator must not flatten,
        # rasterize, or rewrite the nested artwork Form and its resources.
        nested_form = page_form["/Resources"]["/XObject"]["/FmArtwork"]
        assert nested_form.read_bytes() == source_artwork_stream
        assert b"/OC /Artwork BDC" in nested_form.read_bytes()
        assert b" re W n" in nested_form.read_bytes()
        assert b"/GSalpha gs" in nested_form.read_bytes()
        ext_gstate = nested_form["/Resources"]["/ExtGState"]["/GSalpha"]
        assert float(ext_gstate["/ca"]) == pytest.approx(0.75)
        assert str(ext_gstate["/BM"]) == "/Multiply"

        # Resource dictionaries remain available on the copied page Form even
        # though the CutContour painting instruction was removed from print.
        spot = page_form["/Resources"]["/ColorSpace"]["/CutContour"]
        assert str(spot[0]) == "/Separation"
        assert str(spot[1]) == "/CutContour"
        assert str(spot[2]) == "/DeviceCMYK"

        root_ocgs = list(pdf.Root["/OCProperties"]["/OCGs"])
        form_ocg = nested_form["/Resources"]["/Properties"]["/Artwork"]
        assert any(ocg.objgen == form_ocg.objgen for ocg in root_ocgs)
        assert str(form_ocg.get("/Name", "")) == "Artwork"

        cut_layer_names = {
            str(ocg.get("/Name", ""))
            for ocg in pdf.Root["/OCProperties"]["/OCGs"]
        }
        assert "Result_Cutline_Model_1" in cut_layer_names
        assert not cut_page.Resources.get("/XObject", {})

    print_paths = _vector_paths(output, 0)
    cut_paths = _vector_paths(output, 1)
    assert not any(path.get("spot_name") == "CutContour" for path in print_paths)
    assert _matching_path_count(print_paths, 180, 120) == 4
    assert _matching_path_count(cut_paths, 184, 124) == 4


def test_a4_landscape_rotation_into_a3_rotates_artwork_and_cut_geometry(tmp_path):
    source = tmp_path / "a4-landscape-with-cut.pdf"
    output = tmp_path / "a3-portrait-output.pdf"
    _make_layered_page(
        source,
        width_mm=303,
        height_mm=216,
        artwork_rect=(100, 180, 500, 200),
        cut_rect=(80, 120, 420, 70),
    )

    nup_engine.run_nup_engine(
        str(source),
        str(output),
        _settings(
            sheetWidth=297,
            sheetHeight=420,
            gridStrategy="optimal_auto",
            cols=1,
            rows=1,
            targetQuantity=1,
            marginTop=10,
            marginBottom=10,
            marginLeft=10,
            marginRight=10,
        ),
        job_id="page-sheet-a4-rotate",
    )

    with pikepdf.open(output) as pdf:
        assert len(pdf.pages) == 2

    print_paths = _vector_paths(output, 0)
    cut_paths = _vector_paths(output, 1)

    # A4 landscape cannot fit the 277 mm usable A3 width unrotated. Both the
    # artwork Form and its extracted die path must therefore use the same 90°.
    assert _matching_path_count(print_paths, 200, 500) == 1
    assert _matching_path_count(cut_paths, 70, 420) == 1
    assert _matching_path_count(cut_paths, 420, 70) == 0


@pytest.mark.parametrize("ponts_on_cut_file", [False, True])
def test_ponts_are_on_print_and_optional_on_cut_page(
    tmp_path,
    ponts_on_cut_file,
):
    source = tmp_path / f"pont-source-{ponts_on_cut_file}.pdf"
    output = tmp_path / f"pont-output-{ponts_on_cut_file}.pdf"
    _make_layered_page(source)

    nup_engine.run_nup_engine(
        str(source),
        str(output),
        _settings(
            sheetWidth=180,
            sheetHeight=240,
            cols=1,
            rows=1,
            targetQuantity=1,
            pontType="corner",
            pontConfig=dict(PONT_CONFIG),
            pontsOnCutFile=ponts_on_cut_file,
            separateCutPage=False,
        ),
        job_id=f"page-sheet-ponts-{ponts_on_cut_file}",
    )

    expected_cut_ponts = 4 if ponts_on_cut_file else 0
    with pikepdf.open(output) as pdf:
        assert len(pdf.pages) == 2
        for page_index, expected_named_items in (
            (0, 4),
            (1, expected_cut_ponts),
        ):
            page = pdf.pages[page_index]
            properties = page.Resources.get("/Properties", {})
            span_properties = [
                str(instruction.operands[1])
                for instruction in pikepdf.parse_content_stream(page)
                if (
                    str(instruction.operator) == "BDC"
                    and len(instruction.operands) == 2
                    and str(instruction.operands[0]) == "/Span"
                )
            ]
            assert len(span_properties) == expected_named_items
            for property_name in span_properties:
                prop = properties[pikepdf.Name(property_name)]
                assert str(prop.get("/NM", "")) == PONT_CONFIG["itemName"]

    assert _count_circle_ponts(_vector_paths(output, 0)) == 4
    assert _count_circle_ponts(_vector_paths(output, 1)) == expected_cut_ponts



def test_batch_capacity_schema_and_pont_collision_never_increase_capacity(
    tmp_path,
):
    source = tmp_path / "batch-capacity-source.pdf"
    _make_layered_page(source)
    sheet_w = 310 * MM_TO_PT
    sheet_h = 434 * MM_TO_PT
    page = {
        "page_idx": 0,
        "item_w": 154 * MM_TO_PT,
        "item_h": 216 * MM_TO_PT,
    }
    common = {
        "usable_w": sheet_w,
        "usable_h": sheet_h,
        "gap_x": 0.0,
        "gap_y": 0.0,
        "strategy": "optimal_auto",
        "pages": [page],
        "path": str(source),
        "bleed": 3 * MM_TO_PT,
        "task_mode": "nup",
        "is_die_cut": False,
        "page_sheet_mode": True,
        "sheet_w": sheet_w,
        "sheet_h": sheet_h,
        "margin_left": 0.0,
        "margin_right": 0.0,
        "margin_top": 0.0,
        "margin_bottom": 0.0,
    }

    without_ponts = PreviewLayoutBatchRequest(**common)
    dumped = without_ponts.model_dump()
    assert dumped["page_sheet_mode"] is True
    assert dumped["sheet_w"] == pytest.approx(sheet_w)
    assert dumped["sheet_h"] == pytest.approx(sheet_h)
    assert dumped["margin_left"] == 0
    assert dumped["margin_right"] == 0
    assert dumped["margin_top"] == 0
    assert dumped["margin_bottom"] == 0

    colliding_ponts = PreviewLayoutBatchRequest(
        **common,
        pont_config={
            **PONT_CONFIG,
            "size": 20.0,
            "marginTop": 0.0,
            "marginBottom": 0.0,
            "marginLeft": 0.0,
            "marginRight": 0.0,
            "disableCollision": False,
        },
    )
    base_capacity = preview_layouts_batch(
        without_ponts,
        PRO_LICENSE,
    )["capacities"][0]
    collision_capacity = preview_layouts_batch(
        colliding_ponts,
        PRO_LICENSE,
    )["capacities"][0]

    assert base_capacity > 0
    assert collision_capacity <= base_capacity

def test_guillotine_marks_share_only_zero_gap_edges():
    def marks_for_gap(gap):
        placements = []
        for row in range(2):
            for col in range(2):
                placements.append({
                    "cluster_idx": 0,
                    "abs_x": col * (100 + gap),
                    "abs_y": row * (100 + gap),
                    "original_cell_y": row * (100 + gap),
                    "width": 100,
                    "height": 100,
                    "cell": {"blockId": 0},
                })
        return pdfcompare_native.compute_mark_coords(
            placements, "guillotine", 8, 5, 0,
        )

    shared_edge_marks = marks_for_gap(0)
    split_edge_marks = marks_for_gap(10)
    assert len(shared_edge_marks) == 12
    assert len(split_edge_marks) == 16


def test_report_contains_whole_sheet_dimensions_gap_quantity_and_mode(tmp_path):
    source = tmp_path / "report-source.pdf"
    output = tmp_path / "report-output.pdf"
    _make_layered_page(source)
    report_display = {
        "enabled": True,
        "fieldOrder": [
            "identifier",
            "gangCount",
            "labelName",
            "dimensions",
            "paperSize",
            "labelsPerSheet",
            "sheetCount",
            "modeLabel",
        ],
        "showIdentifier": True,
        "showGangCount": True,
        "showLabelName": True,
        "showDimensions": True,
        "showPaperSize": True,
        "showLabelsPerSheet": True,
        "showSheetCount": True,
        "showModeLabel": True,
        "labelNameText": "QA page sheet",
        "position": "top",
        "fontSize": 8,
        "centered": True,
        "offsetX": 5,
        "offsetY": 5,
        "removeDiacritics": True,
    }
    nup_engine.run_nup_engine(
        str(source),
        str(output),
        _settings(
            sheetWidth=180,
            sheetHeight=240,
            cols=1,
            rows=1,
            targetQuantity=1,
            gapX=5,
            gapY=7,
            reportDisplay=report_display,
        ),
        job_id="page-sheet-report",
    )

    text = PdfReader(str(output)).pages[0].extract_text() or ""
    assert "Binh nguyen tam decal" in text
    assert "148 x 210 mm" in text
    # gapX/gapY không còn nhét vào identifier (field 「Mẫu/Trang」) — intentional product.
    assert "Khoang cach tam" not in text
    assert "SL yeu cau: 1" in text or "SL/to: 1" in text
    assert "1 mau" in text


def test_multi_sample_rejects_different_media_sizes_even_with_cluster(tmp_path):
    source = tmp_path / "mixed-media.pdf"
    output = tmp_path / "mixed-media-out.pdf"
    pdf = pikepdf.Pdf.new()
    first = pdf.add_blank_page(page_size=(154 * MM_TO_PT, 216 * MM_TO_PT))
    second = pdf.add_blank_page(page_size=(120 * MM_TO_PT, 180 * MM_TO_PT))
    # Matching TrimBox metadata must not override the user-defined
    # MediaBox-plus-bleed rule.
    shared_trim = pikepdf.Array([0, 0, 100 * MM_TO_PT, 160 * MM_TO_PT])
    first.TrimBox = shared_trim
    second.TrimBox = shared_trim
    pdf.save(source)
    pdf.close()

    with pytest.raises(ValueError, match="Bình nguyên tấm decal"):
        nup_engine.run_nup_engine(
            str(source),
            str(output),
            _settings(
                layoutType="sequential",
                groupingStrategy="cluster_tile",
                targetQuantitiesByPage={"0": 1, "1": 1},
            ),
            job_id="page-sheet-mixed-size",
        )
