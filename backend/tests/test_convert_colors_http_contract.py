"""Regression cho hợp đồng HTTP của POST /api/preflight/convert-colors."""

import shutil
import zlib
from pathlib import Path

import pikepdf
import pytest
from fastapi.testclient import TestClient

from app.api.routes import preflight as preflight_routes
from app.config import settings
from app.core import icc_profiles, pdf_actions_native
from app.core.ink_manager import InkManagerEngine
from app.core.license_guard import require_license
from app.main import app


def _write_isolated_alpha_pdf(path: Path, icc_range=None) -> None:
    """Fixture PNG-like RGB+SMask cô lập để đi xuyên router thật."""
    pdf = pikepdf.Pdf.new()
    colorspace = pikepdf.Name("/DeviceRGB")
    if icc_range is not None:
        srgb = Path(__file__).parents[1] / "app/assets/icc/sRGB.icc"
        profile = pdf.make_stream(srgb.read_bytes())
        profile["/N"] = 3
        profile["/Range"] = pikepdf.Array(icc_range)
        colorspace = pdf.make_indirect(
            pikepdf.Array([pikepdf.Name("/ICCBased"), profile])
        )
    mask = pikepdf.Stream(
        pdf,
        zlib.compress(bytes([128])),
        Type=pikepdf.Name("/XObject"),
        Subtype=pikepdf.Name("/Image"),
        Width=1,
        Height=1,
        BitsPerComponent=8,
        ColorSpace=pikepdf.Name("/DeviceGray"),
        Filter=pikepdf.Name("/FlateDecode"),
    )
    image = pikepdf.Stream(
        pdf,
        zlib.compress(bytes([255, 0, 0])),
        Type=pikepdf.Name("/XObject"),
        Subtype=pikepdf.Name("/Image"),
        Width=1,
        Height=1,
        BitsPerComponent=8,
        ColorSpace=colorspace,
        SMask=pdf.make_indirect(mask),
        Filter=pikepdf.Name("/FlateDecode"),
    )
    page = pikepdf.Dictionary(
        Type=pikepdf.Name("/Page"),
        MediaBox=[0, 0, 100, 100],
        Resources=pikepdf.Dictionary(
            XObject=pikepdf.Dictionary(Im0=pdf.make_indirect(image))
        ),
        Contents=pdf.make_indirect(
            pikepdf.Stream(pdf, b"q 100 0 0 100 0 0 cm /Im0 Do Q\n")
        ),
    )
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    pdf.save(str(path))
    pdf.close()


def _write_simple_vector_alpha_pdf(path: Path, *, two_paints: bool = False) -> None:
    """Một fill vector alpha có thể chứng minh source-over trên giấy trắng."""
    pdf = pikepdf.Pdf.new()
    gs = pdf.make_indirect(pikepdf.Dictionary(ca=0.5, CA=0.5))
    content = b"/GS0 gs 1 0 0 rg 0 0 100 100 re f\n"
    if two_paints:
        content = (
            b"/GS0 gs 1 0 0 rg 0 0 50 100 re f "
            b"0 1 0 rg 50 0 50 100 re f\n"
        )
    page = pikepdf.Dictionary(
        Type=pikepdf.Name("/Page"),
        MediaBox=[0, 0, 100, 100],
        Resources=pikepdf.Dictionary(
            ExtGState=pikepdf.Dictionary(GS0=gs)
        ),
        Contents=pdf.make_indirect(pikepdf.Stream(pdf, content)),
    )
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    pdf.save(str(path))
    pdf.close()


