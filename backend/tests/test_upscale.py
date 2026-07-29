"""Hồi quy hợp đồng kích thước của công cụ Upscale."""

from __future__ import annotations

from io import BytesIO

from fastapi.testclient import TestClient
from PIL import Image

from app.main import app


def _png_bytes(size: tuple[int, int] = (7, 5)) -> bytes:
    buffer = BytesIO()
    Image.new("RGB", size, (80, 120, 160)).save(buffer, format="PNG")
    return buffer.getvalue()


def _encoded_image(
    mode: str,
    size: tuple[int, int],
    image_format: str,
    **save_kwargs,
) -> bytes:
    buffer = BytesIO()
    color = (20, 40, 60, 180) if mode == "RGBA" else (20, 40, 60)
    Image.new(mode, size, color).save(buffer, format=image_format, **save_kwargs)
    return buffer.getvalue()

def _fake_upscale(image: Image.Image, variant: str = "general") -> Image.Image:
    del variant
    return image.resize((image.width * 4, image.height * 4), Image.Resampling.NEAREST)


def test_upscale_returns_exact_requested_factor(monkeypatch):
    monkeypatch.setattr("app.workers.realesrgan_engine.upscale", _fake_upscale)
    monkeypatch.setattr("app.api.routes.pdf_tools._validate_upscale_memory", lambda _w, _h: None)

    with TestClient(app) as client:
        for factor, expected in ((2, (14, 10)), (4, (28, 20))):
            response = client.post(
                "/api/pdf-tools/upscale",
                files={"file": ("anh.mau.png", _png_bytes(), "image/png")},
                data={"engine": "general", "scale_factor": str(factor)},
            )
            assert response.status_code == 200, response.text
            with Image.open(BytesIO(response.content)) as result:
                assert result.size == expected


def test_upscale_rejects_unknown_factor_before_inference(monkeypatch):
    called = False

    def _must_not_run(*_args, **_kwargs):
        nonlocal called
        called = True
        raise AssertionError("Không được chạy model với hệ số sai")

    monkeypatch.setattr("app.workers.realesrgan_engine.upscale", _must_not_run)
    with TestClient(app) as client:
        response = client.post(
            "/api/pdf-tools/upscale",
            files={"file": ("anh.png", _png_bytes(), "image/png")},
            data={"scale_factor": "3"},
        )

    assert response.status_code == 400
    assert "×2 hoặc ×4" in response.json()["detail"]
    assert called is False


def test_memory_guard_reports_instead_of_silently_resizing(monkeypatch):
    monkeypatch.setattr(
        "app.core.system_memory.read_memory_status_mb",
        lambda: (8 * 1024.0, 2 * 1024.0),
    )
    from app.api.routes.pdf_tools import _validate_upscale_memory

    try:
        _validate_upscale_memory(8000, 8000)
    except Exception as exc:
        assert getattr(exc, "status_code", None) == 422
        assert "8000×8000" in getattr(exc, "detail", "")
    else:
        raise AssertionError("Ảnh vượt RAM phải bị từ chối minh bạch")


def test_upscale_normalizes_exif_orientation(monkeypatch):
    monkeypatch.setattr("app.workers.realesrgan_engine.upscale", _fake_upscale)
    monkeypatch.setattr("app.api.routes.pdf_tools._validate_upscale_memory", lambda _w, _h: None)
    exif = Image.Exif()
    exif[274] = 6

    with TestClient(app) as client:
        response = client.post(
            "/api/pdf-tools/upscale",
            files={"file": ("xoay.jpg", _encoded_image("RGB", (3, 2), "JPEG", exif=exif), "image/jpeg")},
            data={"scale_factor": "2"},
        )

    assert response.status_code == 200, response.text
    with Image.open(BytesIO(response.content)) as result:
        assert result.size == (4, 6)


def test_upscale_preserves_rgba_icc_and_dpi(monkeypatch):
    monkeypatch.setattr("app.workers.realesrgan_engine.upscale", _fake_upscale)
    monkeypatch.setattr("app.api.routes.pdf_tools._validate_upscale_memory", lambda _w, _h: None)
    icc = b"prynx-test-icc-profile"

    with TestClient(app) as client:
        response = client.post(
            "/api/pdf-tools/upscale",
            files={"file": ("mau.png", _encoded_image("RGBA", (4, 3), "PNG", icc_profile=icc, dpi=(300, 300)), "image/png")},
            data={"scale_factor": "2"},
        )

    assert response.status_code == 200, response.text
    assert response.headers["X-Upscale-Output-Size"] == "8x6"
    with Image.open(BytesIO(response.content)) as result:
        assert result.mode == "RGBA"
        assert result.info.get("icc_profile") == icc
        assert abs(result.info["dpi"][0] - 300) < 1


def test_upscale_warns_when_cmyk_is_converted(monkeypatch):
    monkeypatch.setattr("app.workers.realesrgan_engine.upscale", _fake_upscale)
    monkeypatch.setattr("app.api.routes.pdf_tools._validate_upscale_memory", lambda _w, _h: None)

    with TestClient(app) as client:
        response = client.post(
            "/api/pdf-tools/upscale",
            files={"file": ("cmyk.jpg", _encoded_image("CMYK", (4, 3), "JPEG"), "image/jpeg")},
            data={"scale_factor": "2"},
        )

    assert response.status_code == 200, response.text
    assert "color-converted-to-srgb" in response.headers["X-Upscale-Warnings"]
    with Image.open(BytesIO(response.content)) as result:
        assert result.mode == "RGB"

