"""Test khâu hậu xử lý của /pdf-tools/optimize: strip metadata THẬT + chuẩn hóa
xref cổ điển. Đây là 2 bug đã sửa (strip_metadata no-op; GS output pdf-lib không
mở lại được). Test trực tiếp helper, không qua HTTP để tránh token licensing."""
from __future__ import annotations

import pikepdf

from app.api.routes.pdf_tools import _strip_pdf_metadata, _normalize_compat
from app.workers.pdf_tools_engine import save_pdf_compat


def _make_pdf_with_meta(path: str) -> None:
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(200, 300))
    pdf.docinfo[pikepdf.Name("/Title")] = "Bí mật"
    pdf.docinfo[pikepdf.Name("/Author")] = "PrynX"
    # XMP metadata stream (thứ GS -dFastWebView KHÔNG xóa được).
    with pdf.open_metadata() as m:
        m["dc:creator"] = ["Photoshop"]
    pdf.save(path)


def test_strip_removes_docinfo_and_xmp(tmp_path):
    p = str(tmp_path / "meta.pdf")
    _make_pdf_with_meta(p)

    # Tiền đề: metadata thật sự có mặt trước khi strip.
    with pikepdf.open(p) as pdf:
        assert len(pdf.docinfo.keys()) > 0
        assert "/Metadata" in pdf.Root

    _strip_pdf_metadata(p)

    with pikepdf.open(p) as pdf:
        assert len(pdf.docinfo.keys()) == 0
        assert "/Metadata" not in pdf.Root


def test_strip_preserves_page_content(tmp_path):
    p = str(tmp_path / "meta.pdf")
    _make_pdf_with_meta(p)
    _strip_pdf_metadata(p)
    with pikepdf.open(p) as pdf:
        assert len(pdf.pages) == 1


def test_normalize_compat_produces_classic_xref(tmp_path):
    """GS-output dùng xref stream (Flate) mà pdf-lib không đọc được. Sau chuẩn hóa
    phải là xref cổ điển: object stream bị tắt."""
    p = str(tmp_path / "objstm.pdf")
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(100, 100))
    # Ép ghi object stream (giống GS output) để có gì đó để chuẩn hóa.
    pdf.save(p, object_stream_mode=pikepdf.ObjectStreamMode.generate)

    _normalize_compat(p)

    # Đọc thô: file chuẩn hóa phải chứa bảng 'xref' cổ điển, không phải xref stream.
    raw = open(p, "rb").read()
    assert b"xref" in raw
    # Nội dung vẫn mở được và giữ trang.
    with pikepdf.open(p) as pdf:
        assert len(pdf.pages) == 1


def test_normalize_compat_nonblocking_on_bad_file(tmp_path):
    """Lỗi chuẩn hóa không được ném ra ngoài (non-blocking) — file giữ nguyên."""
    p = str(tmp_path / "broken.pdf")
    open(p, "wb").write(b"not a pdf at all")
    # Không được raise.
    _normalize_compat(p)
    assert open(p, "rb").read() == b"not a pdf at all"
