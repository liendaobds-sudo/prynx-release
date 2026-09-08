"""Test xuất trang PDF ra ảnh (export.render_pdf_to_images)."""
import io
import os
import asyncio
import threading

import pytest

from app.api.routes import export as export_route
from app.api.routes.export import render_pdf_to_images
from app.schemas.export import ExportImageBatchJob, ExportImagesBatchRequest, ExportImagesRequest
from app.workers import pdf_wrapper as pdf_lib


class _ConnectedRequest:
    async def is_disconnected(self):
        return False



def _make_pdf(tmp_path, pages=3, *, width=200, height=300):
    doc = pdf_lib.open()
    for _ in range(pages):
        pg = doc.new_page(width=width, height=height)
        sh = pg.new_shape()
        sh.draw_rect(pdf_lib.Rect(20, 20, 120, 120))
        sh.finish(color=(0, 0, 0), fill=(0, 0, 0))
        sh.commit()
    p = str(tmp_path / "src.pdf")
    buf = io.BytesIO(); doc.save(buf); doc.close()
    open(p, "wb").write(buf.getvalue())
    return p


def _is_image(path, expect_fmt):
    from PIL import Image
    with Image.open(path) as im:
        im.verify()
        return im.format.lower() == expect_fmt


def test_export_png_all_pages(tmp_path):
    src = _make_pdf(tmp_path, 3)
    out = str(tmp_path / "out")
    files = render_pdf_to_images(src, out, fmt="png", dpi=72)
    assert len(files) == 3
    for f in files:
        assert os.path.exists(f)
        assert _is_image(f, "png")


def test_export_jpeg_page_range(tmp_path):
    src = _make_pdf(tmp_path, 4)
    out = str(tmp_path / "out")
    files = render_pdf_to_images(src, out, fmt="jpeg", dpi=72, pages=[1, 3])
    assert len(files) == 2
    assert all(_is_image(f, "jpeg") for f in files)


def test_export_grayscale(tmp_path):
    src = _make_pdf(tmp_path, 1)
    out = str(tmp_path / "out")
    files = render_pdf_to_images(src, out, fmt="png", dpi=72, color_mode="gray")
    from PIL import Image
    with Image.open(files[0]) as im:
        assert im.mode == "L"


def test_rgb_export_composites_transparency_on_white(tmp_path):
    """EXPORT (audit 2026-09-08 §EXIMG-08): output ảnh hiện hành là opaque RGB."""
    from reportlab.pdfgen.canvas import Canvas
    from PIL import Image

    src = str(tmp_path / "transparent.pdf")
    canvas = Canvas(src, pagesize=(100, 100))
    canvas.setFillAlpha(0.5)
    canvas.setFillColorRGB(0, 0, 0)
    canvas.rect(0, 0, 100, 100, fill=1, stroke=0)
    canvas.save()

    files = render_pdf_to_images(src, str(tmp_path / "out"), fmt="png", dpi=72)
    with Image.open(files[0]) as image:
        assert image.mode == "RGB"
        assert "transparency" not in image.info
        assert image.getpixel((50, 50))[0] in range(100, 256)


def test_rgb_export_disables_annotation_widgets_for_parity(tmp_path, monkeypatch):
    """EXPORT (audit 2026-09-08 §EXIMG-09): widget tương tác không vào artifact ảnh."""
    import pypdfium2 as pdfium

    src = _make_pdf(tmp_path, 1)
    calls = []
    original_render = pdfium.PdfPage.render

    def spy_render(page, *args, **kwargs):
        calls.append(kwargs.copy())
        return original_render(page, *args, **kwargs)

    monkeypatch.setattr(pdfium.PdfPage, "render", spy_render)
    render_pdf_to_images(src, str(tmp_path / "out"), fmt="png", dpi=72)
    assert calls and all(call.get("draw_annots") is False for call in calls)


def test_export_multipage_tiff(tmp_path):
    src = _make_pdf(tmp_path, 3)
    out = str(tmp_path / "out")
    files = render_pdf_to_images(src, out, fmt="tiff", dpi=72, multipage_tiff=True)
    assert len(files) == 1
    from PIL import Image
    with Image.open(files[0]) as im:
        assert getattr(im, "n_frames", 1) == 3
        assert im.tag_v2.get(259) == 8  # Deflate, không còn TIFF raw khổng lồ


