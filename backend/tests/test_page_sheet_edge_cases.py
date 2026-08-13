from __future__ import annotations

import hashlib

import pikepdf
import pytest

from app.workers import nup_engine, pdf_wrapper as pdf_lib


MM_TO_PT = 2.83465
PAGE_W = 154 * MM_TO_PT
PAGE_H = 216 * MM_TO_PT


def _cut_contour_colorspace():
    return pikepdf.Array([
        pikepdf.Name("/Separation"),
        pikepdf.Name("/CutContour"),
        pikepdf.Name("/DeviceCMYK"),
        pikepdf.Dictionary({
            "/FunctionType": 2,
            "/Domain": pikepdf.Array([0, 1]),
            "/C0": pikepdf.Array([0, 0, 0, 0]),
            "/C1": pikepdf.Array([0, 1, 0, 0]),
            "/N": 1,
        }),
    ])


def _make_form(pdf, stream: bytes, *, resources=None):
    form = pikepdf.Stream(pdf, stream)
    form["/Type"] = pikepdf.Name("/XObject")
    form["/Subtype"] = pikepdf.Name("/Form")
    form["/BBox"] = pikepdf.Array([0, 0, PAGE_W, PAGE_H])
    if resources is not None:
        form["/Resources"] = resources
    return form


def _settings(**overrides):
    settings = {
        "page_sheet_mode": True,
        "isDieCutMode": True,
        "sheetWidth": 180,
        "sheetHeight": 240,
        "layoutType": "repeat",
        "gridStrategy": "manual",
        "cols": 1,
        "rows": 1,
        "targetQuantity": 1,
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
        "cutType": "default",
        "separateCutPage": True,
        "duplexFlow": "normal",
    }
    settings.update(overrides)
    return settings


def _paths(path, page_index):
    doc = pdf_lib.open(str(path))
    try:
        return doc[page_index].extract_vector_paths()
    finally:
        doc.close()


def _matches_size(path, width, height, tolerance=1.0):
    return (
        abs(path["rect"].width - width) <= tolerance
        and abs(path["rect"].height - height) <= tolerance
    )


def _count_size(paths, width, height):
    return sum(_matches_size(path, width, height) for path in paths)


def _count_painted_rect_items(paths, width, height, tolerance=1.0):
    count = 0
    for path in paths:
        for item in path.get("items", []):
            if not item or item[0] != "re":
                continue
            rect = item[1]
            if (
                abs(rect.width - width) <= tolerance
                and abs(rect.height - height) <= tolerance
            ):
                count += 1
    return count


def _spot_paths(paths, spot_name="CutContour"):
    return [
        path
        for path in paths
        if str(path.get("spot_name") or "").lower() == spot_name.lower()
    ]


def _make_two_pages_with_one_shared_cut_form(path):
    pdf = pikepdf.Pdf.new()
    shared_form = _make_form(
        pdf,
        (
            b"0 0 0 1 k 30 30 100 50 re f\n"
            b"/CutContour CS 1 SCN 18 18 184 124 re S\n"
        ),
        resources=pikepdf.Dictionary({
            "/ColorSpace": pikepdf.Dictionary({
                "/CutContour": _cut_contour_colorspace(),
            }),
        }),
    )
    for _ in range(2):
        page = pdf.add_blank_page(page_size=(PAGE_W, PAGE_H))
        page.Resources = pikepdf.Dictionary({
            "/XObject": pikepdf.Dictionary({"/FmShared": shared_form}),
        })
        page.Contents = pikepdf.Stream(pdf, b"q /FmShared Do Q\n")

    first_form = pdf.pages[0].Resources["/XObject"]["/FmShared"]
    second_form = pdf.pages[1].Resources["/XObject"]["/FmShared"]
    assert first_form.objgen == second_form.objgen
    pdf.save(path)
    pdf.close()