def test_convert_colors_returns_log_list_and_downloadable_pdf(monkeypatch, tmp_path):
    """Response model phải giữ danh sách log và tên artifact tải được qua API."""
    source_pdf = tmp_path / "rgb-source.pdf"
    source_bytes = b"%PDF-1.4\n% RGB source for HTTP contract test\n%%EOF\n"
    source_pdf.write_bytes(source_bytes)
    results_dir = tmp_path / "results"

    monkeypatch.setattr(settings, "RESULTS_DIR", str(results_dir))
    monkeypatch.setattr(
        preflight_routes,
        "_get_file_path",
        lambda _file_id: str(source_pdf),
    )
    monkeypatch.setattr(
        icc_profiles,
        "resolve_cmyk_profile_path",
        lambda _profile_id=None: "test-destination.icc",
    )
    monkeypatch.setattr(
        icc_profiles,
        "resolve_srgb_profile_path",
        lambda: "test-source.icc",
    )

    captured_options = {}
    captured_profiles = []

    def fake_convert_to_cmyk(input_path, output_path, *profiles, **options):
        captured_profiles.extend(profiles)
        captured_options.update(options)
        Path(output_path).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(input_path, output_path)
        return {"supported": True, "operations": 1, "blockers": []}

    monkeypatch.setattr(pdf_actions_native, "convert_to_cmyk", fake_convert_to_cmyk)
    app.dependency_overrides[require_license] = lambda: {
        "license_key": "TEST",
        "hwid": "TEST",
        "verified": True,
        "plan": "pro",
        "features": ["*"],
    }

    try:
        client = TestClient(app, raise_server_exceptions=False)
        response = client.post(
            "/api/preflight/convert-colors",
            json={
                "file_id": "rgb-http-contract",
                "conversions": ["rgb_to_cmyk"],
                "icc_profile": "fogra39",
                "rendering_intent": "relative",
                "preserve_black": False,
                "black_point_compensation": False,
                "gamut_mapping": "adaptive_vivid",
                "adjustment_stage": "post_cmyk",
                "brightness_lstar": 3,
                "contrast_percent": -5,
                "vibrance_percent": 7,
            },
        )

        # COLOR (audit 2026-08-20 §COLOR.02): kiểm qua response_model thật để
        # không tái diễn ca engine tạo được file nhưng FastAPI trả HTTP 500.
        assert response.status_code == 200, response.text
        payload = response.json()
        assert payload["success"] is True
        assert payload["log"] == [
            {
                "action_id": "rgb_to_cmyk",
                "status": "success",
                "message": "RGB → CMYK (pikepdf, giữ spot)",
                "duration_ms": payload["log"][0]["duration_ms"],
            }
        ]
        assert isinstance(payload["log"][0]["duration_ms"], int)
        assert captured_options == {
            "rendering_intent": "relative",
            "preserve_black": False,
            "black_point_compensation": False,
            "gamut_mapping": "adaptive_vivid",
            "adjustment_stage": "post_cmyk",
            "brightness_lstar": 3,
            "contrast_percent": -5,
            "vibrance_percent": 7,
        }
        assert captured_profiles == ["test-destination.icc", "test-source.icc"]

        output_filename = payload["output_filename"]
        output_path = results_dir / "preflight_output" / output_filename
        assert output_path.is_file()

        download = client.get(f"/api/preflight/download/{output_filename}")
        assert download.status_code == 200, download.text
        assert download.headers["content-type"].startswith("application/pdf")
        assert output_filename in download.headers["content-disposition"]
        assert download.content == source_bytes
    finally:
        app.dependency_overrides.pop(require_license, None)


