"""Truy vấn trạng thái bộ máy khuôn bế phải nói trước, và không rò gì.

[DIELINE-ENGINE-STATUS 2026-08-26 §G] Vì sao có endpoint này: engine khuôn bế ở bản
phát hành được mã hoá theo từng bản, khoá mở nằm ở claim `rk` trong token license.
`warm_dieline_engine` CỐ Ý no-op ở bản đã khoá (chưa có token thì chưa có khoá, và
warmup không được log lỗi mỗi lần khởi động), nên trước đây trạng thái "engine bị
khoá" chỉ lộ ra khi người dùng đã bấm tạo khuôn và nhận 403 — đo thật trên bản
1.0.0-rc.9: sáu lần liên tiếp, sửa số đo hay bấm "Thử lại" đều không hết.

`GET /api/dieline/engine-status` là đường CHỈ-ĐỌC để công cụ biết trước. Ba bất biến
mà bộ test này gác:

  1. LUÔN 200 — truy vấn trạng thái không bao giờ bị 403 vì lý do engine bị khoá, kể
     cả khi native chưa build hoặc wheel cũ chưa có hàm trạng thái.
  2. Vẫn thừa hưởng `require_feature("packaging.dieline")` — license Free bị từ chối ở
     tầng entitlement như cũ (3.3).
  3. Property 4 (No-Secret-Leak): body chỉ gồm boolean. Không giá trị `rk`, không
     token, không license key (3.5).

Cộng Property 2 (Preservation): warmup vẫn IM LẶNG — trên payload đã khoá
`warm_dieline_engine()` trả Ok và không ghi dòng nào chứa "Dieline engine" vào log.

Test không cần `maturin develop --release`: lời gọi native được thay bằng module giả
đặt vào `sys.modules`, nên vẫn đi qua đúng đường `import pdfcompare_native` của route.
"""
from __future__ import annotations

import base64
import json
import logging
import sys
import types
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.api.routes import dieline
from app.core import feature_entitlements
from app.core.license_guard import require_license
from app.main import app

STATUS_URL = "/api/dieline/engine-status"

# Giá trị "khoá" chỉ dùng trong test, cố ý dễ nhận dạng để bắt rò rỉ trong body/log.
FAKE_RK = base64.b64encode(bytes(range(32))).decode("ascii")
FAKE_LICENSE_KEY = "PRYNX-TEST-LICENSE-KEY-0001"
LOCKED_VERSION = "1.0.0-rc.9"


def _token(**claims: Any) -> str:
    """Dựng token có hình dạng thật: `<payload_b64url>.<sig_b64url>`.

    Route chỉ đọc phần payload (chữ ký đã được `require_license` verify trước đó), nên
    phần chữ ký ở đây là placeholder — test này kiểm hợp đồng đọc claim, không kiểm lại
    tầng mật mã.
    """
    raw = json.dumps(claims, separators=(",", ":")).encode("utf-8")
    payload = base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")
    return f"{payload}.c2lnbmF0dXJl"


TOKEN_WITH_RK = _token(
    exp=4102444800, k="0123456789abcdef", m="TEST", p="prynx", plan="pro", rk=FAKE_RK
)
TOKEN_WITHOUT_RK = _token(
    exp=4102444800, k="0123456789abcdef", m="TEST", p="prynx", plan="pro"
)


@pytest.fixture(autouse=True)
def _feature_gate_on(monkeypatch):
    monkeypatch.setattr(feature_entitlements, "FEATURE_GATING_ENABLED", True)
    yield
    app.dependency_overrides.clear()


def _use_license(*, plan: str = "pro", features: list[str] | None = None, token: str = "") -> None:
    app.dependency_overrides[require_license] = lambda: {
        "license_key": FAKE_LICENSE_KEY,
        "hwid": "TEST",
        "license_token": token,
        "verified": True,
        "plan": plan,
        "features": [] if features is None else features,
    }


