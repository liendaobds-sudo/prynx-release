"""SHADOW.2: AI không được nâng hình học khi đã bỏ nhầm thân tem."""

from pathlib import Path
from io import BytesIO
from unittest.mock import patch

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
import pikepdf
import pytest

from app.core import sticker_sheet_session as sessions
from app.workers import sticker_source_pipeline as pipeline
from app.workers.sticker_artwork_guard import assess_ai_artwork_loss
from app.workers.sticker_shadow_boundary import recover_soft_shadow_alpha, _distance_to_candidate
from app.core.sticker_background import detect_background
from app.workers.sticker_cutline_preview import build_sticker_cutline_preview
from app.workers.sticker_sheet_engine import reprocess_sticker_sheet
from app.workers.sticker_sheet_export import export_sticker_sheet_document
from app.workers.sticker_source_inspector import inspect_sticker_source
from app.workers.cut_export.cut_layer_extractor import ExtractConfig, extract_cut_contours_from_pdf


EVIDENCE = Path(__file__).resolve().parents[2] / "docs" / "audit" / "BU_XEN_SHADOW_2026-09-05"


@pytest.fixture(autouse=True)
def isolated_sessions(tmp_path, monkeypatch):
    existing_ids = set(sessions._SESSIONS)
    monkeypatch.setattr(sessions, "SESSION_ROOT", tmp_path / "sessions")
    yield
    for session_id in set(sessions._SESSIONS) - existing_ids:
        sessions.close_session(session_id)


def _saved_user_case():
    # Alpha này là output ONNX thật đã lưu ở audit, không phải silhouette tự vẽ.
    with Image.open(EVIDENCE / "analysis_source.png") as image:
        source = image.convert("RGB")
    with Image.open(EVIDENCE / "multi_auto_raw_alpha.png") as image:
        raw_alpha = np.array(image)
    return source, raw_alpha


def _detected(source):
    # Lô A kiểm nhánh fallback khi chưa khử được bóng; không thay baseline IoU
    # bằng silhouette sạch của Lô B rồi làm mất oracle chống AI khoét artwork.
    with patch.object(pipeline, "recover_soft_shadow_alpha", return_value=None, create=True):
        detected = pipeline._background_detection(
            source, model="birefnet-lite", alpha_threshold=128,
            boundary_source="simple-bg", dpi=(300.0, 300.0), minimum_confidence=0.60,
        )
    assert detected is not None
    assert len(detected.analysis.instances) == 1
    return detected


def _replay_ai(monkeypatch, source, raw_alpha):
    analysis = reprocess_sticker_sheet(
        source, raw_alpha=raw_alpha, shadow_exclusion=np.zeros_like(raw_alpha),
    )
    def replay(image, **_kwargs):
        assert np.array_equal(np.asarray(image.convert("RGB")), np.asarray(source))
        return analysis

    monkeypatch.setattr(pipeline, "analyze_sticker_sheet", replay)
    return analysis


def test_saved_user_ai_khong_duoc_cat_mat_mang_ben_phai(monkeypatch):
    source, raw_alpha = _saved_user_case()
    detected = _detected(source)
    ai = _replay_ai(monkeypatch, source, raw_alpha)
    reference = detected.analysis.labels > 0
    candidate = ai.labels > 0
    iou = np.count_nonzero(reference & candidate) / np.count_nonzero(reference | candidate)
    assert 0.89 < iou < 0.90  # Ca đỏ: vẫn lọt gate 0,80 cũ.
    assert raw_alpha[210, 550] == 0

    guarded = pipeline._upgrade_single_simple_background_geometry(
        detected, source, model="birefnet-lite", alpha_threshold=128,
    )

    assert guarded.boundary_source == "simple-bg"
    assert guarded.analysis is detected.analysis
    assert np.all(guarded.analysis.alpha[198:224, 495:520] == 255)
    assert guarded.analysis.alpha[210, 550] == 255
    assert "simple-bg-ai-artwork-loss-rejected" in guarded.warnings
    assert guarded.needs_review


