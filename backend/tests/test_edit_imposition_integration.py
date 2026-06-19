"""
Integration test: SAU khi edit object, Working_File phải GIỮ cấu trúc trang để
các bước sau (imposition / preflight / nup) không bị vỡ.

Audit nêu rủi ro: "edit object xong chạy imposition/preflight có còn đúng không?".
Rủi ro cốt lõi = `apply_and_save` (ghi lại /Contents qua pikepdf) có thể làm RƠI
các Box trang (MediaBox/CropBox/TrimBox/BleedBox) hoặc đổi số trang → mọi engine
imposition (đọc page.rect/trimbox/cropbox) sẽ sai.

Test này khẳng định INVARIANT cho MỌI op (move/delete/editText/add):
  1. Số trang KHÔNG đổi.
  2. MediaBox/CropBox/TrimBox/BleedBox GIỮ NGUYÊN (đầu vào imposition đúng).
  3. File mở lại được bằng pikepdf VÀ PDFium (geometry_reader) — không hỏng cấu trúc.

(Không chạy nup_engine đầy đủ vì nó dùng ProcessPoolExecutor → giòn/chậm cho unit
test; ở đây kiểm đúng phần đầu vào mà imposition phụ thuộc, deterministic.)
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pikepdf

from app.core import geometry_reader
from app.core.edit_io import apply_and_save
from app.core.stream_editor import add_text, delete_objects, edit_text, move_objects

# Box trang đặt LỆCH NHAU rõ rệt để bắt lỗi rơi/đổi box.
MEDIA = [0.0, 0.0, 400.0, 600.0]
CROP = [10.0, 10.0, 390.0, 590.0]
TRIM = [20.0, 20.0, 380.0, 580.0]
BLEED = [5.0, 5.0, 395.0, 595.0]


def _build_pdf(path: str):
    """1 trang có đủ 4 Box + 1 vector rect + 1 cụm text."""
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(400, 600))
    pg = pdf.pages[0]
    pg.obj[pikepdf.Name.MediaBox] = pikepdf.Array(MEDIA)
    pg.obj[pikepdf.Name.CropBox] = pikepdf.Array(CROP)
    pg.obj[pikepdf.Name("/TrimBox")] = pikepdf.Array(TRIM)
    pg.obj[pikepdf.Name("/BleedBox")] = pikepdf.Array(BLEED)
    font = pikepdf.Dictionary(
        Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type1,
        BaseFont=pikepdf.Name.Helvetica, Encoding=pikepdf.Name.WinAnsiEncoding,
    )
    pg.obj[pikepdf.Name.Resources] = pikepdf.Dictionary(
        Font=pikepdf.Dictionary(F1=pdf.make_indirect(font))
    )
    content = (
        "q 0.1 0.3 0.6 rg 100 100 80 50 re f Q\n"
        "BT /F1 14 Tf 120 500 Td (Label) Tj ET\n"
    ).encode("latin-1")
    pg.obj[pikepdf.Name.Contents] = pdf.make_stream(content)
    pdf.save(path)
    pdf.close()


def _boxes_of(path: str):
    with pikepdf.open(path) as pdf:
        pg = pdf.pages[0]
        def _b(name):
            v = pg.obj.get(name)
            return [round(float(x), 3) for x in v] if v is not None else None
        return {
            "n_pages": len(pdf.pages),
            "MediaBox": _b("/MediaBox"),
            "CropBox": _b("/CropBox"),
            "TrimBox": _b("/TrimBox"),
            "BleedBox": _b("/BleedBox"),
        }


def _assert_structure_preserved(out_path: str):
    boxes = _boxes_of(out_path)
    assert boxes["n_pages"] == 1, f"Số trang đổi: {boxes['n_pages']}"
    assert boxes["MediaBox"] == [round(v, 3) for v in MEDIA], boxes["MediaBox"]
    assert boxes["CropBox"] == [round(v, 3) for v in CROP], boxes["CropBox"]
    assert boxes["TrimBox"] == [round(v, 3) for v in TRIM], boxes["TrimBox"]
    assert boxes["BleedBox"] == [round(v, 3) for v in BLEED], boxes["BleedBox"]
    # Mở lại bằng PDFium (đầu vào imposition/preview) — không hỏng cấu trúc.
    objs = geometry_reader.list_objects(out_path, 0)
    assert isinstance(objs, list)


def _vector_meta(src_path):
    return next(o for o in geometry_reader.list_objects(src_path, 0) if o.type == "vector")


def _text_meta(src_path):
    return next(o for o in geometry_reader.list_objects(src_path, 0) if o.type == "text")


def test_move_preserves_page_structure(tmp_path):
    src = str(tmp_path / "src.pdf")
    _build_pdf(src)
    meta = _vector_meta(src)
    out = str(tmp_path / "moved.pdf")

    def mutate(pdf):
        return move_objects(pdf.pages[0], [meta], 15.0, -10.0, pdf, coord_space="pdf")

    saved, _ = apply_and_save(src, mutate, output_path=out)
    _assert_structure_preserved(saved)


def test_delete_preserves_page_structure(tmp_path):
    src = str(tmp_path / "src.pdf")
    _build_pdf(src)
    meta = _vector_meta(src)
    out = str(tmp_path / "deleted.pdf")

    def mutate(pdf):
        return delete_objects(pdf.pages[0], [meta], pdf)

    saved, _ = apply_and_save(src, mutate, output_path=out)
    _assert_structure_preserved(saved)


def test_edittext_preserves_page_structure(tmp_path):
    src = str(tmp_path / "src.pdf")
    _build_pdf(src)
    meta = _text_meta(src)
    out = str(tmp_path / "edited.pdf")

    def mutate(pdf):
        return edit_text(pdf.pages[0], meta, "Renamed", pdf)

    saved, _ = apply_and_save(src, mutate, output_path=out)
    _assert_structure_preserved(saved)


def test_add_preserves_page_structure(tmp_path):
    src = str(tmp_path / "src.pdf")
    _build_pdf(src)
    out = str(tmp_path / "added.pdf")

    def mutate(pdf):
        return add_text(pdf.pages[0], "Extra", [200.0, 300.0, 360.0, 330.0], pdf, font_size=12.0)

    saved, _ = apply_and_save(src, mutate, output_path=out)
    _assert_structure_preserved(saved)


def test_chained_edits_preserve_structure(tmp_path):
    """Chuỗi nhiều op liên tiếp (như người dùng edit thật) vẫn giữ cấu trúc."""
    src = str(tmp_path / "src.pdf")
    _build_pdf(src)

    # move vector
    out1 = str(tmp_path / "c1.pdf")
    m = _vector_meta(src)
    apply_and_save(src, lambda p: move_objects(p.pages[0], [m], 10.0, 5.0, p, coord_space="pdf"), output_path=out1)
    _assert_structure_preserved(out1)

    # editText trên kết quả
    out2 = str(tmp_path / "c2.pdf")
    mt = _text_meta(out1)
    apply_and_save(out1, lambda p: edit_text(p.pages[0], mt, "Chained", p), output_path=out2)
    _assert_structure_preserved(out2)

    # add trên kết quả
    out3 = str(tmp_path / "c3.pdf")
    apply_and_save(out2, lambda p: add_text(p.pages[0], "More", [150.0, 250.0, 320.0, 280.0], p, font_size=11.0), output_path=out3)
    _assert_structure_preserved(out3)