def _stub_native(
    monkeypatch,
    *,
    status: dict[str, Any] | None = None,
    with_status_fn: bool = True,
    warm_raises: Exception | None = None,
) -> dict[str, int]:
    """Đặt module native GIẢ vào `sys.modules` và đếm số lần từng hàm được gọi."""
    calls = {"status": 0, "warm": 0, "generate": 0}
    module = types.ModuleType("pdfcompare_native")

    if with_status_fn:
        def dieline_engine_status() -> dict[str, Any]:
            calls["status"] += 1
            return dict(status or {"locked": False, "payload_version": ""})

        module.dieline_engine_status = dieline_engine_status  # type: ignore[attr-defined]

    def warm_dieline_engine() -> None:
        calls["warm"] += 1
        if warm_raises is not None:
            raise warm_raises

    def generate_dieline_json(*_args: str) -> str:
        calls["generate"] += 1
        raise AssertionError("truy vấn trạng thái KHÔNG được chạy engine")

    module.warm_dieline_engine = warm_dieline_engine  # type: ignore[attr-defined]
    module.generate_dieline_json = generate_dieline_json  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "pdfcompare_native", module)
    return calls


def _get_status():
    with TestClient(app) as client:
        return client.get(STATUS_URL)


# ── Ba ca token trên bản ĐÃ KHOÁ ────────────────────────────────────────────

def test_token_co_rk_bao_da_co_khoa_mo(monkeypatch):
    _stub_native(monkeypatch, status={"locked": True, "payload_version": LOCKED_VERSION})
    _use_license(token=TOKEN_WITH_RK)

    response = _get_status()

    assert response.status_code == 200
    assert response.json() == {"locked": True, "license_key_present": True}


def test_token_khong_co_rk_bao_thieu_khoa(monkeypatch):
    """Đúng trạng thái của bản 1.0.0-rc.9 đã đo: engine khoá, token hợp lệ nhưng không `rk`."""
    _stub_native(monkeypatch, status={"locked": True, "payload_version": LOCKED_VERSION})
    _use_license(token=TOKEN_WITHOUT_RK)

    response = _get_status()

    assert response.status_code == 200
    assert response.json() == {"locked": True, "license_key_present": False}


def test_khong_co_token_bao_thieu_khoa(monkeypatch):
    _stub_native(monkeypatch, status={"locked": True, "payload_version": LOCKED_VERSION})
    _use_license(token="")

    response = _get_status()

    assert response.status_code == 200
    assert response.json() == {"locked": True, "license_key_present": False}


@pytest.mark.parametrize("token", ["", "khong-phai-token", "a.b.c", ".", "e30", "!!!.sig"])
def test_token_rac_khong_bao_gio_bao_co_khoa(monkeypatch, token):
    """Token méo/rỗng ⇒ `license_key_present = False`, không ném, vẫn 200."""
    _stub_native(monkeypatch, status={"locked": True, "payload_version": LOCKED_VERSION})
    _use_license(token=token)

    response = _get_status()

    assert response.status_code == 200
    assert response.json()["license_key_present"] is False


# ── Bản plaintext và các trạng thái "không xác định" ────────────────────────

def test_ban_plaintext_bao_khong_khoa(monkeypatch):
    _stub_native(monkeypatch, status={"locked": False, "payload_version": ""})
    _use_license(token=TOKEN_WITHOUT_RK)

    response = _get_status()

    assert response.status_code == 200
    # Build dev/CI nhúng engine plaintext: không cần `rk`, nên không được hiện banner.
    assert response.json() == {"locked": False, "license_key_present": False}


def test_native_chua_build_van_tra_200_va_khong_bao_dong_sai(monkeypatch):
    monkeypatch.setitem(sys.modules, "pdfcompare_native", None)
    _use_license(token=TOKEN_WITHOUT_RK)

    response = _get_status()

    assert response.status_code == 200
    assert response.json()["locked"] is False


def test_wheel_cu_thieu_ham_trang_thai_van_tra_200(monkeypatch):
    """Wheel cũ chưa có `dieline_engine_status` ⇒ không xác định ⇒ không banner, không lỗi."""
    _stub_native(monkeypatch, with_status_fn=False)
    _use_license(token=TOKEN_WITHOUT_RK)

    response = _get_status()

    assert response.status_code == 200
    assert response.json()["locked"] is False