def _make_inherited_resource_form(path):
    pdf = pikepdf.Pdf.new()
    inherited_form = _make_form(
        pdf,
        (
            b"0 0 0 1 k 30 30 100 50 re f\n"
            b"/CutContour CS 1 SCN 18 18 184 124 re S\n"
        ),
        resources=None,
    )
    assert inherited_form.get("/Resources") is None

    page = pdf.add_blank_page(page_size=(PAGE_W, PAGE_H))
    page.Resources = pikepdf.Dictionary({
        "/XObject": pikepdf.Dictionary({"/FmInherited": inherited_form}),
        "/ColorSpace": pikepdf.Dictionary({
            "/CutContour": _cut_contour_colorspace(),
        }),
    })
    page.Contents = pikepdf.Stream(pdf, b"q /FmInherited Do Q\n")
    pdf.save(path)
    pdf.close()


def _make_page_without_cut_contour(path):
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(PAGE_W, PAGE_H))
    page.Resources = pikepdf.Dictionary()
    page.Contents = pikepdf.Stream(
        pdf,
        b"0 0 0 1 k 30 30 100 50 re f\n",
    )
    pdf.save(path)
    pdf.close()


def _make_spot_and_matching_process_decoration(path):
    pdf = pikepdf.Pdf.new()
    form = _make_form(
        pdf,
        (
            # The alternate CMYK appearance of tint=1 is 0/1/0/0.
            b"/CutContour CS 1 SCN 18 18 184 124 re S\n"
            # This is normal process artwork with the same visible CMYK color.
            b"0 1 0 0 K 60 60 70 30 re S\n"
        ),
        resources=pikepdf.Dictionary({
            "/ColorSpace": pikepdf.Dictionary({
                "/CutContour": _cut_contour_colorspace(),
            }),
        }),
    )
    page = pdf.add_blank_page(page_size=(PAGE_W, PAGE_H))
    page.Resources = pikepdf.Dictionary({
        "/XObject": pikepdf.Dictionary({"/FmArtwork": form}),
    })
    page.Contents = pikepdf.Stream(pdf, b"q /FmArtwork Do Q\n")
    pdf.save(path)
    pdf.close()


def test_shared_form_cut_geometry_is_extracted_for_each_source_page(tmp_path):
    source = tmp_path / "shared-form-two-pages.pdf"
    output = tmp_path / "shared-form-output.pdf"
    _make_two_pages_with_one_shared_cut_form(source)
    source_hash = hashlib.sha256(source.read_bytes()).hexdigest()

    nup_engine.run_nup_engine(
        str(source),
        str(output),
        _settings(
            targetQuantity=1,
            targetQuantitiesByPage={"0": 1, "1": 1},
        ),
        job_id="page-sheet-shared-form",
    )

    assert hashlib.sha256(source.read_bytes()).hexdigest() == source_hash
    with pikepdf.open(output) as pdf:
        assert len(pdf.pages) == 4

    print_page_indices = (0, 2)
    cut_page_indices = (1, 3)
    for page_index in print_page_indices:
        assert not _spot_paths(_paths(output, page_index))
    assert [
        _count_size(_paths(output, page_index), 184, 124)
        for page_index in cut_page_indices
    ] == [1, 1]


def test_form_inherits_page_cutcontour_resources_for_strip_and_cut(tmp_path):
    source = tmp_path / "inherited-form-resources.pdf"
    output = tmp_path / "inherited-form-output.pdf"
    _make_inherited_resource_form(source)

    nup_engine.run_nup_engine(
        str(source),
        str(output),
        _settings(),
        job_id="page-sheet-inherited-form-resources",
    )

    with pikepdf.open(output) as pdf:
        assert len(pdf.pages) == 2
    print_paths = _paths(output, 0)
    cut_paths = _paths(output, 1)
    assert not _spot_paths(print_paths)
    assert _count_size(print_paths, 100, 50) == 1
    assert _count_size(cut_paths, 184, 124) == 1


def test_missing_cutcontour_uses_page_size_instead_of_emitting_blank_cut_page(tmp_path):
    source = tmp_path / "no-cutcontour.pdf"
    output = tmp_path / "no-cutcontour-output.pdf"
    _make_page_without_cut_contour(source)

    nup_engine.run_nup_engine(
        str(source),
        str(output),
        _settings(),
        job_id="page-sheet-missing-cutcontour",
    )

    with pikepdf.open(output) as pdf:
        assert len(pdf.pages) == 2
    print_paths = _paths(output, 0)
    cut_paths = _paths(output, 1)
    assert _count_size(print_paths, 100, 50) == 1
    assert _count_size(cut_paths, PAGE_W, PAGE_H) == 1


