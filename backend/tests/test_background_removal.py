"""Hồi quy hợp đồng ảnh in của công cụ Tách nền."""

from __future__ import annotations

from io import BytesIO

from fastapi.testclient import TestClient
from PIL import Image, ImageCms

from app.main import app


def _encoded_image(image_format: str, *, size=(7, 5), mode="RGB", **save_kwargs) -> bytes:
    buffer = BytesIO()
    color = (30, 90, 150, 180) if mode == "RGBA" else (30, 90, 150)
    Image.new(mode, size, color).save(buffer, format=image_format, **save_kwargs)
    return buffer.getvalue()


def _fake_remove(image: Image.Image) -> Image.Image:
    return image.convert("RGBA")


def test_tiff_and_bmp_upload_contract(monkeypatch):
    monkeypatch.setattr("app.workers.isnet_engine.remove_background", _fake_remove)
    monkeypatch.setattr(
        "app.api.routes.pdf_tools._plan_background_work_size",
        lambda width, height: ((width, height), []),
    )

    with TestClient(app) as client:
        for filename, image_format, mime in (
            ("anh.tiff", "TIFF", "image/tiff"),
            ("anh.bmp", "BMP", "image/bmp"),
        ):
            response = client.post(
                "/api/pdf-tools/remove-background",
                files={"file": (filename, _encoded_image(image_format), mime)},
                data={"engine": "fast"},
            )
            assert response.status_code == 200, response.text
            with Image.open(BytesIO(response.content)) as result:
                assert result.size == (7, 5)
                assert result.mode == "RGBA"


def test_exif_orientation_is_applied_before_inference(monkeypatch):
    monkeypatch.setattr("app.workers.isnet_engine.remove_background", _fake_remove)
    monkeypatch.setattr(
        "app.api.routes.pdf_tools._plan_background_work_size",
        lambda width, height: ((width, height), []),
    )
    exif = Image.Exif()
    exif[274] = 6
    source = _encoded_image("JPEG", size=(5, 3), exif=exif)

    with TestClient(app) as client:
        response = client.post(
            "/api/pdf-tools/remove-background",
            files={"file": ("xoay.jpg", source, "image/jpeg")},
            data={"engine": "fast"},
        )

    assert response.status_code == 200, response.text
    with Image.open(BytesIO(response.content)) as result:
        assert result.size == (3, 5)


def test_output_preserves_dpi_and_has_valid_rgb_profile(monkeypatch):
    monkeypatch.setattr("app.workers.isnet_engine.remove_background", _fake_remove)
    monkeypatch.setattr(
        "app.api.routes.pdf_tools._plan_background_work_size",
        lambda width, height: ((width, height), []),
    )
    profile = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
    source = _encoded_image("PNG", dpi=(300, 300), icc_profile=profile)

    with TestClient(app) as client:
        response = client.post(
            "/api/pdf-tools/remove-background",
            files={"file": ("in.png", source, "image/png")},
            data={"engine": "fast"},
        )

    assert response.status_code == 200, response.text
    assert "color-converted-to-srgb" in response.headers["X-Bg-Removal-Warnings"]
    with Image.open(BytesIO(response.content)) as result:
        assert result.info.get("icc_profile")
        assert abs(result.info["dpi"][0] - 300) < 1


def test_existing_source_alpha_is_not_revived():
    from app.workers.image_postprocessor import refine_foreground_rgba

    source = Image.new("RGBA", (2, 1), (200, 100, 50, 255))
    source.putpixel((0, 0), (200, 100, 50, 0))
    result = refine_foreground_rgba(source, Image.new("L", source.size, 255), r=1)

    assert result.getpixel((0, 0))[3] == 0
    assert result.getpixel((1, 0))[3] == 255


def test_ram_plan_only_downscales_below_16_gb(monkeypatch):
    from app.api.routes.pdf_tools import _plan_background_work_size

    monkeypatch.setattr(
        "app.core.system_memory.read_memory_status_mb",
        lambda: (8 * 1024.0, 1500.0),
    )
    reduced, warnings = _plan_background_work_size(8000, 8000)
    assert reduced[0] < 8000
    assert warnings == ["resolution-reduced"]

    monkeypatch.setattr(
        "app.core.system_memory.read_memory_status_mb",
        lambda: (32 * 1024.0, 24 * 1024.0),
    )
    assert _plan_background_work_size(8000, 8000) == ((8000, 8000), [])
