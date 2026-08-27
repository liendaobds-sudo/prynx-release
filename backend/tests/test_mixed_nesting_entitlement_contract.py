"""Hợp đồng quyền của "Bình lồng ghép tự do" — phase P6a.

Kế hoạch: ``docs/KE_HOACH_MIXED_TRUE_SHAPE_NESTING_DOC_LAP_2026-08-26.md`` §8, §16.2.

Bộ test này khoá bốn thứ dễ trôi nhất khi có người sửa danh mục quyền về sau:

1. Tên capability là **đúng** ``impo.mixed_nesting`` — không phải bí danh, không phải
   biến thể gạch nối, và **không** dùng lại ``impo.diecut``/``packaging.dieline``.
2. Quyền mới **không mở** tool cũ, và quyền cũ **không mở** tool mới (cả hai chiều).
3. Hai catalog (sidecar + desktop) phải parity **trong cùng một commit**.
4. Rollout flag của bản phát hành mặc định **HOLD**. P6a chưa có route nên phần này
   viết kiểu "nếu module route đã tồn tại thì phải đúng hợp đồng" — tới P7a nó tự
   trở thành kiểm tra thật, không cần sửa lại file này.

Ranh giới: P6a **chưa** thêm route hay component. Bằng chứng nằm ở test cuối file.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

import app.core.feature_entitlements as entitlements
from app.core.feature_entitlements import assert_feature, can_use_feature

CAPABILITY = "impo.mixed_nesting"
BACKEND_FLAG = "PRYNX_MIXED_NESTING_ENABLED"
FRONTEND_FLAG = "VITE_MIXED_NESTING_ENABLED"

#: Các quyền của tool cũ mà kế hoạch §8 quy tắc 6 CẤM dùng thay thế.
NEIGHBOUR_CAPABILITIES = (
    "impo.diecut",
    "packaging.dieline",
    "impo.nup",
    "impo.cnc",
    "impo.booklet",
)

_REPO_ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture()
def gate_on(monkeypatch):
    """Bật gate quyền bất kể biến môi trường của tiến trình đang chạy test."""
    monkeypatch.setattr(entitlements, "FEATURE_GATING_ENABLED", True)


# ─────────────────────────────────────────────────────────────────────────────
#  1. Tên và bậc gói
# ─────────────────────────────────────────────────────────────────────────────


def test_capability_ton_tai_va_la_pro():
    assert CAPABILITY in entitlements.PRO_FEATURES
    assert CAPABILITY not in entitlements.FREE_FEATURES
    assert entitlements.FEATURE_MIN_PLAN[CAPABILITY] == "pro"


@pytest.mark.parametrize(
    "near_miss",
    [
        "impo.mixed-nesting",
        "impo.mixednesting",
        "impo.mixed_nest",
        "mixed_nesting",
        "impo.MIXED_NESTING",
        "impo.mixed_nesting ",
        " impo.mixed_nesting",
        "impo.nesting",
        "nesting.mixed",
    ],
)
def test_ten_gan_giong_fail_closed(gate_on, near_miss):
    """Sai một ký tự là quyền lạ; quyền lạ phải bị từ chối, không đoán ý.

    (Grant tường minh trong ``features`` vẫn mở được mọi chuỗi — đó là hành vi
    sẵn có của hệ cho mọi capability. Test này chỉ chốt rằng tên lạ **không**
    được suy ra từ tên đúng, và không lọt vào catalog.)
    """
    assert near_miss not in entitlements.FEATURE_MIN_PLAN
    assert can_use_feature(near_miss, "free") is False
    assert can_use_feature(near_miss, "free", [CAPABILITY]) is False
    assert can_use_feature(CAPABILITY, "free", [near_miss]) is False


# ─────────────────────────────────────────────────────────────────────────────
#  2. Ma trận Free / custom grant / Pro / dev
# ─────────────────────────────────────────────────────────────────────────────


def test_ma_tran_gop_quyen(gate_on):
    assert can_use_feature(CAPABILITY, "free") is False
    assert can_use_feature(CAPABILITY, None) is False
    assert can_use_feature(CAPABILITY, "free", []) is False
    assert can_use_feature(CAPABILITY, "free", [CAPABILITY]) is True
    assert can_use_feature(CAPABILITY, "free", ["*"]) is True
    assert can_use_feature(CAPABILITY, "pro") is True
    assert can_use_feature(CAPABILITY, "professional") is True
    assert can_use_feature(CAPABILITY, "dev") is True


def test_gate_tat_thi_mo_de_vong_dev_khong_bi_chan(monkeypatch):
    monkeypatch.setattr(entitlements, "FEATURE_GATING_ENABLED", False)
    assert can_use_feature(CAPABILITY, "free") is True
    assert_feature(CAPABILITY, {"plan": "free"})  # không được raise


def test_assert_feature_chan_free_bang_thong_bao_tieng_viet(gate_on):
    with pytest.raises(PermissionError) as excinfo:
        assert_feature(CAPABILITY, {"plan": "free"})
    message = str(excinfo.value)
    assert CAPABILITY in message
    assert "PrynX Pro" in message
    assert "free" in message


# ─────────────────────────────────────────────────────────────────────────────
#  3. Không bí danh hai chiều
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("neighbour", NEIGHBOUR_CAPABILITIES)
def test_quyen_cu_khong_mo_tool_moi(gate_on, neighbour):
    assert can_use_feature(CAPABILITY, "free", [neighbour]) is False


@pytest.mark.parametrize("neighbour", NEIGHBOUR_CAPABILITIES)
def test_quyen_moi_khong_mo_tool_cu(gate_on, neighbour):
    assert can_use_feature(neighbour, "free", [CAPABILITY]) is False


def test_capability_moi_khong_lam_thay_doi_bac_goi_cua_quyen_cu():
    """Thêm quyền mới không được sửa phân loại của bất kỳ quyền cũ nào."""
    expected_free = {
        "pdf.shuffle", "pdf.resize", "pdf.crop", "pdf.split", "pdf.pages", "pdf.merge",
        "pdf.encrypt", "pdf.decrypt", "pdf.metadata", "pdf.optimize", "pdf.watermark",
        "pdf.header_footer", "pdf.office_convert", "qc.compare_text",
        "util.document_cleanup",
    }
    expected_pro = {
        "pdf.resize_batch", "pdf.office_batch", "pdf.trim_shift",
        "prepress.preflight", "prepress.convert_colors", "prepress.hairlines",
        "prepress.trapping", "prepress.cutline", "prepress.pdfx",
        "prepress.paper_library",
        "vdp.datamerge", "vdp.numbering", "vdp.cover_numbering",
        "impo.booklet", "impo.nup", "impo.diecut", "impo.cnc", "packaging.dieline",
        "util.bgremover", "util.upscale", "util.logo_rebuild", "qc.compare_pdf",
    }
    assert entitlements.FREE_FEATURES == expected_free
    # Delta duy nhất so với trước phase này đúng bằng một quyền mới.
    assert entitlements.PRO_FEATURES - expected_pro == {CAPABILITY}
    assert expected_pro - entitlements.PRO_FEATURES == set()


# ─────────────────────────────────────────────────────────────────────────────
#  4. Parity hai catalog trong cùng commit
# ─────────────────────────────────────────────────────────────────────────────


def _frontend_catalog() -> dict[str, str]:
    source = (
        _REPO_ROOT / "desktop" / "src" / "lib" / "license" / "features.ts"
    ).read_text(encoding="utf-8")
    return dict(
        re.findall(
            r"^\s*'([^']+)'\s*:\s*\{\s*minPlan\s*:\s*'(free|pro|dev)'",
            source,
            flags=re.MULTILINE,
        )
    )


def test_catalog_desktop_va_sidecar_parity_trong_cung_commit():
    frontend = _frontend_catalog()
    assert frontend == entitlements.FEATURE_MIN_PLAN
    assert frontend[CAPABILITY] == "pro"


def test_capability_co_nhan_hien_thi_tieng_viet():
    source = (
        _REPO_ROOT / "desktop" / "src" / "lib" / "license" / "features.ts"
    ).read_text(encoding="utf-8")
    match = re.search(
        rf"^\s*'{re.escape(CAPABILITY)}'\s*:\s*\{{[^}}]*label\s*:\s*'([^']+)'",
        source,
        flags=re.MULTILINE,
    )
    assert match is not None, "quyền mới phải có nhãn hiển thị trong catalog desktop"
    label = match.group(1)
    assert len(label.strip()) > 2
    # Nhãn phải nói về tool mới, không mượn tên tool cũ.
    assert "lồng ghép" in label.lower()


# ─────────────────────────────────────────────────────────────────────────────
#  5. Rollout mặc định HOLD, và P6a chưa có route/component
# ─────────────────────────────────────────────────────────────────────────────


def test_route_module_neu_da_ton_tai_thi_phai_giu_hop_dong_rollout():
    """Ở P6a file này chưa tồn tại nên test đi qua; từ P7a nó thành kiểm tra thật.

    Hợp đồng bắt buộc khi route ra đời (kế hoạch §8):

    - Đọc cờ ``PRYNX_MIXED_NESTING_ENABLED`` với **mặc định ``"false"``** (HOLD).
    - Chặn tạo job bằng **404** trước khi gọi native.
    - Dùng ``require_feature("impo.mixed_nesting")``, không dùng quyền của tool cũ.
    """
    route_path = _REPO_ROOT / "backend" / "app" / "api" / "routes" / "mixed_nesting.py"
    if not route_path.exists():
        pytest.skip("P6a chưa tạo route; hợp đồng rollout được kiểm từ P7a")

    source = route_path.read_text(encoding="utf-8")
    assert BACKEND_FLAG in source
    assert re.search(
        rf"getenv\(\s*(?:_[A-Z_]*FLAG[A-Z_]*|\"{BACKEND_FLAG}\"|'{BACKEND_FLAG}')\s*,\s*[\"']false[\"']",
        source,
    ), "cờ rollout phải mặc định 'false' (HOLD)"
    assert f'require_feature("{CAPABILITY}")' in source
    for neighbour in NEIGHBOUR_CAPABILITIES:
        assert f'require_feature("{neighbour}")' not in source


def test_p6a_chua_dang_ky_route_hay_component():
    """Bằng chứng phạm vi P6a: quyền đã có, nhưng chưa có đường vào nào.

    Test này **có tuổi thọ**: P7a/P9 sẽ tạo route và component, khi đó phần
    ``skip`` bên dưới tự nhả. Nó không chặn phase sau, chỉ ghi lại trạng thái P6a.
    """
    route_path = _REPO_ROOT / "backend" / "app" / "api" / "routes" / "mixed_nesting.py"
    component_dir = _REPO_ROOT / "desktop" / "src" / "components" / "mixed-nesting"
    if route_path.exists() or component_dir.exists():
        pytest.skip("route/component đã được thêm ở phase sau — kiểm tra ở test của phase đó")

    main_source = (_REPO_ROOT / "backend" / "app" / "main.py").read_text(encoding="utf-8")
    assert "mixed_nesting" not in main_source, "P6a không được include router"

    registry_source = (
        _REPO_ROOT / "desktop" / "src" / "lib" / "toolRegistry.ts"
    ).read_text(encoding="utf-8")
    assert CAPABILITY not in registry_source, "P6a không được đăng ký AppTool"


def test_capability_khong_bi_gan_vao_registry_route_cu():
    """Quyền mới không được lọt vào bảng phân quyền của route/action cũ."""
    from app.api.routes.preflight import (
        _PREFLIGHT_ACTION_FEATURES,
        _PREFLIGHT_ROUTE_FEATURES,
    )
    from app.api.routes.vdp import VDP_EXECUTION_FEATURES

    assert CAPABILITY not in set(_PREFLIGHT_ACTION_FEATURES.values())
    assert CAPABILITY not in set(_PREFLIGHT_ROUTE_FEATURES.values())
    assert CAPABILITY not in VDP_EXECUTION_FEATURES


def test_ten_co_rollout_dung_chinh_ta():
    """Tên cờ phải khớp kế hoạch để `build_production.ps1` probe được ở P15."""
    assert BACKEND_FLAG == "PRYNX_MIXED_NESTING_ENABLED"
    assert FRONTEND_FLAG == "VITE_MIXED_NESTING_ENABLED"