def test_process_cmyk_decoration_matching_spot_appearance_stays_on_print(tmp_path):
    source = tmp_path / "spot-and-process-decoration.pdf"
    output = tmp_path / "spot-and-process-output.pdf"
    _make_spot_and_matching_process_decoration(source)

    nup_engine.run_nup_engine(
        str(source),
        str(output),
        _settings(),
        job_id="page-sheet-process-decoration",
    )

    with pikepdf.open(output) as pdf:
        assert len(pdf.pages) == 2
    print_paths = _paths(output, 0)
    cut_paths = _paths(output, 1)
    assert not _spot_paths(print_paths)
    # Inspect painted subpaths, not only each drawing's union bbox. If stripping
    # removes S without terminating the old path, the later CMYK S paints both
    # rectangles together: decoration survives but CutContour leaks to print.
    assert _count_painted_rect_items(print_paths, 70, 30) == 1
    assert _count_painted_rect_items(print_paths, 184, 124) == 0
    assert _count_size(cut_paths, 184, 124) == 1



def _make_device_cmyk_scn_cutline(path, *, matching_decoration=False):
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(PAGE_W, PAGE_H))
    page.Resources = pikepdf.Dictionary()
    content = (
        b"0 0 0 1 k 30 30 100 50 re f\n"
        b"q /DeviceCMYK CS 0 1 0 0 SCN "
        b"18 18 184 124 re S Q\n"
    )
    if matching_decoration:
        content += (
            b"q /DeviceCMYK CS 0 1 0 0 SCN "
            # Keep the decoration spatially separate from the cut group.
            b"260 260 70 30 re S Q\n"
        )
    page.Contents = pikepdf.Stream(pdf, content)
    pdf.save(path)
    pdf.close()


def _make_page_with_used_and_unused_forms(path):
    pdf = pikepdf.Pdf.new()
    spot_resources = pikepdf.Dictionary({
        "/ColorSpace": pikepdf.Dictionary({
            "/CutContour": _cut_contour_colorspace(),
        }),
    })
    used_form = _make_form(
        pdf,
        (
            b"0 0 0 1 k 30 30 100 50 re f\n"
            b"/CutContour CS 1 SCN 18 18 184 124 re S\n"
        ),
        resources=spot_resources,
    )
    unused_stream = b"/CutContour CS 1 SCN 250 250 40 40 re S\n"
    unused_form = _make_form(
        pdf,
        unused_stream,
        resources=pikepdf.Dictionary({
            "/ColorSpace": pikepdf.Dictionary({
                "/CutContour": _cut_contour_colorspace(),
            }),
        }),
    )
    page = pdf.add_blank_page(page_size=(PAGE_W, PAGE_H))
    page.Resources = pikepdf.Dictionary({
        "/XObject": pikepdf.Dictionary({
            "/FmUsed": used_form,
            "/FmUnused": unused_form,
        }),
    })
    page.Contents = pikepdf.Stream(pdf, b"q /FmUsed Do Q\n")
    pdf.save(path)
    pdf.close()
    return unused_stream


def _named_die_colorspace(name):
    colorspace = _cut_contour_colorspace()
    colorspace[1] = pikepdf.Name(f"/{name}")
    return colorspace


def _make_two_pages_with_shared_inherited_form_contexts(path):
    pdf = pikepdf.Pdf.new()
    shared_form = _make_form(
        pdf,
        (
            b"0 0 0 1 k 30 30 100 50 re f\n"
            b"/InheritedCut CS 1 SCN 18 18 184 124 re S\n"
        ),
        resources=None,
    )
    assert shared_form.get("/Resources") is None

    for die_name in ("CutContour", "KissCut"):
        page = pdf.add_blank_page(page_size=(PAGE_W, PAGE_H))
        page.Resources = pikepdf.Dictionary({
            "/XObject": pikepdf.Dictionary({"/FmShared": shared_form}),
            "/ColorSpace": pikepdf.Dictionary({
                "/InheritedCut": _named_die_colorspace(die_name),
            }),
        })
        page.Contents = pikepdf.Stream(pdf, b"q /FmShared Do Q\n")

    assert (
        pdf.pages[0].Resources["/XObject"]["/FmShared"].objgen
        == pdf.pages[1].Resources["/XObject"]["/FmShared"].objgen
    )
    pdf.save(path)
    pdf.close()


