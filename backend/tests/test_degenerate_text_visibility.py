from __future__ import annotations

import hashlib
from io import BytesIO

import pikepdf
import pypdfium2 as pdfium

from app.core import geometry_reader
from app.core.edit_session import _apply_object_visibility, hidden_object_ids
from app.schemas.edit import EditOp, ObjMeta


def _space_only_pdf() -> bytes:
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(200, 200))
    font = pdf.make_indirect(pikepdf.Dictionary(
        Type=pikepdf.Name('/Font'),
        Subtype=pikepdf.Name('/Type1'),
        BaseFont=pikepdf.Name('/Helvetica'),
    ))
    fonts = pikepdf.Dictionary()
    fonts['/F1'] = font
    page.obj['/Resources'] = pikepdf.Dictionary(Font=fonts)
    page.obj['/Contents'] = pdf.make_stream(
        b'BT /F1 12 Tf 1 0 0 1 20 30 Tm [( )] TJ ET\n'
    )
    out = BytesIO()
    pdf.save(out)
    return out.getvalue()


def _render_digest(data: bytes) -> str:
    document = pdfium.PdfDocument(data)
    try:
        page = document[0]
        try:
            pixels = page.render(scale=1).to_pil().tobytes()
            return hashlib.sha256(pixels).hexdigest()
        finally:
            page.close()
    finally:
        document.close()


def test_space_only_text_is_not_exposed_as_editable_component():
    data = _space_only_pdf()
    assert geometry_reader.list_objects(data, 0, include_text_props=False) == []


def test_stale_point_text_visibility_is_safe_state_only_and_never_409s():
    data = _space_only_pdf()
    meta = ObjMeta(
        id='text-0', drawIndex=0, type='text',
        bbox=[20.0, 30.0, 20.0, 30.0],
        matrix=[1.0, 0.0, 0.0, 1.0, 20.0, 30.0],
    )
    before_digest = _render_digest(data)

    with pikepdf.Pdf.open(BytesIO(data)) as pdf:
        original_stream = pdf.pages[0].obj['/Contents'].read_bytes()
        result = _apply_object_visibility(
            pdf,
            EditOp(page=0, kind='objectVisibility', targetIds=['text-0'], visible=False),
            {'text-0': meta},
        )
        assert result['changed'] is True
        assert hidden_object_ids(pdf, 0) == ['text-0']
        assert pdf.pages[0].obj['/Contents'].read_bytes() == original_stream

        hidden = BytesIO()
        pdf.save(hidden)

        _apply_object_visibility(
            pdf,
            EditOp(page=0, kind='objectVisibility', targetIds=['text-0'], visible=True),
            {'text-0': meta},
        )
        assert hidden_object_ids(pdf, 0) == []

    assert _render_digest(hidden.getvalue()) == before_digest