@pytest.mark.parametrize("scale", [0.25, 0.5, 1.0, 2.0])
def test_guard_ca_that_khong_phu_thuoc_do_phong(scale):
    source, raw_alpha = _saved_user_case()
    reference = _detected(source).analysis.labels > 0
    candidate = reprocess_sticker_sheet(
        source, raw_alpha=raw_alpha, shadow_exclusion=np.zeros_like(raw_alpha),
    ).labels > 0
    size = (round(source.width * scale), round(source.height * scale))
    rgb = cv2.resize(np.asarray(source), size, interpolation=cv2.INTER_LINEAR)
    reference = cv2.resize(reference.astype(np.uint8), size, interpolation=cv2.INTER_NEAREST)
    candidate = cv2.resize(candidate.astype(np.uint8), size, interpolation=cv2.INTER_NEAREST)
    assessment = assess_ai_artwork_loss(rgb, reference, candidate)
    assert assessment.rejected
    assert assessment.reason == "lost-source-detail"


@pytest.mark.parametrize("scale", [0.25, 0.5, 1.0, 2.0])
def test_chi_bo_dai_bong_that_khong_bi_chan_khi_anh_thu_nho(scale):
    source, raw_alpha = _saved_user_case()
    reference = _detected(source).analysis.labels > 0
    ai = reprocess_sticker_sheet(
        source, raw_alpha=raw_alpha, shadow_exclusion=np.zeros_like(raw_alpha),
    ).labels > 0
    _count, lost_labels = cv2.connectedComponents((reference & ~ai).astype(np.uint8), connectivity=8)
    # Chỉ lấy cụm bóng dưới tại điểm đã xác minh trong audit; giữ mọi artwork AI bỏ.
    shadow_id = int(lost_labels[590, 295])
    assert shadow_id > 0
    candidate = reference & (lost_labels != shadow_id)
    assert candidate[210, 550]
    size = (round(source.width * scale), round(source.height * scale))
    rgb = cv2.resize(np.asarray(source), size, interpolation=cv2.INTER_LINEAR)
    reference = cv2.resize(reference.astype(np.uint8), size, interpolation=cv2.INTER_NEAREST)
    candidate = cv2.resize(candidate.astype(np.uint8), size, interpolation=cv2.INTER_NEAREST)
    assert not assess_ai_artwork_loss(rgb, reference, candidate).rejected


@pytest.mark.parametrize("color", [(35, 130, 60), (150, 150, 150), (240, 240, 240), (252, 252, 252)])
def test_bien_ai_cat_sau_qua_mang_dac_cung_bi_tu_choi(color):
    reference = np.zeros((300, 300), dtype=np.uint8)
    reference[40:261, 40:261] = 255
    rgb = np.full((300, 300, 3), 255, dtype=np.uint8)
    rgb[reference > 0] = color
    candidate = reference.copy()
    candidate[95:170, 220:] = 0
    assessment = assess_ai_artwork_loss(rgb, reference, candidate)
    assert assessment.rejected
    assert assessment.reason == "unsupported-interior-boundary"
    assert assessment.unsupported_run_px > 100


@pytest.mark.parametrize("body_color", [(35, 130, 60), (240, 240, 240), (252, 252, 252)])
@pytest.mark.parametrize("shadow_color", [(80, 80, 80), (180, 80, 30), (70, 70, 190), (205, 205, 205)])
def test_bo_bong_mem_xam_va_co_mau_khong_bi_nham_la_mat_artwork(body_color, shadow_color):
    body = np.zeros((300, 300), dtype=np.uint8)
    body[40:261, 40:261] = 255
    shifted = np.zeros(body.shape, dtype=np.float32)
    shifted[48:269, 45:266] = 1.0
    opacity = cv2.GaussianBlur(shifted, (0, 0), 8)[:, :, None] * 0.5
    rgb = np.rint(255 * (1 - opacity) + np.asarray(shadow_color) * opacity).astype(np.uint8)
    rgb[body > 0] = body_color
    reference = (np.max(255 - rgb, axis=2) > 12) | (body > 0)
    assessment = assess_ai_artwork_loss(rgb, reference, body)
    assert not assessment.rejected


