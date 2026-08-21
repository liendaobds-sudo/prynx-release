import cv2
import numpy as np
import pytest
from PIL import Image, ImageDraw

from app.workers.document_cleanup_engine import (
    ID1_RATIO,
    SCAN_ANALYSIS_MAX_DIMENSION,
    DocumentCleanupCancelled,
    _scan_analysis_image,
    _scan_texture_score,
    clean_scan,
    clean_scan_pdf,
    detect_card_quad,
    normalized_points,
    rectify_card,
)


def _two_page_dirty_pdf() -> bytes:
    from io import BytesIO

    from reportlab.lib.utils import ImageReader
    from reportlab.pdfgen import canvas

    output = BytesIO()
    writer = canvas.Canvas(output, pagesize=(180, 120))
    for size in ((180, 120), (120, 180)):
        writer.setPageSize(size)
        image = _dirty_scan_fixture().resize((360, 240))
        encoded = BytesIO()
        image.save(encoded, format="PNG")
        encoded.seek(0)
        writer.drawImage(ImageReader(encoded), 0, 0, width=size[0], height=size[1])
        writer.showPage()
    writer.save()
    return output.getvalue()


def _phone_card_fixture() -> tuple[Image.Image, np.ndarray]:
    card = np.full((340, 540, 3), 244, dtype=np.uint8)
    card[20:-20, 20:-20] = (220, 238, 248)
    cv2.rectangle(card, (35, 55), (155, 245), (70, 130, 205), -1)
    cv2.putText(card, "ID CARD", (190, 105), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (20, 30, 40), 3)
    cv2.line(card, (190, 155), (480, 155), (50, 60, 70), 5)
    source = np.float32([[0, 0], [539, 0], [539, 339], [0, 339]])
    destination = np.float32([[145, 95], [735, 45], [675, 510], [85, 455]])
    matrix = cv2.getPerspectiveTransform(source, destination)
    canvas = cv2.warpPerspective(
        card,
        matrix,
        (820, 580),
        flags=cv2.INTER_CUBIC,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=(55, 70, 65),
    )
    return Image.fromarray(canvas), destination


def test_detects_phone_card_quad_and_reports_normalized_points():
    image, expected = _phone_card_fixture()

    detection = detect_card_quad(image)

    assert detection is not None
    actual = np.asarray(detection.points)
    assert np.max(np.linalg.norm(actual - expected, axis=1)) < 18.0
    assert detection.confidence >= 0.70
    normalized = normalized_points(detection, image.width, image.height)
    assert len(normalized) == 4
    assert all(0.0 <= point[axis] <= 1.0 for point in normalized for axis in ("x", "y"))


