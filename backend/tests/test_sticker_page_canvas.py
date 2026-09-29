from __future__ import annotations

import asyncio
import hashlib

import pikepdf
import pytest

from app.workers.sticker_page_canvas import (
    normalize_sticker_tight_crop_origin,
    restore_sticker_page_canvas,
    split_or_normalize_sticker_tight_crop,
)


MM_TO_PT = 72.0 / 25.4
A5_W = 148.0 * MM_TO_PT
A5_H = 210.0 * MM_TO_PT


def _box(page, key: str) -> list[float]:
    return [float(value) for value in page.obj[key]]


def _make_source(path) -> None:
    with pikepdf.Pdf.new() as pdf:
        page = pdf.add_blank_page(page_size=(A5_W, A5_H))
        page.TrimBox = pikepdf.Array([2.0, 3.0, A5_W - 4.0, A5_H - 5.0])
        pdf.save(path)


def _make_tight_cropped_output(path, expansion_pts: float) -> None:
    with pikepdf.Pdf.new() as pdf:
        page = pdf.add_blank_page(
            page_size=(A5_W + 2 * expansion_pts, A5_H + 2 * expansion_pts)
        )
        tight = pikepdf.Array(
            [
                expansion_pts + 10.0,
                expansion_pts + 15.0,
                expansion_pts + A5_W - 12.0,
                expansion_pts + A5_H - 18.0,
            ]
        )
        page.MediaBox = tight
        page.CropBox = tight
        page.TrimBox = tight
        page.BleedBox = tight
        page.ArtBox = tight
        pdf.save(path)


def _make_overflow_output(
    path,
    expansion_pts: float,
    *,
    overflow_left: float = 0.0,
    overflow_bottom: float = 0.0,
    overflow_right: float = 0.0,
    overflow_top: float = 0.0,
) -> None:
    """Simulate engine tight-crop when bleed/cutline extends past the source page."""
    with pikepdf.Pdf.new() as pdf:
        page = pdf.add_blank_page(
            page_size=(A5_W + 2 * expansion_pts, A5_H + 2 * expansion_pts)
        )
        # Source canvas maps to [exp, exp, exp+W, exp+H]. Overflow grows past it.
        media = pikepdf.Array(
            [
                expansion_pts - overflow_left,
                expansion_pts - overflow_bottom,
                expansion_pts + A5_W + overflow_right,
                expansion_pts + A5_H + overflow_top,
            ]
        )
        page.MediaBox = media
        page.CropBox = media
        page.BleedBox = media
        pdf.save(path)


def test_restore_sticker_page_canvas_preserves_source_boxes(tmp_path):
    source = tmp_path / "source_a5.pdf"
    output = tmp_path / "tight_output.pdf"
    expansion = 3.0 * 2.83465
    _make_source(source)
    _make_tight_cropped_output(output, expansion)

    restore_sticker_page_canvas(
        str(source),
        str(output),
        expansion_pts=expansion,
    )

    with pikepdf.Pdf.open(output) as pdf:
        page = pdf.pages[0]
        assert _box(page, "/MediaBox") == pytest.approx(
            [expansion, expansion, expansion + A5_W, expansion + A5_H]
        )
        assert _box(page, "/CropBox") == pytest.approx(
            [expansion, expansion, expansion + A5_W, expansion + A5_H]
        )
        assert _box(page, "/TrimBox") == pytest.approx(
            [
                expansion + 2.0,
                expansion + 3.0,
                expansion + A5_W - 4.0,
                expansion + A5_H - 5.0,
            ]
        )
        assert "/BleedBox" not in page.obj
        assert "/ArtBox" not in page.obj
        crop = _box(page, "/CropBox")
        assert (crop[2] - crop[0]) * 25.4 / 72.0 == pytest.approx(148.0)
        assert (crop[3] - crop[1]) * 25.4 / 72.0 == pytest.approx(210.0)