@pytest.mark.parametrize("scale", [0.25, 0.5, 1.0, 2.0])
def test_than_gan_trang_bong_nhat_van_co_bien_hop_le_o_nhieu_co_anh(scale):
    body = np.zeros((300, 300), dtype=np.uint8)
    body[40:261, 40:261] = 255
    shifted = np.zeros(body.shape, dtype=np.float32)
    shifted[48:269, 45:266] = 1.0
    opacity = cv2.GaussianBlur(shifted, (0, 0), 8) * 0.5
    gray = np.rint(255 - 50 * opacity).astype(np.uint8)
    rgb = np.repeat(gray[:, :, None], 3, axis=2)
    rgb[body > 0] = 252
    reference = (gray < 253) | (body > 0)
    size = (round(300 * scale), round(300 * scale))
    rgb = cv2.resize(rgb, size, interpolation=cv2.INTER_LINEAR)
    reference = cv2.resize(reference.astype(np.uint8), size, interpolation=cv2.INTER_NEAREST)
    candidate = cv2.resize(body, size, interpolation=cv2.INTER_NEAREST)
    assert not assess_ai_artwork_loss(rgb, reference, candidate).rejected


@pytest.mark.parametrize("pixels", [0, 1, 2])
def test_giu_nguyen_va_sua_antialias_mong_khong_bi_chan(pixels):
    body = np.zeros((300, 300), dtype=np.uint8)
    cv2.circle(body, (150, 150), 100, 255, -1)
    rgb = np.full((300, 300, 3), 255, dtype=np.uint8)
    rgb[body > 0] = (80, 140, 180)
    reference = cv2.dilate(body, np.ones((2 * pixels + 1, 2 * pixels + 1), dtype=np.uint8))
    assert not assess_ai_artwork_loss(rgb, reference, body).rejected


def test_ai_tot_giu_nguyen_alpha_mem_va_mau_nen(monkeypatch):
    source = Image.new("RGB", (320, 240), (254, 254, 254))
    ImageDraw.Draw(source).ellipse((38, 28, 282, 212), fill=(78, 12, 10))
    raw = Image.new("L", source.size, 0)
    ImageDraw.Draw(raw).ellipse((38, 28, 282, 212), fill=255)
    raw_alpha = np.asarray(raw.filter(ImageFilter.GaussianBlur(1.5)))
    detected = _detected(source)
    ai = _replay_ai(monkeypatch, source, raw_alpha)
    result = pipeline._upgrade_single_simple_background_geometry(
        detected, source, model="birefnet-lite", alpha_threshold=128,
    )
    assert result.analysis is ai
    assert result.boundary_source == "ai"
    assert result.background_rgb == detected.background_rgb
    assert np.any((result.analysis.alpha > 0) & (result.analysis.alpha < 255))


@pytest.mark.parametrize("failure", [MemoryError, ValueError, cv2.error])
def test_khong_kiem_duoc_artwork_thi_khong_tin_ung_vien_ai(monkeypatch, failure):
    source, raw_alpha = _saved_user_case()
    detected = _detected(source)
    _replay_ai(monkeypatch, source, raw_alpha)

    def fail_validation(*_args):
        raise failure("probe")

    monkeypatch.setattr(pipeline, "assess_ai_artwork_loss", fail_validation)
    result = pipeline._upgrade_single_simple_background_geometry(
        detected, source, model="birefnet-lite", alpha_threshold=128,
    )
    assert result.analysis is detected.analysis
    assert result.boundary_source == "simple-bg"
    assert "simple-bg-ai-validation-unavailable" in result.warnings