def test_truy_van_trang_thai_khong_chay_engine(monkeypatch):
    calls = _stub_native(monkeypatch, status={"locked": True, "payload_version": LOCKED_VERSION})
    _use_license(token=TOKEN_WITHOUT_RK)

    assert _get_status().status_code == 200

    assert calls["status"] == 1
    # Truy vấn trạng thái không được giải mã, không được warm lại engine.
    assert calls["generate"] == 0
    assert calls["warm"] == 0


# ── Cổng entitlement giữ nguyên (3.3) ───────────────────────────────────────

def test_license_free_van_bi_require_feature_tu_choi(monkeypatch):
    calls = _stub_native(monkeypatch, status={"locked": True, "payload_version": LOCKED_VERSION})
    _use_license(plan="free", token=TOKEN_WITHOUT_RK)

    response = _get_status()

    assert response.status_code == 403
    # Bị chặn TRƯỚC khi chạm native — người dùng Free không cần banner này.
    assert calls["status"] == 0


def test_free_co_grant_rieng_van_doc_duoc_trang_thai(monkeypatch):
    _stub_native(monkeypatch, status={"locked": True, "payload_version": LOCKED_VERSION})
    _use_license(plan="free", features=["packaging.dieline"], token=TOKEN_WITH_RK)

    response = _get_status()

    assert response.status_code == 200
    assert response.json() == {"locked": True, "license_key_present": True}


# ── Property 4: No-Secret-Leak ──────────────────────────────────────────────
# **Validates: Requirements 2.8, 3.5**

def test_body_chi_gom_boolean_khong_ro_bi_mat(monkeypatch, caplog):
    """Body chỉ có hai boolean; không giá trị `rk`, token hay license key ở body lẫn log."""
    _stub_native(monkeypatch, status={"locked": True, "payload_version": LOCKED_VERSION})
    _use_license(token=TOKEN_WITH_RK)

    with caplog.at_level(logging.DEBUG):
        response = _get_status()

    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"locked", "license_key_present"}
    assert all(isinstance(value, bool) for value in body.values()), body

    haystack = response.text + "\n".join(record.getMessage() for record in caplog.records)
    for secret in (FAKE_RK, TOKEN_WITH_RK, TOKEN_WITH_RK.split(".", 1)[0], FAKE_LICENSE_KEY):
        assert secret not in haystack, "giá trị bí mật rò ra phản hồi hoặc log"
    # Kể cả tên claim cũng không cần có trong body — chỉ trạng thái có/không.
    assert '"rk"' not in response.text


# ── Property 2: Preservation — warmup vẫn im lặng ───────────────────────────
# **Validates: Requirements 1.8, 3.8**

def test_warmup_im_lang_tren_payload_da_khoa(monkeypatch, caplog):
    """Bản đã khoá: `warm_dieline_engine()` trả Ok và KHÔNG ghi dòng nào chứa "Dieline engine".

    Đây là bất biến của lô này: thêm truy vấn trạng thái không được biến warmup thành
    nguồn log lỗi mỗi lần khởi động (1.8).
    """
    calls = _stub_native(monkeypatch, status={"locked": True, "payload_version": LOCKED_VERSION})

    with caplog.at_level(logging.DEBUG):
        dieline._warm_native_engine()

    assert calls["warm"] == 1, "warmup phải thật sự được gọi, không bị bỏ qua âm thầm"
    noisy = [record.getMessage() for record in caplog.records if "Dieline engine" in record.getMessage()]
    assert not noisy, f"warmup phải im lặng trên payload đã khoá: {noisy}"


def test_warmup_im_lang_khi_native_chua_build(monkeypatch, caplog):
    monkeypatch.setitem(sys.modules, "pdfcompare_native", None)

    with caplog.at_level(logging.DEBUG):
        dieline._warm_native_engine()

    noisy = [record.getMessage() for record in caplog.records if "Dieline engine" in record.getMessage()]
    assert not noisy, f"native chưa build cũng phải im lặng: {noisy}"


def test_classify_native_failure_khong_doi():
    """`_classify_native_failure()` là hợp đồng của bản vá trước — lô này KHÔNG đụng tới."""
    locked = dieline._classify_native_failure(
        "Dieline engine is locked: a valid license token is required"
    )
    assert locked.status_code == 403
    assert dieline._classify_native_failure("params.L must be a finite number").status_code == 422
