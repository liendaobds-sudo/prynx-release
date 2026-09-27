"""Giữ Alpha artwork gốc; mask phục vụ đường CUT không được xén chi tiết in.

QUALITY (audit 2026-09-27 §ARTWORK.ALPHA): file ảnh/SMask còn nguyên byte
chưa đủ: một clip trace đặt ngoài Form vẫn có thể che các điểm ảnh thật.
"""
from __future__ import annotations

from io import BytesIO
from pathlib import Path
import zlib

import numpy as np
import pytest

pikepdf = pytest.importorskip("pikepdf")
pdfium = pytest.importorskip("pypdfium2")
pytest.importorskip("cv2")
pytest.importorskip("shapely")
pytest.importorskip("skimage")
pytest.importorskip("reportlab")

from PIL import Image
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

from app.core.pdfium_lock import pdfium_guard
from app.workers import sticker_engine


def _write_source(path: Path, *, transparent: bool = True, detail_alpha: int = 255) -> np.ndarray:
    """PNG 600 DPI có đảo nhỏ thật, lỗ và biên bán trong suốt."""
    height, width = 300, 360
    yy, xx = np.mgrid[:height, :width]
    radius = np.sqrt(((xx - 195) / 1.2) ** 2 + (yy - 155) ** 2)
    alpha = np.zeros((height, width), dtype=np.uint8)
    alpha[radius < 91] = 96
    alpha[radius < 88] = 255
    alpha[137:159, 180:202] = 0
    # Đảo màu thật nhỏ hơn ngưỡng lọc 1 mm² của hình học dao.
    alpha[76:82, 115:121] = detail_alpha
    rgb = np.empty((height, width, 3), dtype=np.uint8)
    rgb[:] = (31, 112, 189)
    rgb[76:82, 115:121] = (225, 35, 42)
    if transparent:
        image = Image.fromarray(np.dstack((rgb, alpha)), "RGBA")
    else:
        opaque = np.full_like(rgb, 255)
        opaque[alpha > 0] = rgb[alpha > 0]
        image = Image.fromarray(opaque, "RGB")
    png = BytesIO()
    image.save(png, format="PNG")
    png.seek(0)
    width_pt, height_pt = width * 72.0 / 600.0, height * 72.0 / 600.0
    document = canvas.Canvas(str(path), pagesize=(width_pt, height_pt), pageCompression=0)
    document.drawImage(ImageReader(png), 0, 0, width=width_pt, height=height_pt, mask="auto")
    document.showPage()
    document.save()
    return alpha


def _execute(source: Path, output: Path, **changes) -> dict:
    options = dict(
        cut_mode="original", offset_mm=0.0, bleed_mm=1.0,
        corner_style="preserve", fill_holes=True, remove_white_bg=False,
        bleed_color_type="solid", solid_bleed_color=(255, 255, 255),
        draw_cut_contour=True, shape_mode="contour", edge_bite_mm=0.0,
        cutline_denoise=70, cutline_simplify_mm=0.0,
    )
    options.update(changes)
    success, metadata = sticker_engine.StickerEngine(dpi=300).process_pdf(
        input_path=str(source), output_path=str(output), **options,
    )
    assert success is True, metadata
    return metadata


def _artwork_range(page):
    """Tách đúng nhóm q…Form nguồn Do…Q, không đếm clip của ảnh bù xén."""
    instructions = list(pikepdf.parse_content_stream(page))
    resources = page.Resources.XObject
    stack = []
    start = end = None
    for index, instruction in enumerate(instructions):
        operator = str(instruction.operator)
        if operator == "q":
            stack.append(index)
        elif operator == "Q":
            opened = stack.pop()
            if start == opened:
                end = index + 1
                break
        elif operator == "Do" and str(resources[instruction.operands[0]].get("/Subtype")) == "/Form":
            assert start is None, "Fixture chỉ được có một lần vẽ Form artwork."
            start = stack[-1]
    assert start is not None and end is not None
    return instructions, start, end