def _captured_source_pdf(tmp_path):
    # test/ chứa PDF khách bị gitignore. Fixture CI dùng raster đã lưu trong
    # evidence; 1 px = 1 pt giữ đúng lưới Alpha mà không phụ thuộc file ngoài repo.
    source, _raw = _saved_user_case()
    path = tmp_path / "captured-user-raster.pdf"
    with pikepdf.new() as pdf:
        page = pdf.add_blank_page(page_size=source.size)
        image = pdf.make_stream(np.asarray(source).tobytes())
        image["/Type"] = pikepdf.Name("/XObject")
        image["/Subtype"] = pikepdf.Name("/Image")
        image["/Width"], image["/Height"] = source.size
        image["/ColorSpace"] = pikepdf.Name("/DeviceRGB")
        image["/BitsPerComponent"] = 8
        page.Resources = pikepdf.Dictionary(XObject=pikepdf.Dictionary(Im0=image))
        page.Contents = pdf.make_stream(f"q {source.width} 0 0 {source.height} 0 0 cm /Im0 Do Q".encode("ascii"))
        pdf.save(path)
    return path


def _user_session(tmp_path, source_kind):
    source, _raw = _saved_user_case()
    if source_kind == "pdf":
        path = _captured_source_pdf(tmp_path)
    else:
        path = tmp_path / "user-sticker.png"
        source.save(path, dpi=(300.0, 300.0))
    inspection = inspect_sticker_source(str(path), path.name)
    return sessions.create_source_session(source_path=path, original_name=path.name, inspection=inspection)


@pytest.fixture
def no_shadow_recovery(monkeypatch):
    monkeypatch.setattr(pipeline, "recover_soft_shadow_alpha", lambda *_args, **_kwargs: None, raising=False)


@pytest.mark.usefixtures("no_shadow_recovery")
@pytest.mark.parametrize("source_kind", ["raster", "pdf"])
@pytest.mark.parametrize("preview_only", [False, True])
def test_auto_va_classic_tho_cung_qua_guard(monkeypatch, tmp_path, source_kind, preview_only):
    source, raw_alpha = _saved_user_case()
    session = _user_session(tmp_path, source_kind)
    _replay_ai(monkeypatch, source, raw_alpha)
    if preview_only:
        monkeypatch.setattr(pipeline, "_simple_bg_preview_needs_geometry_upgrade", lambda _analysis: True)
    detected = pipeline.detect_sticker_source(session, strategy="auto", preview_only=preview_only)
    assert detected.boundary_source == "simple-bg"
    assert "simple-bg-ai-artwork-loss-rejected" in detected.warnings
    assert np.all(detected.analysis.alpha[198:224, 495:520] == 255)


@pytest.mark.usefixtures("no_shadow_recovery")
def test_legacy_khong_co_canonical_cung_bao_ve_artwork(monkeypatch, tmp_path):
    source, raw_alpha = _saved_user_case()
    _replay_ai(monkeypatch, source, raw_alpha)
    approved = pipeline.build_legacy_single_page_approved_contour(
        str(_captured_source_pdf(tmp_path)), cut_mode="original", offset_mm=0, bleed_mm=0,
        corner_style="preserve", fill_holes=True, cutline_denoise=30,
    )
    assert approved is not None
    assert approved.boundary_source == "simple-bg"
    assert np.all(approved.alpha[198:224, 495:520] == 255)
    assert len(approved.path_groups) == 1


