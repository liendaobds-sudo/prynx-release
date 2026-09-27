"""UIUX R25.GPU.30: cùng glyph PDF cho hit-test native và lớp chữ cũ."""
import ast
import io
import os
from pathlib import Path

import pypdfium2 as pdfium
import pytest
from pypdf import PdfReader, PdfWriter
from pypdf.generic import FloatObject, NameObject
from reportlab.pdfgen import canvas


def extract_function():
    # Hàm tự chứa; tránh khởi động router/license/job của ứng dụng trong test glyph.
    source = Path(os.environ.get("PRYNX_NATIVE_TEXT_SOURCE") or
                  Path(__file__).parents[1] / "app/api/routes/document_tools.py")
    tree = ast.parse(source.read_text(encoding="utf-8-sig"))
    node = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "_get_pdf_text")
    ns = {"os": os, "_resolve_document_pdf_path": lambda p: p,
          "_validate_file_path": lambda p: p,
          "raise_http": lambda e, _: (_ for _ in ()).throw(e)}
    exec(compile(ast.Module(body=[node], type_ignores=[]), str(source), "exec"), ns)
    return ns["_get_pdf_text"]


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
def test_raw_glyph_boxes_survive_crop_rotation_and_user_unit(tmp_path, rotation):
    buf = io.BytesIO()
    pdf = canvas.Canvas(buf, pagesize=(400, 300))
    pdf.drawString(60, 200, "GPU text")
    pdf.save()
    writer = PdfWriter()
    page = PdfReader(buf).pages[0]
    page.cropbox.lower_left = (20, 30)
    page.cropbox.upper_right = (380, 280)
    page.rotate(rotation)
    page[NameObject("/UserUnit")] = FloatObject(2)
    writer.add_page(page)
    path = tmp_path / "text.pdf"
    writer.write(path)
    data = extract_function()({"path": str(path), "page": 1})
    chars = [ch for block in data["blocks"] for line in block["lines"] for ch in line["chars"]]
    glyph = next(ch for ch in chars if ch["c"] == "G")
    from app.core.pdfium_lock import pdfium_guard
    with pdfium_guard("test_native_pdf_text_geometry"):
        with pdfium.PdfDocument(path) as doc:
            pg = doc[0]
            text = pg.get_textpage()
            left, bottom, right, top = text.get_charbox(0)
    assert glyph["pdf_bbox"] == pytest.approx({"x": left, "y": bottom,
                                              "width": right-left, "height": top-bottom})
    assert "GPU text" in "".join(c["c"] for c in chars)