def _artwork_block(page):
    instructions, start, end = _artwork_range(page)
    return instructions[start:end]


def _clip_free_artwork(block):
    """Oracle giữ nguyên CTM và Form; chỉ bỏ trace clip vừa được engine thêm."""
    return [instruction for instruction in block
            if str(instruction.operator) in {"q", "cm", "Do", "Q"}]


def _without_cut(page):
    instructions = list(pikepdf.parse_content_stream(page))
    stack = []
    cut_start = None
    for index, instruction in enumerate(instructions):
        operator = str(instruction.operator)
        if operator == "q":
            stack.append(index)
        elif operator == "CS" and str(instruction.operands[0]) == "/CutContour":
            cut_start = stack[-1]
        elif operator == "Q":
            opened = stack.pop()
            if opened == cut_start:
                return instructions[:cut_start] + instructions[index + 1:]
    pytest.fail("Fixture phải có đường CUT để chặn việc bỏ nhầm layer dao.")


def _render_program(document, page, program, *, dpi: float = 600.0) -> np.ndarray:
    page_index = next(index for index, item in enumerate(document.pages)
                      if item.obj.objgen == page.obj.objgen)
    page.Contents = document.make_stream(pikepdf.unparse_content_stream(program))
    encoded = BytesIO()
    document.save(encoded)
    with pdfium_guard():
        rendered = pdfium.PdfDocument(encoded.getvalue())
        try:
            rendered_page = rendered[page_index]
            try:
                bitmap = rendered_page.render(
                    scale=dpi / 72.0, fill_color=(0, 0, 0, 0), rev_byteorder=True,
                )
                try:
                    pixels = np.array(bitmap.to_numpy(), copy=True)
                    # RGB ẩn dưới Alpha=0 không phải khác biệt phần in nhìn thấy.
                    pixels[pixels[:, :, 3] == 0, :3] = 0
                    return pixels
                finally:
                    bitmap.close()
            finally:
                rendered_page.close()
        finally:
            rendered.close()


def _image_records(page):
    records = []

    def visit(resources):
        for value in resources.get("/XObject", {}).values():
            subtype = str(value.get("/Subtype"))
            if subtype == "/Form":
                visit(value.get("/Resources", {}))
            elif subtype == "/Image":
                alpha = value.get("/SMask")
                # qpdf có thể bỏ wrapper ASCII85 của PNG mà không đổi pixel.
                # JPEG phải giữ stream nén gốc; Flate so toàn bộ byte giải nén.
                image_bytes = (value.read_raw_bytes() if "/DCTDecode" in str(value.get("/Filter"))
                               else value.read_bytes())
                records.append((
                    int(value.Width), int(value.Height), image_bytes,
                    alpha.read_bytes() if alpha is not None else None,
                ))

    visit(page.Resources)
    return records


@pytest.mark.parametrize("bleed_color_type", ["solid", "image"])
@pytest.mark.parametrize("remove_white_bg", [False, True])
def test_native_alpha_artwork_preserves_original_pixels_and_image_streams(
    tmp_path, bleed_color_type, remove_white_bg,
):
    source, output = tmp_path / "source.pdf", tmp_path / "result.pdf"
    _write_source(source)
    _execute(source, output, bleed_color_type=bleed_color_type, remove_white_bg=remove_white_bg)
    with pikepdf.Pdf.open(source) as original, pikepdf.Pdf.open(output) as result:
        page = result.pages[0]
        original_images = _image_records(original.pages[0])
        assert len(original_images) == 1 and original_images[0][-1] is not None
        assert original_images[0] in _image_records(page)
        block = _artwork_block(page)
        expected = _render_program(result, page, _clip_free_artwork(block))
        actual = _render_program(result, page, block)
        assert np.array_equal(actual, expected), (
            "Clip hình học dao đã che/méo điểm ảnh Alpha gốc: "
            f"{np.count_nonzero(np.any(actual != expected, axis=2))} pixel."
        )
        assert not {"W", "W*"}.intersection(str(item.operator) for item in block)