@pytest.mark.usefixtures("no_shadow_recovery")
@pytest.mark.parametrize("crop_to_sticker", [False, True])
def test_fallback_khong_phuc_hoi_raw_ai_sai_va_pdf_xuat_giu_roi(monkeypatch, tmp_path, crop_to_sticker):
    source, raw_alpha = _saved_user_case()
    session = _user_session(tmp_path, "pdf")
    _replay_ai(monkeypatch, source, raw_alpha)
    detected = pipeline.detect_sticker_source(session, strategy="auto")
    promoted = sessions.promote_source_session(
        session.session_id, analysis=detected.analysis, analysis_source=detected.source_image,
        boundary_source=detected.boundary_source, strategy_confidence=detected.strategy_confidence,
        needs_review=detected.needs_review, dpi=detected.dpi, source_page=1,
        warnings=list(detected.warnings), edge_background_rgb=detected.background_rgb,
        edge_background_tolerance=detected.background_tolerance,
    )
    assert promoted is not None
    page = promoted.pages[1]
    assert page.manifest["refinement_available"] is False
    assert not (page.directory / "raw_alpha.png").exists()
    assert not (page.directory / "shadow_exclusion.png").exists()
    assert "simple-bg-ai-artwork-loss-rejected" in page.manifest["warnings"]
    dpi_x, dpi_y = detected.dpi
    tuning = dict(offset_mm=0.0, bleed_mm=0.0, cut_mode="original", corner_style="preserve",
                  fill_holes=True, cutline_smoothness=50.0, cutline_fidelity=50.0,
                  curve_tension=50.0, min_detail_area_mm2=1.0)
    preview = build_sticker_cutline_preview(
        promoted, page_number=1, base_revision=1, edits=[], dpi=dpi_x, dpi_y=dpi_y,
        cutline_denoise=50, **tuning,
    )
    assert len(preview["paths"]) == 1
    cache = page.cutline_export_cache
    assert cache is not None and len(cache["instances"]) == 1
    instance = cache["instances"][0]
    left, top = instance["left"], instance["top"]
    canonical_alpha = instance["alpha"]
    # Guard A/B vẫn phải giữ mảng AI đã khoét, độc lập writer giữ tấm/tách tem.
    assert np.all(canonical_alpha[198 - top:224 - top, 495 - left:520 - left] == 255)
    assert canonical_alpha[210 - top, 550 - left] == 255
    assert sessions.confirm_source_session(session.session_id, page_number=1) is not None
    result = export_sticker_sheet_document(
        promoted, pages=[{
            "source_page": 1, "expected_revision": 1, "edits": [],
            "dpi": dpi_x, "dpi_y": dpi_y,
            "expected_fingerprint": preview["fingerprint"], "cutline_denoise": 50,
        }],
        page_order=[1], dpi=dpi_x, dpi_y=dpi_y, output_format="pdf", crop_to_sticker=crop_to_sticker,
        cutline_denoise=50,
        shape_mode="contour", preserve_existing_cut=False, **tuning,
    )
    with pikepdf.Pdf.open(result.path) as pdf:
        assert len(pdf.pages) == 1
        if crop_to_sticker:
            # Tách tem vẫn đi cầu Alpha: giữ oracle SMask cũ trên crop đã dịch.
            images = list(pdf.pages[0].get_images(recursive=True).values())
            masks = [pikepdf.PdfImage(obj.SMask).as_pil_image() for obj in images if "/SMask" in obj]
            assert len(masks) == 1
            alpha = np.asarray(masks[0])
            assert alpha.shape == canonical_alpha.shape
            assert np.all(alpha[198 - top:224 - top, 495 - left:520 - left] == 255)
            assert alpha[210 - top, 550 - left] == 255
        else:
            # Giữ tấm nay copy PDF gốc, không tạo SMask phủ lại artwork. Giữ
            # bytes ảnh gốc và pixel ROI để không đổi oracle thành chỉ đếm dao.
            source_image = pdf.pages[0].Resources.XObject.Im0
            assert source_image.read_bytes() == np.asarray(source).tobytes()
            pixels = np.asarray(pikepdf.PdfImage(source_image).as_pil_image())
            assert np.array_equal(pixels[198:224, 495:520], np.asarray(source)[198:224, 495:520])
            assert np.array_equal(pixels[210, 550], np.asarray(source)[210, 550])
        assert len(extract_cut_contours_from_pdf(pdf, config=ExtractConfig(page_frame_ratio=1.1)).contours) == 1
        from app.workers.cutline_geometry import build_bezier_segments_path_stream
        from app.workers.sticker_sheet_export import _translate_cutline_path_groups

        groups = instance["path_groups"]
        height_points = canonical_alpha.shape[0] * 72.0 / dpi_y
        if not crop_to_sticker:
            groups = _translate_cutline_path_groups(
                groups, offset_x_points=left * 72.0 / dpi_x,
                offset_y_points=top * 72.0 / dpi_y,
            )
            height_points = raw_alpha.shape[0] * 72.0 / dpi_y
        contents = pdf.pages[0].obj["/Contents"]
        stream = (
            b"\n".join(item.read_bytes() for item in contents)
            if isinstance(contents, pikepdf.Array) else contents.read_bytes()
        )
        for group in groups:
            for ring in [group["exterior"], *(group.get("interiors") or [])]:
                for command in build_bezier_segments_path_stream(ring, height_points):
                    assert command.encode("ascii") in stream
    if not crop_to_sticker:
        import pypdfium2 as pdfium
        from app.core.pdfium_lock import pdfium_guard

        def rendered(path):
            with pdfium_guard(), pdfium.PdfDocument(str(path)) as document:
                rendered_page = document[0]
                try:
                    bitmap = rendered_page.render(scale=1, rev_byteorder=True)
                    try:
                        return np.array(bitmap.to_numpy(), copy=True)
                    finally:
                        bitmap.close()
                finally:
                    rendered_page.close()

        original_pixels, result_pixels = rendered(session.source_path), rendered(result.path)
        assert np.array_equal(original_pixels[198:224, 495:520], result_pixels[198:224, 495:520])
        assert np.array_equal(original_pixels[210, 550], result_pixels[210, 550])


