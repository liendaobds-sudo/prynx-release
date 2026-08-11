"""Orchestrator nhận diện nguồn: ưu tiên dữ liệu chắc chắn trước AI."""

from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import time

import numpy as np
import pikepdf
from PIL import Image
import pytest

from app.core import sticker_sheet_session as session_store
from app.core.sticker_background import BackgroundInfo
from app.core.sticker_sheet_session import (
    abort_source_detection,
    begin_source_detection,
    confirm_source_session,
    create_source_session,
    promote_source_session,
)
from app.workers.sticker_source_inspector import inspect_sticker_source
from app.workers.cut_export.cut_layer_extractor import CutContour, ExtractResult
from app.workers.sticker_source_pipeline import (
    _cut_contour_alpha,
    _render_pdf_page,
    detect_sticker_source,
)


COREL_CUT_FIXTURE = (
    Path(__file__).resolve().parents[1]
    / "app" / "workers" / "cut_export" / "tests" / "fixtures" / "corel_cut_sample.pdf"
)


@pytest.fixture(autouse=True)
def isolated_sessions(tmp_path, monkeypatch):
    for session_id in list(session_store._SESSIONS):
        session_store.close_session(session_id)
    monkeypatch.setattr(session_store, "SESSION_ROOT", tmp_path / "source_pipeline_sessions")
    yield
    for session_id in list(session_store._SESSIONS):
        session_store.close_session(session_id)


def _create_session(path: Path):
    inspection = inspect_sticker_source(str(path), path.name)
    return create_source_session(
        source_path=path,
        original_name=path.name,
        inspection=inspection,
    )


def _two_sticker_image(*, alpha: bool) -> Image.Image:
    background = (255, 255, 255, 0 if alpha else 255)
    image = Image.new("RGBA", (160, 100), background)
    image.paste((220, 40, 80, 255), (12, 15, 65, 80))
    image.paste((40, 120, 220, 255), (92, 20, 148, 82))
    return image


def _save_pdf(path: Path, size: tuple[float, float], *, user_unit: float = 1.0) -> None:
    document = pikepdf.Pdf.new()
    page = document.add_blank_page(page_size=size)
    page.obj["/UserUnit"] = user_unit
    document.save(path)
    document.close()


def _save_multi_page_pdf(path: Path, page_count: int = 3) -> None:
    document = pikepdf.Pdf.new()
    for index in range(page_count):
        document.add_blank_page(page_size=(120 + index * 10, 90 + index * 10))
    document.save(path)
    document.close()


def _save_soft_mask_pdf(path: Path) -> None:
    document = pikepdf.Pdf.new()
    page = document.add_blank_page(page_size=(100, 80))
    alpha = pikepdf.Stream(document, bytes([255]) * (60 * 40))
    alpha.Type = pikepdf.Name.XObject
    alpha.Subtype = pikepdf.Name.Image
    alpha.Width = 60
    alpha.Height = 40
    alpha.ColorSpace = pikepdf.Name.DeviceGray
    alpha.BitsPerComponent = 8
    image = pikepdf.Stream(document, bytes([220, 40, 80]) * (60 * 40))
    image.Type = pikepdf.Name.XObject
    image.Subtype = pikepdf.Name.Image
    image.Width = 60
    image.Height = 40
    image.ColorSpace = pikepdf.Name.DeviceRGB
    image.BitsPerComponent = 8
    image.SMask = document.make_indirect(alpha)
    page.Resources = pikepdf.Dictionary(
        XObject=pikepdf.Dictionary(Im0=document.make_indirect(image)),
    )
    page.Contents = document.make_stream(b"q 60 0 0 40 20 20 cm /Im0 Do Q")
    document.save(path)
    document.close()


def _save_full_page_image_pdf(
    path: Path,
    image_sizes: tuple[tuple[int, int], ...],
    *,
    vector_pages: frozenset[int] = frozenset(),
) -> None:
    """Tạo PDF giống luồng Viewer: mỗi trang chỉ có một ảnh phủ kín trang."""
    document = pikepdf.Pdf.new()
    for page_number, (width, height) in enumerate(image_sizes, start=1):
        page = document.add_blank_page(page_size=(width, height))
        image = pikepdf.Stream(document, bytes([220, 40, 80]) * (width * height))
        image.Type = pikepdf.Name.XObject
        image.Subtype = pikepdf.Name.Image
        image.Width = width
        image.Height = height
        image.ColorSpace = pikepdf.Name.DeviceRGB
        image.BitsPerComponent = 8
        page.Resources = pikepdf.Dictionary(
            XObject=pikepdf.Dictionary(Im0=document.make_indirect(image)),
        )
        content = f"q {width} 0 0 {height} 0 0 cm /Im0 Do Q".encode("ascii")
        if page_number in vector_pages:
            content += f" 0 0 m {width} {height} l S".encode("ascii")
        page.Contents = document.make_stream(content)
    document.save(path)
    document.close()