def test_convert_colors_spot_step_uses_selected_cmyk_profile(monkeypatch, tmp_path):
    """Màu pha Lab phải dùng cùng profile đích với bước RGB → CMYK."""

    source_pdf = tmp_path / "rgb-spot-source.pdf"
    source_pdf.write_bytes(b"%PDF-1.4\n% RGB + Spot profile contract\n%%EOF\n")
    results_dir = tmp_path / "results"
    selected_profile = "selected-swop.icc"
    captured_spot_profile: list[str | None] = []

    monkeypatch.setattr(settings, "RESULTS_DIR", str(results_dir))
    monkeypatch.setattr(
        preflight_routes,
        "_get_file_path",
        lambda _file_id: str(source_pdf),
    )
    monkeypatch.setattr(
        icc_profiles,
        "resolve_cmyk_profile_path",
        lambda _profile_id=None: selected_profile,
    )
    monkeypatch.setattr(
        icc_profiles,
        "resolve_srgb_profile_path",
        lambda: "test-source.icc",
    )

    def fake_convert_to_cmyk(input_path, output_path, *_profiles, **_options):
        Path(output_path).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(input_path, output_path)
        return {"supported": True, "operations": 1, "blockers": []}

    async def fake_convert_spot(
        self,
        file_path,
        spot_name=None,
        cmyk_profile=None,
    ):
        captured_spot_profile.append(cmyk_profile)
        output_path = self.output_dir / "spot-selected-profile.pdf"
        shutil.copyfile(file_path, output_path)
        return str(output_path)

    monkeypatch.setattr(pdf_actions_native, "convert_to_cmyk", fake_convert_to_cmyk)
    monkeypatch.setattr(InkManagerEngine, "convert_spot_to_cmyk", fake_convert_spot)
    app.dependency_overrides[require_license] = lambda: {
        "license_key": "TEST",
        "hwid": "TEST",
        "verified": True,
        "plan": "pro",
        "features": ["*"],
    }

    try:
        client = TestClient(app, raise_server_exceptions=False)
        response = client.post(
            "/api/preflight/convert-colors",
            json={
                "file_id": "rgb-spot-profile-contract",
                "conversions": ["rgb_to_cmyk", "spot_to_cmyk"],
                "icc_profile": "swop",
            },
        )

        assert response.status_code == 200, response.text
        payload = response.json()
        assert payload["success"] is True, payload
        assert captured_spot_profile == [selected_profile]
        assert payload["output_filename"] == "spot-selected-profile.pdf"
    finally:
        app.dependency_overrides.pop(require_license, None)


@pytest.mark.parametrize(
    "field,value",
    [
        ("brightness_lstar", 11),
        ("brightness_lstar", -11),
        ("contrast_percent", 21),
        ("vibrance_percent", -21),
        ("adjustment_stage", "after_cmyk"),
    ],
)
def test_convert_colors_rejects_adjustments_outside_safe_range(field, value):
    """API phải trả 422, không âm thầm clamp thanh chỉnh vượt miền an toàn."""
    app.dependency_overrides[require_license] = lambda: {
        "license_key": "TEST",
        "hwid": "TEST",
        "verified": True,
        "plan": "pro",
        "features": ["*"],
    }
    try:
        client = TestClient(app, raise_server_exceptions=False)
        response = client.post(
            "/api/preflight/convert-colors",
            json={
                "file_id": "must-not-reach-route",
                "conversions": ["rgb_to_cmyk"],
                field: value,
            },
        )
        assert response.status_code == 422, response.text
        assert any(field in str(item.get("loc")) for item in response.json()["detail"])
    finally:
        app.dependency_overrides.pop(require_license, None)


@pytest.mark.parametrize(
    "overrides",
    [
        {"gamut_mapping": "adaptive_vivid", "rendering_intent": "saturation"},
        {"gamut_mapping": "adaptive_vivid", "adjustment_stage": "pre_icc"},
    ],
)
def test_convert_colors_rejects_incompatible_adaptive_contract(overrides):
    """Adaptive mode is intentionally limited to Relative + post-CMYK."""

    app.dependency_overrides[require_license] = lambda: {
        "license_key": "TEST",
        "hwid": "TEST",
        "verified": True,
        "plan": "pro",
        "features": ["*"],
    }
    try:
        response = TestClient(app, raise_server_exceptions=False).post(
            "/api/preflight/convert-colors",
            json={
                "file_id": "must-not-reach-route",
                "conversions": ["rgb_to_cmyk"],
                **overrides,
            },
        )
        assert response.status_code == 422, response.text
        assert "adaptive_vivid" in response.text
    finally:
        app.dependency_overrides.pop(require_license, None)


