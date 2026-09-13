"""Hợp đồng cấu hình ốc định vị dùng chung cho preview và PDF xuất."""

from __future__ import annotations

import math
from typing import Annotated, Any, Mapping

from pydantic import BeforeValidator


_DEFAULT_GRAPH_INFO = "SA info 0 0 0 17.01 2 -16777216 -16777216 1 1 0"
_PONT_DEFAULTS: dict[str, Any] = {
    "shape": "circle",
    "size": 5.0,
    "thickness": 0.5,
    "isGraphtec": False,
    "layerInfoName": _DEFAULT_GRAPH_INFO,
    "layerName": "Marks_Model_",
    "groupName": "MarkLine",
    "itemName": "MKLINE",
    "disableCollision": False,
}
_VALID_SHAPES = {"circle", "l_corner", "l_inverted"}
_VALID_GUIDE_POSITIONS = {"TL", "TR", "BL", "BR"}
_VALID_PONT_TYPES = {"none", "corner", "5mm", "custom"}


def _finite_number(config: dict[str, Any], key: str, *, minimum: float | None = None) -> float:
    value = config[key]
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"Cấu hình ốc: '{key}' phải là một số.")
    normalized = float(value)
    if not math.isfinite(normalized):
        raise ValueError(f"Cấu hình ốc: '{key}' phải là số hữu hạn.")
    if minimum is not None and normalized < minimum:
        raise ValueError(f"Cấu hình ốc: '{key}' không được nhỏ hơn {minimum:g} mm.")
    config[key] = normalized
    return normalized


def _positive_number(config: dict[str, Any], key: str) -> float:
    value = _finite_number(config, key)
    if value <= 0:
        raise ValueError(f"Cấu hình ốc: '{key}' phải lớn hơn 0 mm.")
    return value


def _required_name(config: dict[str, Any], key: str, label: str) -> str:
    value = config[key]
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"Cấu hình ốc: {label} không được để trống.")
    config[key] = value.strip()
    return config[key]


def validate_pont_config(value: Mapping[str, Any] | None) -> dict[str, Any]:
    """Validate và điền default mà writer đang dùng, không sửa object đầu vào.

    FIX (audit 2026-08-05 §OC.2): trước đây route nhận ``Dict[str, Any]`` và
    writer vẫn xuất thành công với ốc 0 mm hoặc tên rỗng.
    """

    if value is None:
        raise ValueError("Cấu hình ốc đang bật nhưng thiếu dữ liệu cấu hình.")
    if not isinstance(value, Mapping):
        raise ValueError("Cấu hình ốc phải là một đối tượng hợp lệ.")
    if not value:
        raise ValueError("Cấu hình ốc đang bật nhưng thiếu dữ liệu cấu hình.")

    config = {**_PONT_DEFAULTS, **dict(value)}
    shape = config["shape"]
    if not isinstance(shape, str) or shape not in _VALID_SHAPES:
        allowed = ", ".join(sorted(_VALID_SHAPES))
        raise ValueError(f"Cấu hình ốc: 'shape' chỉ nhận một trong: {allowed}.")

    _positive_number(config, "size")
    _positive_number(config, "thickness")
    for key in ("marginTop", "marginBottom", "marginLeft", "marginRight"):
        # Giữ nguyên hợp đồng cấu hình rút gọn: thiếu lề thì collision dùng lề tờ,
        # writer vẫn có fallback riêng. Chỉ validate field mà caller thực sự gửi.
        if key in config:
            _finite_number(config, key, minimum=0)

    for key in ("isGraphtec", "disableCollision", "guide1Enabled", "guide2Enabled"):
        if key in config and not isinstance(config[key], bool):
            raise ValueError(f"Cấu hình ốc: '{key}' phải là true hoặc false.")

    _required_name(config, "layerName", "tên lớp")
    _required_name(config, "groupName", "tên nhóm")
    _required_name(config, "itemName", "tên đối tượng")

    layer_info = config.get("layerInfoName", "")
    if not isinstance(layer_info, str):
        raise ValueError("Cấu hình ốc: tên lớp Graphtec phải là chuỗi.")
    if config["isGraphtec"]:
        _required_name(config, "layerInfoName", "tên lớp Graphtec")

    for index in (1, 2):
        enabled_key = f"guide{index}Enabled"
        if not config.get(enabled_key, False):
            continue
        position_key = f"guide{index}Pos"
        position = config.get(position_key, "BL" if index == 1 else "BR")
        if position not in _VALID_GUIDE_POSITIONS:
            raise ValueError(
                f"Cấu hình ốc: '{position_key}' chỉ nhận TL, TR, BL hoặc BR."
            )
        config[position_key] = position
        for suffix in ("Length", "Thickness"):
            key = f"guide{index}{suffix}"
            config.setdefault(key, 20.0 if suffix == "Length" else 0.5)
            _positive_number(config, key)
        for suffix in ("OffX", "OffY"):
            key = f"guide{index}{suffix}"
            config.setdefault(key, 0.0)
            _finite_number(config, key)

    return config


PontConfigPayload = Annotated[dict[str, Any], BeforeValidator(validate_pont_config)]


def normalize_pont_settings(settings: Mapping[str, Any]) -> dict[str, Any]:
    """Áp hợp đồng PontConfig khi ốc đang bật; giữ config cũ khi ốc tắt."""

    normalized = dict(settings)
    pont_type = normalized.get("pontType", "none")
    if pont_type in (None, ""):
        normalized["pontType"] = "none"
        return normalized
    if not isinstance(pont_type, str):
        raise ValueError("Cấu hình ốc: 'pontType' phải là chuỗi hợp lệ.")
    pont_type = pont_type.strip().lower()
    if pont_type.startswith("preset_"):
        pont_type = "custom"
    if pont_type not in _VALID_PONT_TYPES:
        allowed = ", ".join(sorted(_VALID_PONT_TYPES))
        raise ValueError(f"Cấu hình ốc: 'pontType' chỉ nhận một trong: {allowed}.")
    normalized["pontType"] = pont_type
    enabled = pont_type != "none"
    if enabled:
        normalized["pontConfig"] = validate_pont_config(normalized.get("pontConfig"))
    return normalized
