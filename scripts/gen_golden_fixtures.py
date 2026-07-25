"""Sinh bộ PDF golden cho PrynX Print Engine.

Vì sao cần bộ fixture riêng: fixture preflight có sẵn là ảnh và văn bản trộn lẫn,
nên khi PPE lệch Ghostscript ta **không biết** lệch ở đâu — quy đổi màu, lấy mẫu
ảnh, hay hình học. Mỗi file ở đây cố ý chỉ chứa **một** biến số, phủ kín trang,
để hiệu số đo được chỉ có duy nhất một nguyên nhân.

Chạy:

    backend/venv/Scripts/python.exe scripts/gen_golden_fixtures.py
"""

from __future__ import annotations

import sys
import zlib
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = REPO_ROOT / "print_engine" / "golden" / "fixtures"

PAGE_W = 200
PAGE_H = 200


def build_pdf(content: str, extra_resources: str = "") -> bytes:
    """Dựng PDF một trang tối giản, không nén, không phụ thuộc thư viện ngoài.

    Viết tay để fixture golden **không** đi qua thư viện nào có thể tự ý thêm
    metadata hay đổi colorspace — nội dung file phải đúng như ta viết ra.
    """
    stream = content.encode("latin-1")
    objects: list[bytes] = []

    objects.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    objects.append(
        f"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".encode("latin-1")
    )
    objects.append(
        (
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {PAGE_W} {PAGE_H}] "
            f"/Contents 4 0 R /Resources << {extra_resources} >> >>"
        ).encode("latin-1")
    )
    objects.append(
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream"
    )

    out = bytearray(b"%PDF-1.7\n")
    offsets = [0]
    for i, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode("latin-1") + body + b"\nendobj\n"

    xref_pos = len(out)
    out += f"xref\n0 {len(objects) + 1}\n".encode("latin-1")
    out += b"0000000000 65535 f \n"
    for off in offsets[1:]:
        out += f"{off:010d} 00000 n \n".encode("latin-1")
    out += (
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref_pos}\n%%EOF\n"
    ).encode("latin-1")
    return bytes(out)


def full_page(ops: str) -> str:
    return f"{ops} 0 0 {PAGE_W} {PAGE_H} re f\n"


# ── Bộ fixture ───────────────────────────────────────────────────────────────
# Mỗi file = MỘT biến số. Tên file nói rõ đang đo cái gì.

