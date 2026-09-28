"""PERF (audit 2026-09-28 §PERF28.02 A3): đo VDP qua ASGI, không AI QC.

FastAPI riêng chỉ gắn router VDP và license fixture trong process đo. Không nạp
app.main, mở server, gọi mạng, đọc token hoặc ghi kho dữ liệu của người dùng.
Baseline chỉ phục hồi hàm endpoint trả dict từ Git, giữ helper offload lô A1/A2.
Control chuyển jsonable_encoder + JSONResponse sang worker, chưa sửa parser.
"""

from __future__ import annotations

import argparse
import ast
from contextlib import contextmanager, ExitStack
import csv
import gc
from functools import wraps
import hashlib
import io
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
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "backend"))
BASELINE = "bc3d6d5b1761e5c5309eb589ec6eb58ac31b3f58"
ROUTE_PATH = "backend/app/api/routes/vdp.py"


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class Trace:
    def __init__(self):
        self.events = []
        self.started = time.perf_counter()
        self.loop_thread = threading.get_ident()

    @contextmanager
    def span(self, name, **extra):
        begin = time.perf_counter()
        try:
            yield
        finally:
            self.events.append({
                "stage": name, "start_ms": (begin - self.started) * 1000,
                "ms": (time.perf_counter() - begin) * 1000,
                "on_loop": threading.get_ident() == self.loop_thread, **extra,
            })


def fixtures():
    from openpyxl import Workbook

    columns = ["id", "Tên", "Mã", "city", "group", "_sa_debug"]

    def row(index):
        return [str(index), f"Khách {index}", f"00{index:06d}", "Hà Nội", f"G{index % 10}", "giữ parity cũ"]

    csv_buffer = io.StringIO(newline="")
    writer = csv.writer(csv_buffer)
    writer.writerow(columns)
    writer.writerows(row(index) for index in range(100_000))
    workbook = Workbook(write_only=True)
    sheet = workbook.create_sheet("Data")
    sheet.append(columns)
    for index in range(10_000):
        sheet.append(row(index))
    buffer = io.BytesIO()
    workbook.save(buffer)
    workbook.close()
    return {"xlsx": buffer.getvalue(), "csv": csv_buffer.getvalue().encode("utf-8")}


