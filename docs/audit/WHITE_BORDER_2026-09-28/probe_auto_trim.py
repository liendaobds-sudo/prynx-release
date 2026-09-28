"""Probe audit độc lập; không sửa tài liệu người dùng hoặc mã production."""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

import numpy as np
import pikepdf
from PIL import Image, ImageDraw


REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "backend"))
EVIDENCE = Path(__file__).resolve().parent
POPPLER = Path(
    r"C:\Users\Khanh Pham\.cache\codex-runtimes\codex-primary-runtime"
    r"\dependencies\native\poppler\Library\bin\pdftoppm.exe"
)


def write_fixture(path: Path, crop: list[float], rotation: int) -> None:
    with pikepdf.Pdf.new() as pdf:
        page = pdf.add_blank_page(page_size=(200, 100))
        page.CropBox = pikepdf.Array(crop)
        page.Rotate = rotation
        # Mốc xanh ở sát trái artwork để phát hiện xén nhầm, không chỉ đo box.
        page.Contents = pikepdf.Stream(
            pdf, b"1 0 0 rg 40 10 120 80 re f\n0 0 1 rg 40 10 4 80 re f\n"
        )
        pdf.save(path)


def render(path: Path, prefix: Path) -> np.ndarray:
    subprocess.run(
        [str(POPPLER), "-cropbox", "-r", "288", "-singlefile", "-png", str(path), str(prefix)],
        check=True, capture_output=True,
    )
    with Image.open(prefix.with_suffix(".png")) as image:
        return np.asarray(image.convert("RGB")).copy()


def metrics(rgb: np.ndarray) -> dict:
    blue = (rgb[:, :, 2] > 180) & (rgb[:, :, 0] < 80) & (rgb[:, :, 1] < 80)
    white = np.min(rgb, axis=2) >= 248
    return {
        "raster_size": [int(rgb.shape[1]), int(rgb.shape[0])],
        "blue_marker_pixels": int(blue.sum()),
        "white_fraction": round(float(white.mean()), 6),
    }


def main() -> None:
    results = []
    panels = []
    with tempfile.TemporaryDirectory(prefix="prynx_white_border_audit_") as scratch:
        root = Path(scratch)
        os.environ["UPLOAD_DIR"] = str(root / "uploads")
        os.environ["RESULTS_DIR"] = str(root / "results")
        from app.core.page_boxes import PageBoxesEngine

        engine = PageBoxesEngine()
        engine.output_dir = root
        for rotation in (0, 90, 180, 270):
            for variant, crop in (
                ("intersection_control", [20, 0, 200, 100]),
                ("crop_outside_media", [20, -10, 220, 110]),
            ):
                name = f"{variant}_r{rotation}"
                source = root / f"{name}.pdf"
                write_fixture(source, crop, rotation)
                output = Path(engine.auto_trim(
                    str(source), trim_sides=["top", "right", "bottom", "left"]
                ))
                with pikepdf.Pdf.open(output) as pdf:
                    actual = [float(value) for value in pdf.pages[0].MediaBox]
                rgb = render(output, root / f"{name}_render")
                results.append({
                    "case": name,
                    "input_media": [0, 0, 200, 100],
                    "input_crop": crop,
                    "expected_artwork_box": [40, 10, 160, 90],
                    "actual_media": actual,
                    **metrics(rgb),
                })
                if rotation == 0:
                    panels.append((name, Image.fromarray(rgb)))

        # Đối chứng nguồn: hai file có cùng vùng nhìn thấy dù CropBox khác nhau.
        a = render(root / "intersection_control_r0.pdf", root / "source_control")
        b = render(root / "crop_outside_media_r0.pdf", root / "source_outside")
        source_equal = bool(a.shape == b.shape and np.array_equal(a, b))

    evidence = {"source_render_equal": source_equal, "cases": results}
    (EVIDENCE / "auto_trim_evidence.json").write_text(
        json.dumps(evidence, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    sheet = Image.new("RGB", (740, 840), "#eeeeee")
    draw = ImageDraw.Draw(sheet)
    for index, (label, panel) in enumerate(panels):
        draw.text((16, 12 + index * 390), label, fill="black")
        sheet.paste(panel, (16, 38 + index * 390))
    sheet.save(EVIDENCE / "auto_trim_comparison.png")
    print(json.dumps(evidence, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