def test_dpi_boundary_max_accepted(tmp_path):
    """EXPORT (audit 2026-07-30 §IMG-08 lô 3): dpi=1200 (biên max) vẫn chạy."""
    src = _make_pdf(tmp_path, 1)
    out = str(tmp_path / "out")
    # dpi=1200 là biên max schema chấp nhận, render nhỏ (1 trang A4) không OOM.
    files = render_pdf_to_images(src, out, fmt="png", dpi=1200)
    assert len(files) == 1


def test_invalid_format_raises(tmp_path):
    src = _make_pdf(tmp_path, 1)
    out = str(tmp_path / "out")
    with pytest.raises(ValueError):
        render_pdf_to_images(src, out, fmt="bmp")


def test_no_valid_pages_raises(tmp_path):
    src = _make_pdf(tmp_path, 2)
    out = str(tmp_path / "out")
    with pytest.raises(ValueError):
        render_pdf_to_images(src, out, fmt="png", pages=[99])


def test_existing_file_is_not_overwritten(tmp_path):
    src = _make_pdf(tmp_path, 1)
    out = tmp_path / "out"
    out.mkdir()
    existing = out / "src_p01.png"
    existing.write_bytes(b"anh-cu")

    files = render_pdf_to_images(src, str(out), fmt="png", dpi=72)

    assert existing.read_bytes() == b"anh-cu"
    assert files == [str(out / "src_p01_2.png")]
    assert _is_image(files[0], "png")


def test_base_name_cannot_escape_output_dir(tmp_path):
    src = _make_pdf(tmp_path, 1)
    out = tmp_path / "out"

    files = render_pdf_to_images(
        src, str(out), fmt="png", dpi=72, base_name="../ngoai-thu-muc"
    )

    root = os.path.normcase(str(out.resolve()))
    exported = os.path.normcase(os.path.abspath(files[0]))
    assert os.path.commonpath((root, exported)) == root
    assert not (tmp_path / "ngoai-thu-muc_p01.png").exists()


