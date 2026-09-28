"""Probe audit độc lập; không sửa source sản phẩm, không gọi mạng thật.

Chạy bằng backend/venv/Scripts/python.exe -B docs/audit/PERF_2026-09-28/probe.py.
Mọi PDF/DB/ảnh phát sinh ở TemporaryDirectory riêng, không khởi động server.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import ctypes
import hashlib
import io
import json
import logging
import os
from pathlib import Path
import statistics
import sys
import tempfile
import threading
import time
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "backend"))


async def measure(factory):
    """Đo gap heartbeat cùng event loop; không cộng thời gian chuẩn bị fixture."""
    ticks = []
    running = True

    async def heartbeat():
        while running:
            ticks.append(time.perf_counter())
            await asyncio.sleep(0.005)

    task = asyncio.create_task(heartbeat())
    await asyncio.sleep(0.03)
    begin = time.perf_counter()
    result = await factory()
    elapsed = time.perf_counter() - begin
    await asyncio.sleep(0.03)
    running = False
    await task
    gaps = [(b - a) * 1000 for a, b in zip(ticks, ticks[1:])]
    return result, {
        "elapsed_ms": round(elapsed * 1000, 3),
        "max_heartbeat_gap_ms": round(max(gaps, default=0), 3),
    }


def summarize(samples):
    return {
        "n": len(samples),
        "median_elapsed_ms": statistics.median(s["elapsed_ms"] for s in samples),
        "median_max_heartbeat_gap_ms": statistics.median(
            s["max_heartbeat_gap_ms"] for s in samples
        ),
        "samples": samples,
    }


async def route_probes(work):
    from app.api.routes import qc, vdp
    from app.schemas.qc import TextQcRequest
    from app.core import system_memory
    from reportlab.pdfgen.canvas import Canvas
    from PIL import Image

    output = {}
    _, idle = await measure(lambda: asyncio.sleep(0.25))
    output["idle_control"] = idle

    class FakeResponse:
        def raise_for_status(self):
            pass

        def json(self):
            return {"choices": [{"message": {"content": ""}}]}

    class FakeClient:
        def __init__(self, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def post(self, *args, **kwargs):
            time.sleep(0.25)
            return FakeResponse()

    qc_samples = []
    # Chỉ transport được mô phỏng; chạy route + LLMChecker thật.
    with patch("app.core.llm_checker.httpx.Client", FakeClient):
        for _ in range(3):
            result, sample = await measure(lambda: qc.check_text(
                TextQcRequest(text="Mau kiem tra", llm_mode="deepseek", api_key="fixture"),
                license_info={},
            ))
            assert result.errors == []
            qc_samples.append(sample)
        from app.core.llm_checker import LLMChecker
        _, control = await measure(lambda: asyncio.to_thread(
            LLMChecker.check_text_cloud, "Mau kiem tra", "fixture", "deepseek"
        ))
    output["qc_cloud_sync_transport_250ms"] = summarize(qc_samples)
    output["qc_offload_control_only_not_production"] = control

    # CSV thuần tổng hợp, 100.000 dòng/6 cột, cùng payload lặp ba lần.
    csv_text = "id,name,code,city,price,group\n" + "".join(
        f"{i},Record {i},C{i:06d},City,{i % 1000},G{i % 10}\n" for i in range(100_000)
    )
    csv_samples = []
    for _ in range(3):
        result, sample = await measure(lambda: vdp.read_datasource(
            kind="csv", file=None, url=None, text=csv_text, sheet=None,
            has_header=True, include_all_rows=False, license_info={},
        ))
        assert result["record_count"] == 100_000
        assert len(result["preview_rows"]) == 20
        csv_samples.append(sample)
    output["vdp_csv_100000_rows"] = {
        "utf8_bytes": len(csv_text.encode()), **summarize(csv_samples)
    }

    # Excel là đường gọi thật từ UI; không tính thời gian tạo fixture vào số đo.
    from openpyxl import Workbook
    from starlette.datastructures import UploadFile
    workbook = Workbook(write_only=True)
    worksheet = workbook.create_sheet("Audit")
    worksheet.append(["id", "name", "code", "city", "price", "group"])
    for index in range(10_000):
        worksheet.append([index, f"Record {index}", f"C{index:06d}", "City", index % 1000, "G1"])
    xlsx_buffer = io.BytesIO()
    workbook.save(xlsx_buffer)
    workbook.close()
    xlsx_bytes = xlsx_buffer.getvalue()
    xlsx_samples = []
    for _ in range(3):
        upload = UploadFile(file=io.BytesIO(xlsx_bytes), filename="audit.xlsx")
        try:
            result, sample = await measure(lambda: vdp.read_datasource(
                kind="xlsx", file=upload, url=None, text=None, sheet="Audit",
                has_header=True, include_all_rows=False, license_info={},
            ))
            assert result["record_count"] == 10_000
            assert len(result["preview_rows"]) == 20
            xlsx_samples.append(sample)
        finally:
            await upload.close()
    output["vdp_xlsx_10000_rows"] = {
        "fixture_bytes": len(xlsx_bytes), **summarize(xlsx_samples)
    }

    source = work / "template.pdf"
    canvas = Canvas(str(source), pagesize=(595, 842))
    canvas.setFillColorRGB(0.2, 0.4, 0.8)
    canvas.rect(20, 20, 555, 802, fill=1, stroke=0)
    canvas.save()
    preview_samples = []
    preview_hashes = []
    fields = json.dumps([{
        "id": "sample", "name": "name", "type": "text",
        "x": 20, "y": 20, "width": 80, "height": 15,
        "fontSize": 12, "textContent": "{{name}}",
    }])
    for _ in range(3):
        result, sample = await measure(lambda: vdp.preview_vdp(
            fields=fields, requested_index=1, template=None, template_path=str(source),
            kind=None, file=None, url=None, text=None, sheet=None, has_header=True,
            rows='[{"name":"Audit sample"}]', columns='["name"]', rows_file=None,
            scale=2.0, license_info={},
        ))
        raw = base64.b64decode(result["image_png_base64"])
        with Image.open(io.BytesIO(raw)) as image:
            assert image.size == (result["width"], result["height"])
            assert image.size == (1190, 1684)
            image.verify()
        preview_hashes.append(hashlib.sha256(raw).hexdigest())
        preview_samples.append(sample)
    output["vdp_real_preview_one_record"] = {
        "image_size": [1190, 1684], "png_hashes": preview_hashes,
        **summarize(preview_samples),
    }

    policies = []
    for total_mb in [8192, 8192 - 240, 16384, 16384 - 240, 32768, 32768 - 240]:
        with patch.object(system_memory, "read_memory_status_mb", return_value=(total_mb, min(12000, total_mb * 0.75))):
            workers, reason = system_memory.plan_worker_count(
                kind="audit", per_worker_mb=256, cpu_count=16
            )
            policies.append({"usable_mb": total_mb, "workers": workers, "reason": reason})
    output["worker_policy_reserved_ram_boundary"] = policies

    # Chỉ quan sát ownership của khóa trong CMM, không sửa thuật toán/ảnh.
    from app.api.routes.export import render_pdf_to_images
    from app.core.pdfium_lock import PDFIUM_PY_LOCK
    from PIL import ImageCms
    original_transform = ImageCms.applyTransform
    transforms = []

    def measured_transform(*args, **kwargs):
        begin = time.perf_counter()
        owns = PDFIUM_PY_LOCK._is_owned()
        result = original_transform(*args, **kwargs)
        transforms.append({
            "lock_owned": owns,
            "elapsed_ms": round((time.perf_counter() - begin) * 1000, 3),
        })
        return result

    with patch.object(ImageCms, "applyTransform", measured_transform):
        for _ in range(3):
            files = render_pdf_to_images(
                str(source), str(work / "images"), fmt="png", dpi=300, color_mode="gray"
            )
            with Image.open(files[0]) as image:
                assert image.mode == "L"
                image.verify()
    output["gray_export_transform_inside_pdfium_lock"] = transforms
    return output


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["routes", "import"], default="routes")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="prynx_perf_audit_20260928_") as tmp:
        work = Path(tmp).resolve()
        assert work.name.startswith("prynx_perf_audit_20260928_")
        os.environ.update({
            "DEV_MODE": "false", "DATABASE_URL": "sqlite:///:memory:",
            "UPLOAD_DIR": str(work / "uploads"), "RESULTS_DIR": str(work / "results"),
            "PRYNX_MIXED_NESTING_DATA_DIR": str(work / "mixed"),
        })
        os.environ.pop("PRYNX_TOKEN_SOURCE", None)
        logging.disable(logging.CRITICAL)
        if args.mode == "import":
            started = time.perf_counter()
            from app.main import app
            print(json.dumps({
                "import_ms": round((time.perf_counter() - started) * 1000, 3),
                "routes": len(app.routes),
                "eager_modules": [name for name in [
                    "cv2", "numpy", "pikepdf", "pypdf", "pdfplumber", "httpx",
                    "reportlab", "openpyxl", "scipy", "pypdfium2", "pdfcompare_native",
                ] if name in sys.modules],
            }))
        else:
            from app.core.system_memory import read_memory_status_mb
            installed_kib = ctypes.c_ulonglong()
            ctypes.windll.kernel32.GetPhysicallyInstalledSystemMemory(ctypes.byref(installed_kib))
            output = {
                "cpu": os.cpu_count(), "memory_mib": read_memory_status_mb(),
                "installed_mib": installed_kib.value / 1024,
                "main_thread_id": threading.get_ident(),
                "scope": "in-process route/real synthetic artifacts; not GUI or installed runtime",
                **asyncio.run(route_probes(work)),
            }
            print(json.dumps(output, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