async def run(args, work):
    import asyncio
    import fastapi.routing as routing
    from fastapi import APIRouter, FastAPI
    from fastapi.encoders import jsonable_encoder
    import httpx
    from starlette.concurrency import run_in_threadpool
    from starlette.responses import JSONResponse
    from app.api.routes import vdp
    from app.core.license_guard import require_license
    from app.workers import vdp_datasource as datasource

    assert "app.main" not in sys.modules and "app.api.routes.qc" not in sys.modules
    sources = fixtures()
    original_source = subprocess.check_output(
        ["git", "show", f"{BASELINE}:{ROUTE_PATH}"], cwd=ROOT,
    ).decode("utf-8")
    node = next(node for node in ast.parse(original_source).body
                if isinstance(node, ast.AsyncFunctionDef) and node.name == "read_datasource")
    node.decorator_list = []
    namespace = vdp.__dict__.copy()
    exec(compile(ast.Module(body=[node], type_ignores=[]), "<dict-endpoint-baseline>", "exec"), namespace)
    baseline = namespace["read_datasource"]
    current = vdp.read_datasource
    selected = args.variants.split(",")
    if not set(selected) <= {"before", "control", "after"}:
        raise ValueError("variants chỉ gồm before,control,after")
    active_trace = None

    def sync_stage(name, func):
        def wrapped(*call_args, **kwargs):
            if active_trace is None:
                return func(*call_args, **kwargs)
            with active_trace.span(name):
                return func(*call_args, **kwargs)
        return wrapped

    encoded = sync_stage("jsonable_encoder", jsonable_encoder)

    def encode_response(result):
        return JSONResponse(encoded(result))

    def dispose_table(table):
        # Đo việc bỏ reference rows đúng lúc object bị thu hồi. Không clear()
        # list còn được full-response dùng chung, không giữ thêm reference rows.
        if not hasattr(table, "rows"):
            return
        if active_trace is None:
            del table.rows
            return
        with active_trace.span(
            "table_drop_rows_ref", rows=len(table.rows),
            sole_list_owner=sys.getrefcount(table.rows) == 2,
        ):
            del table.rows

    gc_active = {}

    def trace_gc(phase, info):
        key = threading.get_ident(), info["generation"]
        if active_trace is None:
            return
        if phase == "start":
            gc_active[key] = (active_trace, time.perf_counter())
        elif key in gc_active:
            trace, begin = gc_active.pop(key)
            trace.events.append({
                "stage": "gc", "start_ms": (begin - trace.started) * 1000,
                "ms": (time.perf_counter() - begin) * 1000,
                "on_loop": key[0] == trace.loop_thread, "generation": key[1],
            })

    apps = {}
    for variant in selected:
        app = FastAPI()

        async def fixture_license():
            return {"license_key": "TEST-PRO", "hwid": "TEST-HWID", "verified": True,
                    "plan": "pro", "features": ["*"]}

        app.dependency_overrides[require_license] = fixture_license

        def make_endpoint(mode):
            @wraps(current)
            async def endpoint(**kwargs):
                with active_trace.span("handler"):
                    if mode == "before":
                        return await baseline(**kwargs)
                    if mode == "control":
                        result = await baseline(**kwargs)
                        return await run_in_threadpool(encode_response, result)
                    return await current(**kwargs)
            return endpoint

        # Chỉ gắn endpoint VDP cần đo với cùng signature/dependency Form/File.
        # Dùng API công khai, không sửa route internals của FastAPI mới/cũ.
        router = APIRouter()
        router.add_api_route("/datasource", make_endpoint(variant), methods=["POST"])
        app.include_router(router, prefix="/api/vdp")
        apps[variant] = app

    async def one(variant, kind, full):
        nonlocal active_trace
        ticks = []
        running = True

        async def heartbeat():
            while running:
                ticks.append(time.perf_counter())
                await asyncio.sleep(0.005)

        task = asyncio.create_task(heartbeat())
        await asyncio.sleep(0.035)
        trace = Trace()
        active_trace = trace
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=apps[variant]), base_url="http://fixture") as client:
            begin = time.perf_counter()
            response = await client.post("/api/vdp/datasource", data={
                "kind": kind, "sheet": "Data", "include_all_rows": str(full).lower(),
            }, files={"file": (f"data.{kind}", sources[kind])})
            elapsed_ms = (time.perf_counter() - begin) * 1000
        await asyncio.sleep(0.035)
        active_trace = None
        running = False
        await task
        assert response.status_code == 200, response.text
        # Decode/verify sau khi đã dừng timer; không gán chi phí client JSON cho server.
        body = response.json()
        count = 10_000 if kind == "xlsx" else 100_000
        assert body["record_count"] == count and len(body["preview_rows"]) == 20
        assert body["columns"] == ["id", "Tên", "Mã", "city", "group", "_sa_debug"]
        assert body["preview_rows"][0]["Tên"] == "Khách 0"
        assert body["preview_rows"][0]["Mã"] == "00000000"
        assert "_sa_debug" not in body["preview_rows"][0]
        if full:
            assert len(body["rows"]) == count and body["rows"][-1]["id"] == str(count - 1)
        else:
            assert "rows" not in body
        gaps = [(b - a) * 1000 for a, b in zip(ticks, ticks[1:])]
        stages = [event for event in trace.events if event["stage"] != "gc"]
        gc_events = [event for event in trace.events if event["stage"] == "gc"]
        return {
            "elapsed_ms": elapsed_ms, "max_heartbeat_gap_ms": max(gaps, default=0),
            "response_bytes": len(response.content), "response_sha256": sha(response.content),
            "content_type": response.headers["content-type"],
            "content_length": response.headers["content-length"], "status": response.status_code,
            "stages": stages,
            "gc": {"count": len(gc_events), "sum_ms": sum(event["ms"] for event in gc_events),
                   "max_ms": max((event["ms"] for event in gc_events), default=0)},
        }

    samples = {}
    with ExitStack() as stack:
        for name in ("detect_encoding", "_first_non_empty_line", "parse_delimited", "_rows_to_table", "read_xlsx"):
            stack.enter_context(patch.object(datasource, name, sync_stage(name, getattr(datasource, name))))
        # Baseline hàm được compile dùng namespace riêng; hai alias cần cùng wrapper.
        measured_reader = sync_stage("read_source", vdp.read_source)
        stack.enter_context(patch.object(vdp, "read_source", measured_reader))
        stack.enter_context(patch.object(routing, "jsonable_encoder", encoded))
        stack.enter_context(patch.object(JSONResponse, "render", sync_stage("json_dumps", JSONResponse.render)))
        stack.enter_context(patch.object(datasource.RecordTable, "__del__", dispose_table, create=True))
        if hasattr(vdp, "jsonable_encoder"):
            stack.enter_context(patch.object(vdp, "jsonable_encoder", encoded))
        gc.callbacks.append(trace_gc)
        try:
            for index in range(args.runs):
                order = selected if index % 2 == 0 else selected[::-1]
                for kind in ("xlsx", "csv"):
                    for full in (False, True):
                        case = f"{kind}_{'full' if full else 'preview'}"
                        samples.setdefault(case, {variant: [] for variant in selected})
                        for variant in order:
                            samples[case][variant].append(await one(variant, kind, full))
        finally:
            gc.callbacks.remove(trace_gc)
    summary = {}
    for case, variants in samples.items():
        expected = next(iter(variants.values()))[0]
        summary[case] = {}
        for variant, values in variants.items():
            for sample in values:
                for key in ("response_sha256", "response_bytes", "content_type", "content_length", "status"):
                    assert sample[key] == expected[key], (case, variant, key)
            summary[case][variant] = {
                "median_elapsed_ms": statistics.median(s["elapsed_ms"] for s in values),
                "median_max_heartbeat_gap_ms": statistics.median(s["max_heartbeat_gap_ms"] for s in values),
                "response_bytes": expected["response_bytes"], "response_sha256": expected["response_sha256"],
            }
    return {
        "scope": "isolated ASGI only; XLSX active UI chain, CSV API stress only; no GUI or p95",
        "disposal_instrumentation": "del rows attribute at table finalization; does not clear aliased full-response rows",
        "timing_note": "nested stage spans overlap; thread elapsed is not exact GIL hold time; client JSON excluded",
        "n": args.runs, "parity": True, "baseline_ref": BASELINE,
        "source_sha256": sha((ROOT / ROUTE_PATH).read_bytes()),
        "parser_sha256": sha((ROOT / "backend/app/workers/vdp_datasource.py").read_bytes()),
        "harness_sha256": sha(Path(__file__).read_bytes()),
        "fixtures": {kind: {"bytes": len(data), "sha256": sha(data)} for kind, data in sources.items()},
        "summary": summary, "samples": samples,
    }


