"""Route khuôn bế phải nói ĐÚNG tầng nào chặn, không đổ hết cho thông số.

[DIELINE-ERROR-CLASS 2026-08-26] Vì sao có test này: engine dieline được mã hoá
theo từng bản phát hành, khoá mở nằm ở claim `rk` trong token license. Khi token
hợp lệ nhưng THIẾU `rk` (server chưa cấp khoá cho bản đó, hoặc chạm trần chống thu
gom khoá), Rust trả "Dieline engine is locked: ..." — trước bản vá này route gộp
mọi RuntimeError thành 422 "Không thể tạo khuôn với thông số này." nên người dùng
ngồi sửa số đo vô ích và ops phải mở app.log mới biết thật ra là lỗi bản quyền.

Đo thật trên bản 1.0.0-rc.9 đã cài: token hợp lệ, plan=pro, không có claim `rk`
⇒ 100% request khuôn bế trả 422 sai hướng.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.api.routes import dieline
from app.core import feature_entitlements
from app.core.license_guard import require_license
from app.main import app

_ROOT = Path(__file__).resolve().parents[2]
REQUEST = json.loads(
    (_ROOT / "native/tests/fixtures/dieline_default_request.json").read_text(encoding="utf-8")
)
ENGINE_RS = _ROOT / "native" / "src" / "dieline_engine.rs"
LICENSE_RS = _ROOT / "native" / "src" / "dieline_license.rs"

PARAM_DETAIL = "Không thể tạo khuôn với thông số này."


@pytest.fixture(autouse=True)
def _pro_license(monkeypatch):
    monkeypatch.setattr(feature_entitlements, "FEATURE_GATING_ENABLED", True)
    app.dependency_overrides[require_license] = lambda: {
        "license_key": "PRO", "hwid": "TEST", "license_token": "TOKEN",
        "verified": True, "plan": "pro", "features": [],
    }
    yield
    app.dependency_overrides.clear()


def _post_with_native_error(monkeypatch, message: str):
    def raise_native(*_: str) -> str:
        raise RuntimeError(message)

    monkeypatch.setattr(dieline, "_generate_native", raise_native)
    with TestClient(app) as client:
        return client.post("/api/dieline/generate", json=REQUEST)


# ── Hành vi mong đợi theo từng nhóm lỗi ─────────────────────────────────────

def test_engine_bi_khoa_tra_403_va_chi_dan_lam_moi_ban_quyen(monkeypatch):
    response = _post_with_native_error(
        monkeypatch, "Dieline engine is locked: a valid license token is required"
    )
    assert response.status_code == 403
    detail = response.json()["detail"]
    assert detail != PARAM_DETAIL, "Lỗi bản quyền KHÔNG được báo là sai thông số"
    assert "đăng nhập lại" in detail.lower()


def test_khoa_sai_khong_mo_duoc_engine_tra_403(monkeypatch):
    response = _post_with_native_error(
        monkeypatch, "Dieline engine could not be unlocked for this license"
    )
    assert response.status_code == 403
    assert response.json()["detail"] != PARAM_DETAIL


def test_token_het_han_tra_403(monkeypatch):
    response = _post_with_native_error(monkeypatch, "License token expired")
    assert response.status_code == 403
    assert response.json()["detail"] != PARAM_DETAIL


def test_thieu_quyen_pro_tra_403(monkeypatch):
    response = _post_with_native_error(
        monkeypatch, "Feature 'packaging.dieline' requires Pro"
    )
    assert response.status_code == 403


def test_payload_engine_hong_tra_500(monkeypatch):
    response = _post_with_native_error(monkeypatch, "Dieline engine payload is malformed")
    assert response.status_code == 500
    assert response.json()["detail"] != PARAM_DETAIL


def test_ket_qua_qua_lon_tra_413(monkeypatch):
    response = _post_with_native_error(monkeypatch, "Dieline result is too large")
    assert response.status_code == 413


@pytest.mark.parametrize("message", [
    # validate_request_json (native/src/dieline_request.rs) — lỗi THẬT do thông số.
    "params.L must be a finite number",
    "params.boxType is invalid",
    "margin.top is outside the allowed range",
    # Boa ném khi generator gặp tổ hợp số đo không dựng được.
    "TypeError: cannot read property 'x' of undefined",
])
def test_loi_thong_so_van_giu_422(monkeypatch, message):
    response = _post_with_native_error(monkeypatch, message)
    assert response.status_code == 422
    assert response.json()["detail"] == PARAM_DETAIL


def test_native_thieu_van_tra_503(monkeypatch):
    response = _post_with_native_error(monkeypatch, "native_engine_unavailable")
    assert response.status_code == 503


# ── Chốt chống lệch với chuỗi lỗi bên Rust ──────────────────────────────────
# Bảng tiền tố trong dieline.py là BẢN SAO TAY của thông điệp lỗi Rust. Đổi chữ
# bên Rust mà quên sửa đây thì lỗi bản quyền lặng lẽ quay về 422 sai hướng.

def _rust_error_literals(path: Path, func_names: tuple[str, ...]) -> set[str]:
    """Trích chuỗi lỗi trả về từ các hàm chỉ định trong một file Rust."""
    source = path.read_text(encoding="utf-8")
    literals: set[str] = set()
    for name in func_names:
        start = source.index(f"fn {name}(")
        # Cắt tới `fn` cấp cao tiếp theo để không lẫn thông điệp của hàm khác.
        rest = source[start + 1:]
        end = rest.find("\nfn ")
        body = rest if end < 0 else rest[:end]
        literals |= set(re.findall(r'"([A-Z][^"\\]{10,})"\.to_string\(\)', body))
    return literals


def test_moi_loi_ban_quyen_ben_rust_deu_duoc_phan_loai_khong_phai_422() -> None:
    assert LICENSE_RS.is_file(), f"Không tìm thấy {LICENSE_RS}"
    literals = _rust_error_literals(
        LICENSE_RS,
        (
            "authorize_dieline",
            "validate_dieline_claims",
            "validate_v3_device_binding",
            "decode_url",
            "now_seconds",
        ),
    )
    assert len(literals) >= 25, f"Trích được quá ít thông điệp ({len(literals)}) — regex sai?"

    chua_phan_loai = sorted(
        message for message in literals
        if dieline._classify_native_failure(message).detail == PARAM_DETAIL
    )
    assert not chua_phan_loai, (
        "Lỗi bản quyền bên Rust vẫn bị báo là sai thông số: " + repr(chua_phan_loai)
    )


def test_moi_loi_mo_khoa_engine_ben_rust_deu_duoc_phan_loai_khong_phai_422() -> None:
    assert ENGINE_RS.is_file(), f"Không tìm thấy {ENGINE_RS}"
    literals = _rust_error_literals(ENGINE_RS, ("engine_source", "split_payload"))
    assert len(literals) >= 4, f"Trích được quá ít thông điệp ({len(literals)}) — regex sai?"

    chua_phan_loai = sorted(
        message for message in literals
        if dieline._classify_native_failure(message).detail == PARAM_DETAIL
    )
    assert not chua_phan_loai, (
        "Lỗi mở khoá engine vẫn bị báo là sai thông số: " + repr(chua_phan_loai)
    )
