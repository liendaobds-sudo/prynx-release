"""Quy tắc N-Up tem bế: SL trống = một bản mỗi loại, không có chế độ ẩn."""
from collections.abc import Mapping
from typing import Any


def is_sticker_nup(settings: Mapping[str, Any]) -> bool:
    return (
        bool(settings.get("isDieCutMode"))
        and settings.get("imposerMode") != "cnc"
        and not settings.get("page_sheet_mode", False)
        and settings.get("taskMode", "nup") not in ("step_repeat", "sr", "booklet")
        and settings.get("layoutType") != "repeat"
    )


def effective_nup_quantity(value: Any) -> int:
    if value is None or value == "":
        return 1
    if isinstance(value, bool):
        raise ValueError("Số lượng không hợp lệ.")
    try:
        quantity = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("Số lượng phải là số nguyên.") from exc
    if quantity < 0:
        raise ValueError("Số lượng không được âm.")
    return quantity or 1

def validate_sticker_layout(settings: Mapping[str, Any]) -> None:
    """BE.04: không để cách ráp ẩn âm thầm chọn lane/nhân SL cũ."""
    if is_sticker_nup(settings) and settings.get("layoutType") in ("cut_stacks", "ratio_stack"):
        raise ValueError(
            "Xếp chồng/Chia tỷ lệ chỉ áp dụng cho Nguyên tấm decal. "
            "Hãy chọn lại Từng tem để dùng cách xếp lần lượt."
        )


def sticker_order_quantities(pages, settings: Mapping[str, Any]) -> dict[int, int]:
    """Override 0 là loại bỏ tường minh; ô trống kế thừa SL chung (mặc định 1)."""
    default = effective_nup_quantity(settings.get("targetQuantity"))
    overrides = settings.get("targetQuantitiesByPage") or {}
    if not isinstance(overrides, Mapping):
        raise ValueError("Số lượng riêng từng loại không hợp lệ.")
    # BE.05: trống/thiếu key kế thừa SL; số 0 mới nhập không phải profile legacy.
    result = {}
    for page in sorted(pages):
        raw = overrides.get(str(page), overrides.get(page))
        if raw is None or raw == "":
            quantity = default
        else:
            if isinstance(raw, bool):
                raise ValueError("Số lượng riêng từng loại không hợp lệ.")
            quantity = int(raw)
            if quantity < 0:
                raise ValueError("Số lượng riêng từng loại không được âm.")
        if quantity > 0:
            result[int(page)] = quantity
    if not result:
        raise ValueError("Không có mẫu nào có số lượng cần in.")
    return result