def test_restore_expands_page_when_bleed_overflows_edge(tmp_path):
    """Tem sát mép + bù xén lớn hơn lề → trang nới ra, không cắt mất bleed."""
    source = tmp_path / "source_a5.pdf"
    output = tmp_path / "overflow_output.pdf"
    expansion = 3.0 * MM_TO_PT
    # Sticker 1 mm from right edge, 3 mm bleed → ~2 mm past source right edge.
    overflow_right = 2.0 * MM_TO_PT
    _make_source(source)
    _make_overflow_output(output, expansion, overflow_right=overflow_right)

    restore_sticker_page_canvas(
        str(source),
        str(output),
        expansion_pts=expansion,
    )

    with pikepdf.Pdf.open(output) as pdf:
        page = pdf.pages[0]
        media = _box(page, "/MediaBox")
        crop = _box(page, "/CropBox")
        assert media == pytest.approx(crop, abs=1e-6)
        # Left/bottom/top stay at source canvas; only right expands.
        assert media[0] == pytest.approx(expansion)
        assert media[1] == pytest.approx(expansion)
        assert media[2] == pytest.approx(expansion + A5_W + overflow_right)
        assert media[3] == pytest.approx(expansion + A5_H)
        width_mm = (media[2] - media[0]) * 25.4 / 72.0
        height_mm = (media[3] - media[1]) * 25.4 / 72.0
        assert width_mm == pytest.approx(150.0)  # 148 + 2
        assert height_mm == pytest.approx(210.0)
        # Expanded canvas must declare BleedBox covering the grown area.
        assert _box(page, "/BleedBox") == pytest.approx(media)


def test_restore_expands_all_overflow_sides_never_shrinks(tmp_path):
    source = tmp_path / "source_a5.pdf"
    output = tmp_path / "multi_overflow.pdf"
    expansion = 3.0 * MM_TO_PT
    overflows = {
        "overflow_left": 1.5 * MM_TO_PT,
        "overflow_bottom": 0.5 * MM_TO_PT,
        "overflow_right": 2.0 * MM_TO_PT,
        "overflow_top": 1.0 * MM_TO_PT,
    }
    _make_source(source)
    _make_overflow_output(output, expansion, **overflows)

    restore_sticker_page_canvas(
        str(source),
        str(output),
        expansion_pts=expansion,
    )

    with pikepdf.Pdf.open(output) as pdf:
        media = _box(pdf.pages[0], "/MediaBox")
        assert media[0] == pytest.approx(expansion - overflows["overflow_left"])
        assert media[1] == pytest.approx(expansion - overflows["overflow_bottom"])
        assert media[2] == pytest.approx(
            expansion + A5_W + overflows["overflow_right"]
        )
        assert media[3] == pytest.approx(
            expansion + A5_H + overflows["overflow_top"]
        )
        width_mm = (media[2] - media[0]) * 25.4 / 72.0
        height_mm = (media[3] - media[1]) * 25.4 / 72.0
        assert width_mm == pytest.approx(148.0 + 1.5 + 2.0)
        assert height_mm == pytest.approx(210.0 + 0.5 + 1.0)


def test_sticker_endpoint_restores_a5_after_remove_white_background(
    tmp_path, monkeypatch
):
    from app.api.routes import pdf_tools
    from app.workers import sticker_engine

    source = tmp_path / "source_route_a5.pdf"
    _make_source(source)
    source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    expansion = 3.0 * 2.83465
    captured = {}

    class StubEngine:
        def __init__(self, dpi=300):
            self.dpi = dpi

        def process_pdf(self, input_path, output_path, **kwargs):
            captured.update(kwargs)
            _make_tight_cropped_output(output_path, expansion)
            return True, {"pages": [{"page": 1}]}

    class FakeRequest:
        async def form(self):
            return {
                "file_path": str(source),
                "cut_mode": "original",
                "offset_mm": "0",
                "bleed_mm": "3",
                "remove_white_bg": "true",
                "rectangle_mode": "false",
            }

    monkeypatch.setattr(sticker_engine, "StickerEngine", StubEngine)
    monkeypatch.setattr(pdf_tools, "RESULTS_DIR", str(tmp_path))
    monkeypatch.setattr(pdf_tools, "_safe_watermark", lambda *args: None)

    response = asyncio.run(
        pdf_tools.sticker_dieline_endpoint(FakeRequest(), license_info={})
    )

    assert captured["remove_white_bg"] is True
    assert hashlib.sha256(source.read_bytes()).hexdigest() == source_hash
    with pikepdf.Pdf.open(response.path) as pdf:
        page = pdf.pages[0]
        crop = _box(page, "/CropBox")
        assert (crop[2] - crop[0]) * 25.4 / 72.0 == pytest.approx(148.0)
        assert (crop[3] - crop[1]) * 25.4 / 72.0 == pytest.approx(210.0)


