"""
Sinh bộ PDF test chuẩn cho Preflight QA + golden tests.

Chạy:
    cd backend
    venv\\Scripts\\python.exe tests/preflight_fixtures/generate_fixtures.py
"""
from __future__ import annotations

import io
import json
import struct
import zlib
from pathlib import Path

import pikepdf
from PIL import Image
from reportlab.lib.pagesizes import letter
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

FIXTURES_DIR = Path(__file__).parent / "pdfs"
MANIFEST_PATH = Path(__file__).parent / "expected_rules.json"

# ── Metadata từng fixture (must_have = rule PHẢI xuất hiện khi chạy ALL_RULES) ──

FIXTURE_SPECS: dict[str, dict] = {
    "01_clean_blank.pdf": {
        "title": "Trang trắng — thiếu TrimBox/Bleed",
        "category": "baseline",
        "must_have": ["BLEED_MISSING"],
        "must_not_have": ["INTERNAL_ERROR"],
        "manual_note": "File tối thiểu từ pikepdf; kiểm tra CTP báo thiếu hộp cắt.",
    },
    "02_rgb_colorspace.pdf": {
        "title": "ColorSpace DeviceRGB nhúng trên trang",
        "category": "color",
        "must_have": ["COLOR_RGB_DETECTED"],
        "must_not_have": [],
        "manual_note": "Mở Separations/Output Preview — vùng RGB phải highlight.",
    },
    "03_live_text.pdf": {
        "title": "Live text (ReportLab)",
        "category": "font",
        "must_have": ["TEXT_DETECTED"],
        "must_not_have": [],
        "manual_note": "Viewer highlight text; thử action Khóa Font.",
    },
    "04_font_not_embedded.pdf": {
        "title": "Font TrueType không có FontFile",
        "category": "font",
        "must_have": ["FONT_NOT_EMBEDDED"],
        "must_not_have": [],
        "manual_note": "BBox font trên viewer (nếu pdfplumber khớp tên).",
    },
    "05_page_size_mismatch.pdf": {
        "title": "Hai trang khác khổ",
        "category": "structure",
        "must_have": ["PAGE_SIZE_MISMATCH"],
        "must_not_have": [],
        "manual_note": "Trang 2 khác trang 1 — kiểm tra ghép bài N-Up.",
    },
    "06_opi_linked_image.pdf": {
        "title": "Ảnh OPI link (chưa embed)",
        "category": "image",
        "must_have": ["IMAGE_NOT_EMBEDDED"],
        "must_not_have": [],
        "manual_note": "OPI trong XObject. QA manual thêm: file Illustrator XMP linked thật.",
    },
    "06b_xmp_linked_manual.pdf": {
        "title": "[Manual QA] XMP Illustrator linked — không dùng golden auto",
        "category": "image",
        "must_have": [],
        "must_not_have": ["INTERNAL_ERROR"],
        "manual_only": True,
        "manual_note": "Chỉ kiểm tra bằng file AI/Corel thật; pikepdf strip XMP khi save.",
    },
    "07_indexed_palette.pdf": {
        "title": "Ảnh Indexed / palette nghèo 16 màu",
        "category": "image",
        "must_have": ["GIF_IN_PDF"],
        "must_not_have": [],
        "manual_note": "Palette 4-bit giống GIF cũ — cảnh báo chất lượng in kém.",
    },
    "08_low_res_image.pdf": {
        "title": "Ảnh 40×40px kéo full trang (~5 DPI)",
        "category": "image",
        "must_have": ["IMAGE_LOW_RES"],
        "must_not_have": [],
        "manual_note": "BBox ảnh trên viewer; mô tả ~DPI thấp.",
    },
    "09_high_dpi_image.pdf": {
        "title": "Ảnh 2400×2400px đặt 1 inch (~2400 DPI)",
        "category": "image",
        "must_have": ["IMAGE_HIGH_DPI"],
        "must_not_have": [],
        "manual_note": "Gợi ý Downscale 300 DPI.",
    },
    "10_overprint.pdf": {
        "title": "ExtGState Overprint bật",
        "category": "color",
        "must_have": ["OVERPRINT_DETECTED"],
        "must_not_have": [],
        "manual_note": "Bật Overprint Preview — vùng thay đổi.",
    },
    "11_transparency.pdf": {
        "title": "Transparency Group trên trang",
        "category": "structure",
        "must_have": ["TRANSPARENCY_DETECTED"],
        "must_not_have": [],
        "manual_note": "Thử Flatten Transparency fix.",
    },
    "12_spot_color.pdf": {
        "title": "Separation / Spot ColorSpace",
        "category": "color",
        "must_have": ["COLOR_SPOT_DETECTED"],
        "must_not_have": [],
        "manual_note": "Liệt kê kênh spot trong báo cáo.",
    },
    "13_multipage_15.pdf": {
        "title": "15 trang — smoke test multiprocessing",
        "category": "performance",
        "must_have": ["BLEED_MISSING"],
        "must_not_have": ["INTERNAL_ERROR"],
        "manual_note": "File >10 trang → ProcessPoolExecutor; không crash.",
    },
    "14_progressive_jpeg.pdf": {
        "title": "[Manual QA] JPEG Progressive — ReportLab embed",
        "category": "image",
        "must_have": [],
        "must_not_have": ["INTERNAL_ERROR"],
        "manual_only": True,
        "manual_note": "ReportLab dùng ASCII85+DCT; verify PROGRESSIVE_JPEG bằng file JPEG progressive thật từ khách.",
    },
    "15_pdf_version_old.pdf": {
        "title": "PDF version 1.2 (quá cũ)",
        "category": "structure",
        "must_have": ["PDF_VERSION_MISMATCH"],
        "must_not_have": [],
        "manual_note": "Khuyên nâng lên PDF 1.4+.",
    },
    "16_object_off_page.pdf": {
        "title": "Text vẽ ngoài MediaBox",
        "category": "structure",
        "must_have": ["OBJECT_OFF_PAGE"],
        "must_not_have": [],
        "manual_note": "Đối tượng hoàn toàn ngoài vùng in.",
    },
    "17_tac_heavy_cmyk.pdf": {
        "title": "Tấm CMYK đặc — TAC cao (kiểm tra bằng PPE)",
        "category": "ink",
        "must_have": ["TAC_EXCEEDED"],
        "must_not_have": ["INTERNAL_ERROR"],

        "manual_note": "SeparationEngine/PPE phải phát hiện TAC_EXCEEDED. QA manual bắt buộc.",
    },
}


