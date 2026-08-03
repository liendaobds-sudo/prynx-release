"""Khóa hồi quy cho icon ứng dụng/shortcut Windows của PrynX."""

from pathlib import Path

import pytest
from PIL import Image


REPO_ROOT = Path(__file__).resolve().parents[2]
ICON_PATH = REPO_ROOT / "desktop" / "src-tauri" / "icons" / "icon.ico"
REQUIRED_SIZES = {(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)}


def _icon_frame(size: tuple[int, int]) -> Image.Image:
    with Image.open(ICON_PATH) as icon:
        return icon.ico.getimage(size).convert("RGBA").copy()


def test_windows_icon_contains_all_shortcut_sizes() -> None:
    with Image.open(ICON_PATH) as icon:
        assert REQUIRED_SIZES <= icon.ico.sizes()


@pytest.mark.parametrize("size", sorted(REQUIRED_SIZES))
def test_windows_icon_keeps_rounded_white_background(size: tuple[int, int]) -> None:
    frame = _icon_frame(size)
    width, height = frame.size

    # BUILD (audit 2026-08-04 ICON.1): góc phải trong suốt nhưng giữa bốn cạnh
    # phải là nền trắng. Cặp điều kiện này phân biệt tấm nền bo góc với cả hai
    # hồi quy đã gặp: logo trần trong suốt và nền trắng vuông kín.
    assert frame.getpixel((0, 0))[3] <= 64
    edge_points = (
        (width // 2, max(0, round(height * 0.04))),
        (width // 2, min(height - 1, round(height * 0.96))),
        (max(0, round(width * 0.04)), height // 2),
        (min(width - 1, round(width * 0.96)), height // 2),
    )
    for point in edge_points:
        red, green, blue, alpha = frame.getpixel(point)
        assert alpha >= 250
        assert min(red, green, blue) >= 245

    on_white = Image.alpha_composite(
        Image.new("RGBA", frame.size, (255, 255, 255, 255)),
        frame,
    )
    assert on_white.convert("L").getextrema()[0] <= 80, (
        "Icon phải giữ phần logo PrynX màu đen trên tấm nền trắng."
    )