@pytest.mark.parametrize("bleed_color_type", ["solid", "image"])
def test_bleed_does_not_paint_over_detached_native_artwork_detail(tmp_path, bleed_color_type):
    source, output = tmp_path / "source.pdf", tmp_path / "result.pdf"
    _write_source(source)
    _execute(source, output, bleed_color_type=bleed_color_type, edge_sample_inset_mm=0.5)
    with pikepdf.Pdf.open(output) as result:
        page = result.pages[0]
        composite = _without_cut(page)
        original = _render_program(result, page, _clip_free_artwork(_artwork_block(page)))
        actual = _render_program(result, page, composite)
        # Dải choke được phép làm sạch halo sát mép chính theo hợp đồng cũ.
        # Riêng đảo đỏ thật bị bộ lọc CUT bỏ qua phải còn nguyên màu/độ đục.
        detail = ((original[:, :, 3] == 255) & (original[:, :, 0] > 200)
                  & (original[:, :, 1] < 80))
        assert np.count_nonzero(detail) >= 9
        assert np.array_equal(actual[detail], original[detail]), (
            "Màu bù xén không được phủ lên đảo artwork thật mà CUT đã lọc bỏ."
        )


@pytest.mark.parametrize("guard", ["opaque", "edge-bite", "rectangle", "approved-mask", "alpha-path-override"])
def test_intentional_artwork_mask_still_has_clip(tmp_path, guard):
    source, output = tmp_path / "source.pdf", tmp_path / "result.pdf"
    alpha = _write_source(source, transparent=guard != "opaque")
    options = {}
    if guard == "opaque":
        options["remove_white_bg"] = True
    elif guard == "edge-bite":
        options["edge_bite_mm"] = 0.3
    elif guard == "rectangle":
        options["rectangle_mode"] = True
    else:
        # Mask đã sửa là chủ ý khác Alpha nguồn, không được fast-path ghi đè.
        alpha[:, :180] = 0
        ring = sticker_engine._linear_bezier_ring([(21.6, 6), (36, 6), (36, 30), (21.6, 30)])
        payload = {
            "alpha": alpha, "dpi": (600.0, 600.0), "source_pixel_mm": 25.4 / 600.0,
            "boundary_source": "ai", "path_groups": [{"exterior": ring}],
        }
        option = "alpha_path_overrides" if guard == "alpha-path-override" else "approved_contour_overrides"
        options[option] = {0: payload}
    _execute(source, output, **options)
    with pikepdf.Pdf.open(output) as result:
        assert {"W", "W*"}.intersection(str(item.operator) for item in _artwork_block(result.pages[0]))


def test_binder_page_four_native_alpha_keeps_all_artwork_pixels(tmp_path):
    corpus = Path(__file__).resolve().parents[2] / "test" / "Binder2.pdf"
    if not corpus.is_file():
        pytest.skip("Corpus Binder2.pdf không có trên môi trường này.")
    source, output = tmp_path / "nice-work.pdf", tmp_path / "nice-work-result.pdf"
    with pikepdf.Pdf.open(corpus) as original, pikepdf.Pdf.new() as single:
        single.pages.append(original.pages[3])
        single.save(source)
    _execute(source, output, bleed_mm=2.0, cut_mode="bleed", cutline_denoise=30)
    with pikepdf.Pdf.open(source) as original, pikepdf.Pdf.open(output) as result:
        page = result.pages[0]
        assert _image_records(original.pages[0])[0] in _image_records(page)
        block = _artwork_block(page)
        expected = _render_program(result, page, _clip_free_artwork(block))
        actual = _render_program(result, page, block)
        assert np.array_equal(actual, expected), "NICE WORK vẫn bị clip lại bằng hình học đã lọc."


