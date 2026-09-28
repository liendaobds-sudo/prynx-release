"""Đo hợp đồng tái dùng Resize cho phủ viền, không sửa file người dùng."""
from __future__ import annotations

import json
import logging
import subprocess
import sys
import tempfile
from contextlib import nullcontext
from pathlib import Path

import numpy as np
import pikepdf
import pypdfium2 as pdfium
from PIL import Image, ImageCms


ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "backend"))

from app.core.pdfium_lock import pdfium_guard  # noqa: E402
from app.workers.pdf_tools_engine import resize_pages_smart  # noqa: E402


def make_source(path: Path, user_unit: int, rotation: int) -> None:
    """Khối đỏ lệch tâm và ô xanh để đo vị trí/kích thước độc lập lớp nền."""
    with pikepdf.Pdf.new() as document:
        page = document.add_blank_page(page_size=(200, 160))
        page.UserUnit = user_unit
        page.Rotate = rotation
        page.CropBox = pikepdf.Array([0, 0, 200, 160])
        page.TrimBox = pikepdf.Array([5, 7, 195, 153])
        page.Contents = pikepdf.Stream(
            document,
            b"1 0 0 rg 20 30 60 50 re f\n0 0 1 rg 30 40 10 10 re f\n",
        )
        profile = pikepdf.Stream(
            document,
            ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes(),
        )
        profile.N = 3
        document.Root.OutputIntents = pikepdf.Array([
            document.make_indirect(pikepdf.Dictionary(
                Type=pikepdf.Name.OutputIntent,
                S=pikepdf.Name.GTS_PDFX,
                OutputConditionIdentifier="Diagnostic sRGB",
                DestOutputProfile=profile,
            )),
        ])
        document.save(path)


def measure(path: Path) -> dict:
    with pikepdf.Pdf.open(path) as document:
        page = document.pages[0]
        user_unit = float(page.get("/UserUnit", 1))
        boxes = {
            name: [float(value) for value in page.get(name)]
            for name in ("/MediaBox", "/CropBox", "/TrimBox")
            if page.get(name) is not None
        }
        output_intents = len(document.Root.get("/OutputIntents", []))
        rotation = int(page.get("/Rotate", 0))
        forms = [
            {
                "name": str(name),
                "bbox": [float(value) for value in obj.get("/BBox", [])],
                "matrix": [float(value) for value in obj.get("/Matrix", [])],
            }
            for name, obj in page.get("/Resources", {}).get("/XObject", {}).items()
            if obj.get("/Subtype") == pikepdf.Name.Form
        ]
    # PDFium của dự án render theo đơn vị raw, scale theo UserUnit để đo vật lý.
    scale = 4 * user_unit
    with pdfium_guard("audit_white_border_resize_reuse"):
        document = pdfium.PdfDocument(str(path))
        page = document[0]
        reported_size = list(page.get_size())
        bitmap = page.render(scale=scale, rev_byteorder=True)
        rgb = bitmap.to_numpy().copy()[:, :, :3]
        if "--keep-artifacts" in sys.argv:
            bitmap.to_pil().save(path.with_suffix(".png"))
        bitmap.close()
        page.close()
        document.close()
    mask = (rgb[:, :, 2] > 220) & (rgb[:, :, 0] < 40) & (rgb[:, :, 1] < 40)
    ys, xs = np.nonzero(mask)
    marker = None
    if len(xs):
        # 4 pixel/point vật lý sau khi áp UserUnit ở scale render.
        marker = [
            round(float(xs.min()) / 4, 3),
            round(float(rgb.shape[0] - 1 - ys.max()) / 4, 3),
            round(float(xs.max() + 1) / 4, 3),
            round(float(rgb.shape[0] - ys.min()) / 4, 3),
        ]
    return {
        "user_unit": user_unit,
        "rotation": rotation,
        "boxes_raw": boxes,
        "output_intents": output_intents,
        "pdfium_size_raw": reported_size,
        "render_pixels": [rgb.shape[1], rgb.shape[0]],
        "marker_physical_pt": marker,
        "form_resources": forms,
    }


def measure_poppler(path: Path, executable: str) -> dict:
    """Oracle thứ hai: chỉ so tồn tại marker, không suy UserUnit từ DPI Poppler."""
    prefix = path.with_name(path.stem + "-poppler")
    subprocess.run([
        executable, "-f", "1", "-singlefile", "-r", "288", "-png",
        str(path), str(prefix),
    ], check=True, capture_output=True)
    with Image.open(prefix.with_suffix(".png")) as image:
        rgb = np.asarray(image.convert("RGB"))
    mask = (rgb[:, :, 2] > 220) & (rgb[:, :, 0] < 40) & (rgb[:, :, 1] < 40)
    return {
        "render_pixels": [rgb.shape[1], rgb.shape[0]],
        "blue_marker_pixels": int(np.count_nonzero(mask)),
        "note": "Đối chiếu tồn tại marker; Poppler build này không áp UserUnit nguồn.",
    }


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    logging.disable(logging.CRITICAL)
    findings = []
    keep = "--keep-artifacts" in sys.argv
    artifact_directory = Path(__file__).with_name("resize_reuse_artifacts")
    if keep:
        artifact_directory.mkdir(exist_ok=True)
    context = (
        nullcontext(str(artifact_directory))
        if keep else tempfile.TemporaryDirectory(prefix="prynx-white-border-resize-")
    )
    with context as directory:
        temporary = Path(directory)
        for user_unit, rotation, mode in [
            (1, 0, "image"), (1, 0, "mirror"),
            (1, 0, "trajectory"), (1, 0, "inpaint"),
            (2, 0, "image"), (2, 90, "image"),
        ]:
            source = temporary / f"source-{user_unit}-{rotation}-{mode}.pdf"
            output = temporary / f"output-{user_unit}-{rotation}-{mode}.pdf"
            make_source(source, user_unit, rotation)
            display_w, display_h = ((160, 200) if rotation == 90 else (200, 160))
            resize_pages_smart(
                str(source), str(output),
                display_w * user_unit * 25.4 / 72,
                display_h * user_unit * 25.4 / 72,
                scale_mode="center_no_scale", mode="xobject", target_dpi=0,
                bg_fill_mode=mode,
            )
            finding = {
                "mode": mode,
                "source": measure(source),
                "output": measure(output),
            }
            if user_unit == 2 and rotation == 90:
                # Chỉ bỏ lần vẽ cleanup cuối ở BẢN SAO để chứng minh consumer
                # của hình học sai; không can thiệp source/engine thật.
                without_cleanup = temporary / "output-2-90-image-no-cleanup.pdf"
                with pikepdf.Pdf.open(output) as document:
                    document.pages[0].Contents = pikepdf.Array(
                        list(document.pages[0].Contents)[:-1]
                    )
                    document.save(without_cleanup)
                finding["output_without_cleanup_diagnostic"] = measure(without_cleanup)
                if "--poppler" in sys.argv:
                    executable = sys.argv[sys.argv.index("--poppler") + 1]
                    finding["poppler_control"] = {
                        "source": measure_poppler(source, executable),
                        "output": measure_poppler(output, executable),
                        "without_cleanup": measure_poppler(without_cleanup, executable),
                    }
            findings.append(finding)
    print(json.dumps(findings, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
