"""Regression tests cho pipeline trích xuất văn bản QC (subsystem 'qc').

Trước đây KHÔNG có test tự động (audit #S1). Phủ:
  - group_blocks_to_text: gộp từ cùng dòng (y0) bằng khoảng trắng, tách dòng bằng \n.
  - HỢP ĐỒNG SCHEMA: block do PDFProcessor.extract_text_blocks sinh ra
    ({text,x0,y0,x1,y1,fontname,size}) phải được group_blocks_to_text chấp nhận
    (không KeyError) — chính chỗ từng gãy nếu 2 schema lệch.
  - extract_text_blocks: trang ngoài phạm vi → []; PDF shape-only → list (no crash).
"""
import io
import os
import tempfile

import pytest

from app.core.ocr_engine import OCREngine
from app.core.pdf_processor import PDFProcessor


# Schema CHÍNH XÁC mà PDFProcessor.extract_text_blocks phát ra.
def _block(text, x0, y0, x1, y1):
    return {"text": text, "x0": float(x0), "y0": float(y0),
            "x1": float(x1), "y1": float(y1), "fontname": "F", "size": 12.0}


def test_group_blocks_groups_lines_and_separates_rows():
    blocks = [
        _block("Xin", 10, 10, 40, 22),
        _block("chao", 45, 10, 90, 22),
        _block("Dong2", 10, 40, 60, 52),
    ]
    text = OCREngine.group_blocks_to_text(blocks)
    assert isinstance(text, str)
    assert "Xin" in text and "chao" in text and "Dong2" in text
    assert "\n" in text  # ít nhất 2 dòng


def test_group_blocks_empty_input_no_crash():
    assert OCREngine.group_blocks_to_text([]) == "" or isinstance(OCREngine.group_blocks_to_text([]), str)


def test_schema_contract_extract_to_group():
    """Block đúng schema extract_text_blocks → group_blocks_to_text KHÔNG KeyError."""
    blocks = [_block("A", 0, 0, 10, 10), _block("B", 12, 0, 22, 10)]
    # Phải dùng được mọi key schema mà không lỗi.
    text = OCREngine.group_blocks_to_text(blocks)
    assert "A" in text and "B" in text


def _make_shape_pdf():
    from app.workers import pdf_wrapper as pdf_lib
    d = pdf_lib.open()
    pg = d.new_page(width=200, height=300)
    sh = pg.new_shape(); sh.draw_rect(pdf_lib.Rect(20, 20, 180, 280)); sh.finish(color=(0, 0, 0)); sh.commit()
    buf = io.BytesIO(); d.save(buf); d.close()
    fd, sp = tempfile.mkstemp(suffix=".pdf"); os.close(fd)
    open(sp, 'wb').write(buf.getvalue())
    return sp


def test_extract_text_blocks_out_of_range_returns_empty():
    sp = _make_shape_pdf()
    try:
        proc = PDFProcessor()
        assert proc.extract_text_blocks(sp, 0) == []
        assert proc.extract_text_blocks(sp, 999) == []
    finally:
        os.remove(sp)


def test_extract_text_blocks_shape_pdf_no_crash_returns_list():
    sp = _make_shape_pdf()
    try:
        proc = PDFProcessor()
        blocks = proc.extract_text_blocks(sp, 1)
        assert isinstance(blocks, list)
        # PDF chỉ có hình → 0 block văn bản, nhưng KHÔNG được crash.
        for b in blocks:
            assert {"text", "x0", "y0", "x1", "y1"}.issubset(b.keys())
    finally:
        os.remove(sp)


def test_extract_to_group_end_to_end_real_pipeline():
    """Chuỗi đúng như route qc/extract-text: extract → group, không crash."""
    sp = _make_shape_pdf()
    try:
        proc = PDFProcessor()
        meta = proc.get_metadata(sp)
        n = meta.get("page_count", 0)
        all_blocks = []
        for p in range(1, n + 1):
            all_blocks.extend(proc.extract_text_blocks(sp, p))
        text = OCREngine.group_blocks_to_text(all_blocks)
        assert isinstance(text, str)
    finally:
        os.remove(sp)