def _top_form(page):
    forms = [
        obj
        for _, obj in page.Resources.get("/XObject", {}).items()
        if str(obj.get("/Subtype", "")) == "/Form"
    ]
    assert len(forms) == 1
    return forms[0]


def test_device_cmyk_cs_scn_cutline_is_removed_from_print_and_kept_on_cut(
    tmp_path,
):
    source = tmp_path / "device-cmyk-scn-cutline.pdf"
    output = tmp_path / "device-cmyk-scn-output.pdf"
    _make_device_cmyk_scn_cutline(source)

    nup_engine.run_nup_engine(
        str(source),
        str(output),
        _settings(),
        job_id="page-sheet-device-cmyk-scn",
    )

    with pikepdf.open(output) as pdf:
        assert len(pdf.pages) == 2
    print_paths = _paths(output, 0)
    cut_paths = _paths(output, 1)
    assert _count_painted_rect_items(print_paths, 184, 124) == 0
    assert _count_painted_rect_items(print_paths, 100, 50) == 1
    assert _count_size(cut_paths, 184, 124) == 1


def test_same_process_color_only_strips_selected_cut_geometry(tmp_path):
    source = tmp_path / "process-cut-and-decoration.pdf"
    output = tmp_path / "process-cut-and-decoration-output.pdf"
    _make_device_cmyk_scn_cutline(source, matching_decoration=True)

    nup_engine.run_nup_engine(
        str(source),
        str(output),
        _settings(),
        job_id="page-sheet-process-geometry-match",
    )

    print_paths = _paths(output, 0)
    cut_paths = _paths(output, 1)
    assert _count_painted_rect_items(print_paths, 184, 124) == 0
    assert _count_painted_rect_items(print_paths, 70, 30) == 1
    assert _count_size(cut_paths, 184, 124) == 1


def test_unreferenced_form_resource_is_not_rewritten(tmp_path):
    source = tmp_path / "unreferenced-form-resource.pdf"
    output = tmp_path / "unreferenced-form-output.pdf"
    unused_stream = _make_page_with_used_and_unused_forms(source)
    source_hash = hashlib.sha256(source.read_bytes()).hexdigest()

    nup_engine.run_nup_engine(
        str(source),
        str(output),
        _settings(),
        job_id="page-sheet-unreferenced-form",
    )

    assert hashlib.sha256(source.read_bytes()).hexdigest() == source_hash
    with pikepdf.open(output) as pdf:
        assert len(pdf.pages) == 2
        page_form = _top_form(pdf.pages[0])
        unused_form = page_form["/Resources"]["/XObject"]["/FmUnused"]
        assert unused_form.read_bytes() == unused_stream

    assert not _spot_paths(_paths(output, 0))
    assert _count_size(_paths(output, 1), 184, 124) == 1


def test_shared_form_without_resources_uses_each_page_calling_context(tmp_path):
    source = tmp_path / "shared-inherited-contexts.pdf"
    output = tmp_path / "shared-inherited-contexts-output.pdf"
    _make_two_pages_with_shared_inherited_form_contexts(source)

    nup_engine.run_nup_engine(
        str(source),
        str(output),
        _settings(
            targetQuantity=1,
            targetQuantitiesByPage={"0": 1, "1": 1},
        ),
        job_id="page-sheet-shared-inherited-contexts",
    )

    with pikepdf.open(output) as pdf:
        assert len(pdf.pages) == 4
    assert not _spot_paths(_paths(output, 0), "CutContour")
    assert not _spot_paths(_paths(output, 2), "KissCut")
    assert [
        _count_size(_paths(output, page_index), 184, 124)
        for page_index in (1, 3)
    ] == [1, 1]