def test_sticker_endpoint_expands_page_for_bleed_overflow(tmp_path, monkeypatch):
    from app.api.routes import pdf_tools
    from app.workers import sticker_engine

    source = tmp_path / "source_route_overflow.pdf"
    _make_source(source)
    expansion = 3.0 * MM_TO_PT
    overflow_right = 2.0 * MM_TO_PT

    class StubEngine:
        def __init__(self, dpi=300):
            self.dpi = dpi

        def process_pdf(self, input_path, output_path, **kwargs):
            _make_overflow_output(
                output_path, expansion, overflow_right=overflow_right
            )
            return True, {"pages": [{"page": 1}]}

    class FakeRequest:
        async def form(self):
            return {
                "file_path": str(source),
                "cut_mode": "original",
                "offset_mm": "0",
                "bleed_mm": "3",
                "remove_white_bg": "false",
                "rectangle_mode": "false",
            }

    monkeypatch.setattr(sticker_engine, "StickerEngine", StubEngine)
    monkeypatch.setattr(pdf_tools, "RESULTS_DIR", str(tmp_path))
    monkeypatch.setattr(pdf_tools, "_safe_watermark", lambda *args: None)

    response = asyncio.run(
        pdf_tools.sticker_dieline_endpoint(FakeRequest(), license_info={})
    )

    with pikepdf.Pdf.open(response.path) as pdf:
        media = _box(pdf.pages[0], "/MediaBox")
        width_mm = (media[2] - media[0]) * 25.4 / 72.0
        height_mm = (media[3] - media[1]) * 25.4 / 72.0
        assert width_mm == pytest.approx(150.0)
        assert height_mm == pytest.approx(210.0)


def test_sticker_endpoint_passes_process_pages_to_engine(tmp_path, monkeypatch):
    from app.api.routes import pdf_tools
    from app.workers import sticker_engine

    source = tmp_path / "source_route_pages.pdf"
    _make_source(source)
    captured = {}

    class StubEngine:
        def __init__(self, dpi=300):
            self.dpi = dpi

        def process_pdf(self, input_path, output_path, **kwargs):
            captured.update(kwargs)
            _make_tight_cropped_output(output_path, 0.0)
            return True, {"pages": [{"page": 1}]}

    class FakeRequest:
        async def form(self):
            return {
                "file_path": str(source),
                "cut_mode": "none",
                "bleed_mm": "3",
                "rectangle_mode": "true",
                "process_pages": "[2, 4]",
            }

    monkeypatch.setattr(sticker_engine, "StickerEngine", StubEngine)
    monkeypatch.setattr(pdf_tools, "RESULTS_DIR", str(tmp_path))
    monkeypatch.setattr(pdf_tools, "_safe_watermark", lambda *args: None)

    asyncio.run(pdf_tools.sticker_dieline_endpoint(FakeRequest(), license_info={}))
    assert captured["process_pages"] == [2, 4]


def test_sticker_engine_only_expands_selected_pages(tmp_path):
    """RESIZE (audit 2026-07-31 §A.4): trang ngoài applyTo phải giữ nguyên."""
    from app.workers.sticker_engine import StickerEngine

    source = tmp_path / "selected_pages_source.pdf"
    output = tmp_path / "selected_pages_output.pdf"
    with pikepdf.Pdf.new() as pdf:
        for color in (b"1 0 0 rg", b"0 0 1 rg"):
            page = pdf.add_blank_page(page_size=(120.0, 80.0))
            page.obj[pikepdf.Name("/Contents")] = pdf.make_stream(
                color + b" 0 0 120 80 re f\n"
            )
        pdf.save(source)

    success, _meta = StickerEngine(dpi=72).process_pdf(
        input_path=str(source),
        output_path=str(output),
        cut_mode="none",
        bleed_mm=3.0,
        bleed_color_type="image",
        draw_cut_contour=False,
        rectangle_mode=True,
        shape_mode="force_rect",
        process_pages=[2],
    )
    assert success is True

    with pikepdf.Pdf.open(output) as pdf:
        first = _box(pdf.pages[0], "/MediaBox")
        second = _box(pdf.pages[1], "/MediaBox")
        assert first == pytest.approx([0.0, 0.0, 120.0, 80.0])
        assert second[2] - second[0] > 120.0
        assert second[3] - second[1] > 80.0


