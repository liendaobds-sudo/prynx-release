"""Kiểm thử chọn placeholder ảnh/vector thành field QR hoặc barcode."""

from __future__ import annotations

from pathlib import Path

from PIL import Image
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas
import segno

from app.core.geometry_reader import list_objects
from app.workers.vdp_object_picker import (
    _bbox_selected,
    detect_vdp_object_type,
    pick_objects_to_vdp_field,
)


def _make_image_pdf(path: Path) -> None:
    image = Image.new("RGB", (64, 64), (20, 20, 20))
    pdf = canvas.Canvas(str(path), pagesize=(300, 200))
    pdf.drawImage(ImageReader(image), 40, 80, width=60, height=60)
    pdf.save()


def _make_qr_pdf(path: Path, png_path: Path) -> None:
    segno.make("https://prynx.example/placeholder").save(str(png_path), kind="png", scale=4, border=4)
    pdf = canvas.Canvas(str(path), pagesize=(300, 200))
    pdf.drawImage(str(png_path), 40, 70, width=80, height=80, mask="auto")
    pdf.save()


def _make_barcode_pdf(path: Path) -> None:
    pdf = canvas.Canvas(str(path), pagesize=(300, 200))
    for index, width in enumerate((1, 2, 1, 3, 1, 1, 2, 1, 3, 1)):
        x = 40 + index * 7
        pdf.setFillGray(0)
        pdf.rect(x, 80, width, 60, stroke=0, fill=1)
    pdf.save()


def test_image_placeholder_becomes_qr_and_is_removed(tmp_path: Path) -> None:
    source = tmp_path / "image.pdf"
    cleaned = tmp_path / "image-clean.pdf"
    _make_image_pdf(source)
    image = next(obj for obj in list_objects(str(source), 0) if obj.type == "image")

    result = pick_objects_to_vdp_field(
        str(source),
        0,
        draw_indices=[image.drawIndex],
        field_type="qrcode",
        remove_original=True,
        output_path=str(cleaned),
    )

    assert result["field"]["type"] == "qrcode"
    assert result["field"]["width"] > 0
    assert result["field"]["height"] > 0
    assert result["removedDrawIndices"] == [image.drawIndex]
    assert cleaned.is_file()
    assert not any(obj.type == "image" for obj in list_objects(str(cleaned), 0))


def test_multiple_vector_bars_become_one_barcode_field(tmp_path: Path) -> None:
    source = tmp_path / "bars.pdf"
    cleaned = tmp_path / "bars-clean.pdf"
    _make_barcode_pdf(source)
    bars = [obj for obj in list_objects(str(source), 0) if obj.type == "vector"]
    assert len(bars) >= 3

    result = pick_objects_to_vdp_field(
        str(source),
        0,
        draw_indices=[obj.drawIndex for obj in bars],
        field_type="barcode",
        barcode_type="code128",
        remove_original=True,
        output_path=str(cleaned),
    )

    assert result["field"]["type"] == "barcode"
    assert result["field"]["barcodeType"] == "code128"
    assert len(result["removedDrawIndices"]) == len(bars)
    assert not any(obj.type == "vector" for obj in list_objects(str(cleaned), 0))


def test_vector_group_detection_is_only_a_barcode_hint(tmp_path: Path) -> None:
    source = tmp_path / "bars-detect.pdf"
    _make_barcode_pdf(source)
    bars = [obj for obj in list_objects(str(source), 0) if obj.type == "vector"]

    result = detect_vdp_object_type(str(source), 0, [obj.drawIndex for obj in bars])

    assert result["decoded"] is True
    assert result["fieldType"] == "barcode"
    assert result["barcodeType"] == "code128"


def test_qr_image_detection_is_only_a_hint(tmp_path: Path) -> None:
    source = tmp_path / "qr-detect.pdf"
    _make_qr_pdf(source, tmp_path / "qr.png")
    image = next(obj for obj in list_objects(str(source), 0) if obj.type == "image")

    result = detect_vdp_object_type(str(source), 0, [image.drawIndex])

    assert result["decoded"] is True
    assert result["fieldType"] == "qrcode"
    assert result["payload"] == "https://prynx.example/placeholder"


def test_marquee_does_not_select_full_page_background() -> None:
    assert not _bbox_selected([0, 0, 300, 200], [90, 70, 150, 150])
    assert _bbox_selected([100, 80, 120, 120], [90, 70, 150, 150])