def test_upscale_tile_only_reduces_on_low_memory(monkeypatch):
    from app.workers.realesrgan_engine import _default_tile_size

    monkeypatch.delenv("PRYNX_UPSCALE_TILE", raising=False)
    monkeypatch.setattr("app.core.system_memory.read_memory_status_mb", lambda: (6 * 1024, 4 * 1024))
    assert _default_tile_size() == 256
    monkeypatch.setattr("app.core.system_memory.read_memory_status_mb", lambda: (12 * 1024, 8 * 1024))
    assert _default_tile_size() == 384
    monkeypatch.setattr("app.core.system_memory.read_memory_status_mb", lambda: (32 * 1024, 24 * 1024))
    assert _default_tile_size() == 512

    monkeypatch.setenv("PRYNX_UPSCALE_TILE", "640")
    assert _default_tile_size() == 640


def test_upscale_routes_quality_model(monkeypatch):
    variants: list[str] = []

    def _capture(image: Image.Image, variant: str = "general") -> Image.Image:
        variants.append(variant)
        return image.resize((image.width * 4, image.height * 4), Image.Resampling.NEAREST)

    monkeypatch.setattr("app.workers.realesrgan_engine.upscale", _capture)
    monkeypatch.setattr("app.api.routes.pdf_tools._validate_upscale_memory", lambda _w, _h: None)
    with TestClient(app) as client:
        response = client.post(
            "/api/pdf-tools/upscale",
            files={"file": ("anh.png", _png_bytes(), "image/png")},
            data={"engine": "quality", "scale_factor": "2"},
        )

    assert response.status_code == 200, response.text
    assert variants == ["quality"]

def test_quality_model_does_not_fall_back_silently_to_cpu(monkeypatch):
    from app.workers import realesrgan_engine as engine

    class _FailingGpuSession:
        def get_inputs(self):
            return [type("Input", (), {"name": "input"})()]

        def get_providers(self):
            return ["DmlExecutionProvider", "CPUExecutionProvider"]

        def run(self, *_args, **_kwargs):
            raise RuntimeError("GPU OOM")

    monkeypatch.setattr(engine, "_force_cpu_by_env", False)
    monkeypatch.setattr(engine, "_get_session", lambda _variant: _FailingGpuSession())
    monkeypatch.setattr(
        engine,
        "_switch_to_cpu",
        lambda _variant: (_ for _ in ()).throw(AssertionError("Không được rơi về CPU")),
    )

    tile = __import__("numpy").zeros((1, 3, 8, 8), dtype="float32")
    try:
        engine._run_session("quality", tile)
    except RuntimeError as exc:
        assert "chế độ Nhanh" in str(exc)
    else:
        raise AssertionError("GPU lỗi phải được báo ngay cho chế độ Chất lượng")


def test_quality_model_rejects_implicit_cpu_session(monkeypatch):
    from app.workers import realesrgan_engine as engine

    class _CpuSession:
        def get_inputs(self):
            return [type("Input", (), {"name": "input"})()]

        def get_providers(self):
            return ["CPUExecutionProvider"]

    monkeypatch.setattr(engine, "_force_cpu_by_env", False)
    monkeypatch.setattr(engine, "_get_session", lambda _variant: _CpuSession())
    tile = __import__("numpy").zeros((1, 3, 8, 8), dtype="float32")

    try:
        engine._run_session("quality", tile)
    except RuntimeError as exc:
        assert "cần GPU" in str(exc)
    else:
        raise AssertionError("Không được chạy RRDBNet âm thầm trên CPU")

def test_upscale_routes_balanced_without_quality_model(monkeypatch):
    variants: list[str] = []

    def _capture(image: Image.Image, variant: str = "general") -> Image.Image:
        variants.append(variant)
        return image.resize((image.width * 4, image.height * 4), Image.Resampling.NEAREST)

    monkeypatch.setattr("app.workers.realesrgan_engine.upscale", _capture)
    monkeypatch.setattr("app.api.routes.pdf_tools._validate_upscale_memory", lambda _w, _h: None)
    with TestClient(app) as client:
        response = client.post(
            "/api/pdf-tools/upscale",
            files={"file": ("anh.png", _png_bytes(), "image/png")},
            data={"engine": "balanced", "scale_factor": "2"},
        )

    assert response.status_code == 200, response.text
    assert variants == ["balanced"]


def test_balanced_mode_preserves_more_source_texture(monkeypatch):
    from app.workers import realesrgan_engine as engine

    np = __import__("numpy")
    monkeypatch.setattr(
        engine,
        "_upscale_rgb",
        lambda rgb, *_args: np.full(
            (rgb.shape[0] * 4, rgb.shape[1] * 4, 3),
            0.5,
            dtype="float32",
        ),
    )
    source = Image.new("RGB", (8, 8), "black")
    for x in range(0, 8, 2):
        for y in range(8):
            source.putpixel((x, y), (255, 255, 255))

    fast = engine.upscale(source, variant="general", tile=0)
    balanced = engine.upscale(source, variant="balanced", tile=0)

    assert np.asarray(balanced).std() > np.asarray(fast).std()