def test_preserving_native_artwork_does_not_change_cut_geometry(tmp_path, monkeypatch):
    source = tmp_path / "source.pdf"
    _write_source(source)
    programs = []
    for enabled in (False, True):
        monkeypatch.setattr(sticker_engine, "_can_preserve_native_artwork_alpha", lambda *args, **kwargs: enabled)
        output = tmp_path / f"preserve-{enabled}.pdf"
        _execute(source, output)
        with pikepdf.Pdf.open(output) as result:
            instructions = list(pikepdf.parse_content_stream(result.pages[0]))
            start = next(index for index, item in enumerate(instructions)
                         if str(item.operator) == "CS" and str(item.operands[0]) == "/CutContour")
            end = next(index for index in range(start, len(instructions))
                       if str(instructions[index].operator) == "S")
            programs.append(pikepdf.unparse_content_stream(instructions[start:end + 1]))
    assert programs[0] == programs[1]


@pytest.mark.parametrize("changes", [
    {}, {"source_rendered_transparent": False}, {"has_alpha": False},
    {"rectangle_mode": True}, {"selection_page_mode": True},
    {"has_mask_override": True}, {"edge_bite_mm": 0.01},
    {"removes_background": True},
])
def test_native_alpha_clip_bypass_requires_complete_provenance(changes):
    """Có SMask trong tài liệu không đủ để bỏ một mask người dùng chủ ý sửa."""
    options = dict(
        source_rendered_transparent=True, has_alpha=True, rectangle_mode=False,
        selection_page_mode=False, has_mask_override=False, edge_bite_mm=0.0,
        removes_background=False,
    )
    options.update(changes)
    assert sticker_engine._can_preserve_native_artwork_alpha(**options) is (not changes)


def test_mixed_native_alpha_and_opaque_pages_use_independent_artwork_masks(tmp_path):
    """SMask ở trang đầu không được làm trang nền trắng mất bước tách nền."""
    alpha_source, opaque_source = tmp_path / "alpha.pdf", tmp_path / "opaque.pdf"
    _write_source(alpha_source)
    _write_source(opaque_source, transparent=False)
    source, output = tmp_path / "mixed.pdf", tmp_path / "mixed-result.pdf"
    with pikepdf.Pdf.new() as mixed:
        for source_page in (alpha_source, opaque_source):
            with pikepdf.Pdf.open(source_page) as part:
                mixed.pages.append(part.pages[0])
        mixed.save(source)
    _execute(source, output, remove_white_bg=True)
    with pikepdf.Pdf.open(source) as original, pikepdf.Pdf.open(output) as result:
        assert len(result.pages) == 2
        for index, page in enumerate(result.pages):
            record = _image_records(original.pages[index])[0]
            assert (record[-1] is not None) is (index == 0)
            assert record in _image_records(page)
            block = _artwork_block(page)
            clip = {"W", "W*"}.intersection(str(item.operator) for item in block)
            expected = _render_program(result, page, _clip_free_artwork(block))
            actual = _render_program(result, page, block)
            if index == 0:
                assert not clip
                assert np.array_equal(actual, expected)
            else:
                assert clip
                white = (expected[:, :, 3] == 255) & np.all(expected[:, :, :3] >= 248, axis=2)
                assert np.count_nonzero(white & (actual[:, :, 3] == 0)) > 100


@pytest.mark.parametrize("denoise", [0, 30, 100])
def test_semitransparent_detached_detail_survives_cut_denoise_and_sampled_overlay(tmp_path, denoise):
    """Đảo Alpha mềm không bị clip hay nhận thêm lớp phủ chỉ vì dao đã lọc nó."""
    source, output = tmp_path / "soft-detail.pdf", tmp_path / "soft-detail-result.pdf"
    _write_source(source, detail_alpha=96)
    _execute(source, output, bleed_color_type="image", edge_sample_inset_mm=0.5,
             cutline_denoise=denoise)
    with pikepdf.Pdf.open(output) as result:
        page = result.pages[0]
        full = _without_cut(page)
        instructions, start, end = _artwork_range(page)
        block = instructions[start:end]
        # Oracle vẫn có màu bù xén BÊN DƯỚI: Alpha mềm phải blend đúng màu,
        # không so RGBA artwork đơn với ảnh đã ghép nền rồi nới sai số tùy tiện.
        below_and_artwork = instructions[:end]
        artwork = _render_program(result, page, _clip_free_artwork(block))
        assert np.array_equal(_render_program(result, page, block), artwork)
        detail = ((artwork[:, :, 3] > 0) & (artwork[:, :, 0] > 200)
                  & (artwork[:, :, 1] < 80))
        assert np.count_nonzero(detail) >= 9
        assert int(artwork[:, :, 3][detail].max()) < 255
        expected = _render_program(result, page, below_and_artwork)
        actual = _render_program(result, page, full)
        assert np.array_equal(actual[detail], expected[detail])