@pytest.mark.parametrize("preview_only", [True, False])
def test_lo_b_bo_bong_nau_va_giu_than_tem_o_ca_hai_che_do(monkeypatch, tmp_path, preview_only):
    session = _user_session(tmp_path, "raster")

    def no_ai(*_args, **_kwargs):
        raise AssertionError("Biên đã khử bóng chắc chắn không được gọi AI rồi ghi đè")

    monkeypatch.setattr(pipeline, "analyze_sticker_sheet", no_ai)
    detected = pipeline.detect_sticker_source(session, strategy="auto", preview_only=preview_only)
    assert detected.boundary_source == "simple-bg"
    assert detected.analysis.alpha[590, 295] == 0
    assert detected.analysis.alpha[578, 200] == 0
    assert np.all(detected.analysis.alpha[198:224, 495:520] == 255)
    assert detected.analysis.alpha[210, 550] == 255
    assert len(detected.analysis.instances) == 1
    assert "simple-bg-colored-shadow-removed" in detected.warnings
    assert "simple-bg-drop-shadow-removed" in detected.warnings
    assert "simple-bg-preview-denoise-fallback" not in detected.warnings
    assert np.any((detected.analysis.alpha > 0) & (detected.analysis.alpha < 255))


def _recover(source):
    rgb = np.asarray(source, dtype=np.uint8)
    background = detect_background(rgb)
    assert background is not None and background.is_flat
    _count, labels = cv2.connectedComponents(background.foreground_mask, connectivity=8)
    result = recover_soft_shadow_alpha(rgb, background.foreground_mask, labels, background.color)
    return result, background.foreground_mask


def test_lo_b_mep_anh_khong_phai_than_tem_de_do_khoang_cach():
    candidate = np.zeros((5, 12), dtype=bool)
    candidate[:, 2:5] = True
    distance = _distance_to_candidate(candidate)
    assert distance[2, 11] == pytest.approx(7.0)
    assert distance[2, 4] == 0.0


@pytest.mark.parametrize("scale", [0.25, 0.5, 1.0, 2.0])
def test_lo_b_bong_mau_cung_duoc_loai_o_cac_co_anh(scale):
    source, _raw = _saved_user_case()
    rgb = cv2.resize(np.asarray(source), None, fx=scale, fy=scale)
    alpha, _reference = _recover(rgb)
    assert alpha is not None
    # Ở 0,25x điểm này sát dải AA (Alpha=1), nhưng vẫn ở ngoài silhouette.
    # Writer sẽ xóa Alpha ngoài labels; không ép Alpha mềm thành nhị phân ở đây.
    assert alpha[int(590 * scale), int(295 * scale)] < 128
    assert alpha[int(210 * scale), int(550 * scale)] == 255