def _save_canvas_to(path: Path, draw_fn) -> None:
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=letter)
    draw_fn(c)
    c.save()
    path.write_bytes(buf.getvalue())


def _make_clean_blank(path: Path) -> None:
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(612, 792))
    pdf.save(path)
    pdf.close()


def _make_rgb_colorspace(path: Path) -> None:
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(612, 792))
    page["/Resources"] = pikepdf.Dictionary({
        "/ColorSpace": pikepdf.Dictionary({"/Cs1": pikepdf.Name("/DeviceRGB")}),
    })
    pdf.save(path)
    pdf.close()


def _make_live_text(path: Path) -> None:
    def draw(c):
        c.setFont("Helvetica", 24)
        c.drawString(72, 700, "Live Text Preflight QA")
        c.drawString(72, 660, "Chữ sống chưa Outline")

    _save_canvas_to(path, draw)


def _make_font_not_embedded(path: Path) -> None:
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(612, 792))
    font_descriptor = pikepdf.Dictionary({
        "/Type": "/FontDescriptor",
        "/FontName": "/FakeFontQA",
        "/Flags": 32,
        "/ItalicAngle": 0,
        "/Ascent": 800,
        "/Descent": -200,
        "/CapHeight": 700,
        "/StemV": 80,
    })
    font = pikepdf.Dictionary({
        "/Type": "/Font",
        "/Subtype": "/TrueType",
        "/BaseFont": "/FakeFontQA",
        "/FirstChar": 32,
        "/LastChar": 126,
        "/Widths": pikepdf.Array([500] * 95),
        "/FontDescriptor": pdf.make_indirect(font_descriptor),
    })
    page["/Resources"] = pikepdf.Dictionary({
        "/Font": pikepdf.Dictionary({"/F1": pdf.make_indirect(font)}),
    })
    content = b"BT /F1 24 Tf 72 700 Td (Unembedded Font) Tj ET"
    page["/Contents"] = pdf.make_stream(content)
    pdf.save(path)
    pdf.close()


def _make_page_size_mismatch(path: Path) -> None:
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(612, 792))
    pdf.add_blank_page(page_size=(500, 700))
    pdf.save(path)
    pdf.close()