def test_auto_uses_clean_alpha_without_ai(tmp_path, monkeypatch):
    source = tmp_path / "alpha.png"
    _two_sticker_image(alpha=True).save(source, format="PNG", dpi=(300, 300))
    session = _create_session(source)
    monkeypatch.setattr(
        "app.workers.sticker_sheet_engine._run_background_model",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("AI không được chạy")),
    )

    detected = detect_sticker_source(session)

    assert detected.boundary_source == "alpha"
    assert detected.analysis.model_seconds == 0
    assert len(detected.analysis.instances) == 2
    assert np.count_nonzero(detected.analysis.uncertainty) == 0


def test_auto_uses_simple_background_without_ai_and_keeps_topology(tmp_path, monkeypatch):
    source = tmp_path / "white-bg.png"
    _two_sticker_image(alpha=False).convert("RGB").save(source, format="PNG", dpi=(300, 300))
    session = _create_session(source)
    monkeypatch.setattr(
        "app.workers.sticker_sheet_engine._run_background_model",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("AI không được chạy")),
    )

    detected = detect_sticker_source(session)

    assert detected.boundary_source == "simple-bg"
    assert detected.analysis.model_seconds == 0
    assert len(detected.analysis.instances) == 2
    assert [item.bbox for item in detected.analysis.instances] == [
        (12, 15, 53, 65),
        (92, 20, 56, 62),
    ]


def test_auto_falls_back_to_ai_only_when_deterministic_background_fails(tmp_path, monkeypatch):
    source = tmp_path / "complex.png"
    Image.new("RGB", (100, 80), (90, 80, 70)).save(source, format="PNG")
    session = _create_session(source)
    calls: list[str] = []

    def fake_ai(image: Image.Image, _model: str) -> Image.Image:
        calls.append("ai")
        rgba = image.convert("RGBA")
        alpha = Image.new("L", image.size, 0)
        alpha.paste(255, (15, 10, 85, 70))
        rgba.putalpha(alpha)
        return rgba

    monkeypatch.setattr("app.workers.sticker_source_pipeline.detect_background", lambda _rgb: None)
    monkeypatch.setattr("app.workers.sticker_sheet_engine._run_background_model", fake_ai)

    detected = detect_sticker_source(session)

    assert calls == ["ai"]
    assert detected.boundary_source == "ai"
    assert len(detected.analysis.instances) == 1


def test_auto_rejects_nested_simple_background_fragments_and_uses_ai(tmp_path, monkeypatch):
    source = tmp_path / "white-sticker-sheet.png"
    Image.new("RGB", (240, 140), "white").save(source, format="PNG")
    session = _create_session(source)
    fragmented = np.zeros((140, 240), dtype=np.uint8)
    # Hai vỏ tem trắng chỉ còn đường viền; chữ/chi tiết màu ở trong trở thành
    # component rời nhưng tâm vẫn nằm trong bbox của vỏ — đúng lỗi ảnh khách.
    for left, right in ((8, 108), (132, 232)):
        fragmented[10:130, left:left + 3] = 255
        fragmented[10:130, right - 3:right] = 255
        fragmented[10:13, left:right] = 255
        fragmented[127:130, left:right] = 255
        fragmented[35:65, left + 20:left + 42] = 255
        fragmented[78:110, left + 55:left + 82] = 255

    monkeypatch.setattr(
        "app.workers.sticker_source_pipeline.detect_background",
        lambda _rgb: BackgroundInfo(
            color=(255, 255, 255),
            tolerance=12,
            foreground_mask=fragmented,
            confidence=0.99,
            is_near_white=True,
            is_flat=True,
        ),
    )
    calls: list[str] = []

    def fake_ai(image: Image.Image, _model: str) -> Image.Image:
        calls.append("ai")
        rgba = image.convert("RGBA")
        alpha = Image.new("L", image.size, 0)
        alpha.paste(255, (8, 10, 108, 130))
        alpha.paste(255, (132, 10, 232, 130))
        rgba.putalpha(alpha)
        return rgba

    monkeypatch.setattr("app.workers.sticker_sheet_engine._run_background_model", fake_ai)

    detected = detect_sticker_source(session)

    assert calls == ["ai"]
    assert detected.boundary_source == "ai"
    assert len(detected.analysis.instances) == 2


