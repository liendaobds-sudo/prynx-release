"""PERF (audit 2026-09-28 §PERF28.02 A3): phản hồi JSON VDP ngoài event loop.

App ASGI fixture chỉ có router VDP và health; không gọi AI QC hoặc mạng thật.
Giữ nguyên jsonable_encoder, kể cả quy tắc lọc khóa `_sa` đang có của FastAPI.
"""

import asyncio
import csv
import io
import threading

from fastapi import FastAPI
from fastapi.encoders import jsonable_encoder
import fastapi.routing as routing
import httpx
import pytest
from starlette.responses import JSONResponse, Response

from app.api.routes import vdp
from app.core.license_guard import require_license


@pytest.fixture
def datasource_app():
    app = FastAPI()
    app.include_router(vdp.router, prefix="/api/vdp")

    async def fixture_license():
        return {"verified": True, "plan": "pro", "features": ["*"]}

    app.dependency_overrides[require_license] = fixture_license

    @app.get("/health")
    async def health():
        return Response(b'{"ok":true}', media_type="application/json")

    return app


def _csv_source(count=35, prefix="Khách"):
    buffer = io.StringIO(newline="")
    writer = csv.writer(buffer)
    writer.writerow(["Tên", "Mã", "_sa_hidden", "", "Tên"])
    for index in range(count):
        writer.writerow([f"{prefix} {index}", f"00{index}", "giữ hợp đồng cũ", "Hà Nội", 'dòng 1\ndòng "2"'])
    return buffer.getvalue().encode("utf-8")


def _source(kind):
    raw = _csv_source()
    if kind == "csv":
        return raw
    from openpyxl import Workbook

    workbook = Workbook(write_only=True)
    sheet = workbook.create_sheet("Khách hàng")
    for row in csv.reader(io.StringIO(raw.decode("utf-8"))):
        sheet.append(row)
    buffer = io.BytesIO()
    workbook.save(buffer)
    workbook.close()
    return buffer.getvalue()


def _expected_response(kind, raw, full, has_header=True):
    table = vdp.read_source(kind, raw, sheet="Khách hàng", has_header=has_header)
    payload = {"columns": table.columns, "record_count": len(table.rows), "preview_rows": table.rows[:20]}
    if full:
        payload["rows"] = table.rows
    return JSONResponse(jsonable_encoder(payload))


@pytest.mark.asyncio
@pytest.mark.parametrize("stage", ["encoder", "dumps"])
async def test_datasource_json_work_runs_off_event_loop(datasource_app, monkeypatch, stage):
    """Ca đỏ cũ: encode/dumps chạy trên chính thread ASGI dù parse đã offload."""
    loop_thread = threading.get_ident()
    calls = []
    original_render = JSONResponse.render

    def checked_encoder(payload, *args, **kwargs):
        calls.append(threading.get_ident())
        assert threading.get_ident() != loop_thread
        return jsonable_encoder(payload, *args, **kwargs)

    def checked_render(self, payload):
        calls.append(threading.get_ident())
        assert threading.get_ident() != loop_thread
        return original_render(self, payload)

    if stage == "encoder":
        monkeypatch.setattr(routing, "jsonable_encoder", checked_encoder)
        monkeypatch.setattr(vdp, "jsonable_encoder", checked_encoder, raising=False)
    else:
        monkeypatch.setattr(JSONResponse, "render", checked_render)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=datasource_app), base_url="http://fixture") as client:
        response = await client.post("/api/vdp/datasource", data={"kind": "csv", "include_all_rows": "true"},
                                     files={"file": ("data.csv", _csv_source())})
    assert response.status_code == 200 and len(calls) == 1
    assert len(response.json()["rows"]) == 35


@pytest.mark.asyncio
@pytest.mark.parametrize("full", [False, True])
async def test_datasource_health_progresses_while_json_encoder_waits(datasource_app, monkeypatch, full):
    """Health hoàn tất trước khi nhả encoder, không dựa ngưỡng thời gian render."""
    entered = threading.Event()
    release = threading.Event()
    finished = threading.Event()
    loop_thread = threading.get_ident()

    def blocked_encoder(payload, *args, **kwargs):
        assert threading.get_ident() != loop_thread
        entered.set()
        try:
            assert release.wait(5)
            return jsonable_encoder(payload, *args, **kwargs)
        finally:
            finished.set()

    monkeypatch.setattr(vdp, "jsonable_encoder", blocked_encoder, raising=False)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=datasource_app), base_url="http://fixture") as client:
        task = asyncio.create_task(client.post(
            "/api/vdp/datasource", data={"kind": "csv", "include_all_rows": str(full).lower()},
            files={"file": ("data.csv", _csv_source())},
        ))
        try:
            async def wait_for_encoder():
                while not entered.is_set() and not task.done():
                    await asyncio.sleep(0.001)
            await asyncio.wait_for(wait_for_encoder(), timeout=2)
            assert entered.is_set()
            health = await asyncio.wait_for(client.get("/health"), timeout=1)
            assert health.status_code == 200 and not finished.is_set() and not task.done()
        finally:
            release.set()
            result = await asyncio.gather(task, return_exceptions=True)
        assert isinstance(result[0], httpx.Response) and result[0].status_code == 200


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["csv", "xlsx"])
@pytest.mark.parametrize("full", [False, True])
async def test_datasource_response_bytes_headers_and_full_rows_match_old_contract(datasource_app, kind, full):
    """Giữ byte/header, Unicode, số 0 đầu, cột trùng/rỗng và `_sa` như trước."""
    raw = _source(kind)
    expected = _expected_response(kind, raw, full)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=datasource_app), base_url="http://fixture") as client:
        response = await client.post("/api/vdp/datasource", data={
            "kind": kind, "sheet": "Khách hàng", "include_all_rows": str(full).lower(),
        }, files={"file": (f"data.{kind}", raw)})
    assert response.status_code == 200 and response.content == expected.body
    assert response.headers["content-type"] == expected.headers["content-type"]
    assert response.headers["content-length"] == expected.headers["content-length"]
    body = response.json()
    assert body["record_count"] == 35 and len(body["preview_rows"]) == 20
    assert body["columns"] == ["Tên", "Mã", "_sa_hidden", "Cột 4", "Tên_2"]
    assert "_sa_hidden" not in body["preview_rows"][0]
    assert body["preview_rows"][0]["Mã"] == "000"
    assert body["preview_rows"][0]["Tên_2"] == 'dòng 1\ndòng "2"'
    assert (len(body["rows"]) == 35) if full else ("rows" not in body)