def test_failed_page_rolls_back_new_outputs(tmp_path, monkeypatch):
    src = _make_pdf(tmp_path, 2)
    out = tmp_path / "out"
    original = export_route._save_image_atomic
    calls = 0

    def fail_on_second_page(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 2:
            # Helper thật đã giữ tên; giải phóng reservation như đường lỗi thật.
            export_route._release_output_path(args[1])
            raise OSError("disk full")
        return original(*args, **kwargs)

    monkeypatch.setattr(export_route, "_save_image_atomic", fail_on_second_page)
    with pytest.raises(OSError, match="disk full"):
        render_pdf_to_images(src, str(out), fmt="png", dpi=72)

    assert list(out.iterdir()) == []


def test_async_route_offloads_render_from_event_loop(tmp_path, monkeypatch):
    src = _make_pdf(tmp_path, 1)
    out = tmp_path / "out"
    event_loop_thread = threading.get_ident()
    render_thread = None

    def fake_render(*args, **kwargs):
        nonlocal render_thread
        render_thread = threading.get_ident()
        return [str(out / "done.png")]

    monkeypatch.setattr(export_route, "render_pdf_to_images", fake_render)
    req = ExportImagesRequest(file_path=src, output_dir=str(out))
    result = asyncio.run(export_route.export_images(req, _ConnectedRequest()))

    assert result["ok"] is True
    assert render_thread is not None
    assert render_thread != event_loop_thread


def test_disconnect_watcher_sets_cancel_event():
    """RE-AUDIT §RA-03: HTTP disconnect phải bật event mà worker đang kiểm tra."""
    class DisconnectAfterTwoPolls:
        def __init__(self):
            self.calls = 0

        async def is_disconnected(self):
            self.calls += 1
            return self.calls >= 2

    async def run_case():
        request = DisconnectAfterTwoPolls()
        cancel_event = threading.Event()
        await asyncio.wait_for(
            export_route._watch_export_disconnect(request, cancel_event), timeout=1,
        )
        assert cancel_event.is_set()
        assert request.calls == 2

    asyncio.run(run_case())


def test_cancel_event_stops_render_and_rolls_back(tmp_path):
    """EXPORT (audit 2026-07-30 §IMG-06): cancel_event dừng render sớm, rollback output."""
    src = _make_pdf(tmp_path, 5)
    out = tmp_path / "out"
    cancel = threading.Event()

    original = export_route._save_image_atomic
    calls = 0

    def cancel_after_second(*args, **kwargs):
        nonlocal calls
        calls += 1
        result = original(*args, **kwargs)
        if calls >= 2:
            cancel.set()
        return result

    import app.api.routes.export as er
    er_orig = er._save_image_atomic
    er._save_image_atomic = cancel_after_second
    try:
        from app.api.routes.export import ExportCancelled
        with pytest.raises(ExportCancelled):
            render_pdf_to_images(src, str(out), fmt="png", dpi=72, cancel_event=cancel)
        # Rollback: không file nào còn lại
        remaining = list(out.iterdir()) if out.exists() else []
        assert remaining == []
    finally:
        er._save_image_atomic = er_orig


# ── §IMG-01 lô 3: ICC profile nhúng đúng ──────────────────────────────────────

def test_png_has_srgb_icc_profile(tmp_path):
    """EXPORT (audit 2026-07-30 §IMG-01 lô 3): PNG RGB phải nhúng sRGB ICC."""
    src = _make_pdf(tmp_path, 1)
    out = str(tmp_path / "out")
    files = render_pdf_to_images(src, out, fmt="png", dpi=72)
    from PIL import Image
    with Image.open(files[0]) as im:
        icc = im.info.get("icc_profile")
        assert icc is not None, "PNG thiếu ICC profile"
        assert len(icc) > 100, "ICC profile quá ngắn, có thể không hợp lệ"


def test_jpeg_has_srgb_icc_profile(tmp_path):
    """EXPORT (audit 2026-07-30 §IMG-01 lô 3): JPEG RGB phải nhúng sRGB ICC."""
    src = _make_pdf(tmp_path, 1)
    out = str(tmp_path / "out")
    files = render_pdf_to_images(src, out, fmt="jpeg", dpi=72)
    from PIL import Image
    with Image.open(files[0]) as im:
        icc = im.info.get("icc_profile")
        assert icc is not None, "JPEG thiếu ICC profile"


def test_tiff_has_srgb_icc_profile(tmp_path):
    """EXPORT (audit 2026-07-30 §IMG-01 lô 3): TIFF RGB phải nhúng sRGB ICC."""
    src = _make_pdf(tmp_path, 1)
    out = str(tmp_path / "out")
    files = render_pdf_to_images(src, out, fmt="tiff", dpi=72)
    from PIL import Image
    with Image.open(files[0]) as im:
        icc = im.info.get("icc_profile")
        assert icc is not None, "TIFF thiếu ICC profile"


def test_grayscale_has_gray_icc_profile(tmp_path):
    """EXPORT (audit 2026-07-30 §IMG-01 lô 3): Grayscale phải nhúng Gray Gamma 2.2."""
    src = _make_pdf(tmp_path, 1)
    out = str(tmp_path / "out")
    files = render_pdf_to_images(src, out, fmt="png", dpi=72, color_mode="gray")
    from PIL import Image
    with Image.open(files[0]) as im:
        assert im.mode == "L"
        icc = im.info.get("icc_profile")
        assert icc is not None, "Grayscale PNG thiếu ICC profile"


def test_multipage_tiff_has_icc_profile(tmp_path):
    """EXPORT (audit 2026-07-30 §IMG-01 lô 3): TIFF multipage cũng phải nhúng ICC."""
    src = _make_pdf(tmp_path, 2)
    out = str(tmp_path / "out")
    files = render_pdf_to_images(src, out, fmt="tiff", dpi=72, multipage_tiff=True)
    from PIL import Image
    with Image.open(files[0]) as im:
        icc = im.info.get("icc_profile")
        assert icc is not None, "TIFF multipage thiếu ICC profile"


# ── §IMG-08 lô 3: Schema validation ───────────────────────────────────────────

def test_schema_rejects_invalid_format():
    """EXPORT (audit 2026-07-30 §IMG-08 lô 3): format ngoài Literal → reject."""
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        ExportImagesRequest(output_dir="/tmp", format="bmp")


def test_schema_rejects_dpi_out_of_range():
    """EXPORT (audit 2026-07-30 §IMG-08 lô 3): dpi=0 hoặc 9999 → reject."""
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        ExportImagesRequest(output_dir="/tmp", dpi=0)
    with pytest.raises(ValidationError):
        ExportImagesRequest(output_dir="/tmp", dpi=9999)


def test_schema_rejects_quality_out_of_range():
    """EXPORT (audit 2026-07-30 §IMG-08 lô 3): jpeg_quality=200 → reject."""
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        ExportImagesRequest(output_dir="/tmp", jpeg_quality=200)
    with pytest.raises(ValidationError):
        ExportImagesRequest(output_dir="/tmp", jpeg_quality=0)


# ── §IMG-04 lô 4: CMYK production ─────────────────────────────────────────────

def test_schema_accepts_cmyk_color_mode():
    """EXPORT (audit 2026-07-30 §IMG-04 lô 4): schema chấp nhận color_mode='cmyk'."""
    req = ExportImagesRequest(output_dir="/tmp", color_mode="cmyk", format="tiff")
    assert req.color_mode == "cmyk"


def test_cmyk_png_raises(tmp_path):
    """EXPORT (audit 2026-07-30 §IMG-04 lô 4): CMYK+PNG → ValueError."""
    src = _make_pdf(tmp_path, 1)
    out = str(tmp_path / "out")
    with pytest.raises(ValueError, match="PNG"):
        render_pdf_to_images(src, out, fmt="png", color_mode="cmyk")


# ── §IMG-04 lô 4: CMYK end-to-end thật (yêu cầu native ppe_export_cmyk) ────────

def _native_has_cmyk() -> bool:
    """PPE native có symbol ppe_export_cmyk không (bỏ qua test nếu chưa build)."""
    try:
        from app.core.print_engine.facade import _native
        return hasattr(_native(), "ppe_export_cmyk")
    except Exception:
        return False


_requires_cmyk_native = pytest.mark.skipif(
    not _native_has_cmyk(),
    reason="pdfcompare_native chưa build ppe_export_cmyk — cần maturin develop --release",
)


@_requires_cmyk_native
def test_cmyk_export_keeps_antialiased_text_edges(tmp_path):
    """EXPORT (audit 2026-09-08 §EXIMG-01): bitmap CMYK không được tắt AA chữ."""
    from pathlib import Path
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.pdfgen.canvas import Canvas
    from app.core.icc_profiles import resolve_cmyk_profile_path
    from app.core.print_engine.facade import _native

    font_path = str(
        Path(__file__).resolve().parents[1]
        / "app"
        / "assets"
        / "fonts"
        / "DejaVuSans.ttf"
    )
    pdfmetrics.registerFont(TTFont("PrynXAuditDejaVu", font_path))
    src = str(tmp_path / "text.pdf")
    canvas = Canvas(src, pagesize=(300, 200))
    canvas.setFillColorCMYK(0, 1, 1, 0)
    canvas.setFont("PrynXAuditDejaVu", 72)
    canvas.drawString(20, 70, "Lạc Long Quân")
    canvas.save()

    native = _native()
    raw = native.ppe_export_cmyk(
        src,
        page=1,
        dpi=300,
        cmyk_profile=resolve_cmyk_profile_path("fogra39"),
        page_box="media",
    )
    cmyk = bytes(raw["cmyk"])
    partial = [
        sum(1 for value in cmyk[channel::4] if 0 < value < 255)
        for channel in range(4)
    ]
    assert any(partial), f"CMYK export vẫn nhị phân, thiếu anti-alias: {partial}"


@_requires_cmyk_native
def test_cmyk_tiff_is_four_channel_with_icc(tmp_path):
    """EXPORT (audit 2026-07-30 §IMG-04 lô 4): TIFF CMYK phải là 4 kênh + nhúng ICC FOGRA39.

    Đây là test end-to-end THẬT: đi qua _render_cmyk_pages → facade.export_cmyk →
    native ppe_export_cmyk (KHÔNG qua PDFium→RGB). Đóng chốt runtime cho CMYK.
    """
    src = _make_pdf(tmp_path, 1)
    out = str(tmp_path / "out")
    files = render_pdf_to_images(src, out, fmt="tiff", dpi=72, color_mode="cmyk")
    assert len(files) == 1
    from PIL import Image
    with Image.open(files[0]) as im:
        assert im.mode == "CMYK", f"kỳ vọng 4 kênh CMYK, nhận {im.mode}"
        icc = im.info.get("icc_profile")
        assert icc is not None and len(icc) > 100, "TIFF CMYK thiếu ICC profile"


@_requires_cmyk_native
def test_cmyk_jpeg_is_four_channel(tmp_path):
    """EXPORT (audit 2026-07-30 §IMG-04 lô 4): JPEG CMYK phải là 4 kênh + có ICC."""
    src = _make_pdf(tmp_path, 1)
    out = str(tmp_path / "out")
    files = render_pdf_to_images(src, out, fmt="jpeg", dpi=72, color_mode="cmyk")
    assert len(files) == 1
    from PIL import Image
    with Image.open(files[0]) as im:
        assert im.mode == "CMYK", f"kỳ vọng 4 kênh CMYK, nhận {im.mode}"
        assert im.info.get("icc_profile") is not None, "JPEG CMYK thiếu ICC profile"


@_requires_cmyk_native
def test_cmyk_300dpi_trang_khach_chay_duoc_tren_low_tier_sach(
    tmp_path,
    monkeypatch,
):
    """§PPE.SCOPE.8: low-tier còn 3 GiB trống không được chặn TIFF 300 DPI.

    Khổ 748×561 pt trùng trang 1 PDF khách. Baseline budget 384/512 MiB đều
    fail-loud; benchmark xác nhận 640 MiB là mức đầu tiên chạy qua.
    """
    from app.config import settings
    from app.core.print_engine import facade
    from PIL import Image

    src = _make_pdf(tmp_path, 1, width=748, height=561)
    monkeypatch.setattr(settings, "PRYNX_PPE_MEMORY_BUDGET_MB", None)
    monkeypatch.setattr(
        "app.core.system_memory.read_memory_status_mb",
        lambda: (6 * 1024.0, 3 * 1024.0),
    )
    monkeypatch.setattr(
        "app.core.heavy_job_scheduler.max_active_heavy_jobs",
        lambda: 1,
    )
    assert facade._memory_budget_mb() == 640

    files = render_pdf_to_images(
        src,
        str(tmp_path / "out-300"),
        fmt="tiff",
        dpi=300,
        color_mode="cmyk",
    )

    assert len(files) == 1
    with Image.open(files[0]) as image:
        assert image.mode == "CMYK"
        assert image.size == (3117, 2338)
        assert image.info.get("icc_profile") is not None


@_requires_cmyk_native
def test_cmyk_multipage_tiff_four_channel(tmp_path):
    """EXPORT (audit 2026-07-30 §IMG-04 lô 4): TIFF CMYK nhiều trang — mỗi frame 4 kênh."""
    src = _make_pdf(tmp_path, 3)
    out = str(tmp_path / "out")
    files = render_pdf_to_images(
        src, out, fmt="tiff", dpi=72, color_mode="cmyk", multipage_tiff=True
    )
    assert len(files) == 1
    from PIL import Image
    with Image.open(files[0]) as im:
        assert getattr(im, "n_frames", 1) == 3
        assert im.mode == "CMYK"
        assert im.tag_v2.get(259) == 8  # Deflate


def test_cmyk_fails_loudly_when_ppe_reports_unsound(tmp_path, monkeypatch):
    """RE-AUDIT §RA-02: không giao file CMYK nếu PPE báo thiếu nội dung/mực."""
    src = _make_pdf(tmp_path, 1)
    out = tmp_path / "out"

    def fake_export(*args, **kwargs):
        return {
            "width": 2, "height": 2, "cmyk": bytes(2 * 2 * 4),
            "ink_unsound": True, "degraded": False,
        }

    monkeypatch.setattr("app.core.print_engine.facade.export_cmyk", fake_export)
    with pytest.raises(ValueError, match="không thể dựng đủ"):
        render_pdf_to_images(src, str(out), fmt="tiff", color_mode="cmyk")
    assert not out.exists() or list(out.iterdir()) == []


@pytest.mark.parametrize("include_bleed, expected_box", [(True, "media"), (False, "trim")])
def test_cmyk_forwards_selected_page_box(tmp_path, monkeypatch, include_bleed, expected_box):
    """RE-AUDIT §RA-01: CMYK phải truyền đúng MediaBox/TrimBox vào PPE."""
    src = _make_pdf(tmp_path, 1)
    seen = []

    def fake_export(*args, **kwargs):
        seen.append(kwargs.get("page_box"))
        return {
            "width": 2, "height": 2, "cmyk": bytes(2 * 2 * 4),
            "ink_unsound": False, "degraded": False,
        }

    monkeypatch.setattr("app.core.print_engine.facade.export_cmyk", fake_export)
    files = render_pdf_to_images(
        src, str(tmp_path / "out"), fmt="tiff", color_mode="cmyk",
        include_bleed=include_bleed,
    )
    assert seen == [expected_box]
    assert _is_image(files[0], "tiff")


def test_rgb_include_bleed_selects_media_or_trim_box(tmp_path):
    """RE-AUDIT §RA-01: RGB phải render đúng kích thước MediaBox/TrimBox."""
    import pikepdf
    from PIL import Image

    src = _make_pdf(tmp_path, 1)
    with pikepdf.open(src, allow_overwriting_input=True) as pdf:
        page = pdf.pages[0]
        page.MediaBox = [0, 0, 200, 200]
        page.CropBox = [20, 20, 180, 180]
        page.TrimBox = [50, 60, 150, 140]
        pdf.save(src)

    media_file = render_pdf_to_images(src, str(tmp_path / "media"), dpi=72, include_bleed=True)[0]
    trim_file = render_pdf_to_images(src, str(tmp_path / "trim"), dpi=72, include_bleed=False)[0]
    with Image.open(media_file) as media, Image.open(trim_file) as trim:
        assert media.size == (200, 200)
        assert trim.size == (100, 80)


def test_rgb_export_applies_user_unit(tmp_path):
    """EXPORT (audit 2026-09-08 §EXIMG-02): DPI phải là DPI vật lý."""
    import pikepdf
    from PIL import Image

    src = _make_pdf(tmp_path, 1, width=100, height=50)
    with pikepdf.open(src, allow_overwriting_input=True) as pdf:
        pdf.pages[0]["/UserUnit"] = 2
        pdf.save(src)

    files = render_pdf_to_images(src, str(tmp_path / "out"), fmt="png", dpi=72)
    with Image.open(files[0]) as image:
        assert image.size == (200, 100)


def test_export_memory_estimate_scales_with_user_unit(tmp_path):
    """EXPORT (audit 2026-09-08 §EXIMG-03): reservation tính theo pixel vật lý."""
    import pikepdf

    src = _make_pdf(tmp_path, 1, width=5000, height=5000)
    with pikepdf.open(src, allow_overwriting_input=True) as pdf:
        pdf.pages[0]["/UserUnit"] = 2
        pdf.save(src)

    estimated = export_route._estimate_export_peak_mb(
        src, dpi=1200, color_mode="rgb", pages=None, include_bleed=True,
    )
    assert estimated > 100_000


def test_batch_rolls_back_files_from_previous_jobs(tmp_path, monkeypatch):
    """RE-AUDIT §RA-06: job sau lỗi thì file của job trước cũng phải bị xóa."""
    written = tmp_path / "first.png"
    calls = 0

    def fake_render(**kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            written.write_bytes(b"image")
            return [str(written)]
        raise ValueError("job thứ hai lỗi")

    monkeypatch.setattr(export_route, "render_pdf_to_images", fake_render)
    jobs = [
        ExportImageBatchJob(output_dir=str(tmp_path), format="png", dpi=150),
        ExportImageBatchJob(output_dir=str(tmp_path), format="jpeg", dpi=300),
    ]

    with pytest.raises(ValueError, match="job thứ hai lỗi"):
        export_route._render_image_batch(
            "source.pdf", jobs, "rgb", None, True, threading.Event()
        )

    assert not written.exists()


def test_batch_schema_rejects_invalid_job_before_render():
    """RE-AUDIT §RA-06: DPI sai ở bất kỳ hàng nào làm hỏng cả request từ đầu."""
    with pytest.raises(Exception):
        ExportImagesBatchRequest(
            file_path="source.pdf",
            jobs=[
                {"output_dir": "out", "format": "png", "dpi": 150},
                {"output_dir": "out", "format": "png", "dpi": 1201},
            ],
        )


def test_batch_schema_limits_number_of_jobs():
    with pytest.raises(Exception):
        ExportImagesBatchRequest(
            file_path="source.pdf",
            jobs=[{"output_dir": "out", "format": "png", "dpi": 150}] * 9,
        )
