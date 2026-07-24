"""Regression coverage for atomic editing of page-level Form XObjects."""
from __future__ import annotations

import base64
import os
import sys
import threading
from io import BytesIO

import pikepdf
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.api.routes.edit import _render_clip_blocking
from app.core import edit_session, geometry_reader
from app.core.edit_session import EditSession, _apply_object_visibility, apply_op, render_clip
from app.core.object_mapper import (
    apply_matrix,
    build_op_spans,
    map_object_spans,
    mult_matrix,
    parse_page_ops,
)
from app.core.stream_editor import (
    affine_transform_objects,
    delete_objects,
    move_objects,
    resize_objects,
    rotate_objects,
)
from app.schemas.edit import EditOp, MoveDelta, ObjMeta

IDENTITY = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]
FORM_CONTENT = (
    b"q /GS1 gs 0 0 20 10 re W n "
    b"0.1 0.2 0.3 0.4 k 0 0 20 10 re f Q\n"
)


def _set(obj, key: str, value) -> None:
    obj[pikepdf.Name(key)] = value


def _make_form(
    pdf: pikepdf.Pdf,
    *,
    bbox=(0, 0, 20, 10),
    matrix=IDENTITY,
    content=FORM_CONTENT,
    include_bbox: bool = True,
):
    gs = pdf.make_indirect(
        pikepdf.Dictionary(
            Type=pikepdf.Name("/ExtGState"),
            ca=0.65,
            CA=0.65,
            BM=pikepdf.Name("/Multiply"),
        )
    )
    ext = pikepdf.Dictionary()
    _set(ext, "/GS1", gs)
    resources = pikepdf.Dictionary()
    _set(resources, "/ExtGState", ext)

    form = pdf.make_stream(content)
    _set(form, "/Type", pikepdf.Name("/XObject"))
    _set(form, "/Subtype", pikepdf.Name("/Form"))
    _set(form, "/Resources", resources)
    if include_bbox:
        _set(form, "/BBox", pikepdf.Array(bbox))
    if matrix is not None:
        _set(form, "/Matrix", pikepdf.Array(matrix))
    _set(
        form,
        "/Group",
        pikepdf.Dictionary(
            S=pikepdf.Name("/Transparency"),
            CS=pikepdf.Name("/DeviceCMYK"),
            I=True,
            K=False,
        ),
    )
    return form


def _write_pdf(path, page_stream: bytes, form_specs: dict[str, dict]) -> None:
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(200, 200))
    page = pdf.pages[0]

    xobjects = pikepdf.Dictionary()
    for name, spec in form_specs.items():
        _set(xobjects, f"/{name}", _make_form(pdf, **spec))

    page_gs = pdf.make_indirect(
        pikepdf.Dictionary(Type=pikepdf.Name("/ExtGState"), ca=1.0, CA=1.0)
    )
    ext = pikepdf.Dictionary()
    _set(ext, "/GS0", page_gs)
    resources = pikepdf.Dictionary()
    _set(resources, "/XObject", xobjects)
    _set(resources, "/ExtGState", ext)
    _set(page.obj, "/Resources", resources)
    _set(page.obj, "/Contents", pdf.make_stream(page_stream))
    pdf.save(path)
    pdf.close()


def _form_spans(page, pdf):
    return [
        span
        for span in build_op_spans(page, pdf=pdf)
        if span.kind == "vector" and span.resource_name is not None
    ]


def _meta(span, draw_index: int = 0, object_id: str | None = None) -> ObjMeta:
    return ObjMeta(
        id=object_id or f"vector-{draw_index}",
        drawIndex=draw_index,
        type="vector",
        bbox=list(span.bbox),
    )


def _bbox_after(bbox, matrix):
    x0, y0, x1, y1 = bbox
    corners = [
        apply_matrix([x0, y0], matrix),
        apply_matrix([x1, y0], matrix),
        apply_matrix([x0, y1], matrix),
        apply_matrix([x1, y1], matrix),
    ]
    return [
        min(point[0] for point in corners),
        min(point[1] for point in corners),
        max(point[0] for point in corners),
        max(point[1] for point in corners),
    ]


def _assert_bbox(actual, expected, tol=1e-5):
    assert actual == pytest.approx(expected, abs=tol)


@pytest.fixture
def single_form_pdf(tmp_path):
    path = tmp_path / "single_form.pdf"
    _write_pdf(
        str(path),
        (
            b"q 1 0 0 1 20 30 cm /Fm1 Do Q\n"
            b"0 0 1 rg 120 120 20 20 re f\n"
        ),
        {"Fm1": {}},
    )
    return path