@pytest.mark.parametrize("render_dpi", [600, 1200])
def test_sampled_bleed_layers_do_not_create_interpolated_alpha_seam(tmp_path, monkeypatch, render_dpi):
    """Hai SMask bù nhau trước nội suy không đồng nghĩa hai lớp ghép kín sau RIP."""
    source, output = tmp_path / "uniform-alpha.pdf", tmp_path / "uniform-alpha-result.pdf"
    _write_source(source, detail_alpha=0)
    full_rings = []
    build_ring = sticker_engine._build_feathered_bleed_join_mask

    def capture_ring(*args, **kwargs):
        ring = build_ring(*args, **kwargs)
        full_rings.append(ring.copy())
        return ring

    monkeypatch.setattr(sticker_engine, "_build_feathered_bleed_join_mask", capture_ring)
    _execute(source, output, bleed_color_type="image", edge_sample_inset_mm=0.5)
    assert len(full_rings) == 1
    with pikepdf.Pdf.open(output) as result:
        page = result.pages[0]
        composite = _without_cut(page)
        instructions, start, end = _artwork_range(page)
        resources = page.Resources.XObject
        before = [resources[item.operands[0]] for item in instructions[:start]
                  if str(item.operator) == "Do"
                  and str(resources[item.operands[0]].get("/Subtype")) == "/Image"]
        after = [resources[item.operands[0]] for item in instructions[end:]
                 if str(item.operator) == "Do"
                 and str(resources[item.operands[0]].get("/Subtype")) == "/Image"]
        assert len(before) == len(after) == 1
        underlay, overlay = before[0], after[0]
        ring = full_rings[0]
        assert ring.shape == (int(underlay.Height), int(underlay.Width))
        artwork = _render_program(result, page, _clip_free_artwork(instructions[start:end]), dpi=render_dpi)
        actual = _render_program(result, page, composite, dpi=render_dpi)
        # Oracle giữ nguyên nguồn màu/CTM/artwork/mối nối trên. Chỉ chốt lớp
        # dưới bằng vành đầy đủ đã tính trước khi chia layer, không trace lại.
        underlay.SMask.write(zlib.compress(ring.tobytes()), filter=pikepdf.Name.FlateDecode)
        expected = _render_program(result, page, composite, dpi=render_dpi)
        opaque_bleed = (artwork[:, :, 3] == 0) & (expected[:, :, 3] == 255)
        assert np.count_nonzero(opaque_bleed) > 100
        assert np.array_equal(actual[opaque_bleed], expected[opaque_bleed]), (
            "Vành bù xén bị hở Alpha sau nội suy hai SMask riêng, tạo viền trắng."
        )
        # Đối chứng âm: phép trừ vành−mối nối từng qua test ROI rộng nhưng
        # tạo hairline. Fixture phải thực sự bắt được đúng cơ chế hồi quy đó.
        seam = np.frombuffer(overlay.SMask.read_bytes(), dtype=np.uint8).reshape(ring.shape)
        complementary = np.maximum(ring.astype(np.int16) - seam, 0).astype(np.uint8)
        underlay.SMask.write(zlib.compress(complementary.tobytes()), filter=pikepdf.Name.FlateDecode)
        broken = _render_program(result, page, composite, dpi=render_dpi)
        assert np.count_nonzero(opaque_bleed & (broken[:, :, 3] < 255)) > 0
