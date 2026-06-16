"""
profile.py — Machine Profile: schema + loader + validate.

Requirements: 2.1–2.6. Mỗi máy = một hồ sơ khai báo (JSON). Thêm máy mới = thêm
dữ liệu, không sửa lõi. Trường `resolution_plu_per_mm` BẮT BUỘC (Req 2.6).
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import Any, Optional

VALID_EMITTERS = ("command_stream", "vector_file", "gcode")
VALID_ORIGINS = ("bottom_left", "top_left", "blade_current")
VALID_REG_MODES = ("onboard_frame", "manual_affine", "cv", "none")


class ProfileError(ValueError):
    """Lỗi cấu hình profile (thiếu/không hợp lệ) — Req 2.5."""


@dataclass
class MachineProfile:
    id: str
    vendor: str
    model: str
    emitter: str
    resolution_plu_per_mm: float
    dialect: Optional[str] = None          # skycut_ud | hpgl_pupd | gpgl ...
    origin: str = "bottom_left"
    flip_y: bool = False
    swap_xy: bool = False
    separator: str = " "
    header_template: str = ""
    footer_template: str = ""
    pen_up: str = "U{x},{y} "
    pen_down: str = "D{x},{y} "
    registration: dict = field(default_factory=lambda: {"mode": "none"})
    blade: dict = field(default_factory=dict)
    dual_head: dict = field(default_factory=lambda: {"enabled": False})
    filename: dict = field(default_factory=lambda: {"pattern": "{name}", "ext": "plt", "encoding": "ascii"})
    transport: dict = field(default_factory=lambda: {"default": "file"})
    limits: dict = field(default_factory=dict)
    source_ref: str = ""

    @property
    def reg_mode(self) -> str:
        return (self.registration or {}).get("mode", "none")


_REQUIRED = ("id", "vendor", "model", "emitter", "resolution_plu_per_mm")


def validate_profile_dict(data: dict[str, Any]) -> None:
    """Kiểm tra trường bắt buộc + giá trị hợp lệ. Ném ProfileError nếu sai (Req 2.5)."""
    for key in _REQUIRED:
        if key not in data or data[key] in (None, ""):
            raise ProfileError(f"Profile thiếu trường bắt buộc: '{key}'")

    res = data["resolution_plu_per_mm"]
    if not isinstance(res, (int, float)) or res <= 0:
        raise ProfileError(
            f"'resolution_plu_per_mm' phải là số > 0 (nhận: {res!r}) — Req 2.6"
        )

    if data["emitter"] not in VALID_EMITTERS:
        raise ProfileError(
            f"'emitter' không hợp lệ: {data['emitter']!r}. Hợp lệ: {VALID_EMITTERS}"
        )

    if data["emitter"] == "command_stream" and not data.get("dialect"):
        raise ProfileError("emitter 'command_stream' yêu cầu trường 'dialect'")

    origin = data.get("origin", "bottom_left")
    if origin not in VALID_ORIGINS:
        raise ProfileError(f"'origin' không hợp lệ: {origin!r}. Hợp lệ: {VALID_ORIGINS}")

    reg = data.get("registration", {"mode": "none"})
    if reg.get("mode", "none") not in VALID_REG_MODES:
        raise ProfileError(
            f"registration.mode không hợp lệ: {reg.get('mode')!r}. Hợp lệ: {VALID_REG_MODES}"
        )


def profile_from_dict(data: dict[str, Any]) -> MachineProfile:
    validate_profile_dict(data)
    known = MachineProfile.__dataclass_fields__.keys()
    filtered = {k: v for k, v in data.items() if k in known}
    return MachineProfile(**filtered)


def load_profile(path: str) -> MachineProfile:
    if not os.path.isfile(path):
        raise ProfileError(f"Không tìm thấy profile: {path}")
    with open(path, "r", encoding="utf-8") as f:
        try:
            data = json.load(f)
        except json.JSONDecodeError as e:
            raise ProfileError(f"Profile JSON lỗi cú pháp ({path}): {e}") from e
    return profile_from_dict(data)


def builtin_profiles_dir() -> str:
    return os.path.join(os.path.dirname(__file__), "profiles")


def user_profiles_dir() -> str:
    """Thư mục lưu profile máy do NGƯỜI DÙNG tạo (ghi được kể cả khi đóng gói).

    Dùng `./data/cut_profiles` (cùng nơi với DB SQLite của app desktop).
    """
    d = os.path.join(os.getcwd(), "data", "cut_profiles")
    os.makedirs(d, exist_ok=True)
    return d


def load_builtin_profiles() -> dict[str, MachineProfile]:
    """Nạp mọi profile .json trong thư mục profiles/. Bỏ qua file lỗi (ghi None)."""
    out: dict[str, MachineProfile] = {}
    d = builtin_profiles_dir()
    if not os.path.isdir(d):
        return out
    for fn in sorted(os.listdir(d)):
        if fn.endswith(".json"):
            prof = load_profile(os.path.join(d, fn))
            out[prof.id] = prof
    return out


def builtin_profile_ids() -> set[str]:
    """ID của các máy CÓ SẴN (không cho xóa/sửa lõi)."""
    return set(load_builtin_profiles().keys())


def load_all_profiles() -> dict[str, MachineProfile]:
    """Gộp máy có sẵn + máy người dùng (user ghi đè builtin nếu trùng id)."""
    out = load_builtin_profiles()
    ud = user_profiles_dir()
    if os.path.isdir(ud):
        for fn in sorted(os.listdir(ud)):
            if fn.endswith(".json"):
                try:
                    p = load_profile(os.path.join(ud, fn))
                    out[p.id] = p
                except Exception:
                    continue
    return out