def test_form_bbox_uses_reversed_bbox_matrix_and_page_ctm(tmp_path):
    path = tmp_path / "form_matrix.pdf"
    form_bbox = [10, 20, -2, -4]
    form_matrix = [1, 0.25, -0.5, 1, 3, 4]
    page_matrix = [2, 0, 0, 3, 50, 40]
    _write_pdf(
        str(path),
        b"q /GS0 gs 0 TL 2 0 0 3 50 40 cm /Fm1 Do Q\n",
        {"Fm1": {"bbox": form_bbox, "matrix": form_matrix}},
    )

    with pikepdf.open(path) as pdf:
        span = _form_spans(pdf.pages[0], pdf)[0]
        expected_ctm = mult_matrix(form_matrix, page_matrix)
        expected_bbox = _bbox_after(form_bbox, expected_ctm)
        assert span.start == 0 and span.end == 6
        assert span.ctm == pytest.approx(expected_ctm)
        _assert_bbox(span.bbox, expected_bbox)


def test_form_span_includes_outer_clip_wrapper(tmp_path):
    path = tmp_path / "form_outer_clip.pdf"
    _write_pdf(
        str(path),
        (
            b"q 0 0 100 100 re W n "
            b"q 2 0 0 2 10 15 cm /Fm1 Do Q Q\n"
        ),
        {"Fm1": {}},
    )

    with pikepdf.open(path) as pdf:
        span = _form_spans(pdf.pages[0], pdf)[0]
        operators = [str(item.operator) for item in parse_page_ops(pdf.pages[0])]
        assert operators == ["q", "re", "W", "n", "q", "cm", "Do", "Q", "Q"]
        assert span.start == 0 and span.end == len(operators)


def test_form_without_bbox_or_with_invalid_matrix_fails_safe(tmp_path):
    missing_bbox = tmp_path / "form_missing_bbox.pdf"
    bad_matrix = tmp_path / "form_bad_matrix.pdf"
    _write_pdf(
        str(missing_bbox),
        b"/Fm1 Do\n",
        {"Fm1": {"include_bbox": False}},
    )
    _write_pdf(
        str(bad_matrix),
        b"/Fm1 Do\n",
        {"Fm1": {"matrix": [1, 0, 0, 1, 0]}},
    )

    for path in (missing_bbox, bad_matrix):
        with pikepdf.open(path) as pdf:
            assert _form_spans(pdf.pages[0], pdf) == []


def test_move_is_page_space_and_preserves_form_stream_resources(single_form_pdf):
    with pikepdf.open(single_form_pdf) as pdf:
        page = pdf.pages[0]
        span = _form_spans(page, pdf)[0]
        meta = _meta(span)
        form = page.Resources.XObject.Fm1
        stream_before = form.read_bytes()
        resources_before = str(form.Resources)
        group_before = str(form.Group)

        move_objects(page, [meta], 11.0, -7.0, pdf)

        moved = _form_spans(page, pdf)[0]
        _assert_bbox(moved.bbox, [31, 23, 51, 33])
        assert form.read_bytes() == stream_before
        assert str(form.Resources) == resources_before
        assert str(form.Group) == group_before
        # Unrelated blue rectangle remains present and unchanged.
        assert any(
            span.resource_name is None
            and span.kind == "vector"
            and span.bbox == pytest.approx([120, 120, 140, 140])
            for span in build_op_spans(page, pdf=pdf)
        )


@pytest.mark.parametrize("operation", ["affine", "resize", "rotate"])
def test_form_affine_resize_rotate_update_bbox(single_form_pdf, operation):
    with pikepdf.open(single_form_pdf) as pdf:
        page = pdf.pages[0]
        original = _form_spans(page, pdf)[0]
        meta = _meta(original)

        if operation == "affine":
            matrix = [1.5, 0.2, -0.1, 0.8, 5, -3]
            affine_transform_objects(page, [meta], matrix, pdf)
            expected = _bbox_after(original.bbox, matrix)
        elif operation == "resize":
            resize_objects(page, [meta], 2.0, 0.5, "sw", pdf)
            expected = [20, 30, 60, 35]
        else:
            rotate_objects(page, [meta], 90.0, pdf)
            expected = [25, 25, 35, 45]

        transformed = _form_spans(page, pdf)[0]
        _assert_bbox(transformed.bbox, expected)
        assert page.Resources.XObject.Fm1.read_bytes() == FORM_CONTENT
        assert str(page.Resources.XObject.Fm1.Subtype) == "/Form"