def _colored_shadow_scene(body_color=(170, 130, 90), *, shell=None, tip_size=None, jpeg=False, shape="circle"):
    yy, xx = np.mgrid[:300, :330]
    main = (xx - 140) ** 2 + (yy - 140) ** 2 < 90 ** 2
    if shape == "notch":
        main[(xx > 198) & (yy > 120) & (yy < 142)] = False
    tip = np.zeros(main.shape, dtype=bool)
    if tip_size is not None:
        width, height = tip_size
        tip = (xx >= 225) & (xx < 225 + width) & (yy >= 131) & (yy < 131 + height)
    body = main | tip
    shadow = cv2.GaussianBlur(np.roll(body.astype(np.float32), 6, axis=0), (0, 0), 4)
    rgb = np.full((*body.shape, 3), 255, np.float32) - shadow[:, :, None] * np.array([60, 90, 110])
    rgb[body] = body_color
    if shell is not None:
        rgb[body] = shell
        inner = (xx - 140) ** 2 + (yy - 140) ** 2 < 85 ** 2
        rgb[inner & body] = (180, 50, 30)
    rgb[tip] = 235
    rgb = rgb.astype(np.uint8)
    if jpeg:
        stream = BytesIO()
        Image.fromarray(rgb).save(stream, format="JPEG", quality=95)
        stream.seek(0)
        rgb = np.array(Image.open(stream).convert("RGB"))
    return rgb, body, tip


@pytest.mark.parametrize("width,height", [(15, 3), (15, 7), (25, 13), (40, 3), (69, 13)])
@pytest.mark.parametrize("jpeg", [False, True])
def test_lo_b_khong_xoa_tai_nhat_ke_ca_jpeg(width, height, jpeg):
    rgb, body, tip = _colored_shadow_scene(tip_size=(width, height), jpeg=jpeg)
    alpha, reference = _recover(rgb)
    assert np.all(reference[tip] == 255)
    actual = reference if alpha is None else alpha
    assert np.all(actual[tip] >= 128)


