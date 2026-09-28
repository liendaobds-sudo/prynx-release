"""PERF (audit 2026-09-28 §PERF28.04): A/B xuất xám, không chạy AI QC.

Chạy từ root bằng backend/venv/Scripts/python.exe -B <đường dẫn script này>.
Baseline được đọc bằng git show, không ghi/khôi phục source sản phẩm. PDF/ảnh
nằm trong TemporaryDirectory riêng; không mở server, app hoặc file khách.
Mỗi mẫu chạy process mới, cùng PDF/ICC/DPI. Đo source dev, không phải startup
release/scan-out hay áp lực RAM trên máy yếu thật. Mặc định N=3, không báo p95.
"""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import hashlib
import json
import logging
import os
from pathlib import Path
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import types
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "backend"))
BASELINE = "bc3d6d5b1761e5c5309eb589ec6eb58ac31b3f58"
EXPORT_PATH = "backend/app/api/routes/export.py"


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _artifact(path: str) -> dict:
    from PIL import Image

    with Image.open(path) as image:
        return {
            "mode": image.mode,
            "size": list(image.size),
            "dpi": [float(value) for value in image.info["dpi"]] if "dpi" in image.info else None,
            "pixel_sha256": _sha(image.tobytes()),
            "icc_sha256": _sha(image.info["icc_profile"]),
            "file_sha256": _sha(Path(path).read_bytes()),
        }


