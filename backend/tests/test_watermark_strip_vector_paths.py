"""Watermark PrynX không được làm mất path vector của trang.

Bug (đọc ra từ code, 2026-07-28): `extract_vector_paths` lọc watermark ở hai mức
khác nhau — /Contents dạng MẢNG thì bỏ đúng chunk, dạng MỘT stream thì bỏ cả
stream. Mọi bước gọi `contents_coalesce()` (pdf_wrapper.clean_contents,
stream_editor, page_boxes, nup_artwork…) đều gộp trang về dạng một stream, lúc đó
artwork + đường bế nằm chung stream với watermark → mất sạch path → không nhận
được khuôn, âm thầm lùi về khổ trang.
"""
import pikepdf
import pytest

from app.workers.pdf_content_parser import (
    _strip_prynx_watermark, extract_vector_paths,
)


# Khối y theo app/core/watermark.py: chữ vô hình (3 Tr) mang tag PX_<lid>_<hid>_<ts>.
WATERMARK = (
    b"q\n"
    b"BT\n"
    b"3 Tr\n"
    b"/F0 0.10 Tf\n"
    b"1.0000 1.0000 Td\n"
    b"(PX_ab12cd_ef34_1753700000) Tj\n"
    b"ET\n"
    b"Q\n"
)

ART_ONE = b"0 0 1 RG 10 10 50 50 re S\n"
ART_TWO = b"1 0 0 RG 80 80 40 40 re S\n"


def _page_with_contents(contents_bytes_list):
    """Dựng PDF 1 trang; /Contents là stream đơn nếu 1 phần tử, mảng nếu nhiều."""
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(200, 200))
    page = pdf.pages[0]
    streams = [pdf.make_stream(b) for b in contents_bytes_list]
    if len(streams) == 1:
        page.obj[pikepdf.Name("/Contents")] = streams[0]
    else:
        page.obj[pikepdf.Name("/Contents")] = pikepdf.Array(streams)
    return pdf, page


# ------------------------------------------------------------- cắt đúng khối

def test_strip_removes_only_the_watermark_block():
    cleaned = _strip_prynx_watermark(ART_ONE + WATERMARK + ART_TWO)
    assert b"PX_" not in cleaned
    assert b"10 10 50 50 re" in cleaned
    assert b"80 80 40 40 re" in cleaned


def test_strip_keeps_chunk_without_watermark():
    assert _strip_prynx_watermark(ART_ONE) == ART_ONE


def test_strip_ignores_product_code_that_looks_like_tag():
    """Mã sản phẩm in trên tem không phải watermark → không được cắt gì."""
    chunk = ART_ONE + b"BT /F0 8 Tf 10 10 Td (PX_1234) Tj ET\n"
    assert _strip_prynx_watermark(chunk) == chunk


def test_strip_leaves_unmatched_block_intact():
    """Khối lạ có tag nhưng khác thứ tự toán tử → giữ nguyên, không xoá bừa."""
    odd = b"BT 3 Tr (PX_ab12cd_ef34_1753700000) Tj ET\n"
    assert _strip_prynx_watermark(ART_ONE + odd) == ART_ONE + odd


# --------------------------------------------------- trích path trên trang thật

def test_single_stream_with_watermark_keeps_vector_paths():
    """Ca hỏng chính: trang đã gộp về một stream vẫn phải trích được path."""
    pdf, page = _page_with_contents([ART_ONE + WATERMARK])
    with pdf:
        paths = extract_vector_paths(page, pdf)
    assert len(paths) == 1, "watermark không được làm mất path của trang"
    assert paths[0]['type'] == 's'


def test_array_contents_with_watermark_keeps_all_artwork():
    """Dạng mảng: bỏ watermark nhưng giữ đủ path của mọi chunk artwork."""
    pdf, page = _page_with_contents([ART_ONE, WATERMARK, ART_TWO])
    with pdf:
        paths = extract_vector_paths(page, pdf)
    assert len(paths) == 2
    assert [p['paint_index'] for p in paths] == [0, 1]


def test_coalesced_page_matches_array_page():
    """Gộp stream không được đổi số path trích ra (trước đây gộp = mất hết)."""
    pdf_arr, page_arr = _page_with_contents([ART_ONE, WATERMARK, ART_TWO])
    with pdf_arr:
        before = len(extract_vector_paths(page_arr, pdf_arr))

    pdf_co, page_co = _page_with_contents([ART_ONE, WATERMARK, ART_TWO])
    with pdf_co:
        page_co.contents_coalesce()
        assert not isinstance(page_co.obj["/Contents"], pikepdf.Array)
        after = len(extract_vector_paths(page_co, pdf_co))

    assert before == after == 2


def test_chunks_joined_with_whitespace():
    """Chunk kế tiếp không bị dính token: stream trước kết thúc ngay sau toán tử."""
    pdf, page = _page_with_contents([b"0 0 1 RG 10 10 50 50 re S",
                                     b"80 80 40 40 re S"])
    with pdf:
        paths = extract_vector_paths(page, pdf)
    assert len(paths) == 2


def test_page_without_contents_returns_empty():
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(200, 200))
    page = pdf.pages[0]
    with pdf:
        if "/Contents" in page.obj:
            del page.obj[pikepdf.Name("/Contents")]
        assert extract_vector_paths(page, pdf) == []