def test_real_corel_cutcontour_creates_review_mask_without_ai(monkeypatch):
    session = _create_session(COREL_CUT_FIXTURE)
    monkeypatch.setattr(
        "app.workers.sticker_sheet_engine._run_background_model",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("AI không được chạy")),
    )

    detected = detect_sticker_source(session, page_number=1)

    assert detected.boundary_source == "existing-cut"
    assert detected.vector_geometry_ref == {
        "kind": "pdf-cut-contours",
        "source_page": 1,
        "contour_count": 75,
        "preserve_original": True,
    }
    assert len(detected.analysis.instances) == 75


def test_promote_keeps_session_id_and_blocks_until_confirmed(tmp_path):
    source = tmp_path / "alpha.png"
    _two_sticker_image(alpha=True).save(source, format="PNG", dpi=(300, 300))
    session = _create_session(source)
    detected = detect_sticker_source(session)

    promoted = promote_source_session(
        session.session_id,
        analysis=detected.analysis,
        analysis_source=detected.source_image,
        boundary_source=detected.boundary_source,
        strategy_confidence=detected.strategy_confidence,
        needs_review=detected.needs_review,
        dpi=detected.dpi,
        source_page=detected.source_page,
        vector_geometry_ref=detected.vector_geometry_ref,
        warnings=list(detected.warnings),
    )

    assert promoted is session
    assert promoted.stage == "mask-review"
    assert promoted.analysis_source_path == promoted.directory / "analysis_source.png"
    assert promoted.analysis_source_path.is_file()
    assert (promoted.directory / "source_preview.png").is_file()
    assert (promoted.directory / "labels.npy").is_file()
    assert confirm_source_session(session.session_id) is session
    assert session.stage == "mask-ready"
    assert session.manifest["mask_confirmed"] is True


def test_auto_low_confidence_gradient_falls_back_to_ai(tmp_path, monkeypatch):
    source = tmp_path / "gradient.png"
    x = np.linspace(245, 90, 180, dtype=np.uint8)
    rgb = np.repeat(x[None, :, None], 120, axis=0)
    rgb = np.repeat(rgb, 3, axis=2)
    rgb[25:95, 55:130] = (220, 40, 80)
    Image.fromarray(rgb, "RGB").save(source)
    session = _create_session(source)
    calls: list[str] = []

    def fake_ai(image: Image.Image, _model: str) -> Image.Image:
        calls.append("ai")
        rgba = image.convert("RGBA")
        alpha = Image.new("L", image.size, 0)
        alpha.paste(255, (55, 25, 130, 95))
        rgba.putalpha(alpha)
        return rgba

    monkeypatch.setattr("app.workers.sticker_sheet_engine._run_background_model", fake_ai)

    detected = detect_sticker_source(session)

    assert detected.boundary_source == "ai"
    assert calls == ["ai"]


def test_auto_background_without_valid_components_falls_back_to_ai(tmp_path, monkeypatch):
    source = tmp_path / "fragments.png"
    image = Image.new("RGB", (400, 400), "white")
    for index in range(20):
        x = 10 + (index % 5) * 70
        y = 10 + (index // 5) * 70
        image.paste((20, 80, 180), (x, y, x + 3, y + 3))
    image.save(source)
    session = _create_session(source)
    calls: list[str] = []

    def fake_ai(source_image: Image.Image, _model: str) -> Image.Image:
        calls.append("ai")
        rgba = source_image.convert("RGBA")
        alpha = Image.new("L", source_image.size, 0)
        alpha.paste(255, (80, 80, 320, 320))
        rgba.putalpha(alpha)
        return rgba

    monkeypatch.setattr("app.workers.sticker_sheet_engine._run_background_model", fake_ai)

    detected = detect_sticker_source(session)

    assert detected.boundary_source == "ai"
    assert calls == ["ai"]


def test_single_transparent_pixel_is_not_clean_alpha(tmp_path, monkeypatch):
    source = tmp_path / "false-alpha.png"
    image = Image.new("RGBA", (100, 80), (255, 255, 255, 255))
    image.paste((220, 40, 80, 255), (20, 15, 80, 65))
    image.putpixel((0, 0), (255, 255, 255, 0))
    image.save(source)
    session = _create_session(source)
    monkeypatch.setattr(
        "app.workers.sticker_sheet_engine._run_background_model",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("AI không được chạy")),
    )

    detected = detect_sticker_source(session)

    assert session.manifest["has_alpha"] is False
    assert detected.boundary_source == "simple-bg"
    assert detected.analysis.instances[0].bbox == (20, 15, 60, 50)