def _child(args) -> None:
    work = Path(args.work).resolve()
    os.environ.update({
        "DEV_MODE": "false",
        "DATABASE_URL": "sqlite:///:memory:",
        "UPLOAD_DIR": str(work / "uploads"),
        "RESULTS_DIR": str(work / "results"),
        "PRYNX_MIXED_NESTING_DATA_DIR": str(work / "mixed"),
    })
    logging.disable(logging.CRITICAL)
    import pypdfium2 as pdfium
    from PIL import ImageCms, __version__ as pillow_version
    from app.api.routes import export as current
    from app.core import pdfium_lock
    from app.core.system_memory import read_installed_memory_mb, read_memory_status_mb

    if args.child == "before":
        source = subprocess.check_output(
            ["git", "show", f"{BASELINE}:{EXPORT_PATH}"], cwd=ROOT,
        )
        module = types.ModuleType("prynx_gray_export_baseline")
        exec(compile(source, "<baseline-export.py>", "exec"), module.__dict__)
    else:
        source = (ROOT / EXPORT_PATH).read_bytes()
        module = current
    # sRGB do LittleCMS tạo có timestamp; dùng cùng bytes để so parity WebP.
    module._SRGB_ICC_BYTES = (work.parent / "srgb.icc").read_bytes()

    original_guard = pdfium_lock.pdfium_guard
    original_apply = ImageCms.applyTransform
    page_spans = []
    cmm_spans = []
    started = threading.Event()
    waiter_ready = threading.Event()
    waiter_result = {}

    @contextmanager
    def measured_guard(label="pdfium"):
        with original_guard(label):
            begin = time.perf_counter()
            try:
                yield
            finally:
                if label == "export_images_page":
                    page_spans.append((time.perf_counter() - begin) * 1000)

    def measured_apply(*apply_args, **kwargs):
        owned = pdfium_lock.PDFIUM_PY_LOCK._is_owned()
        begin = time.perf_counter()
        started.set()
        result = original_apply(*apply_args, **kwargs)
        cmm_spans.append({
            "ms": (time.perf_counter() - begin) * 1000,
            "pdfium_lock_owned": owned,
        })
        return result

    def wait_for_pdfium():
        waiter_ready.set()
        if not started.wait(10):
            waiter_result["error"] = "Không thấy CMM bắt đầu"
            return
        begin = time.perf_counter()
        try:
            with original_guard("probe_competing_document"):
                waiter_result["wait_ms"] = (time.perf_counter() - begin) * 1000
                pdf = pdfium.PdfDocument(args.source)
                page = pdf[0]
                try:
                    waiter_result["page_size"] = list(page.get_size())
                finally:
                    page.close()
                    pdf.close()
        except Exception as exc:
            waiter_result["error"] = repr(exc)

    waiter = threading.Thread(target=wait_for_pdfium)
    waiter.start()
    assert waiter_ready.wait(5)
    with patch.object(pdfium_lock, "pdfium_guard", measured_guard), patch.object(
        ImageCms, "applyTransform", measured_apply,
    ):
        begin = time.perf_counter()
        try:
            files = module.render_pdf_to_images(
                args.source, str(work / "timed"), fmt="png", dpi=args.dpi,
                color_mode="gray",
            )
            elapsed_ms = (time.perf_counter() - begin) * 1000
        finally:
            started.set()
            waiter.join(timeout=10)
    assert not waiter.is_alive() and "error" not in waiter_result, waiter_result
    assert len(files) == 1 and len(page_spans) == 1 and len(cmm_spans) == 1

    parity = {}
    for fmt in ("png", "jpeg", "tiff", "webp"):
        for include_bleed in (False, True):
            key = f"{fmt}_{'media' if include_bleed else 'trim'}"
            exported = module.render_pdf_to_images(
                args.source, str(work / key), fmt=fmt, dpi=72,
                color_mode="gray", include_bleed=include_bleed,
            )
            parity[key] = _artifact(exported[0])
    print(json.dumps({
        "variant": args.child,
        "dpi": args.dpi,
        "elapsed_ms": elapsed_ms,
        "page_lock_ms": page_spans[0],
        "cmm": cmm_spans[0],
        "competing_pdfium": waiter_result,
        "timed_artifact": _artifact(files[0]),
        "format_box_artifacts": parity,
        "source_sha256": _sha(source),
        "cpu": os.cpu_count(),
        "installed_mib": read_installed_memory_mb(),
        "usable_available_mib": read_memory_status_mb(),
        "pillow": pillow_version,
        "littlecms": ImageCms.core.littlecms_version,
    }))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--dpi", type=int, default=300)
    parser.add_argument("--child", choices=("before", "after"))
    parser.add_argument("--work")
    parser.add_argument("--source")
    args = parser.parse_args()
    if args.child:
        _child(args)
        return
    if args.runs < 1 or not 36 <= args.dpi <= 1200:
        parser.error("Cần runs > 0 và 36 <= dpi <= 1200")
    from PIL import ImageCms
    import pikepdf
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen.canvas import Canvas

    with tempfile.TemporaryDirectory(prefix="prynx_gray_perf28_") as tmp:
        work = Path(tmp)
        source = work / "fixture.pdf"
        canvas = Canvas(str(source), pagesize=A4)
        canvas.setFillColorRGB(0.95, 0.1, 0.3)
        canvas.rect(0, 0, A4[0] / 2, A4[1], fill=1, stroke=0)
        canvas.setFillAlpha(0.5)
        canvas.setFillColorRGB(0.1, 0.3, 0.9)
        canvas.rect(30, 40, A4[0] - 60, A4[1] - 80, fill=1, stroke=0)
        canvas.save()
        with pikepdf.open(source, allow_overwriting_input=True) as pdf:
            pdf.pages[0].CropBox = [10, 10, A4[0] - 10, A4[1] - 10]
            pdf.pages[0].TrimBox = [20, 30, A4[0] - 20, A4[1] - 30]
            pdf.save(source)
        (work / "srgb.icc").write_bytes(
            ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
        )
        samples = {"before": [], "after": []}
        for index in range(args.runs):
            order = ("before", "after") if index % 2 == 0 else ("after", "before")
            for variant in order:
                sample_work = work / f"{variant}-{index}"
                sample_work.mkdir()
                completed = subprocess.run([
                    sys.executable, "-B", str(Path(__file__).resolve()),
                    "--child", variant, "--work", str(sample_work),
                    "--source", str(source), "--dpi", str(args.dpi),
                ], cwd=ROOT, capture_output=True, text=True, encoding="utf-8", timeout=60)
                if completed.returncode:
                    raise RuntimeError(completed.stdout + completed.stderr)
                samples[variant].append(json.loads(completed.stdout))
        baseline = samples["before"][0]
        for sample in samples["before"] + samples["after"]:
            assert sample["timed_artifact"] == baseline["timed_artifact"]
            assert sample["format_box_artifacts"] == baseline["format_box_artifacts"]
        summary = {}
        for variant, values in samples.items():
            summary[variant] = {
                "median_elapsed_ms": statistics.median(s["elapsed_ms"] for s in values),
                "median_page_lock_ms": statistics.median(s["page_lock_ms"] for s in values),
                "median_cmm_ms": statistics.median(s["cmm"]["ms"] for s in values),
                "median_competing_wait_ms": statistics.median(
                    s["competing_pdfium"]["wait_ms"] for s in values
                ),
                "cmm_lock_owned": [s["cmm"]["pdfium_lock_owned"] for s in values],
            }
        print(json.dumps({
            "scope": "process mới, source dev, CMM cold, filesystem cache không kiểm soát; không phải GUI/release/máy yếu thật",
            "n": args.runs,
            "baseline_ref": BASELINE,
            "fixture_sha256": _sha(source.read_bytes()),
            "harness_sha256": _sha(Path(__file__).read_bytes()),
            "artifact_parity": True,
            "summary": summary,
            "samples": samples,
        }, indent=2))


if __name__ == "__main__":
    main()