@pytest.mark.parametrize("shell", [235, 236, 237, 238, 239])
def test_lo_b_khong_xoa_vien_sang_giua_bong_va_artwork(shell):
    rgb, body, _ = _colored_shadow_scene(shell=shell)
    alpha, reference = _recover(rgb)
    actual = reference if alpha is None else alpha
    # Lấy lõi thân để không biến dung sai antialias thành kỳ vọng bất khả thi.
    body_core = cv2.erode(body.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0
    assert np.all(actual[body_core] >= 128)


@pytest.mark.parametrize("body_color", [(40, 90, 180), (145, 145, 145), (170, 130, 90)])
@pytest.mark.parametrize("shape", ["circle", "notch"])
def test_lo_b_bien_ro_dung_duoc_voi_mau_va_hinh_khac_nhau(body_color, shape):
    rgb, body, _ = _colored_shadow_scene(body_color=body_color, shape=shape)
    alpha, reference = _recover(rgb)
    assert alpha is not None
    core = cv2.erode(body.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0
    assert np.all(alpha[core] >= 128)
    before = np.count_nonzero((reference > 0) & ~body)
    after = np.count_nonzero((alpha >= 128) & ~body)
    assert after < before * 0.15


def test_lo_b_khong_tu_xoa_vien_phang_hong_cua_jpeg():
    source = Image.new("RGB", (320, 240), (254, 254, 254))
    draw = ImageDraw.Draw(source)
    draw.ellipse((38, 28, 282, 212), fill=(255, 232, 232))
    draw.ellipse((44, 34, 276, 206), fill=(170, 120, 120))
    draw.ellipse((45, 35, 275, 205), fill=(78, 12, 10))
    stream = BytesIO()
    source.save(stream, format="JPEG", quality=95)
    stream.seek(0)
    alpha, _reference = _recover(np.array(Image.open(stream).convert("RGB")))
    assert alpha is None


def test_lo_b_giu_component_khong_bong_va_lo_that():
    rgb, body, _ = _colored_shadow_scene(body_color=(40, 90, 180))
    hole = np.zeros(body.shape, np.uint8)
    cv2.circle(hole, (140, 140), 12, 255, -1)
    rgb[hole > 0] = 255
    background = detect_background(rgb)
    assert background is not None
    reference = background.foreground_mask.copy()
    reference[hole > 0] = 0
    # Một nhãn khác không bóng nằm trong ROI mở rộng của nhãn chính.
    reference[25:45, 242:266] = 255
    rgb[25:45, 242:266] = (70, 160, 40)
    _count, labels = cv2.connectedComponents(reference, connectivity=8)
    alpha = recover_soft_shadow_alpha(rgb, reference, labels, background.color)
    assert alpha is not None
    assert np.all(alpha[27:43, 244:264] == 255)
    assert np.all(alpha[135:145, 135:145] == 0)
    assert cv2.connectedComponents((alpha >= 128).astype(np.uint8), connectivity=8)[0] == _count


def test_lo_b_hai_che_do_tra_cung_alpha_va_duong_cat(monkeypatch, tmp_path):
    def no_ai(*_args, **_kwargs):
        raise AssertionError("Biên deterministic đã kiểm không được chạy AI")
    monkeypatch.setattr(pipeline, "analyze_sticker_sheet", no_ai)
    alphas, paths = [], []
    for preview_only in (True, False):
        session = _user_session(tmp_path, "pdf")
        detected = pipeline.detect_sticker_source(session, strategy="auto", preview_only=preview_only)
        promoted = sessions.promote_source_session(session.session_id, analysis=detected.analysis,
            analysis_source=detected.source_image, boundary_source=detected.boundary_source,
            strategy_confidence=detected.strategy_confidence, needs_review=detected.needs_review,
            dpi=detected.dpi, source_page=1, warnings=list(detected.warnings))
        assert promoted is not None
        preview = build_sticker_cutline_preview(promoted, page_number=1, base_revision=1,
            edits=[], dpi=detected.dpi[0], dpi_y=detected.dpi[1], offset_mm=0, bleed_mm=0,
            cut_mode="original", corner_style="preserve", fill_holes=True,
            cutline_smoothness=50, cutline_fidelity=50, curve_tension=50,
            min_detail_area_mm2=1, cutline_denoise=50)
        assert len(preview["paths"]) == 1
        alphas.append(detected.analysis.alpha)
        paths.append(preview["paths"])
    assert np.array_equal(alphas[0], alphas[1])
    assert paths[0] == paths[1]


def test_lo_b_legacy_chua_co_preview_khong_nhan_dien_ai_lai(monkeypatch, tmp_path):
    def no_ai(*_args, **_kwargs):
        raise AssertionError("Legacy cũng phải giữ biên bóng đã xác minh")
    monkeypatch.setattr(pipeline, "analyze_sticker_sheet", no_ai)
    approved = pipeline.build_legacy_single_page_approved_contour(
        str(_captured_source_pdf(tmp_path)), cut_mode="original", offset_mm=0,
        bleed_mm=0, corner_style="preserve", fill_holes=True, cutline_denoise=50,
    )
    assert approved is not None and approved.boundary_source == "simple-bg"
    assert approved.alpha[590, 295] == 0
    assert np.all(approved.alpha[198:224, 495:520] == 255)
    assert len(approved.path_groups) == 1


def test_lo_b_giu_id_theo_vi_tri_khi_nhieu_tem():
    first, _body, _tip = _colored_shadow_scene(body_color=(40, 90, 180))
    rgb = np.full((300, 660, 3), 255, dtype=np.uint8)
    rgb[:, :330] = first
    rgb[:, 330:] = first
    source = Image.fromarray(rgb)
    kwargs = dict(model="birefnet-lite", alpha_threshold=128,
                  boundary_source="simple-bg", dpi=(300.0, 300.0), minimum_confidence=0.60)
    with patch.object(pipeline, "recover_soft_shadow_alpha", return_value=None):
        before = pipeline._background_detection(source, **kwargs)
    after = pipeline._background_detection(source, **kwargs)
    assert before is not None and after is not None
    assert len(before.analysis.instances) == len(after.analysis.instances) == 2
    assert "simple-bg-colored-shadow-removed" in after.warnings
    for x in (140, 470):
        assert after.analysis.labels[140, x] == before.analysis.labels[140, x] > 0
    assert [item.id for item in after.analysis.instances] == [item.id for item in before.analysis.instances]