def _make_opi_linked_image(path: Path) -> None:
    """Ảnh có /OPI → rule IMAGE_NOT_EMBEDDED (ổn định hơn XMP qua pikepdf save)."""
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(612, 792))
    img = pikepdf.Stream(pdf, b"\x00" * 256)
    img["/Type"] = pikepdf.Name("/XObject")
    img["/Subtype"] = pikepdf.Name("/Image")
    img["/Width"] = 16
    img["/Height"] = 16
    img["/BitsPerComponent"] = 8
    img["/ColorSpace"] = pikepdf.Name("/DeviceRGB")
    img["/OPI"] = pikepdf.Dictionary({
        "/F": pikepdf.Name("/URL"),
        "/URL": "file:///linked_image.tif",
    })
    page["/Resources"] = pikepdf.Dictionary({
        "/XObject": pikepdf.Dictionary({"/ImOPI": pdf.make_indirect(img)}),
    })
    page["/Contents"] = pdf.make_stream(b"q 72 0 0 72 200 400 cm /ImOPI Do Q")
    pdf.save(path)
    pdf.close()


def _make_indexed_palette(path: Path) -> None:
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(612, 792))
    # Indexed ColorSpace nghèo: 4-bit / 16 màu — đúng ngưỡng GIF_IN_PDF.
    palette = bytes(range(16)) * 3
    indexed = pikepdf.Array([
        pikepdf.Name("/Indexed"),
        pikepdf.Name("/DeviceRGB"),
        15,
        pikepdf.Stream(pdf, palette),
    ])
    img = pikepdf.Stream(pdf, b"\x12" * 32)
    img["/Type"] = pikepdf.Name("/XObject")
    img["/Subtype"] = pikepdf.Name("/Image")
    img["/Width"] = 8
    img["/Height"] = 8
    img["/BitsPerComponent"] = 4
    img["/ColorSpace"] = indexed
    page["/Resources"] = pikepdf.Dictionary({
        "/ColorSpace": pikepdf.Dictionary({"/CsI": indexed}),
        "/XObject": pikepdf.Dictionary({"/Im1": pdf.make_indirect(img)}),
    })
    # Draw image on page
    page["/Contents"] = pdf.make_stream(
        b"q 200 0 0 200 72 400 cm /Im1 Do Q"
    )
    pdf.save(path)
    pdf.close()


def _pil_png_bytes(size: tuple[int, int], color=(200, 50, 50)) -> bytes:
    img = Image.new("RGB", size, color)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _make_low_res_image(path: Path) -> None:
    png = _pil_png_bytes((40, 40))

    def draw(c):
        c.drawImage(ImageReader(io.BytesIO(png)), 36, 36, width=540, height=720)

    _save_canvas_to(path, draw)


def _make_high_dpi_image(path: Path) -> None:
    png = _pil_png_bytes((2400, 2400))

    def draw(c):
        c.drawImage(ImageReader(io.BytesIO(png)), 72, 500, width=72, height=72)

    _save_canvas_to(path, draw)


def _make_overprint(path: Path) -> None:
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(612, 792))
    gs = pikepdf.Dictionary({"/Type": "/ExtGState", "/OP": True, "/op": True})
    page["/Resources"] = pikepdf.Dictionary({
        "/ExtGState": pikepdf.Dictionary({"/GS1": pdf.make_indirect(gs)}),
    })
    page["/Contents"] = pdf.make_stream(b"/GS1 gs 72 700 200 50 re f")
    pdf.save(path)
    pdf.close()


def _make_transparency(path: Path) -> None:
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(612, 792))
    group = pikepdf.Dictionary({"/S": "/Transparency", "/I": True})
    page["/Group"] = pdf.make_indirect(group)
    pdf.save(path)
    pdf.close()


def _make_spot_color(path: Path) -> None:
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(612, 792))
    sep = pikepdf.Array([
        pikepdf.Name("/Separation"),
        pikepdf.Name("/PANTONE185C"),
        pikepdf.Name("/DeviceCMYK"),
        pikepdf.Stream(pdf, b"{1 exch 0 exch 0 exch 0 exch}"),
    ])
    page["/Resources"] = pikepdf.Dictionary({
        "/ColorSpace": pikepdf.Dictionary({"/CsSpot": sep}),
    })
    pdf.save(path)
    pdf.close()