def test_convert_colors_http_flattens_isolated_alpha_and_surfaces_warning(
    monkeypatch, tmp_path
):
    """HTTP thật phải công bố rõ khi ảnh alpha được flatten trên nền trắng."""
    source_pdf = tmp_path / "alpha-source.pdf"
    _write_isolated_alpha_pdf(source_pdf)
    results_dir = tmp_path / "results"
    monkeypatch.setattr(settings, "RESULTS_DIR", str(results_dir))
    monkeypatch.setattr(preflight_routes, "_get_file_path", lambda _file_id: str(source_pdf))
    monkeypatch.setattr(
        icc_profiles,
        "resolve_cmyk_profile_path",
        lambda _profile_id=None: str(Path(__file__).parents[1] / "app/assets/icc/FOGRA39.icc"),
    )
    monkeypatch.setattr(
        icc_profiles,
        "resolve_srgb_profile_path",
        lambda: str(Path(__file__).parents[1] / "app/assets/icc/sRGB.icc"),
    )
    app.dependency_overrides[require_license] = lambda: {
        "license_key": "TEST",
        "hwid": "TEST",
        "verified": True,
        "plan": "pro",
        "features": ["*"],
    }
    try:
        client = TestClient(app, raise_server_exceptions=False)
        response = client.post(
            "/api/preflight/convert-colors",
            json={
                "file_id": "isolated-alpha",
                "conversions": ["rgb_to_cmyk"],
                "icc_profile": "fogra39",
                "rendering_intent": "relative",
                "preserve_black": True,
                "black_point_compensation": True,
            },
        )
        assert response.status_code == 200, response.text
        payload = response.json()
        assert payload["success"] is True, payload
        assert "flatten" in payload["log"][0]["message"].lower()
        output = results_dir / "preflight_output" / payload["output_filename"]
        with pikepdf.open(str(output)) as opened:
            image = opened.pages[0].Resources.XObject.Im0
            assert str(image.ColorSpace) == "/DeviceCMYK"
            assert image.get("/SMask") is None
    finally:
        app.dependency_overrides.pop(require_license, None)


def test_convert_colors_http_flattens_simple_vector_alpha_and_rejects_overlap(
    monkeypatch, tmp_path
):
    """Lane vector alpha hẹp đi qua HTTP; nhiều paint vẫn fail-closed."""
    source_pdf = tmp_path / "vector-alpha-source.pdf"
    _write_simple_vector_alpha_pdf(source_pdf)
    results_dir = tmp_path / "results"
    monkeypatch.setattr(settings, "RESULTS_DIR", str(results_dir))
    monkeypatch.setattr(preflight_routes, "_get_file_path", lambda _file_id: str(source_pdf))
    monkeypatch.setattr(
        icc_profiles,
        "resolve_cmyk_profile_path",
        lambda _profile_id=None: str(Path(__file__).parents[1] / "app/assets/icc/FOGRA39.icc"),
    )
    monkeypatch.setattr(
        icc_profiles,
        "resolve_srgb_profile_path",
        lambda: str(Path(__file__).parents[1] / "app/assets/icc/sRGB.icc"),
    )
    app.dependency_overrides[require_license] = lambda: {
        "license_key": "TEST",
        "hwid": "TEST",
        "verified": True,
        "plan": "pro",
        "features": ["*"],
    }
    try:
        client = TestClient(app, raise_server_exceptions=False)
        body = {
            "file_id": "vector-alpha",
            "conversions": ["rgb_to_cmyk"],
            "icc_profile": "fogra39",
            "rendering_intent": "relative",
            "preserve_black": True,
            "black_point_compensation": True,
        }
        response = client.post("/api/preflight/convert-colors", json=body)
        assert response.status_code == 200, response.text
        payload = response.json()
        assert payload["success"] is True, payload
        assert "flatten 1" in payload["log"][0]["message"].lower()
        output = results_dir / "preflight_output" / payload["output_filename"]
        assert output.is_file()
        with pikepdf.open(str(output)) as opened:
            assert opened.pages[0].Resources.get("/ExtGState") is None
            assert b" k" in bytes(opened.pages[0].Contents.read_bytes())

        # Đổi source sang hai paint chồng/kề nhau; route phải trả business
        # failure và không để lại artifact đã stage.
        _write_simple_vector_alpha_pdf(source_pdf, two_paints=True)
        response = client.post("/api/preflight/convert-colors", json=body)
        assert response.status_code == 200, response.text
        payload = response.json()
        assert payload["success"] is False, payload
        assert payload["output_filename"] is None
        assert "LIVE_TRANSPARENCY_RGB" in payload["log"][-1]["message"]
        outputs = list((results_dir / "preflight_output").glob("*.pdf"))
        assert len(outputs) == 1, outputs
    finally:
        app.dependency_overrides.pop(require_license, None)


