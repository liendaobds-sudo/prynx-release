"""Chính sách chọn bộ làm mượt cho đường cắt tem."""


def resolve_sticker_corner_policy(
    cut_mode: object,
    rectangle_mode: bool,
    has_object_selection: bool,
    shape_mode: str,
    corner_style: object,
) -> str:
    """Chỉ bật thích ứng khi route thực sự sinh contour giữ nguyên góc."""
    # QUALITY (audit 2026-08-05 §EXISTING.CUT1): rectangle, selection và hình
    # chuẩn tái dựng giữ legacy để không đổi hợp đồng hình học của công cụ cũ.
    eligible = (
        str(cut_mode or "").strip().lower() != "none"
        and not rectangle_mode
        and not has_object_selection
        and shape_mode == "contour"
        and str(corner_style or "").strip().lower() in {"preserve", "original"}
    )
    return "adaptive" if eligible else "legacy"