def main():
    import asyncio

    parser = argparse.ArgumentParser()
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--variants", default="before,control,after")
    args = parser.parse_args()
    if args.runs < 1:
        parser.error("runs phải dương")
    original_cwd = Path.cwd()
    with tempfile.TemporaryDirectory(prefix="prynx_vdp_a3_") as temp:
        work = Path(temp)
        # license_guard có thể tiêu thụ/xóa token-file khi import; chỉ dùng fixture.
        os.environ.pop("PRYNX_TOKEN_FILE", None)
        os.environ.pop("PRYNX_TOKEN_SOURCE", None)
        os.environ.pop("PRYNX_SIDECAR_TOKEN", None)
        os.environ.update({
            "DEV_MODE": "false", "IS_DESKTOP_APP": "false", "DATABASE_URL": "sqlite:///:memory:",
            "UPLOAD_DIR": str(work / "uploads"), "RESULTS_DIR": str(work / "results"),
            "PRYNX_MIXED_NESTING_DATA_DIR": str(work / "mixed"),
            "APPDATA": str(work / "appdata"), "LOCALAPPDATA": str(work / "localappdata"),
            "USERPROFILE": str(work / "profile"),
        })
        os.chdir(work)
        logging.disable(logging.CRITICAL)
        try:
            print(json.dumps(asyncio.run(run(args, work)), indent=2))
        finally:
            os.chdir(original_cwd)


if __name__ == "__main__":
    main()
