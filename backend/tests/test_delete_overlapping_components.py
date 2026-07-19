import base64
import os
import sys
from io import BytesIO

import pikepdf
from PIL import Image

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.core import geometry_reader
from app.core.object_mapper import build_op_spans
from app.core.stream_editor import delete_objects
from app.api.routes.edit import _render_hide_preview_blocking
from app.core.edit_session import (
    EditSession, SESSIONS, _apply_op_to_pdf, apply_op, hidden_object_ids, redo, undo,
)
from app.schemas.edit import EditOp
from app.core.layer_engine import LayerEngine
from app.schemas.edit import ObjMeta


def _document():
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(200, 200))
    page.obj[pikepdf.Name("/Contents")] = pdf.make_stream(
        b"q 0.7 0.5 0.3 rg 20 20 120 120 re f Q\n"
        b"q 1 0 0 RG 2 w 20 20 120 120 re S Q\n"
    )
    return pdf, page


def _metas():
    bbox = [20.0, 20.0, 140.0, 140.0]
    return [
        ObjMeta(id="fill", drawIndex=0, type="vector", bbox=bbox),
        ObjMeta(id="stroke", drawIndex=1, type="vector", bbox=bbox),
    ]


def test_delete_fill_keeps_overlapping_stroke():
    pdf, page = _document()
    try:
        metas = _metas()
        delete_objects(page, [metas[0]], pdf, all_obj_metas=metas)
        spans = build_op_spans(page, pdf=pdf)
        assert len(spans) == 1
        instructions = pikepdf.parse_content_stream(page)
        assert any(str(item.operator) == "S" for item in instructions)
        assert not any(str(item.operator) == "f" for item in instructions)
    finally:
        pdf.close()


def test_delete_stroke_keeps_overlapping_fill():
    pdf, page = _document()
    try:
        metas = _metas()
        delete_objects(page, [metas[1]], pdf, all_obj_metas=metas)
        spans = build_op_spans(page, pdf=pdf)
        assert len(spans) == 1
        instructions = pikepdf.parse_content_stream(page)
        assert any(str(item.operator) == "f" for item in instructions)
        assert not any(str(item.operator) == "S" for item in instructions)
    finally:
        pdf.close()

def test_pdfium_fill_and_stroke_ids_each_delete_only_their_own_paint():
    source, _ = _document()
    buffer = BytesIO()
    source.save(buffer)
    source.close()
    pdf_bytes = buffer.getvalue()
    metas = geometry_reader.list_objects(pdf_bytes, 0)
    assert [(meta.type, meta.drawIndex) for meta in metas] == [
        ("vector", 0),
        ("vector", 1),
    ]

    expected_remaining = [("f", "S"), ("S", "f")]
    for target, (removed, kept) in zip(metas, expected_remaining):
        with pikepdf.Pdf.open(BytesIO(pdf_bytes)) as pdf:
            delete_objects(
                pdf.pages[0], [target], pdf, all_obj_metas=metas
            )
            operators = [str(item.operator) for item in pikepdf.parse_content_stream(pdf.pages[0])]
            assert removed not in operators
            assert kept in operators