def test_rectify_card_uses_id1_ratio_without_mirroring_content():
    image, points = _phone_card_fixture()

    corrected = rectify_card(image, points, target_ratio=ID1_RATIO)

    assert abs(corrected.width / corrected.height - ID1_RATIO) < 0.01
    array = np.asarray(corrected)
    # Khối ảnh xanh nằm bên trái; assertion này bắt thứ tự góc bị đảo/mirror.
    left_blue_bias = (
        array[:, : array.shape[1] // 3, 2].astype(np.float32)
        - array[:, : array.shape[1] // 3, 0].astype(np.float32)
    ).mean()
    right_blue_bias = (
        array[:, -array.shape[1] // 3 :, 2].astype(np.float32)
        - array[:, -array.shape[1] // 3 :, 0].astype(np.float32)
    ).mean()
    assert left_blue_bias > right_blue_bias + 8


def _dirty_scan_fixture() -> Image.Image:
    width, height = 900, 620
    x = np.linspace(0, 1, width, dtype=np.float32)
    y = np.linspace(0, 1, height, dtype=np.float32)[:, None]
    paper = 172 + 45 * x[None, :] + 16 * np.sin(x[None, :] * np.pi * 7) - 22 * y
    rgb = np.repeat(np.clip(paper, 0, 255)[:, :, None], 3, axis=2).astype(np.uint8)
    image = Image.fromarray(rgb)
    draw = ImageDraw.Draw(image)
    draw.rectangle((90, 100, 760, 112), fill=(30, 30, 30))
    draw.rectangle((90, 170, 650, 181), fill=(65, 65, 65))
    draw.rectangle((90, 240, 720, 250), fill=(105, 105, 105))
    draw.ellipse((650, 320, 790, 460), outline=(185, 35, 45), width=12)
    return image


def _speckled_scan_fixture() -> tuple[Image.Image, np.ndarray, tuple[slice, slice]]:
    """Bản scan có bụi hạt rời, nhưng vẫn có chữ mảnh và dấu màu cần giữ."""

    height, width = 720, 1120
    paper = np.full((height, width, 3), 238, dtype=np.uint8)
    paper[:, :, 0] -= np.linspace(0, 16, width, dtype=np.uint8)[None, :]
    paper[:, :, 1] -= np.linspace(0, 11, width, dtype=np.uint8)[None, :]
    paper[:, :, 2] -= np.linspace(0, 8, width, dtype=np.uint8)[None, :]
    cv2.putText(paper, "VAN BAN CO CHU VIET TAY", (80, 155), cv2.FONT_HERSHEY_SIMPLEX, 1.05, (28, 28, 28), 2, cv2.LINE_AA)
    cv2.putText(paper, "Noi dung can duoc giu lai", (80, 220), cv2.FONT_HERSHEY_SIMPLEX, 0.70, (70, 70, 70), 1, cv2.LINE_AA)
    cv2.line(paper, (70, 275), (840, 275), (45, 45, 45), 2)
    cv2.ellipse(paper, (895, 195), (115, 105), 0, 0, 360, (185, 35, 45), 8)

    noise_mask = np.zeros((height, width), dtype=bool)
    rng = np.random.default_rng(20260820)
    # Các vùng trống có rất nhiều chấm xám/đen như scanner điện thoại tạo ra.
    for y0, y1, x0, x1, count in ((330, 690, 65, 1050, 6200), (300, 690, 30, 65, 900)):
        ys = rng.integers(y0, y1, size=count)
        xs = rng.integers(x0, x1, size=count)
        shades = rng.integers(25, 165, size=count, dtype=np.uint8)
        paper[ys, xs] = np.stack((shades, shades, shades), axis=1)
        noise_mask[ys, xs] = True
    return Image.fromarray(paper), noise_mask, (slice(85, 240), slice(60, 750))


def _native_resolution_speckled_fixture() -> tuple[Image.Image, np.ndarray, tuple[slice, slice]]:
    """PDF 300 DPI có hạt 1 px mà ảnh analysis dễ trung bình hóa mất."""

    height, width = 3509, 2480
    paper = np.full((height, width, 3), 239, dtype=np.uint8)
    cv2.putText(paper, "NOI DUNG VAN BAN CAN GIU", (160, 480), cv2.FONT_HERSHEY_SIMPLEX, 1.8, (32, 32, 32), 3, cv2.LINE_AA)
    cv2.putText(paper, "Net chu mong va chu ky", (160, 575), cv2.FONT_HERSHEY_SIMPLEX, 1.1, (110, 110, 110), 2, cv2.LINE_AA)
    cv2.line(paper, (150, 660), (2180, 660), (45, 45, 45), 2)

    noise_mask = np.zeros((height, width), dtype=bool)
    rng = np.random.default_rng(20260822)
    ys = rng.integers(900, 3350, size=18000)
    xs = rng.integers(100, 2380, size=18000)
    shades = rng.integers(25, 165, size=18000, dtype=np.uint8)
    paper[ys, xs] = np.stack((shades, shades, shades), axis=1)
    noise_mask[ys, xs] = True
    return Image.fromarray(paper), noise_mask, (slice(340, 640), slice(120, 2200))


def _dense_noise_scan_fixture() -> tuple[
    Image.Image,
    tuple[slice, slice],
    tuple[slice, slice],
    np.ndarray,
]:
    """Mô phỏng nền hạt dày của app scan nhưng vẫn có chữ/biểu mẫu để bảo vệ."""

    height, width = 760, 1100
    paper = np.full((height, width, 3), 236, dtype=np.uint8)
    cv2.rectangle(paper, (70, 70), (980, 285), (45, 45, 45), 2)
    for y in range(115, 275, 40):
        cv2.line(paper, (70, y), (980, y), (60, 60, 60), 1)
    cv2.putText(paper, "PHIEU THU VA NOI DUNG", (110, 105), cv2.FONT_HERSHEY_SIMPLEX, 0.85, (35, 35, 35), 2, cv2.LINE_AA)

    rng = np.random.default_rng(20260821)
    noise_region = (slice(370, 710), slice(80, 1030))
    region = paper[noise_region]
    noise = rng.random(region.shape[:2]) < 0.30
    shades = rng.integers(35, 175, size=region.shape[:2], dtype=np.uint8)
    region[noise] = np.stack((shades[noise], shades[noise], shades[noise]), axis=1)
    # Nét ghi chú xám đặt ngay trong mảng nhiễu để bắt hồi quy làm trắng quá tay.
    signature_mask = np.zeros((height, width), dtype=np.uint8)
    cv2.putText(paper, "Chu ky can giu", (110, 435), cv2.FONT_HERSHEY_SCRIPT_COMPLEX, 0.90, (135, 135, 135), 2, cv2.LINE_AA)
    cv2.putText(signature_mask, "Chu ky can giu", (110, 435), cv2.FONT_HERSHEY_SCRIPT_COMPLEX, 0.90, 255, 2, cv2.LINE_AA)
    return (
        Image.fromarray(paper),
        noise_region,
        (slice(390, 450), slice(90, 500)),
        signature_mask.astype(bool),
    )


def _native_resolution_dense_noise_fixture() -> tuple[
    Image.Image,
    tuple[slice, slice],
    tuple[slice, slice],
    np.ndarray,
    np.ndarray,
]:
    """Nền hạt theo cụm ở 300 DPI mà median 3 px full-res dễ bỏ sót."""

    height, width = 3509, 2480
    paper = np.full((height, width, 3), 242, dtype=np.uint8)
    cv2.rectangle(paper, (150, 170), (2280, 1120), (42, 42, 42), 5)
    for y in range(310, 1120, 135):
        cv2.line(paper, (150, y), (2280, y), (55, 55, 55), 3)
    cv2.putText(
        paper,
        "PHIEU THU VA NOI DUNG CAN GIU",
        (240, 275),
        cv2.FONT_HERSHEY_SIMPLEX,
        1.55,
        (32, 32, 32),
        4,
        cv2.LINE_AA,
    )

    noise_region = (slice(1450, 3260), slice(170, 2310))
    region_height = noise_region[0].stop - noise_region[0].start
    region_width = noise_region[1].stop - noise_region[1].start
    rng = np.random.default_rng(20260823)
    # Hạt 2–4 px mô phỏng PDF scan 300 DPI: ở ảnh gốc chúng phẳng trong từng
    # cụm, nhưng khi đưa về thang phân tích mới bộc lộ thành texture dày.
    coarse_height = (region_height + 2) // 3
    coarse_width = (region_width + 2) // 3
    coarse = np.full((coarse_height, coarse_width), 242, dtype=np.uint8)
    noisy = rng.random(coarse.shape) < 0.34
    coarse[noisy] = rng.integers(35, 180, size=np.count_nonzero(noisy), dtype=np.uint8)
    texture = cv2.resize(coarse, (region_width, region_height), interpolation=cv2.INTER_NEAREST)
    paper[noise_region] = np.repeat(texture[:, :, None], 3, axis=2)
    thin_text_mask = np.zeros((height, width), dtype=np.uint8)
    thin_text_args = (
        "Chu nho can doc duoc 0123456789",
        (260, 1300),
        cv2.FONT_HERSHEY_SIMPLEX,
        1.5,
        1,
        cv2.LINE_AA,
    )
    cv2.putText(
        paper,
        thin_text_args[0],
        thin_text_args[1],
        thin_text_args[2],
        thin_text_args[3],
        (85, 85, 85),
        thin_text_args[4],
        thin_text_args[5],
    )
    cv2.putText(
        thin_text_mask,
        thin_text_args[0],
        thin_text_args[1],
        thin_text_args[2],
        thin_text_args[3],
        255,
        thin_text_args[4],
        thin_text_args[5],
    )
    signature_mask = np.zeros((height, width), dtype=np.uint8)
    signature_args = (
        "Chu ky can giu",
        (250, 1840),
        cv2.FONT_HERSHEY_SCRIPT_COMPLEX,
        2.0,
        4,
        cv2.LINE_AA,
    )
    cv2.putText(
        paper,
        signature_args[0],
        signature_args[1],
        signature_args[2],
        signature_args[3],
        (125, 125, 125),
        signature_args[4],
        signature_args[5],
    )
    cv2.putText(
        signature_mask,
        signature_args[0],
        signature_args[1],
        signature_args[2],
        signature_args[3],
        255,
        signature_args[4],
        signature_args[5],
    )
    return (
        Image.fromarray(paper),
        noise_region,
        (slice(1660, 1900), slice(210, 1420)),
        signature_mask.astype(bool),
        thin_text_mask.astype(bool),
    )


def test_color_cleanup_whitens_uneven_paper_and_preserves_red_stamp():
    source = _dirty_scan_fixture()
    before = np.asarray(source)

    result = np.asarray(clean_scan(source, mode="color", strength=0.55, deskew=False))

    background_slice = np.s_[20:80, 20:860]
    before_gray = cv2.cvtColor(before, cv2.COLOR_RGB2GRAY)[background_slice]
    after_gray = cv2.cvtColor(result, cv2.COLOR_RGB2GRAY)[background_slice]
    assert after_gray.mean() > before_gray.mean() + 20
    assert after_gray.std() < before_gray.std()
    stamp = result[320:460, 650:790]
    assert float(stamp[:, :, 0].mean() - stamp[:, :, 1].mean()) > 4.0


def test_color_cleanup_removes_isolated_scan_speckles_without_erasing_text():
    source, noise_mask, text_region = _speckled_scan_fixture()
    before = cv2.cvtColor(np.asarray(source), cv2.COLOR_RGB2GRAY)

    result = np.asarray(clean_scan(source, mode="color", strength=0.70, deskew=False))
    after = cv2.cvtColor(result, cv2.COLOR_RGB2GRAY)

    before_noise = np.count_nonzero(before[noise_mask] < 180)
    after_noise = np.count_nonzero(after[noise_mask] < 180)
    assert after_noise < before_noise * 0.25
    # Chữ mảnh trong vùng có nội dung không được mờ thành nền trắng.
    assert np.count_nonzero(after[text_region] < 170) > 500
    stamp = result[90:300, 780:1010]
    assert float(stamp[:, :, 0].mean() - stamp[:, :, 1].mean()) > 4.0


def test_color_cleanup_removes_native_resolution_speckles_without_erasing_text():
    source, noise_mask, text_region = _native_resolution_speckled_fixture()
    before = cv2.cvtColor(np.asarray(source), cv2.COLOR_RGB2GRAY)

    result = np.asarray(clean_scan(source, mode="color", strength=0.55, deskew=False))
    after = cv2.cvtColor(result, cv2.COLOR_RGB2GRAY)

    before_noise = np.count_nonzero(before[noise_mask] < 180)
    after_noise = np.count_nonzero(after[noise_mask] < 180)
    assert after_noise < before_noise * 0.25
    assert np.count_nonzero(after[text_region] < 190) > 2500


def test_color_cleanup_flattens_dense_scan_noise_and_keeps_faint_signature():
    source, noise_region, signature_region, _ = _dense_noise_scan_fixture()
    before = cv2.cvtColor(np.asarray(source), cv2.COLOR_RGB2GRAY)

    result = np.asarray(clean_scan(source, mode="color", strength=0.55, deskew=False))
    after = cv2.cvtColor(result, cv2.COLOR_RGB2GRAY)

    assert np.count_nonzero(after[noise_region] < 190) < np.count_nonzero(before[noise_region] < 190) * 0.15
    assert np.count_nonzero(after[signature_region] < 225) > 120


def test_gray_cleanup_uses_dense_noise_path_without_reintroducing_particles():
    source, noise_region, _, _ = _dense_noise_scan_fixture()
    before = np.asarray(source.convert("L"))

    result = np.asarray(clean_scan(source, mode="gray", strength=0.55, deskew=False))

    assert np.count_nonzero(result[noise_region] < 190) < np.count_nonzero(before[noise_region] < 190) * 0.15


def test_bw_cleanup_keeps_low_resolution_table_and_faint_signature():
    source, noise_region, _, signature_mask = _dense_noise_scan_fixture()

    result = np.asarray(clean_scan(source, mode="bw", strength=1.0, deskew=False))

    table_region = np.s_[60:300, 60:1000]
    assert np.count_nonzero(result[noise_region] == 0) < result[noise_region].size * 0.02
    assert np.count_nonzero(result[table_region] == 0) > result[table_region].size * 0.04
    output_ink = cv2.dilate((result == 0).astype(np.uint8), np.ones((3, 3), dtype=np.uint8)).astype(bool)
    stroke_recall = np.count_nonzero(output_ink & signature_mask) / np.count_nonzero(signature_mask)
    assert stroke_recall > 0.75


def test_bw_cleanup_detects_native_resolution_dense_noise_and_cleans_blank_area():
    source, noise_region, _, signature_mask, thin_text_mask = _native_resolution_dense_noise_fixture()
    before = np.asarray(source.convert("L"))

    result = np.asarray(clean_scan(source, mode="bw", strength=1.0, deskew=False))

    assert _scan_texture_score(before) >= 10.0
    remaining_noise = np.count_nonzero(result[noise_region] == 0)
    source_noise = np.count_nonzero(before[noise_region] < 190)
    assert remaining_noise < source_noise * 0.15
    assert remaining_noise < result[noise_region].size * 0.05
    output_ink = cv2.dilate((result == 0).astype(np.uint8), np.ones((3, 3), dtype=np.uint8)).astype(bool)
    stroke_recall = np.count_nonzero(output_ink & signature_mask) / np.count_nonzero(signature_mask)
    assert stroke_recall > 0.75
    thin_text_recall = np.count_nonzero(output_ink & thin_text_mask) / np.count_nonzero(thin_text_mask)
    assert thin_text_recall > 0.75


def test_high_resolution_scan_uses_small_analysis_but_keeps_output_pixels():
    source = _dirty_scan_fixture().resize((2480, 3509), Image.Resampling.BICUBIC)
    analysis, scale = _scan_analysis_image(np.asarray(source.convert("L")))

    result = clean_scan(source, mode="color", strength=0.55, deskew=False)

    assert max(analysis.shape) == SCAN_ANALYSIS_MAX_DIMENSION
    assert 0 < scale < 1
    assert result.size == source.size


def test_gray_cleanup_keeps_faint_text_darker_than_cleaned_background():
    result = np.asarray(clean_scan(_dirty_scan_fixture(), mode="gray", strength=0.55, deskew=False))

    faint_text = result[240:251, 90:720].mean()
    nearby_background = result[270:300, 90:720].mean()
    assert faint_text < nearby_background - 45
    assert nearby_background > 225


def test_bw_cleanup_returns_binary_image():
    result = np.asarray(clean_scan(_dirty_scan_fixture(), mode="bw", strength=0.65, deskew=False))

    assert set(np.unique(result)).issubset({0, 255})
    assert np.count_nonzero(result == 0) > 1000


def test_pdf_cleanup_preserves_page_count_and_each_page_size():
    import pypdfium2 as pdfium

    result = clean_scan_pdf(
        _two_page_dirty_pdf(),
        mode="gray",
        strength=0.55,
        deskew=False,
        dpi=144,
    )

    assert result.startswith(b"%PDF-")
    pdf = pdfium.PdfDocument(result)
    try:
        assert len(pdf) == 2
        assert np.allclose(pdf[0].get_size(), (180, 120), atol=0.1)
        assert np.allclose(pdf[1].get_size(), (120, 180), atol=0.1)
    finally:
        pdf.close()


def test_pdf_cleanup_reports_each_page_and_honors_cancel_between_pages():
    progress: list[tuple[int, int, str]] = []

    with pytest.raises(DocumentCleanupCancelled):
        clean_scan_pdf(
            _two_page_dirty_pdf(),
            mode="gray",
            deskew=False,
            dpi=144,
            progress_callback=lambda current, total, phase: progress.append(
                (current, total, phase)
            ),
            cancel_check=lambda: bool(progress and progress[-1][0] >= 1),
        )

    assert progress[0] == (0, 2, "rendering")
    assert progress[1] == (1, 2, "cleaning")
