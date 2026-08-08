"""Chính sách chọn bộ làm mượt cho đường cắt tem."""


def resolve_sticker_corner_policy(
    cut_mode: object,
    rectangle_mode: bool,
    has_object_selection: bool,
    shape_mode: str,
    corner_style: object,
) -> str:
    """Chỉ bật thích ứng khi route thực sự sinh contour giữ nguyên góc."""
    # QUALITY (audit 2026-08-07 §NOODLE.2): `auto_safe + preserve` cần adaptive
    # làm fallback khi không nhận được hình chuẩn. Chỉ `force_*` mới đi legacy;
    # rectangle/selection vẫn giữ hợp đồng cũ.
    eligible = (
        str(cut_mode or "").strip().lower() != "none"
        and not rectangle_mode
        and not has_object_selection
        and shape_mode in {"contour", "auto_safe"}
        and str(corner_style or "").strip().lower() in {"preserve", "original"}
    )
    return "adaptive" if eligible else "legacy"
