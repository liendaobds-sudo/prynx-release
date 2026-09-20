"""Kiểm thử tính năng khử trùng lặp Image XObjects (pdf_resource_dedup)."""

import io
import zlib
import pytest
import pikepdf

from app.core.pdf_resource_dedup import deduplicate_image_xobjects, stable_pdf_object_signature


def _make_dummy_image_pdf(pixels: bytes, width: int = 100, height: int = 100) -> bytes:
    """Tạo một file PDF 1 trang có chứa một ảnh CMYK + SMask."""
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(300, 200))
    
    alpha = bytes([255]) * (width * height)
    smask = pikepdf.Stream(pdf, zlib.compress(alpha, 1))
    smask.Type = pikepdf.Name.XObject
    smask.Subtype = pikepdf.Name.Image
    smask.Width = width
    smask.Height = height
    smask.ColorSpace = pikepdf.Name.DeviceGray
    smask.BitsPerComponent = 8
    smask.Filter = pikepdf.Name.FlateDecode

    image = pikepdf.Stream(pdf, zlib.compress(pixels, 1))
    image.Type = pikepdf.Name.XObject
    image.Subtype = pikepdf.Name.Image
    image.Width = width
    image.Height = height
    image.ColorSpace = pikepdf.Name.DeviceCMYK
    image.BitsPerComponent = 8
    image.Filter = pikepdf.Name.FlateDecode
    image.SMask = smask

    name = page.add_resource(image, pikepdf.Name.XObject)
    page.Contents = pdf.make_stream(
        f"q 300 0 0 200 0 0 cm {name} Do Q".encode("ascii")
    )
    
    buf = io.BytesIO()
    pdf.save(buf)
    return buf.getvalue()


def test_deduplicate_identical_images():
    """Kiểm tra hai chunk có cùng ảnh khi gộp lại sẽ được dedup thành 1 object duy nhất."""
    width, height = 150, 100
    # 4 kênh CMYK
    pixels = bytes([50, 100, 150, 200]) * (width * height)

    pdf_bytes_1 = _make_dummy_image_pdf(pixels, width, height)
    pdf_bytes_2 = _make_dummy_image_pdf(pixels, width, height)

    doc1 = pikepdf.Pdf.open(io.BytesIO(pdf_bytes_1))
    doc2 = pikepdf.Pdf.open(io.BytesIO(pdf_bytes_2))

    # Ghép trang doc2 vào doc1 (mô phỏng final_doc.pages.extend(src_pdf.pages))
    doc1.pages.extend(doc2.pages)
    assert len(doc1.pages) == 2

    # Đếm số image objects trước khi dedup (gồm 2 ảnh chính + 2 SMask = 4)
    images_before = [
        obj for obj in doc1.objects
        if isinstance(obj, pikepdf.Stream) and str(obj.get("/Subtype", "")) == "/Image"
    ]
    assert len(images_before) == 4

    # Chạy dedup
    stats = deduplicate_image_xobjects(doc1)
    assert stats["images"] == 4
    assert stats["unique"] == 2  # 1 ảnh chính + 1 SMask
    assert stats["duplicates"] == 2  # 1 ảnh chính lặp + 1 SMask lặp
    assert stats["rewired"] >= 2

    # Lưu lại để QPDF dọn sạch unreferenced objects
    out_buf = io.BytesIO()
    doc1.save(out_buf)
    doc1.close()
    doc2.close()

    # Mở lại kiểm tra
    verified_doc = pikepdf.Pdf.open(out_buf)
    assert len(verified_doc.pages) == 2

    images_after = [
        obj for obj in verified_doc.objects
        if isinstance(obj, pikepdf.Stream) and str(obj.get("/Subtype", "")) == "/Image"
    ]
    # Sau khi dedup và save, chỉ còn 2 image object duy nhất (1 ảnh chính + 1 SMask)
    assert len(images_after) == 2

    # Cả 2 trang đều tham chiếu tới cùng 1 image stream đó
    p1_img = list(verified_doc.pages[0].Resources.XObject.values())[0]
    p2_img = list(verified_doc.pages[1].Resources.XObject.values())[0]
    assert p1_img.objgen == p2_img.objgen

    verified_doc.close()


def test_deduplicate_different_images_kept_intact():
    """Kiểm tra hai ảnh khác màu/nội dung không bị gộp bừa."""
    width, height = 50, 50
    pixels1 = bytes([10, 20, 30, 40]) * (width * height)
    pixels2 = bytes([50, 60, 70, 80]) * (width * height)

    pdf_bytes_1 = _make_dummy_image_pdf(pixels1, width, height)
    pdf_bytes_2 = _make_dummy_image_pdf(pixels2, width, height)

    doc1 = pikepdf.Pdf.open(io.BytesIO(pdf_bytes_1))
    doc2 = pikepdf.Pdf.open(io.BytesIO(pdf_bytes_2))
    doc1.pages.extend(doc2.pages)

    stats = deduplicate_image_xobjects(doc1)
    assert stats["images"] == 4  # 2 ảnh chính + 2 SMask (nếu SMask giống nhau có thể dedup SMask nhưng ảnh chính khác)
    # Ảnh chính khác nhau nên không bị merge lẫn nhau
    assert stats["unique"] >= 2

    doc1.close()
    doc2.close()


def test_stable_signature_depth_limit():
    """Kiểm tra đồ thị quá sâu bị từ chối an toàn."""
    with pytest.raises(ValueError, match="too deep"):
        stable_pdf_object_signature("val", depth=9)