def test_pdf_user_unit_keeps_physical_size_and_only_caps_low_ram(tmp_path, monkeypatch):
    source = tmp_path / "user-unit.pdf"
    _save_pdf(source, (1000, 500), user_unit=2.0)
    physical_size_mm = (1000 * 2 * 25.4 / 72.0, 500 * 2 * 25.4 / 72.0)

    monkeypatch.setattr(
        "app.workers.sticker_source_pipeline.read_memory_status_mb",
        lambda: (32 * 1024, 24 * 1024),
    )
    full_image, full_dpi = _render_pdf_page(str(source), 0, physical_size_mm)
    assert max(full_image.size) > 3000
    assert full_dpi[0] == pytest.approx(300, abs=0.2)
    assert full_dpi[1] == pytest.approx(300, abs=0.2)

    monkeypatch.setattr(
        "app.workers.sticker_source_pipeline.read_memory_status_mb",
        lambda: (6 * 1024, 3 * 1024),
    )
    capped_image, capped_dpi = _render_pdf_page(str(source), 0, physical_size_mm)
    assert max(capped_image.size) <= 3000
    assert capped_dpi[0] < full_dpi[0]


def test_image_only_pdf_keeps_native_resolution_for_each_thumbnail_page(tmp_path, monkeypatch):
    source = tmp_path / "viewer-images.pdf"
    native_sizes = ((320, 180), (180, 260))
    _save_full_page_image_pdf(source, native_sizes)
    inspection = inspect_sticker_source(str(source), source.name)
    monkeypatch.setattr(
        "app.workers.sticker_source_pipeline.read_memory_status_mb",
        lambda: (32 * 1024, 24 * 1024),
    )

    rendered = []
    for page_index, page in enumerate(inspection.pages):
        image, dpi = _render_pdf_page(
            str(source),
            page_index,
            (float(page.width_mm), float(page.height_mm)),
        )
        rendered.append((image.size, dpi))

    assert [size for size, _dpi in rendered] == list(native_sizes)
    for _size, dpi in rendered:
        assert dpi[0] == pytest.approx(72, abs=0.2)
        assert dpi[1] == pytest.approx(72, abs=0.2)


def test_image_page_with_vector_content_still_renders_at_300_dpi(tmp_path, monkeypatch):
    source = tmp_path / "image-and-vector.pdf"
    _save_full_page_image_pdf(source, ((320, 180),), vector_pages=frozenset({1}))
    inspection = inspect_sticker_source(str(source), source.name)
    page = inspection.pages[0]
    monkeypatch.setattr(
        "app.workers.sticker_source_pipeline.read_memory_status_mb",
        lambda: (32 * 1024, 24 * 1024),
    )

    image, dpi = _render_pdf_page(
        str(source),
        0,
        (float(page.width_mm), float(page.height_mm)),
    )

    assert image.width > 320 * 4
    assert image.height > 180 * 4
    assert dpi[0] == pytest.approx(300, abs=0.2)
    assert dpi[1] == pytest.approx(300, abs=0.2)


def test_nested_cut_contours_keep_inner_hole(tmp_path, monkeypatch):
    source = tmp_path / "nested.pdf"
    _save_pdf(source, (100, 100))
    monkeypatch.setattr(
        "app.workers.sticker_source_pipeline.extract_cut_contours",
        lambda *_args, **_kwargs: ExtractResult(contours=[
            CutContour([(10, 10), (90, 10), (90, 90), (10, 90)], True),
            CutContour([(30, 30), (70, 30), (70, 70), (30, 70)], True),
        ]),
    )

    alpha, count = _cut_contour_alpha(str(source), 0, (100, 100))

    assert count == 2
    assert alpha[15, 15] == 255
    assert alpha[50, 50] == 0


def test_pdf_soft_mask_is_used_before_simple_background(tmp_path, monkeypatch):
    source = tmp_path / "soft-mask.pdf"
    _save_soft_mask_pdf(source)
    session = _create_session(source)
    monkeypatch.setattr(
        "app.workers.sticker_sheet_engine._run_background_model",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("AI không được chạy")),
    )

    detected = detect_sticker_source(session)

    assert session.manifest["has_alpha"] is True
    assert detected.boundary_source == "alpha"
    assert len(detected.analysis.instances) == 1


