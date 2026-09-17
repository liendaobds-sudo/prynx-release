import os
import pytest
import pikepdf
from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor

from app.core import geometry_reader
from app.api.routes.edit import _apply_edit_op
from app.schemas.edit import EditOp, TextPayload


@pytest.fixture
def multi_char_pdf(tmp_path):
    pdf_path = str(tmp_path / "multi_char.pdf")
    c = canvas.Canvas(pdf_path, pagesize=(300, 200))
    c.setFont("Helvetica", 16)
    c.setFillColor(HexColor("#FF0000"))
    c.drawString(40, 100, "A")
    c.drawString(60, 100, "B")
    c.drawString(80, 100, "C")
    c.save()
    return pdf_path


def test_edit_text_cluster_via_edit_op(multi_char_pdf, tmp_path):
    metas = geometry_reader.list_objects(multi_char_pdf, 0, include_text_props=True)
    text_metas = [m for m in metas if m.type == "text"]
    assert len(text_metas) >= 3

    target_ids = [m.id for m in text_metas[:3]]
    op = EditOp(
        page=0,
        kind="editText",
        targetIds=target_ids,
        text=TextPayload(content="WORLD"),
    )

    out_path = str(tmp_path / "out_cluster.pdf")
    with pikepdf.open(multi_char_pdf) as pdf:
        _apply_edit_op(pdf, op, multi_char_pdf)
        pdf.save(out_path)

    new_metas = geometry_reader.list_objects(out_path, 0, include_text_props=True)
    new_texts = [m.content for m in new_metas if m.type == "text" and m.content]
    full_text = "".join(new_texts)
    
    assert "WORLD" in full_text
    assert "A" not in full_text
    assert "B" not in full_text
    assert "C" not in full_text