FIXTURES: dict[str, tuple[str, str]] = {
    # Quy đổi RGB→CMYK: mỗi file một màu nguồn duy nhất, phủ kín trang.
    "rgb_black.pdf": (full_page("0 0 0 rg"), ""),
    "rgb_white.pdf": (full_page("1 1 1 rg"), ""),
    "rgb_mid_gray.pdf": (full_page("0.5 0.5 0.5 rg"), ""),
    "rgb_red.pdf": (full_page("1 0 0 rg"), ""),
    "rgb_green.pdf": (full_page("0 1 0 rg"), ""),
    "rgb_blue.pdf": (full_page("0 0 1 rg"), ""),
    "rgb_dark_brown.pdf": (full_page("0.25 0.15 0.05 rg"), ""),
    # Mực thật: KHÔNG được đi qua ICC ở bất kỳ chế độ nào của PPE.
    "cmyk_solid_400.pdf": (full_page("1 1 1 1 k"), ""),
    "cmyk_k_only.pdf": (full_page("0 0 0 1 k"), ""),
    "cmyk_rich_black.pdf": (full_page("0.6 0.4 0.4 1 k"), ""),
    # DeviceGray phải ra K thuần, không phải rich black.
    "gray_black.pdf": (full_page("0 g"), ""),
    "gray_mid.pdf": (full_page("0.5 g"), ""),
    # Spot: kẽm riêng phải sống.
    "spot_solid.pdf": (
        full_page("/CS0 cs 1 scn"),
        "/ColorSpace << /CS0 [/Separation /PANTONE#20485#20C /DeviceCMYK "
        "<< /FunctionType 2 /Domain [0 1] /C0 [0 0 0 0] /C1 [0 0.91 0.76 0] "
        "/N 1 /Range [0 1 0 1 0 1 0 1] >>] >>",
    ),
    "spot_half_tint.pdf": (
        full_page("/CS0 cs 0.5 scn"),
        "/ColorSpace << /CS0 [/Separation /PANTONE#20485#20C /DeviceCMYK "
        "<< /FunctionType 2 /Domain [0 1] /C0 [0 0 0 0] /C1 [0 0.91 0.76 0] "
        "/N 1 /Range [0 1 0 1 0 1 0 1] >>] >>",
    ),
    # Overprint: nền Cyan + đen overprint. Tổng mực phải là 200%.
    "overprint_black_on_cyan.pdf": (
        f"1 0 0 0 k 0 0 {PAGE_W} {PAGE_H} re f\n"
        f"/GSop gs 0 0 0 1 k 0 0 {PAGE_W} {PAGE_H} re f\n",
        "/ExtGState << /GSop << /op true /OP true /OPM 1 >> >>",
    ),
    # Knockout: cùng nội dung nhưng không overprint. Tổng mực phải là 100%.
    "knockout_black_on_cyan.pdf": (
        f"1 0 0 0 k 0 0 {PAGE_W} {PAGE_H} re f\n"
        f"0 0 0 1 k 0 0 {PAGE_W} {PAGE_H} re f\n",
        "",
    ),
}


def write_image_fixture(path: Path, colorspace: str, n_comps: int, sample: list[int]) -> None:
    """Ảnh 1x1 phủ kín trang — tách phần lấy mẫu ảnh khỏi phần quy đổi màu."""
    data = bytes(sample)
    compressed = zlib.compress(data)
    img = (
        b"<< /Type /XObject /Subtype /Image /Width 1 /Height 1 "
        b"/BitsPerComponent 8 /ColorSpace " + colorspace.encode("latin-1") +
        b" /Filter /FlateDecode /Length " + str(len(compressed)).encode() + b" >>\nstream\n"
        + compressed + b"\nendstream"
    )
    stream = f"q {PAGE_W} 0 0 {PAGE_H} 0 0 cm /Im0 Do Q\n".encode("latin-1")

    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        (
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {PAGE_W} {PAGE_H}] "
            f"/Contents 4 0 R /Resources << /XObject << /Im0 5 0 R >> >> >>"
        ).encode("latin-1"),
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
        img,
    ]
    _ = n_comps

    out = bytearray(b"%PDF-1.7\n")
    offsets = []
    for i, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode("latin-1") + body + b"\nendobj\n"
    xref_pos = len(out)
    out += f"xref\n0 {len(objects) + 1}\n".encode("latin-1")
    out += b"0000000000 65535 f \n"
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode("latin-1")
    out += (
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref_pos}\n%%EOF\n"
    ).encode("latin-1")
    path.write_bytes(bytes(out))


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    written = 0

    for name, (content, resources) in FIXTURES.items():
        (OUT_DIR / name).write_bytes(build_pdf(content, resources))
        written += 1

    # Ảnh: cùng màu với các fixture vector tương ứng để so chéo được hai đường.
    write_image_fixture(OUT_DIR / "image_rgb_black.pdf", "/DeviceRGB", 3, [0, 0, 0])
    write_image_fixture(OUT_DIR / "image_rgb_mid_gray.pdf", "/DeviceRGB", 3, [128, 128, 128])
    write_image_fixture(OUT_DIR / "image_cmyk_solid_400.pdf", "/DeviceCMYK", 4, [255, 255, 255, 255])
    write_image_fixture(OUT_DIR / "image_gray_black.pdf", "/DeviceGray", 1, [0])
    written += 4

    print(f"Đã ghi {written} fixture vào {OUT_DIR}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
