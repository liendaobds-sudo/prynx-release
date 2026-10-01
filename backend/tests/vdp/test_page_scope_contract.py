"""Regression cho hợp đồng field theo trang của VDP.

``pageNum`` dùng số trang template 1-based. Field không có ``pageNum`` vẫn
được dùng trên mọi trang để giữ tương thích với payload VDP cũ.
"""

import os
import sys
import uuid

import pypdfium2 as pdfium
import pytest
from pydantic import ValidationError
from reportlab.pdfgen import canvas as rl_canvas

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from app.schemas.vdp import VdpField, VdpRequest
from app.workers.vdp_engine import process_chunk, run_vdp_engine


PAGE_W_PT = 297.5
PAGE_H_PT = 419.5


def _make_template(path: str, num_pages: int = 2) -> None:
    c = rl_canvas.Canvas(path, pagesize=(PAGE_W_PT, PAGE_H_PT))
    for _ in range(num_pages):
        c.setFillColorRGB(0.97, 0.97, 0.97)
        c.rect(0, 0, PAGE_W_PT, PAGE_H_PT, stroke=0, fill=1)
        c.showPage()
    c.save()


def _text(pdf_path: str, page_index: int) -> str:
    pdf = pdfium.PdfDocument(pdf_path)
    try:
        page = pdf[page_index]
        text_page = page.get_textpage()
        try:
            return text_page.get_text_bounded()
        finally:
            text_page.close()
    finally:
        pdf.close()


def _field(field_id: str, name: str, token: str, **kwargs) -> VdpField:
    return VdpField(
        id=field_id,
        name=name,
        type="text",
        x=10,
        y=10,
        width=100,
        height=20,
        fontSize=12,
        alignment="left",
        textContent=token,
        **kwargs,
    )


def test_page_num_scopes_fields_to_matching_template_page(tmp_path):
    template = tmp_path / "template.pdf"
    output = tmp_path / "output.pdf"
    _make_template(str(template), num_pages=2)

    fields = [
        _field("shared", "shared", "{shared}"),
        _field("page1", "page1", "{page1}", pageNum=1),
        _field("page2", "page2", "{page2}", pageNum=2),
    ]
    run_vdp_engine(
        str(template),
        fields,
        [
            {"shared": "SHARED-1", "page1": "PAGE1-1", "page2": "PAGE2-1"},
            {"shared": "SHARED-2", "page1": "PAGE1-2", "page2": "PAGE2-2"},
        ],
        str(output),
        job_id=uuid.uuid4().hex,
    )

    page1 = _text(str(output), 0)
    page2 = _text(str(output), 1)
    assert "SHARED-1" in page1
    assert "PAGE1-1" in page1
    assert "PAGE2-1" not in page1
    assert "SHARED-2" in page2
    assert "PAGE2-2" in page2
    assert "PAGE1-2" not in page2


def test_legacy_field_without_page_num_is_shared_across_template_pages(tmp_path):
    template = tmp_path / "template.pdf"
    output = tmp_path / "output.pdf"
    _make_template(str(template), num_pages=2)

    field = _field("legacy", "legacy", "{legacy}")
    run_vdp_engine(
        str(template),
        [field],
        [{"legacy": "LEGACY-1"}, {"legacy": "LEGACY-2"}],
        str(output),
        job_id=uuid.uuid4().hex,
    )

    assert "LEGACY-1" in _text(str(output), 0)
    assert "LEGACY-2" in _text(str(output), 1)


def test_duplicate_field_ids_are_rejected_before_engine_work(tmp_path):
    first = _field("duplicate", "first", "{first}")
    second = _field("duplicate", "second", "{second}")

    with pytest.raises(ValidationError, match="field id bị trùng"):
        VdpRequest(file_id="template.pdf", fields=[first, second], data=[])

    # Route hiện parse List[VdpField], nên engine cũng phải kiểm tra trực tiếp.
    with pytest.raises(ValueError, match="field id bị trùng"):
        run_vdp_engine(
            str(tmp_path / "missing-template.pdf"),
            [first, second],
            [],
            str(tmp_path / "output.pdf"),
        )


def test_page_num_is_one_based_and_optional():
    assert _field("legacy", "legacy", "{legacy}").pageNum is None
    assert _field("page2", "page2", "{page2}", pageNum=2).pageNum == 2

    with pytest.raises(ValidationError):
        _field("page0", "page0", "{page0}", pageNum=0)

    with pytest.raises(ValidationError):
        _field("boolean", "boolean", "{boolean}", pageNum=True)


def test_page_scope_uses_global_record_index_across_chunk_boundaries(tmp_path):
    template = tmp_path / "template.pdf"
    _make_template(str(template), num_pages=3)
    fields = [
        _field("page1", "value", "PAGE-1", pageNum=1),
        _field("page2", "value", "PAGE-2", pageNum=2),
        _field("page3", "value", "PAGE-3", pageNum=3),
    ]

    # Chunk bắt đầu ở record 101: trang template kế tiếp là trang 2, không phải 1.
    output = process_chunk((
        str(template), [field.model_dump() for field in fields], [{}, {}, {}], 100, None,
    ))
    try:
        for page_index, expected in enumerate(("PAGE-2", "PAGE-3", "PAGE-1")):
            page_text = _text(output, page_index)
            assert expected in page_text
            assert all(marker not in page_text for marker in ("PAGE-1", "PAGE-2", "PAGE-3") if marker != expected)
    finally:
        os.remove(output)


def test_page_scope_applies_to_reportlab_fields_and_keeps_their_geometry(tmp_path):
    template = tmp_path / "template.pdf"
    output = tmp_path / "output.pdf"
    _make_template(str(template), num_pages=2)
    fields = [
        _field("page1", "first", "FIRST-PAGE", pageNum=1),
        VdpField(
            id="barcode", name="code", type="barcode", pageNum=2,
            x=15, y=90, width=90, height=20, barType="code128", showText=False,
            textContent="{code}",
        ),
    ]
    run_vdp_engine(
        str(template), fields, [{"code": "ABC123"}, {"code": "ABC123"}],
        str(output), job_id=uuid.uuid4().hex,
    )

    pdf = pdfium.PdfDocument(str(output))
    try:
        for index in (0, 1):
            page = pdf[index]
            bitmap = page.render(scale=1)
            try:
                image = bitmap.to_pil().convert("RGB")
                # y=90 CSS-mm tương ứng y=191pt: vùng này chỉ chứa barcode trang 2.
                area = image.crop((20, 180, 240, 240))
                has_dark_pixel = area.convert("L").getextrema()[0] < 120
                assert has_dark_pixel is (index == 1)
            finally:
                bitmap.close()
                page.close()
    finally:
        pdf.close()