@pytest.mark.asyncio
async def test_datasource_without_header_keeps_every_row(datasource_app):
    raw = b"001,A\n002,B\n003,C\n"
    expected = _expected_response("csv", raw, True, has_header=False)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=datasource_app), base_url="http://fixture") as client:
        response = await client.post("/api/vdp/datasource", data={
            "kind": "csv", "has_header": "false", "include_all_rows": "true",
        }, files={"file": ("data.csv", raw)})
    assert response.content == expected.body
    assert response.json()["rows"][0] == {"Cột 1": "001", "Cột 2": "A"}


@pytest.mark.asyncio
@pytest.mark.parametrize("kind,raw", [("csv", b""), ("xlsx", b"not-an-xlsx")])
async def test_datasource_read_error_stays_400_and_retry_works(datasource_app, kind, raw):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=datasource_app), base_url="http://fixture") as client:
        failed = await client.post("/api/vdp/datasource", data={"kind": kind}, files={"file": (f"data.{kind}", raw)})
        assert failed.status_code == 400 and isinstance(failed.json()["detail"], str)
        succeeded = await client.post("/api/vdp/datasource", data={"kind": "csv"}, files={"file": ("data.csv", _csv_source())})
        assert succeeded.status_code == 200 and succeeded.json()["record_count"] == 35


@pytest.mark.asyncio
async def test_datasource_serialization_error_does_not_poison_worker(datasource_app, monkeypatch):
    calls = []

    def fail_once(payload, *args, **kwargs):
        calls.append(True)
        if len(calls) == 1:
            raise ValueError("lỗi encoder giả lập")
        return jsonable_encoder(payload, *args, **kwargs)

    monkeypatch.setattr(vdp, "jsonable_encoder", fail_once, raising=False)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=datasource_app, raise_app_exceptions=False), base_url="http://fixture") as client:
        for expected_status in (500, 200):
            response = await client.post("/api/vdp/datasource", data={"kind": "csv"}, files={"file": ("data.csv", _csv_source())})
            assert response.status_code == expected_status
    assert len(calls) == 2


@pytest.mark.asyncio
async def test_datasource_cancel_during_encoder_keeps_next_request_healthy(datasource_app, monkeypatch):
    """Hủy request không giết thread; đợi worker thu hồi rồi kiểm request sau."""
    entered = threading.Event()
    release = threading.Event()
    finished = threading.Event()

    def blocked_encoder(payload, *args, **kwargs):
        entered.set()
        try:
            assert release.wait(5)
            return jsonable_encoder(payload, *args, **kwargs)
        finally:
            finished.set()

    async def wait_for(event):
        while not event.is_set():
            await asyncio.sleep(0.001)

    monkeypatch.setattr(vdp, "jsonable_encoder", blocked_encoder, raising=False)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=datasource_app), base_url="http://fixture") as client:
        task = asyncio.create_task(client.post(
            "/api/vdp/datasource", data={"kind": "csv", "include_all_rows": "true"},
            files={"file": ("data.csv", _csv_source())},
        ))
        try:
            await asyncio.wait_for(wait_for(entered), timeout=2)
            task.cancel()
            assert (await asyncio.wait_for(client.get("/health"), timeout=1)).status_code == 200
        finally:
            release.set()
            outcome = await asyncio.gather(task, return_exceptions=True)
            await asyncio.wait_for(wait_for(finished), timeout=2)
        assert isinstance(outcome[0], asyncio.CancelledError)
        monkeypatch.setattr(vdp, "jsonable_encoder", jsonable_encoder)
        response = await client.post("/api/vdp/datasource", data={"kind": "csv"}, files={"file": ("data.csv", _csv_source())})
        assert response.status_code == 200 and response.json()["record_count"] == 35


@pytest.mark.asyncio
async def test_datasource_parallel_requests_do_not_mix_records(datasource_app):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=datasource_app), base_url="http://fixture") as client:
        responses = await asyncio.gather(*[client.post(
            "/api/vdp/datasource", data={"kind": "csv", "include_all_rows": "true"},
            files={"file": ("data.csv", _csv_source(101, prefix=prefix))},
        ) for prefix in ("A", "B")])
    for prefix, response in zip(("A", "B"), responses):
        assert response.status_code == 200 and response.json()["record_count"] == 101
        assert response.json()["rows"][-1]["Tên"] == f"{prefix} 100"
