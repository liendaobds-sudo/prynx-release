"""Tạo icon tài liệu PDF của PrynX từ ảnh nguồn RGBA."""

from pathlib import Path
import sys

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
ICON_DIR = ROOT / "desktop" / "src-tauri" / "icons"
SOURCE_PATH = ICON_DIR / "file-pdf-source.png"
PREVIEW_PATH = ICON_DIR / "file-pdf-preview.png"
ICO_PATH = ICON_DIR / "file-pdf.ico"
SVG_PATH = ICON_DIR / "file-pdf.svg"
ICO_SIZES = ((16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256))


def fit_on_transparent_square(source: Image.Image, size: int) -> Image.Image:
    """Giữ nguyên tỷ lệ hình dọc và căn giữa trên canvas vuông trong suốt."""
    scale = min(size / source.width, size / source.height)
    width = max(1, round(source.width * scale))
    height = max(1, round(source.height * scale))
    resized = source.resize((width, height), Image.Resampling.LANCZOS)

    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.alpha_composite(resized, ((size - width) // 2, (size - height) // 2))
    return canvas


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    with Image.open(SOURCE_PATH) as image:
        source = image.convert("RGBA")

    if source.width <= 0 or source.height <= 0:
        raise ValueError("Ảnh nguồn icon PDF không có kích thước hợp lệ.")

    preview = fit_on_transparent_square(source, 128)
    preview.save(PREVIEW_PATH, format="PNG", optimize=True)

    master = fit_on_transparent_square(source, 256)
    master.save(ICO_PATH, format="ICO", sizes=ICO_SIZES)

    # ASSET (2026-08-04): SVG chỉ làm vỏ vuông và tham chiếu cùng ảnh nguồn để
    # preview/tài liệu không trôi sang một thiết kế khác với icon Windows.
    canvas_size = max(source.width, source.height)
    x = (canvas_size - source.width) // 2
    y = (canvas_size - source.height) // 2
    SVG_PATH.write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        f'<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 {canvas_size} {canvas_size}">\n'
        '  <!-- ASSET (2026-08-04): Giữ ảnh PDF đúng tỷ lệ trên canvas icon vuông. -->\n'
        f'  <image href="{SOURCE_PATH.name}" x="{x}" y="{y}" '
        f'width="{source.width}" height="{source.height}" preserveAspectRatio="xMidYMid meet"/>\n'
        '</svg>\n',
        encoding='utf-8',
    )

    with Image.open(ICO_PATH) as icon:
        actual_sizes = set(icon.ico.sizes())
    expected_sizes = set(ICO_SIZES)
    if actual_sizes != expected_sizes:
        raise RuntimeError(
            f"Các frame ICO không đúng: thực tế={sorted(actual_sizes)}, "
            f"mong đợi={sorted(expected_sizes)}"
        )

    print(
        f"Đã tạo {ICO_PATH.name}: {len(ICO_SIZES)} kích thước; "
        f"đồng bộ {PREVIEW_PATH.name} và {SVG_PATH.name}, giữ nguyên tỷ lệ nguồn."
    )


if __name__ == "__main__":
    main()