def test_normalize_sticker_tight_crop_origin(tmp_path):
    """ARTBOARD-ORIGIN: File tight crop có offset toạ độ được chuẩn hoá về (0, 0)."""
    target = tmp_path / "tight_crop_offset.pdf"
    with pikepdf.Pdf.new() as pdf:
        page = pdf.add_blank_page(page_size=(300.0, 200.0))
        page.MediaBox = pikepdf.Array([50.0, 80.0, 250.0, 180.0])
        page.CropBox = pikepdf.Array([50.0, 80.0, 250.0, 180.0])
        page.TrimBox = pikepdf.Array([60.0, 90.0, 240.0, 170.0])
        page.obj[pikepdf.Name("/Contents")] = pdf.make_stream(b"1 0 0 rg 50 80 200 100 re f\n")
        pdf.save(target)

    normalized = normalize_sticker_tight_crop_origin(target)
    assert normalized is True

    with pikepdf.Pdf.open(target) as pdf:
        p = pdf.pages[0]
        assert _box(p, "/MediaBox") == pytest.approx([0.0, 0.0, 200.0, 100.0])
        assert _box(p, "/CropBox") == pytest.approx([0.0, 0.0, 200.0, 100.0])
        assert _box(p, "/TrimBox") == pytest.approx([10.0, 10.0, 190.0, 90.0])
        contents = p.Contents.read_bytes()
        assert b"q 1 0 0 1 -50.0000 -80.0000 cm" in contents

    # Gọi lần hai khi toạ độ đã ở (0, 0) thì không sửa gì
    assert normalize_sticker_tight_crop_origin(target) is False


def test_split_or_normalize_sticker_tight_crop_multibox(tmp_path):
    """Tách tờ nhiều tem thành các trang riêng biệt với toạ độ chuẩn hoá về (0, 0)."""
    target = tmp_path / "multi_box_sheet.pdf"
    with pikepdf.Pdf.new() as pdf:
        page = pdf.add_blank_page(page_size=(500.0, 500.0))
        page.obj[pikepdf.Name("/Contents")] = pdf.make_stream(
            b"1 0 0 rg 50 50 100 100 re f\n0 1 0 rg 250 250 150 150 re f\n"
        )
        pdf.save(target)

    meta = {
        "pages": [
            {
                "page": 1,
                "sticker_boxes": [
                    {
                        "crop_box": [45.0, 45.0, 155.0, 155.0],
                        "trim_box": [50.0, 50.0, 150.0, 150.0],
                    },
                    {
                        "crop_box": [245.0, 245.0, 405.0, 405.0],
                        "trim_box": [250.0, 250.0, 400.0, 400.0],
                    },
                ],
            }
        ]
    }

    splat = split_or_normalize_sticker_tight_crop(target, meta=meta)
    assert splat is True

    with pikepdf.Pdf.open(target) as pdf:
        assert len(pdf.pages) == 2

        # Trang 1: Tem 1
        p1 = pdf.pages[0]
        assert _box(p1, "/MediaBox") == pytest.approx([0.0, 0.0, 110.0, 110.0])
        assert _box(p1, "/CropBox") == pytest.approx([0.0, 0.0, 110.0, 110.0])
        assert _box(p1, "/TrimBox") == pytest.approx([5.0, 5.0, 105.0, 105.0])
        p1_contents = p1.Contents.read_bytes()
        assert b"q 0 0 110.0000 110.0000 re W n 1 0 0 1 -45.0000 -45.0000 cm" in p1_contents

        # Trang 2: Tem 2
        p2 = pdf.pages[1]
        assert _box(p2, "/MediaBox") == pytest.approx([0.0, 0.0, 160.0, 160.0])
        assert _box(p2, "/CropBox") == pytest.approx([0.0, 0.0, 160.0, 160.0])
        assert _box(p2, "/TrimBox") == pytest.approx([5.0, 5.0, 155.0, 155.0])
        p2_contents = p2.Contents.read_bytes()
        assert b"q 0 0 160.0000 160.0000 re W n 1 0 0 1 -245.0000 -245.0000 cm" in p2_contents