def test_detection_reservation_is_exclusive_and_can_be_aborted(tmp_path):
    source = tmp_path / "alpha.png"
    _two_sticker_image(alpha=True).save(source, format="PNG")
    session = _create_session(source)

    assert begin_source_detection(session.session_id) is session
    assert session.stage == "detecting"
    assert begin_source_detection(session.session_id) is None
    assert abort_source_detection(session.session_id) is True
    assert session.stage == "inspected"


def test_detection_reservations_are_isolated_by_source_page(tmp_path):
    source = tmp_path / "three-pages.pdf"
    _save_multi_page_pdf(source)
    session = _create_session(source)

    assert sorted(session.pages) == [1, 2, 3]
    assert begin_source_detection(session.session_id, page_number=1) is session
    assert begin_source_detection(session.session_id, page_number=2) is session
    assert begin_source_detection(session.session_id, page_number=1) is None
    assert session.pages[1].stage == "detecting"
    assert session.pages[2].stage == "detecting"
    assert session.pages[3].stage == "inspected"

    assert abort_source_detection(session.session_id, page_number=1) is True
    assert session.pages[1].stage == "inspected"
    assert session.pages[2].stage == "detecting"
    assert abort_source_detection(session.session_id, page_number=2) is True

    page_two_directory = session.directory / "pages" / "0002"
    assert session.pages[2].directory == page_two_directory
    assert (page_two_directory / "manifest.json").is_file()


def test_concurrent_promote_and_confirm_keep_manifest_consistent(tmp_path):
    source = tmp_path / "alpha.png"
    _two_sticker_image(alpha=True).save(source, format="PNG")
    session = _create_session(source)
    detected = detect_sticker_source(session)

    def promote():
        return promote_source_session(
            session.session_id,
            analysis=detected.analysis,
            analysis_source=detected.source_image,
            boundary_source=detected.boundary_source,
            strategy_confidence=detected.strategy_confidence,
            needs_review=detected.needs_review,
            dpi=detected.dpi,
            source_page=detected.source_page,
        )

    with ThreadPoolExecutor(max_workers=2) as executor:
        promoted = list(executor.map(lambda _index: promote(), range(2)))

    assert promoted.count(session) == 1
    assert promoted.count(None) == 1
    manifest = json.loads((session.directory / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["stage"] == "mask-review"
    assert len(manifest["instances"]) == 2
    assert not (session.directory / "manifest.json.tmp").exists()
    with Image.open(session.directory / "preview.png") as preview:
        assert preview.size == (160, 100)

    with ThreadPoolExecutor(max_workers=8) as executor:
        confirmed = list(executor.map(
            lambda _index: confirm_source_session(session.session_id),
            range(32),
        ))
    assert confirmed == [session] * 32
    assert session.stage == "mask-ready"


def test_failed_promote_restores_inspected_preview(tmp_path, monkeypatch):
    source = tmp_path / "alpha.png"
    _two_sticker_image(alpha=True).save(source, format="PNG")
    session = _create_session(source)
    detected = detect_sticker_source(session)
    original_preview = (session.directory / "preview.png").read_bytes()
    monkeypatch.setattr(
        "app.core.sticker_sheet_session.np.save",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(OSError("disk-full")),
    )

    with pytest.raises(OSError, match="disk-full"):
        promote_source_session(
            session.session_id,
            analysis=detected.analysis,
            analysis_source=detected.source_image,
            boundary_source=detected.boundary_source,
            strategy_confidence=detected.strategy_confidence,
            needs_review=detected.needs_review,
            dpi=detected.dpi,
            source_page=detected.source_page,
        )

    assert session.stage == "inspected"
    assert (session.directory / "preview.png").read_bytes() == original_preview
    assert not (session.directory / "analysis_source.png").exists()
    assert not list(session.directory.glob(".promote-*"))


def test_session_copy_gets_fresh_mtime(tmp_path):
    source = tmp_path / "old-alpha.png"
    _two_sticker_image(alpha=True).save(source, format="PNG")
    old_time = time.time() - 72 * 60 * 60
    os.utime(source, (old_time, old_time))

    session = _create_session(source)

    assert session.source_path.stat().st_mtime > old_time + 60 * 60