@pytest.mark.parametrize("same_resource", [True, False])
def test_same_bbox_form_calls_are_distinct_and_delete_one_only(tmp_path, same_resource):
    path = tmp_path / f"duplicate_{same_resource}.pdf"
    if same_resource:
        stream = b"q /Fm1 Do Q q /Fm1 Do Q\n"
        specs = {"Fm1": {}}
    else:
        stream = b"q /Fm1 Do Q q /Fm2 Do Q\n"
        specs = {
            "Fm1": {"content": FORM_CONTENT},
            "Fm2": {
                "content": FORM_CONTENT.replace(
                    b"0.1 0.2 0.3 0.4", b"0.4 0.3 0.2 0.1"
                )
            },
        }
    _write_pdf(str(path), stream, specs)

    with pikepdf.open(path) as pdf:
        page = pdf.pages[0]
        spans = _form_spans(page, pdf)
        assert len(spans) == 2
        assert spans[0].bbox == pytest.approx(spans[1].bbox)
        first_meta = _meta(spans[0], 0, "vector-0")
        second_meta = _meta(spans[1], 1, "vector-1")
        assert map_object_spans(page, first_meta, pdf=pdf) == [spans[0]]
        assert map_object_spans(page, second_meta, pdf=pdf) == [spans[1]]

        delete_objects(page, [second_meta], pdf)
        remaining = [
            instruction
            for instruction in parse_page_ops(page)
            if str(instruction.operator) == "Do"
        ]
        assert len(remaining) == 1
        assert str(remaining[0].operands[0]) == "/Fm1"


def test_form_object_visibility_hide_show_wraps_atomic_span(single_form_pdf):
    with pikepdf.open(single_form_pdf) as pdf:
        page = pdf.pages[0]
        span = _form_spans(page, pdf)[0]
        meta = _meta(span, object_id="vector-0")
        by_id = {meta.id: meta}

        hide = EditOp(
            page=0,
            kind="objectVisibility",
            targetIds=[meta.id],
            visible=False,
        )
        _apply_object_visibility(pdf, hide, by_id)
        operators = [str(item.operator) for item in parse_page_ops(page)]
        assert operators.count("Do") == 1
        assert "BDC" in operators and "EMC" in operators
        assert len(list(pdf.Root.OCProperties.D.OFF)) == 1
        assert page.Resources.XObject.Fm1.read_bytes() == FORM_CONTENT

        show = EditOp(
            page=0,
            kind="objectVisibility",
            targetIds=[meta.id],
            visible=True,
        )
        _apply_object_visibility(pdf, show, by_id)
        assert len(list(pdf.Root.OCProperties.D.OFF)) == 0
        assert len(list(pdf.Root.OCProperties.D.ON)) == 1
        assert page.Resources.XObject.Fm1.read_bytes() == FORM_CONTENT


def test_form_session_move_uses_full_page_preview(single_form_pdf):
    """Desktop preview must not crop an atomic Form after it is moved."""
    source_bytes = single_form_pdf.read_bytes()
    objects = geometry_reader.list_objects(source_bytes, 0, include_text_props=False)
    target = next(
        obj
        for obj in objects
        if obj.type == "vector" and obj.bbox == pytest.approx([20, 30, 40, 40])
    )

    sid = "test-form-preview-" + os.urandom(4).hex()
    session = EditSession(
        session_id=sid,
        source_fid=sid,
        source_path=str(single_form_pdf),
        pdf=pikepdf.Pdf.open(BytesIO(source_bytes)),
        baseline_bytes=source_bytes,
        lock=threading.Lock(),
        live_bytes=source_bytes,
    )
    edit_session.SESSIONS[sid] = session
    edit_session.by_fid[sid] = sid
    try:
        op = EditOp(
            page=0,
            kind="move",
            targetIds=[target.id],
            delta=MoveDelta(dx=55, dy=25),
        )
        result = apply_op(session, op)
        assert result["detail"]["moved_spans"][0]["resource_name"] == "Fm1"

        preview, clip_rect, full = render_clip(
            session, op, result, scale=2.0, clip_pad=8.0
        )
        assert full is True
        assert clip_rect is None

        expected_b64, _width, _height = _render_clip_blocking(
            session.live_bytes, 0, 2.0, None
        )
        assert base64.b64decode(preview.split("base64,", 1)[1]) == base64.b64decode(expected_b64)
    finally:
        edit_session.SESSIONS.pop(sid, None)
        if edit_session.by_fid.get(sid) == sid:
            edit_session.by_fid.pop(sid, None)
        session.pdf.close()