def test_convert_colors_http_rejects_nondefault_image_decode_without_artifact(
    monkeypatch, tmp_path
):
    """`/Decode` tùy biến phải thành business failure, không có file tải xuống."""
    base_pdf = tmp_path / "decode-base.pdf"
    source_pdf = tmp_path / "decode-source.pdf"
    _write_isolated_alpha_pdf(base_pdf)
    with pikepdf.open(base_pdf) as pdf:
        pdf.pages[0].Resources.XObject.Im0["/Decode"] = pikepdf.Array(
            [1, 0, 0, 1, 0, 1]
        )
        pdf.save(source_pdf)

    results_dir = tmp_path / "results"
    monkeypatch.setattr(settings, "RESULTS_DIR", str(results_dir))
    monkeypatch.setattr(preflight_routes, "_get_file_path", lambda _file_id: str(source_pdf))
    monkeypatch.setattr(
        icc_profiles,
        "resolve_cmyk_profile_path",
        lambda _profile_id=None: str(Path(__file__).parents[1] / "app/assets/icc/FOGRA39.icc"),
    )
    monkeypatch.setattr(
        icc_profiles,
        "resolve_srgb_profile_path",
        lambda: str(Path(__file__).parents[1] / "app/assets/icc/sRGB.icc"),
    )
    app.dependency_overrides[require_license] = lambda: {
        "license_key": "TEST",
        "hwid": "TEST",
        "verified": True,
        "plan": "pro",
        "features": ["*"],
    }
    try:
        client = TestClient(app, raise_server_exceptions=False)
        response = client.post(
            "/api/preflight/convert-colors",
            json={
                "file_id": "custom-decode",
                "conversions": ["rgb_to_cmyk"],
                "icc_profile": "fogra39",
                "rendering_intent": "relative",
                "preserve_black": True,
                "black_point_compensation": True,
            },
        )
        assert response.status_code == 200, response.text
        payload = response.json()
        assert payload["success"] is False, payload
        assert payload["output_filename"] is None
        assert "UNSUPPORTED_IMAGE_DECODE" in payload["log"][0]["message"]
        assert not list((results_dir / "preflight_output").glob("*.pdf"))
    finally:
        app.dependency_overrides.pop(require_license, None)


def test_convert_colors_http_rejects_custom_icc_range_without_artifact(
    monkeypatch, tmp_path
):
    """Range ICC tùy biến phải dừng trước alpha flatten và không có file tải."""
    source_pdf = tmp_path / "custom-range-source.pdf"
    _write_isolated_alpha_pdf(
        source_pdf,
        icc_range=[0.25, 0.75, 0.25, 0.75, 0.25, 0.75],
    )
    results_dir = tmp_path / "results"
    monkeypatch.setattr(settings, "RESULTS_DIR", str(results_dir))
    monkeypatch.setattr(preflight_routes, "_get_file_path", lambda _file_id: str(source_pdf))
    monkeypatch.setattr(
        icc_profiles,
        "resolve_cmyk_profile_path",
        lambda _profile_id=None: str(Path(__file__).parents[1] / "app/assets/icc/FOGRA39.icc"),
    )
    monkeypatch.setattr(
        icc_profiles,
        "resolve_srgb_profile_path",
        lambda: str(Path(__file__).parents[1] / "app/assets/icc/sRGB.icc"),
    )
    app.dependency_overrides[require_license] = lambda: {
        "license_key": "TEST",
        "hwid": "TEST",
        "verified": True,
        "plan": "pro",
        "features": ["*"],
    }
    try:
        client = TestClient(app, raise_server_exceptions=False)
        response = client.post(
            "/api/preflight/convert-colors",
            json={
                "file_id": "custom-icc-range",
                "conversions": ["rgb_to_cmyk"],
                "icc_profile": "fogra39",
                "rendering_intent": "relative",
                "preserve_black": True,
                "black_point_compensation": True,
            },
        )
        assert response.status_code == 200, response.text
        payload = response.json()
        assert payload["success"] is False, payload
        assert payload["output_filename"] is None
        assert "UNSUPPORTED_ICC_RANGE" in payload["log"][0]["message"]
        assert not list((results_dir / "preflight_output").glob("*.pdf"))
    finally:
        app.dependency_overrides.pop(require_license, None)


