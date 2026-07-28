"""Chốt chống lệch giữa validator backend và DEFAULT_PARAMS phía TypeScript.

[HANGING-WINDOW 2026-07-27] Vì sao cần test này: `dieline_validation.py` là BẢN SAO
tay của `desktop/src/lib/dieline/runtimeValidation.ts`; hai đầu không có codegen
chung nên thêm loại hộp/tham số mới rất dễ sửa một bên. Đã xảy ra thật: loại hộp
`hanging_window` đủ ở TS + bundle sidecar nhưng thiếu trong `ENUM_PARAMS['boxType']`
của backend ⇒ route `/api/dieline/generate` trả 422 "params.boxType không hợp lệ."
mà nhìn log frontend không đoán ra tầng nào chặn.
"""
from __future__ import annotations

import re
from pathlib import Path

from app.api.routes.dieline_validation import ALL_PARAMS, ENUM_PARAMS

_ROOT = Path(__file__).resolve().parents[2]
TYPES_TS = _ROOT / "desktop" / "src" / "lib" / "dieline" / "types.ts"
# Bản sao THỨ BA: allow-list bằng Rust, chạy TRƯỚC Boa trong sidecar native.
REQUEST_RS = _ROOT / "native" / "src" / "dieline_request.rs"


def _read_types_ts() -> str:
    return TYPES_TS.read_text(encoding="utf-8")


def test_types_ts_ton_tai() -> None:
    assert TYPES_TS.is_file(), f"Không tìm thấy {TYPES_TS}"


def test_box_type_enum_khop_hai_dau() -> None:
    """ENUM_PARAMS['boxType'] phải khớp ĐÚNG union boxType trong BoxParams."""
    union = re.search(r"\n    boxType: (.+?);", _read_types_ts())
    assert union, "Không đọc được union boxType trong types.ts"
    ts_types = set(re.findall(r"'([a-z_]+)'", union.group(1)))

    assert ts_types, "Union boxType rỗng — regex sai?"
    thieu_o_backend = sorted(ts_types - ENUM_PARAMS["boxType"])
    thua_o_backend = sorted(ENUM_PARAMS["boxType"] - ts_types)
    assert not thieu_o_backend, (
        f"Loại hộp có ở TS nhưng thiếu trong backend → route trả 422: {thieu_o_backend}"
    )
    assert not thua_o_backend, (
        f"Loại hộp có ở backend nhưng không còn trong TS: {thua_o_backend}"
    )


def test_moi_tham_so_default_params_deu_duoc_validate() -> None:
    """Mọi khoá của DEFAULT_PARAMS phải nằm trong ALL_PARAMS của backend.

    Khoá bị bỏ sót = tham số KHÔNG được kiểm miền giá trị ở biên native.
    """
    block = re.search(
        r"export const DEFAULT_PARAMS: BoxParams = \{(.*?)\n\};",
        _read_types_ts(),
        re.S,
    )
    assert block, "Không đọc được DEFAULT_PARAMS trong types.ts"
    ts_keys = set(re.findall(r"^\s{4}(\w+):", block.group(1), re.M))

    assert len(ts_keys) > 40, f"Đọc được quá ít khoá ({len(ts_keys)}) — regex sai?"
    bo_sot = sorted(ts_keys - ALL_PARAMS)
    khong_con_ton_tai = sorted(ALL_PARAMS - ts_keys)
    assert not bo_sot, f"Tham số chưa được backend validate: {bo_sot}"
    assert not khong_con_ton_tai, (
        f"Backend validate tham số không còn trong DEFAULT_PARAMS: {khong_con_ton_tai}"
    )


def test_allow_list_rust_khop_types_ts() -> None:
    """`native/src/dieline_request.rs` là bản sao thứ ba của allow-list boxType.

    Nó chạy TRƯỚC engine Boa nên thiếu loại hộp ở đây làm route trả 422
    "Không thể tạo khuôn với thông số này." — thông báo mờ, không chỉ ra tầng chặn.
    """
    assert REQUEST_RS.is_file(), f"Không tìm thấy {REQUEST_RS}"
    rust = REQUEST_RS.read_text(encoding="utf-8")

    call = re.search(r'one_of\(params\.get\("boxType"\).*?&\[(.*?)\]\)', rust, re.S)
    assert call, "Không đọc được allow-list boxType trong dieline_request.rs"
    rust_types = set(re.findall(r'"([a-z_]+)"', call.group(1)))

    union = re.search(r"\n    boxType: (.+?);", _read_types_ts())
    ts_types = set(re.findall(r"'([a-z_]+)'", union.group(1)))

    thieu = sorted(ts_types - rust_types)
    thua = sorted(rust_types - ts_types)
    assert not thieu, f"Loại hộp có ở TS nhưng thiếu trong allow-list Rust: {thieu}"
    assert not thua, f"Loại hộp có trong allow-list Rust nhưng không còn ở TS: {thua}"


def test_tham_so_rust_bao_phu_default_params() -> None:
    """NUMERIC/BOOLEAN/STRING_PARAMS phía Rust phải phủ hết khoá của DEFAULT_PARAMS."""
    rust = REQUEST_RS.read_text(encoding="utf-8")
    rust_keys: set[str] = set()
    for name in ("NUMERIC_PARAMS", "BOOLEAN_PARAMS", "STRING_PARAMS"):
        block = re.search(rf"const {name}: &\[&str\] = &\[(.*?)\];", rust, re.S)
        assert block, f"Không đọc được {name} trong dieline_request.rs"
        rust_keys |= set(re.findall(r'"(\w+)"', block.group(1)))

    block = re.search(
        r"export const DEFAULT_PARAMS: BoxParams = \{(.*?)\n\};",
        _read_types_ts(),
        re.S,
    )
    ts_keys = set(re.findall(r"^\s{4}(\w+):", block.group(1), re.M))

    bo_sot = sorted(ts_keys - rust_keys)
    khong_con = sorted(rust_keys - ts_keys)
    assert not bo_sot, f"Tham số chưa được validate ở tầng Rust: {bo_sot}"
    assert not khong_con, f"Tầng Rust validate tham số không còn trong DEFAULT_PARAMS: {khong_con}"