def test_split_or_normalize_sticker_tight_crop_isolates_cut_streams(tmp_path):
    """Mỗi trang tem sau khi tách CHỈ mang đường bế của chính nó, không rò rỉ đường bế tem lân cận."""
    target = tmp_path / "multi_sticker_sheet.pdf"
    with pikepdf.Pdf.new() as pdf:
        page = pdf.add_blank_page(page_size=(500.0, 500.0))
        # 2 stream: Stream 0 là artwork, Stream 1 là CutContour chung
        s0 = pdf.make_stream(b"q /Im1 Do Q\n")
        s1 = pdf.make_stream(b"q /CutContour CS 1.0 SCN 1.0 w 50 50 100 100 re S 250 250 150 150 re S Q\n")
        page.obj[pikepdf.Name("/Contents")] = pikepdf.Array([s0, s1])
        pdf.save(target)

    cut1 = "q /CutContour CS 1.0 SCN 1.0 w 50 50 100 100 re S Q"
    cut2 = "q /CutContour CS 1.0 SCN 1.0 w 250 250 150 150 re S Q"

    meta = {
        "pages": [
            {
                "page": 1,
                "sticker_boxes": [
                    {
                        "crop_box": [45.0, 45.0, 155.0, 155.0],
                        "trim_box": [50.0, 50.0, 150.0, 150.0],
                        "cut_stream": cut1,
                    },
                    {
                        "crop_box": [245.0, 245.0, 405.0, 405.0],
                        "trim_box": [250.0, 250.0, 400.0, 400.0],
                        "cut_stream": cut2,
                    },
                ],
            }
        ]
    }

    splat = split_or_normalize_sticker_tight_crop(target, meta=meta)
    assert splat is True

    with pikepdf.Pdf.open(target) as pdf:
        assert len(pdf.pages) == 2

        # Trang 1: Phải có cut1 và KHÔNG có cut2
        p1 = pdf.pages[0]
        assert isinstance(p1.obj.Contents, pikepdf.Array)
        assert len(p1.obj.Contents) == 2
        p1_art = p1.obj.Contents[0].read_bytes()
        p1_cut = p1.obj.Contents[1].read_bytes()
        assert b"q 0 0 110.0000 110.0000 re W n 1 0 0 1 -45.0000 -45.0000 cm\nq /Im1 Do Q\n\nQ" in p1_art
        assert b"50 50 100 100 re S" in p1_cut
        assert b"250 250 150 150 re S" not in p1_cut

        # Trang 2: Phải có cut2 và KHÔNG có cut1
        p2 = pdf.pages[1]
        assert isinstance(p2.obj.Contents, pikepdf.Array)
        assert len(p2.obj.Contents) == 2
        p2_art = p2.obj.Contents[0].read_bytes()
        p2_cut = p2.obj.Contents[1].read_bytes()
        assert b"q 0 0 160.0000 160.0000 re W n 1 0 0 1 -245.0000 -245.0000 cm\nq /Im1 Do Q\n\nQ" in p2_art
        assert b"250 250 150 150 re S" in p2_cut
        assert b"50 50 100 100 re S" not in p2_cut


def test_split_or_normalize_sticker_tight_crop_fallback_when_cut_stream_missing(tmp_path):
    """Khi sticker_boxes chưa có cut_stream riêng nhưng sheet có /CutContour, khuôn bế KHÔNG BAO GIỜ bị mất."""
    target = tmp_path / "multi_sticker_fallback.pdf"
    with pikepdf.Pdf.new() as pdf:
        page = pdf.add_blank_page(page_size=(500.0, 500.0))
        s0 = pdf.make_stream(b"q /Im1 Do Q\n")
        s1 = pdf.make_stream(b"q /CutContour CS 1.0 SCN 1.0 w 50 50 100 100 re S Q\n")
        page.obj[pikepdf.Name("/Contents")] = pikepdf.Array([s0, s1])
        pdf.save(target)

    # Metadata không có trường cut_stream
    meta = {
        "pages": [
            {
                "page": 1,
                "sticker_boxes": [
                    {
                        "crop_box": [45.0, 45.0, 155.0, 155.0],
                        "trim_box": [50.0, 50.0, 150.0, 150.0],
                    },
                    {
                        "crop_box": [245.0, 245.0, 405.0, 405.0],
                        "trim_box": [250.0, 250.0, 400.0, 400.0],
                    },
                ],
            }
        ]
    }

    splat = split_or_normalize_sticker_tight_crop(target, meta=meta)
    assert splat is True

    with pikepdf.Pdf.open(target) as pdf:
        assert len(pdf.pages) == 2
        for p in pdf.pages:
            assert isinstance(p.obj.Contents, pikepdf.Array)
            assert len(p.obj.Contents) == 2
            # Stream thứ 2 vẫn bảo toàn CutContour
            cut_bytes = p.obj.Contents[1].read_bytes()
            assert b"/CutContour" in cut_bytes