@pytest.mark.parametrize(
    "overrides",
    [
        {"conversions": []},
        {"conversions": ["not_a_conversion"]},
        {"conversions": ["rgb_to_cmyk", "rgb_to_cmyk"]},
        {"icc_profile": "unknown-profile"},
        {"rendering_intent": "unknown-intent"},
    ],
)
def test_convert_colors_rejects_invalid_request_contract(overrides):
    """Input sai phải dừng ở HTTP 422, không được trả thành công giả."""
    app.dependency_overrides[require_license] = lambda: {
        "license_key": "TEST",
        "hwid": "TEST",
        "verified": True,
        "plan": "pro",
        "features": ["*"],
    }
    try:
        client = TestClient(app, raise_server_exceptions=False)
        body = {
            "file_id": "invalid-contract",
            "conversions": ["rgb_to_cmyk"],
            "icc_profile": "fogra39",
            "rendering_intent": "relative",
        }
        body.update(overrides)
        response = client.post("/api/preflight/convert-colors", json=body)
        assert response.status_code == 422, response.text
    finally:
        app.dependency_overrides.pop(require_license, None)


def test_convert_colors_rejects_explicit_unavailable_profile(
    monkeypatch, tmp_path
):
    """Profile tường minh bị thiếu không được rơi ngầm về FOGRA39."""
    source_pdf = tmp_path / "source.pdf"
    source_pdf.write_bytes(b"%PDF-1.4\n%%EOF\n")
    converter_called = False

    monkeypatch.setattr(
        preflight_routes,
        "_get_file_path",
        lambda _file_id: str(source_pdf),
    )
    monkeypatch.setattr(
        icc_profiles,
        "resolve_cmyk_profile_path",
        lambda _profile_id=None: None,
    )

    def should_not_convert(*_args, **_kwargs):
        nonlocal converter_called
        converter_called = True
        raise AssertionError("converter không được chạy")

    monkeypatch.setattr(pdf_actions_native, "convert_to_cmyk", should_not_convert)
    app.dependency_overrides[require_license] = lambda: {
        "license_key": "TEST",
        "hwid": "TEST",
        "verified": True,
        "plan": "pro",
        "features": ["*"],
    }
    try:
        client = TestClient(app, raise_server_exceptions=False)
        response = client.post(
            "/api/preflight/convert-colors",
            json={
                "file_id": "missing-profile",
                "conversions": ["rgb_to_cmyk"],
                "icc_profile": "gracol",
            },
        )
        assert response.status_code == 422, response.text
        assert "chưa được cài" in response.json()["detail"]
        assert converter_called is False
    finally:
        app.dependency_overrides.pop(require_license, None)


def test_convert_colors_does_not_publish_postflight_blocker(
    monkeypatch, tmp_path
):
    """Residual màu phải là lỗi nghiệp vụ, không thành artifact tải xuống."""
    source_pdf = tmp_path / "jpx-source.pdf"
    source_pdf.write_bytes(b"%PDF-1.4\n% residual source\n%%EOF\n")
    results_dir = tmp_path / "results"
    monkeypatch.setattr(settings, "RESULTS_DIR", str(results_dir))
    monkeypatch.setattr(
        preflight_routes,
        "_get_file_path",
        lambda _file_id: str(source_pdf),
    )
    monkeypatch.setattr(
        icc_profiles,
        "resolve_cmyk_profile_path",
        lambda _profile_id=None: "test-destination.icc",
    )
    monkeypatch.setattr(
        icc_profiles,
        "resolve_srgb_profile_path",
        lambda: "test-source.icc",
    )

    def fake_convert_to_cmyk(input_path, output_path, *_profiles, **_options):
        Path(output_path).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(input_path, output_path)
        return {
            "supported": False,
            "blockers": [
                "[RESIDUAL_JPX_RGB] Trang 1, XObject Im0 còn RGB sau chuyển CMYK.",
                "[UNVERIFIED_JPX_COLORSPACE] Trang 1, XObject Im1 không chứng minh được.",
            ],
        }

    monkeypatch.setattr(pdf_actions_native, "convert_to_cmyk", fake_convert_to_cmyk)
    app.dependency_overrides[require_license] = lambda: {
        "license_key": "TEST",
        "hwid": "TEST",
        "verified": True,
        "plan": "pro",
        "features": ["*"],
    }

    try:
        client = TestClient(app, raise_server_exceptions=False)
        response = client.post(
            "/api/preflight/convert-colors",
            json={
                "file_id": "jpx-http-contract",
                "conversions": ["rgb_to_cmyk"],
                "icc_profile": "auto",
            },
        )

        # COLOR (audit 2026-08-20 §COLOR.04): không giao file partial khi
        # hậu kiểm residual fail-closed.
        assert response.status_code == 200, response.text
        payload = response.json()
        assert payload["success"] is False
        assert payload["output_filename"] is None
        assert payload["log"][-1]["status"] == "error"
        assert "RESIDUAL_JPX_RGB" in payload["log"][-1]["message"]
        output_dir = results_dir / "preflight_output"
        assert not list(output_dir.glob("*.pdf"))
    finally:
        app.dependency_overrides.pop(require_license, None)