def _make_multipage_15(path: Path) -> None:
    pdf = pikepdf.Pdf.new()
    for _ in range(15):
        pdf.add_blank_page(page_size=(612, 792))
    pdf.save(path)
    pdf.close()


def _progressive_jpeg_bytes() -> bytes:
    """JPEG tổng hợp có marker SOF2 (0xFFC2) — scanner preflight chỉ cần marker."""
    return bytes([
        0xFF, 0xD8,
        0xFF, 0xC2, 0x00, 0x11,
        0x08, 0x01, 0x00, 0x01, 0x00, 0x01,
        0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
        0xFF, 0xDA, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3F, 0x00,
        0x55, 0x66, 0x77,
        0xFF, 0xD9,
    ])


def _make_progressive_jpeg(path: Path) -> None:
    """ReportLab embed JPEG có SOF2 — giống pipeline in thực tế."""
    jpg_tmp = path.with_suffix(".progressive.jpg")
    jpg_tmp.write_bytes(_progressive_jpeg_bytes())

    def draw(c):
        c.drawImage(str(jpg_tmp), 72, 400, width=72, height=72)

    _save_canvas_to(path, draw)
    jpg_tmp.unlink(missing_ok=True)


def _make_pdf_version_old(path: Path) -> None:
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(612, 792))
    pdf.save(path, min_version="1.2")
    pdf.close()
    # pikepdf có thể nâng header lên 1.3 — patch header để giữ 1.2 cho QA
    raw = path.read_bytes()
    if raw.startswith(b"%PDF-1.3"):
        path.write_bytes(raw.replace(b"%PDF-1.3", b"%PDF-1.2", 1))


def _make_object_off_page(path: Path) -> None:
    def draw(c):
        c.setFont("Helvetica", 14)
        c.drawString(-400, -400, "Off page object QA")

    _save_canvas_to(path, draw)


def _make_tac_heavy_cmyk(path: Path) -> None:
    """Full CMYK fill — TAC ~400% nếu SeparationEngine hoạt động."""

    def draw(c):
        c.setFillColorCMYK(1, 1, 1, 1)
        c.rect(36, 36, 540, 720, fill=1, stroke=0)

    _save_canvas_to(path, draw)


GENERATORS = {
    "01_clean_blank.pdf": _make_clean_blank,
    "02_rgb_colorspace.pdf": _make_rgb_colorspace,
    "03_live_text.pdf": _make_live_text,
    "04_font_not_embedded.pdf": _make_font_not_embedded,
    "05_page_size_mismatch.pdf": _make_page_size_mismatch,
    "06_opi_linked_image.pdf": _make_opi_linked_image,
    "07_indexed_palette.pdf": _make_indexed_palette,
    "08_low_res_image.pdf": _make_low_res_image,
    "09_high_dpi_image.pdf": _make_high_dpi_image,
    "10_overprint.pdf": _make_overprint,
    "11_transparency.pdf": _make_transparency,
    "12_spot_color.pdf": _make_spot_color,
    "13_multipage_15.pdf": _make_multipage_15,
    "14_progressive_jpeg.pdf": _make_progressive_jpeg,
    "15_pdf_version_old.pdf": _make_pdf_version_old,
    "16_object_off_page.pdf": _make_object_off_page,
    "17_tac_heavy_cmyk.pdf": _make_tac_heavy_cmyk,
}


def generate_all() -> None:
    FIXTURES_DIR.mkdir(parents=True, exist_ok=True)
    for name, fn in GENERATORS.items():
        out = FIXTURES_DIR / name
        fn(out)
        print(f"  OK {name}")

    # Manifest chỉ gồm fixture có PDF (bỏ manual_only không sinh file)
    fixtures = {
        k: v for k, v in FIXTURE_SPECS.items()
        if not v.get("manual_only")
    }
    manifest = {
        "version": 1,
        "generated_by": "tests/preflight_fixtures/generate_fixtures.py",
        "fixtures": fixtures,
        "manual_only_fixtures": {
            k: v for k, v in FIXTURE_SPECS.items() if v.get("manual_only")
        },
    }
    MANIFEST_PATH.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"\nWrote {MANIFEST_PATH}")
    print(f"PDFs in {FIXTURES_DIR}")


if __name__ == "__main__":
    print("Generating preflight fixture PDFs...")
    generate_all()
