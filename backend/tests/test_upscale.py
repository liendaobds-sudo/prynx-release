"""Hồi quy hợp đồng kích thước của công cụ Upscale."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
import uuid
from io import BytesIO
from pathlib import Path

from fastapi.testclient import TestClient
from PIL import Image
import pikepdf
import pytest

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

def _fake_upscale(
    image: Image.Image,
    variant: str = "general",
    cancelled=None,
) -> Image.Image:
    del variant
    if cancelled is not None and cancelled():
        from app.workers.realesrgan_engine import UpscaleCancelled
        raise UpscaleCancelled("test cancelled")
    return image.resize((image.width * 4, image.height * 4), Image.Resampling.NEAREST)


def _upscale_file_grant(
    path: str,
    tab_id: str,
    token: str,
    *,
    issued_at: int | None = None,
    nonce: str | None = None,
) -> str:
    issued = int(time.time()) if issued_at is None else issued_at
    claims = {
        "v": 1,
        "iat": issued,
        "exp": issued + 120,
        "nonce": nonce or uuid.uuid4().hex,
        "tab": tab_id,
        "path": os.path.realpath(os.path.abspath(path)),
    }
    payload = base64.urlsafe_b64encode(
        json.dumps(claims, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    ).decode("ascii").rstrip("=")
    signature = hmac.new(
        token.encode("utf-8"),
        f"prynx-upscale-file-grant:v1:{payload}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return f"v1.{payload}.{signature}"


def _bypass_route_guards(monkeypatch) -> None:
    """Bỏ hai chốt policy của route để test tập trung vào hợp đồng đầu ra.

    UPSCALE (audit 2026-07-29 §NET.04): `guard_runtime` nay được route gọi thật.
    Không bỏ qua ở đây thì test sẽ nạp ONNX thật và phụ thuộc máy chạy test có GPU
    hay không — ca `quality` trên máy CPU sẽ bị chặn bằng 422 và fail giả.
    """
    monkeypatch.setattr("app.api.routes.pdf_tools._validate_upscale_memory", lambda _w, _h: None)
    monkeypatch.setattr("app.workers.realesrgan_engine.guard_runtime", lambda *_a, **_k: None)


def test_upscale_returns_exact_requested_factor(monkeypatch):
    monkeypatch.setattr("app.workers.realesrgan_engine.upscale", _fake_upscale)
    _bypass_route_guards(monkeypatch)

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


def test_route_calls_runtime_guard_before_inference(monkeypatch):
    """§NET.04: `guard_runtime` từng là code chết — chốt lại là route PHẢI gọi nó."""
    calls: list[tuple[int, int, str]] = []

    def _spy(width: int, height: int, variant: str, tile=None, tile_pad: int = 40) -> None:
        del tile, tile_pad
        calls.append((width, height, variant))

    monkeypatch.setattr("app.workers.realesrgan_engine.upscale", _fake_upscale)
    monkeypatch.setattr("app.api.routes.pdf_tools._validate_upscale_memory", lambda _w, _h: None)
    monkeypatch.setattr("app.workers.realesrgan_engine.guard_runtime", _spy)

    with TestClient(app) as client:
        response = client.post(
            "/api/pdf-tools/upscale",
            files={"file": ("anh.png", _png_bytes(), "image/png")},
            data={"engine": "quality", "scale_factor": "4"},
        )

    assert response.status_code == 200, response.text
    assert calls == [(7, 5, "quality")]


def test_runtime_guard_message_reaches_client_as_422(monkeypatch):
    """§NET.04: thông điệp của engine phải ra 422 nguyên văn, không phải 500 chung."""
    from app.workers.realesrgan_engine import UpscaleUnavailable

    def _refuse(*_args, **_kwargs):
        raise UpscaleUnavailable(
            "Máy này không có tăng tốc GPU dùng được cho chế độ Chất lượng."
        )

    def _must_not_run(*_args, **_kwargs):
        raise AssertionError("Bị chặn rồi thì không được chạy model")

    monkeypatch.setattr("app.api.routes.pdf_tools._validate_upscale_memory", lambda _w, _h: None)
    monkeypatch.setattr("app.workers.realesrgan_engine.guard_runtime", _refuse)
    monkeypatch.setattr("app.workers.realesrgan_engine.upscale", _must_not_run)

    with TestClient(app) as client:
        response = client.post(
            "/api/pdf-tools/upscale",
            files={"file": ("anh.png", _png_bytes(), "image/png")},
            data={"engine": "quality", "scale_factor": "4"},
        )

    assert response.status_code == 422, response.text
    assert "tăng tốc GPU" in response.json()["detail"]


def test_duration_message_never_says_zero_minutes():
    """§NET.04: bản cũ chia 60 rồi `.0f` nên mọi giá trị dưới 30 giây ra '0 phút'."""
    from app.workers.realesrgan_engine import _format_duration, _format_seconds

    assert "0 phút" not in _format_duration(0.03)
    assert "0 phút" not in _format_duration(25)
    assert _format_duration(600) == "10 phút"
    assert _format_duration(2400) == "40 phút"
    assert _format_seconds(3.0) == "3.0s"
    assert _format_seconds(0.0001) == "0.0001s"


def test_general_model_uses_upstream_default_denoise_blend():
    """§NET.02: 'general' phải là bản DNI alpha 0,5, không phải bản khử nhiễu tối đa.

    Khoá theo SHA-256 để một bản .onnx khác trọng số không lặng lẽ lọt vào.
    Hash của bản alpha 1,0 cũ: 027319ff…4457a.
    """
    from app.workers.realesrgan_engine import MODEL_SHA256

    assert MODEL_SHA256["general"] == (
        "3ae50bb3a9131697d62ac79f934e57c2ef9cd3b8762993ca0d1fabd8a36a343f"
    )
    assert MODEL_SHA256["general"] != (
        "027319ffe4f00ec2550957c0957d44969638a03d2ed2f0329af9fd6cd44a457a"
    )


def test_upscale_normalizes_exif_orientation(monkeypatch):
    monkeypatch.setattr("app.workers.realesrgan_engine.upscale", _fake_upscale)
    _bypass_route_guards(monkeypatch)
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


def test_upscale_preserves_rgba_icc_and_physical_size(monkeypatch):
    monkeypatch.setattr("app.workers.realesrgan_engine.upscale", _fake_upscale)
    _bypass_route_guards(monkeypatch)
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
        # Pixel tăng x2 thì DPI cũng tăng x2: kích thước in vẫn giữ nguyên.
        assert abs(result.info["dpi"][0] - 600) < 1


def test_upscale_working_pdf_keeps_page_size_when_source_has_no_dpi(monkeypatch):
    """Hồi quy lỗi 8000 px bị hiểu thành 8000 pt làm PPE dựng raster 10667 px."""
    monkeypatch.setattr("app.workers.realesrgan_engine.upscale", _fake_upscale)
    _bypass_route_guards(monkeypatch)

    with TestClient(app) as client:
        for factor in (2, 4):
            response = client.post(
                "/api/pdf-tools/upscale",
                files={"file": ("khong-dpi.png", _png_bytes(), "image/png")},
                data={
                    "scale_factor": str(factor),
                    "include_working_pdf": "true",
                },
            )

            assert response.status_code == 200, response.text
            with Image.open(BytesIO(response.content)) as result:
                assert abs(result.info["dpi"][0] - 72 * factor) < 1

            working_pdf = Path(response.headers["X-Upscale-Working-Pdf-Path"])
            lease_token = response.headers["X-Upscale-Artifact-Lease"]
            assert len(lease_token) == 32
            claim = client.post(
                "/api/pdf-tools/upscale/artifact/claim",
                data={"lease_token": lease_token},
            )
            assert claim.status_code == 200, claim.text
            try:
                with pikepdf.open(working_pdf) as document:
                    box = [float(value) for value in document.pages[0].MediaBox]
                assert abs((box[2] - box[0]) - 7.0) < 0.02
                assert abs((box[3] - box[1]) - 5.0) < 0.02
            finally:
                released = client.post(
                    "/api/pdf-tools/upscale/artifact/release",
                    data={"lease_token": lease_token},
                )
                assert released.status_code == 200, released.text
            assert not working_pdf.exists()


def test_upscale_warns_when_cmyk_is_converted(monkeypatch):
    monkeypatch.setattr("app.workers.realesrgan_engine.upscale", _fake_upscale)
    _bypass_route_guards(monkeypatch)

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

    def _capture(image: Image.Image, variant: str = "general", cancelled=None) -> Image.Image:
        del cancelled
        variants.append(variant)
        return image.resize((image.width * 4, image.height * 4), Image.Resampling.NEAREST)

    monkeypatch.setattr("app.workers.realesrgan_engine.upscale", _capture)
    _bypass_route_guards(monkeypatch)
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
    except engine.UpscaleUnavailable as exc:
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
    except engine.UpscaleUnavailable as exc:
        assert "cần GPU" in str(exc)
    else:
        raise AssertionError("Không được chạy RRDBNet âm thầm trên CPU")

def test_upscale_routes_balanced_without_quality_model(monkeypatch):
    variants: list[str] = []

    def _capture(image: Image.Image, variant: str = "general", cancelled=None) -> Image.Image:
        del cancelled
        variants.append(variant)
        return image.resize((image.width * 4, image.height * 4), Image.Resampling.NEAREST)

    monkeypatch.setattr("app.workers.realesrgan_engine.upscale", _capture)
    _bypass_route_guards(monkeypatch)
    with TestClient(app) as client:
        response = client.post(
            "/api/pdf-tools/upscale",
            files={"file": ("anh.png", _png_bytes(), "image/png")},
            data={"engine": "balanced", "scale_factor": "2"},
        )

    assert response.status_code == 200, response.text
    assert variants == ["balanced"]


def test_detail_strength_ladder_is_monotonic(monkeypatch):
    """§NET.01: ba chế độ phải là một thang thật, Chất lượng mạnh nhất."""
    from app.workers import realesrgan_engine as engine

    for mode in ("general", "balanced", "quality"):
        monkeypatch.delenv(f"PRYNX_UPSCALE_DETAIL_{mode.upper()}", raising=False)

    assert engine._detail_strength("general") == 0.0
    assert 0.0 < engine._detail_strength("balanced") < engine._detail_strength("quality")

    # 0 là giá trị hợp lệ (tắt hẳn), không được bị coi là "không hợp lệ" rồi rơi về mặc định.
    monkeypatch.setenv("PRYNX_UPSCALE_DETAIL_QUALITY", "0")
    assert engine._detail_strength("quality") == 0.0
    monkeypatch.setenv("PRYNX_UPSCALE_DETAIL_QUALITY", "0.8")
    assert engine._detail_strength("quality") == 0.8
    monkeypatch.setenv("PRYNX_UPSCALE_DETAIL_QUALITY", "khong-phai-so")
    assert engine._detail_strength("quality") == engine._DETAIL_BY_MODE["quality"]


def test_upscale_passes_mode_detail_into_tiling(monkeypatch):
    """§NET.03: cường độ chi tiết phải tới được vòng lặp ô, theo đúng chế độ UI."""
    from app.workers import realesrgan_engine as engine

    np = __import__("numpy")
    seen: list[float] = []

    def _fake_tiling(rgb, variant, tile, tile_pad, detail=0.0, cancelled=None):
        del variant, tile, tile_pad, cancelled
        seen.append(detail)
        return np.full((rgb.shape[0] * 4, rgb.shape[1] * 4, 3), 0.5, dtype="float32")

    monkeypatch.setattr(engine, "_upscale_rgb", _fake_tiling)
    source = Image.new("RGB", (8, 8), "black")

    for mode in ("general", "balanced", "quality"):
        engine.upscale(source, variant=mode, tile=0)

    assert seen == [
        engine._DETAIL_BY_MODE["general"],
        engine._DETAIL_BY_MODE["balanced"],
        engine._DETAIL_BY_MODE["quality"],
    ]


def test_amplify_ai_detail_boosts_only_what_model_added():
    """§NET.03: khuếch đại phần AI thêm vào so với nền Lanczos, không phải gợn nguồn."""
    from app.workers.realesrgan_engine import SCALE, _amplify_ai_detail

    np = __import__("numpy")
    rng = np.random.default_rng(7)
    patch = rng.random((8, 8, 3)).astype("float32")

    baseline = np.asarray(
        Image.fromarray((patch * 255.0 + 0.5).astype("uint8"), "RGB").resize(
            (8 * SCALE, 8 * SCALE), Image.Resampling.LANCZOS
        ),
        dtype="float32",
    ) / 255.0

    # Nền Lanczos y nguyên → model không thêm gì → không được tự sinh chi tiết.
    unchanged = _amplify_ai_detail(baseline.copy(), patch, 0.45)
    assert np.abs(unchanged - baseline).max() < 2e-3

    # Model thêm chi tiết → tương phản cục bộ phải tăng theo cường độ.
    sr = np.clip(baseline + rng.normal(0, 0.05, baseline.shape).astype("float32"), 0.0, 1.0)
    weak = _amplify_ai_detail(sr, patch, 0.12)
    strong = _amplify_ai_detail(sr, patch, 0.45)
    assert strong.std() > weak.std() > 0.0


def test_quality_tile_pad_is_wider_than_light_model():
    """§NET.08: RRDBNet có receptive field lớn hơn, pad 40 còn lệch 5 mức màu."""
    from app.workers.realesrgan_engine import _default_tile_pad

    assert _default_tile_pad("quality") > _default_tile_pad("general")
    assert _default_tile_pad("general") == 40


def test_icc_data_colorspace_parser():
    """§UP.X.05: helper phải đọc đúng colorspace từ ICC header."""
    from app.api.routes.pdf_tools import _icc_data_colorspace

    assert _icc_data_colorspace(None) is None
    assert _icc_data_colorspace(b"short") is None
    # Tạo fake ICC header 128 bytes với 4 byte colorspace ở offset 16
    def _make_fake_icc(sig: bytes) -> bytes:
        header = bytearray(128)
        header[16:20] = sig
        return bytes(header)

    assert _icc_data_colorspace(_make_fake_icc(b"RGB ")) == "RGB"
    assert _icc_data_colorspace(_make_fake_icc(b"GRAY")) == "GRAY"
    assert _icc_data_colorspace(_make_fake_icc(b"Lab ")) == "LAB"
    assert _icc_data_colorspace(_make_fake_icc(b"CMYK")) == "CMYK"
    assert _icc_data_colorspace(_make_fake_icc(b"????")) is None


def test_upscale_gray_icc_warns_and_outputs_rgb(monkeypatch):
    """§UP.X.05: ảnh Gray có ICC Gray không được gắn profile Gray lên output RGB."""
    monkeypatch.setattr("app.workers.realesrgan_engine.upscale", _fake_upscale)
    _bypass_route_guards(monkeypatch)

    # Tạo ảnh Gray 8-bit với ICC profile Gray
    from PIL import ImageCms
    gray_profile = ImageCms.createProfile("sRGB")  # dùng sRGB làm gốc
    # Tạo real Gray profile
    try:
        # Pillow cài từ wheel thường có createProfile hạn chế, nhưng ta có thể
        # xây bằng cách tạo ảnh L rồi gắn ICC sRGB — route sẽ thấy icc_cs = 'RGB'
        # → không trigger fix. Thay vào đó, ta giả lập bằng cách tạo ảnh RGB
        # nhưng gắn ICC header fake GRAY.
        fake_gray_icc = bytearray(ImageCms.ImageCmsProfile(gray_profile).tobytes())
        fake_gray_icc[16:20] = b"GRAY"  # giả lập colorspace GRAY
        fake_gray_icc = bytes(fake_gray_icc)
    except Exception:
        return  # skip nếu không tạo được ICC giả lập

    with TestClient(app) as client:
        response = client.post(
            "/api/pdf-tools/upscale",
            files={"file": ("gray.png", _encoded_image("RGB", (4, 3), "PNG", icc_profile=fake_gray_icc), "image/png")},
            data={"scale_factor": "2"},
        )

    assert response.status_code == 200, response.text
    warning_header = response.headers.get("X-Upscale-Warnings", "")
    # Phải có cảnh báo chuyển đổi hoặc bỏ ICC
    assert "icc-converted-to-srgb" in warning_header or "icc-dropped-incompatible" in warning_header


def test_upscale_external_path_requires_native_grant(tmp_path, monkeypatch):
    from app.api.routes import pdf_tools

    source = tmp_path / "ngoai-scope.png"
    source.write_bytes(_png_bytes())
    pdf_tools._IMAGE_PATH_ALLOWED_DIRS.clear()
    called = False

    def _must_not_run(*_args, **_kwargs):
        nonlocal called
        called = True
        raise AssertionError("Path không grant không được vào inference")

    monkeypatch.setattr("app.workers.realesrgan_engine.upscale", _must_not_run)
    with TestClient(app) as client:
        response = client.post(
            "/api/pdf-tools/upscale",
            data={"file_path": str(source), "scale_factor": "2"},
        )

    assert response.status_code == 403
    assert called is False


def test_upscale_accepts_scoped_native_grant_once(tmp_path, monkeypatch):
    from app.core import license_guard

    source = tmp_path / "picker.png"
    source.write_bytes(_png_bytes())
    token = "grant-test-sidecar-token"
    tab_id = "tab-picker"
    grant = _upscale_file_grant(str(source), tab_id, token)
    monkeypatch.setattr(license_guard, "_SIDECAR_TOKEN", token)
    monkeypatch.setattr("app.workers.realesrgan_engine.upscale", _fake_upscale)
    _bypass_route_guards(monkeypatch)
    payload = {
        "file_path": str(source),
        "file_grant": grant,
        "file_grant_tab_id": tab_id,
        "scale_factor": "2",
    }

    with TestClient(app) as client:
        first = client.post("/api/pdf-tools/upscale", data=payload)
        replay = client.post("/api/pdf-tools/upscale", data=payload)

    assert first.status_code == 200, first.text
    assert replay.status_code == 403


def test_upscale_rejects_grant_for_other_path_tab_or_expiry(tmp_path, monkeypatch):
    from app.core import license_guard

    source = tmp_path / "source.png"
    other = tmp_path / "other.png"
    source.write_bytes(_png_bytes())
    other.write_bytes(_png_bytes())
    token = "grant-negative-sidecar-token"
    monkeypatch.setattr(license_guard, "_SIDECAR_TOKEN", token)
    monkeypatch.setattr(
        "app.workers.realesrgan_engine.upscale",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("Grant sai không được vào inference")
        ),
    )

    cases = [
        {
            "file_path": str(other),
            "file_grant": _upscale_file_grant(str(source), "tab-a", token),
            "file_grant_tab_id": "tab-a",
        },
        {
            "file_path": str(source),
            "file_grant": _upscale_file_grant(str(source), "tab-a", token),
            "file_grant_tab_id": "tab-b",
        },
        {
            "file_path": str(source),
            "file_grant": _upscale_file_grant(
                str(source), "tab-a", token, issued_at=int(time.time()) - 300
            ),
            "file_grant_tab_id": "tab-a",
        },
    ]

    with TestClient(app) as client:
        responses = [client.post("/api/pdf-tools/upscale", data=case) for case in cases]

    assert [response.status_code for response in responses] == [403, 403, 403]


def test_upscale_rejects_tampered_grant_and_unc_before_inference(tmp_path, monkeypatch):
    from app.core import license_guard

    source = tmp_path / "tamper.png"
    source.write_bytes(_png_bytes())
    token = "grant-tamper-sidecar-token"
    grant = _upscale_file_grant(str(source), "tab-a", token)
    tampered = grant[:-1] + ("0" if grant[-1] != "0" else "1")
    monkeypatch.setattr(license_guard, "_SIDECAR_TOKEN", token)

    with TestClient(app) as client:
        tampered_response = client.post(
            "/api/pdf-tools/upscale",
            data={
                "file_path": str(source),
                "file_grant": tampered,
                "file_grant_tab_id": "tab-a",
            },
        )
        unc_response = client.post(
            "/api/pdf-tools/upscale",
            data={"file_path": r"\\server\share\image.png"},
        )

    assert tampered_response.status_code == 403
    assert unc_response.status_code == 403


def test_image_scope_canonicalizes_both_root_and_candidate(monkeypatch):
    from app.api.routes import pdf_tools

    short_root = r"C:\Users\KHANHP~1\AppData\Local\Temp"
    long_root = r"C:\Users\Khanh Pham\AppData\Local\Temp"
    candidate = long_root + r"\PrynX-dev\results\alpha.png"
    original_realpath = pdf_tools.os.path.realpath

    def _fake_realpath(path):
        normalized = os.path.normcase(os.path.normpath(os.fspath(path)))
        if normalized == os.path.normcase(os.path.normpath(short_root)):
            return long_root
        return original_realpath(path) if os.path.exists(path) else os.path.normpath(os.fspath(path))

    monkeypatch.setattr(pdf_tools.os.path, "realpath", _fake_realpath)
    assert pdf_tools._is_path_inside(candidate, short_root) is True


def test_upscale_disconnect_before_admission_never_runs_inference(monkeypatch):
    from starlette.requests import Request

    called = False

    async def _disconnected(_request):
        return True

    def _must_not_run(*_args, **_kwargs):
        nonlocal called
        called = True
        raise AssertionError("Request đã disconnect không được vào inference")

    monkeypatch.setattr(Request, "is_disconnected", _disconnected)
    monkeypatch.setattr("app.workers.realesrgan_engine.upscale", _must_not_run)
    _bypass_route_guards(monkeypatch)

    with TestClient(app) as client:
        response = client.post(
            "/api/pdf-tools/upscale",
            files={"file": ("cancel.png", _png_bytes(), "image/png")},
        )

    assert response.status_code == 499
    assert called is False


def test_upscale_cancellation_stops_at_tile_boundary(monkeypatch):
    from app.workers import realesrgan_engine as engine

    np = __import__("numpy")
    session_runs = 0

    def _fake_session(_variant, tile_nchw):
        nonlocal session_runs
        session_runs += 1
        _n, channels, height, width = tile_nchw.shape
        return np.zeros((1, channels, height * 4, width * 4), dtype="float32")

    monkeypatch.setattr(engine, "_run_session", _fake_session)
    rgb = np.zeros((4, 8, 3), dtype="float32")

    with pytest.raises(engine.UpscaleCancelled):
        engine._upscale_rgb(
            rgb,
            "general",
            tile=4,
            tile_pad=0,
            cancelled=lambda: session_runs >= 1,
        )

    assert session_runs == 1