def test_convert_colors_residual_blockers_fail_closed_without_artifact(
    monkeypatch,
    tmp_path,
):
    """Hậu kiểm còn RGB phải trả lỗi nghiệp vụ và xóa output chưa đạt."""
    source_pdf = tmp_path / "rgb-residual-source.pdf"
    source_pdf.write_bytes(b"%PDF-1.4\n% residual source\n%%EOF\n")
    results_dir = tmp_path / "results"
    attempted_outputs: list[Path] = []

    monkeypatch.setattr(settings, "RESULTS_DIR", str(results_dir))
    monkeypatch.setattr(
        preflight_routes,
        "_get_file_path",
        lambda _file_id: str(source_pdf),
    )
    monkeypatch.setattr(
        icc_profiles,
        "resolve_cmyk_profile_path",
        lambda _profile_id=None: "test-destination.icc",
    )
    monkeypatch.setattr(
        icc_profiles,
        "resolve_srgb_profile_path",
        lambda: "test-source.icc",
    )

    def fake_convert_with_residual(_input_path, output_path, *_profiles, **_options):
        attempted = Path(output_path)
        attempted.parent.mkdir(parents=True, exist_ok=True)
        attempted.write_bytes(b"%PDF-1.4\n% partial unsafe output\n%%EOF\n")
        attempted_outputs.append(attempted)
        return {
            "supported": False,
            "blockers": [
                "hậu kiểm còn /DeviceRGB trong inline image",
                "hậu kiểm còn /CalRGB trong shading",
                r"hậu kiểm lỗi tại C:\Users\Operator\secret-job.pdf: /DeviceRGB",
                "blocker thứ tư không được công bố",
            ],
        }

    monkeypatch.setattr(
        pdf_actions_native,
        "convert_to_cmyk",
        fake_convert_with_residual,
    )
    app.dependency_overrides[require_license] = lambda: {
        "license_key": "TEST",
        "hwid": "TEST",
        "verified": True,
        "plan": "pro",
        "features": ["*"],
    }

    try:
        client = TestClient(app, raise_server_exceptions=False)
        response = client.post(
            "/api/preflight/convert-colors",
            json={"file_id": "rgb-residual", "conversions": ["rgb_to_cmyk"]},
        )

        # COLOR (audit 2026-08-20 §COLOR.04): residual là lỗi nghiệp vụ,
        # không phải HTTP 500 và tuyệt đối không được công bố file chưa đạt.
        assert response.status_code == 200, response.text
        payload = response.json()
        assert payload["success"] is False
        assert payload["output_filename"] is None
        assert payload["error"] == payload["log"][0]["message"]
        assert payload["log"][0]["status"] == "error"

        public_message = payload["error"]
        assert "hậu kiểm còn /DeviceRGB" in public_message
        assert "hậu kiểm còn /CalRGB" in public_message
        assert "[đường dẫn đã ẩn]" in public_message
        assert "blocker thứ tư" not in public_message
        assert "C:\\Users" not in public_message
        assert "secret-job.pdf" not in public_message

        assert len(attempted_outputs) == 1
        attempted_output = attempted_outputs[0]
        assert not attempted_output.exists()
        download = client.get(f"/api/preflight/download/{attempted_output.name}")
        assert download.status_code == 404
    finally:
        app.dependency_overrides.pop(require_license, None)