def test_hide_preview_renders_each_pdfium_component_independently():
    source, _ = _document()
    buffer = BytesIO()
    source.save(buffer)
    source.close()
    pdf_bytes = buffer.getvalue()
    metas = geometry_reader.list_objects(pdf_bytes, 0)

    hidden_fill = _render_hide_preview_blocking(pdf_bytes, 0, [metas[0].id])
    hidden_stroke = _render_hide_preview_blocking(pdf_bytes, 0, [metas[1].id])
    fill_image = Image.open(BytesIO(base64.b64decode(hidden_fill.image.split(",", 1)[1])))
    stroke_image = Image.open(BytesIO(base64.b64decode(hidden_stroke.image.split(",", 1)[1])))

    center = (fill_image.width // 2, fill_image.height // 2)
    assert fill_image.getpixel(center)[:3] == (255, 255, 255)
    assert stroke_image.getpixel(center)[:3] != (255, 255, 255)

def test_live_session_delete_uses_full_object_list_for_overlap_mapping():
    source, _ = _document()
    buffer = BytesIO()
    source.save(buffer)
    source.close()
    with pikepdf.Pdf.open(BytesIO(buffer.getvalue())) as pdf:
        metas = geometry_reader.list_objects(buffer.getvalue(), 0)
        by_id = {meta.id: meta for meta in metas}
        _apply_op_to_pdf(
            pdf,
            EditOp(page=0, kind="delete", targetIds=[metas[1].id]),
            by_id,
        )
        operators = [str(item.operator) for item in pikepdf.parse_content_stream(pdf.pages[0])]
        assert "f" in operators
        assert "S" not in operators

def test_object_visibility_persists_in_pdf_and_can_be_shown_again():
    source, _ = _document()
    initial = BytesIO()
    source.save(initial)
    source.close()
    with pikepdf.Pdf.open(BytesIO(initial.getvalue())) as pdf:
        metas = geometry_reader.list_objects(initial.getvalue(), 0)
        by_id = {meta.id: meta for meta in metas}
        _apply_op_to_pdf(
            pdf,
            EditOp(page=0, kind="objectVisibility", targetIds=[metas[0].id], visible=False),
            by_id,
        )
        hidden_bytes = BytesIO()
        pdf.save(hidden_bytes)
        assert hidden_object_ids(pdf, 0) == [metas[0].id]

    hidden_result = _render_hide_preview_blocking(hidden_bytes.getvalue(), 0, [])
    hidden_image = Image.open(BytesIO(base64.b64decode(hidden_result.image.split(",", 1)[1])))
    assert hidden_image.getpixel((hidden_image.width // 2, hidden_image.height // 2))[:3] == (255, 255, 255)
    layer_names = [layer["name"] for layer in LayerEngine().get_layer_tree(hidden_bytes.getvalue())["layers"]]
    assert not any(name.startswith("PrynX hidden object") for name in layer_names)

    with pikepdf.Pdf.open(BytesIO(hidden_bytes.getvalue())) as pdf:
        metas = geometry_reader.list_objects(hidden_bytes.getvalue(), 0)
        _apply_op_to_pdf(
            pdf,
            EditOp(page=0, kind="objectVisibility", targetIds=[metas[0].id], visible=True),
            {meta.id: meta for meta in metas},
        )
        shown_bytes = BytesIO()
        pdf.save(shown_bytes)
        assert hidden_object_ids(pdf, 0) == []

    shown_result = _render_hide_preview_blocking(shown_bytes.getvalue(), 0, [])
    shown_image = Image.open(BytesIO(base64.b64decode(shown_result.image.split(",", 1)[1])))
    assert shown_image.getpixel((shown_image.width // 2, shown_image.height // 2))[:3] != (255, 255, 255)

def test_object_visibility_participates_in_session_undo_redo():
    source, _ = _document()
    initial = BytesIO()
    source.save(initial)
    source.close()
    baseline = initial.getvalue()
    session = EditSession(
        session_id="visibility-history",
        source_fid="visibility-fid",
        source_path="",
        pdf=pikepdf.Pdf.open(BytesIO(baseline)),
        baseline_bytes=baseline,
    )
    SESSIONS[session.session_id] = session
    try:
        target = geometry_reader.list_objects(baseline, 0)[0]
        apply_op(session, EditOp(
            page=0, kind="objectVisibility", targetIds=[target.id], visible=False,
        ))
        assert hidden_object_ids(session.pdf, 0) == [target.id]
        undo(session, scale=1.0)
        assert hidden_object_ids(session.pdf, 0) == []
        redo(session, scale=1.0)
        assert hidden_object_ids(session.pdf, 0) == [target.id]
    finally:
        SESSIONS.pop(session.session_id, None)
        session.pdf.close()