"""PERF (audit 2026-09-28 §PERF28.01/02): API vẫn phản hồi khi xử lý dữ liệu.

Chạy router/middleware thật qua ASGI trong cùng event loop, không mở server hay
gọi mạng. Gate do event loop nhả chứng minh health hoàn tất TRƯỚC worker, không
dùng ngưỡng mili-giây mong manh để thay thế kiểm tra thứ tự.
"""

import asyncio
import io
import json
import threading

import httpx
import pytest

from app.api.routes import qc, vdp
from app.main import app
from app.workers.vdp_datasource import DataSourceError, RecordTable
from app.workers.vdp_validate import Issue


class WorkerGate:
    """Giữ lời gọi đồng bộ đến khi request khác đã đi hết vòng HTTP ASGI."""

    def __init__(self, result):
        self.result = result
        self.entered = threading.Event()
        self.release = threading.Event()
        self.finished = threading.Event()
        self.thread_id = None
        self.calls = []

    def __call__(self, *args, **kwargs):
        self.thread_id = threading.get_ident()
        self.calls.append((args, kwargs))
        self.entered.set()
        try:
            if not self.release.wait(2):
                raise RuntimeError("Event loop không nhả được worker kiểm thử")
            return self.result
        finally:
            self.finished.set()


@pytest.mark.asyncio
@pytest.mark.parametrize("case", [
    "qc-openai", "qc-gemini", "qc-deepseek", "csv", "xlsx", "gsheet",
    "sheets", "rows", "validate", "error-report",
])
async def test_http_health_completes_while_worker_pending(monkeypatch, case):
    rows = [{"Tên": f"Khách {i}"} for i in range(35)]
    table = RecordTable(columns=["Tên"], rows=rows)
    request = {"data": {"fields": "[]", "rows": json.dumps(rows)}}
    path = "/api/vdp/validate"
    module, name, result = vdp, "validate_batch", []
    if case.startswith("qc-"):
        module, name, result = qc.LLMChecker, "check_text_cloud", ["Lỗi thử"]
        path = "/api/qc/check-text"
        request = {"json": {"text": "  Bản in  ", "api_key": "fixture", "llm_mode": case[3:]}}
    elif case in {"csv", "xlsx", "gsheet"}:
        name, result = "read_source", table
        path = "/api/vdp/datasource"
        request = {"data": {"kind": case, "include_all_rows": "true", "has_header": "false"}}
        if case == "xlsx":
            request["files"] = {"file": ("data.xlsx", b"fixture-bytes")}
            request["data"]["sheet"] = "Khách hàng"
        elif case == "gsheet":
            request["data"]["url"] = "https://docs.google.com/spreadsheets/d/fixture/edit"
        else:
            request["data"]["text"] = "Tên\nKhách hàng"
    elif case == "sheets":
        name, result = "list_xlsx_sheets", ["Khách hàng", "Sản phẩm"]
        path = "/api/vdp/datasource/sheets"
        request = {"files": {"file": ("data.xlsx", b"fixture-bytes")}}
    elif case == "rows":
        name, result = "_table_from_rows", table
    elif case == "error-report":
        path = "/api/vdp/error-report"
        result = [Issue("warning", 34, "Tên", "Ảnh còn thiếu")]

    gate = WorkerGate(result)
    monkeypatch.setattr(module, name, gate)
    loop_thread = threading.get_ident()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        task = asyncio.create_task(client.post(path, **request))
        try:
            async def wait_entered():
                while not gate.entered.is_set() and not task.done():
                    await asyncio.sleep(0.001)

            await asyncio.wait_for(wait_entered(), timeout=5)
            assert gate.entered.is_set(), (await task).text
            assert gate.thread_id != loop_thread
            assert not gate.finished.is_set()
            health = await asyncio.wait_for(client.get("/health"), timeout=1)
            assert health.status_code == 200, health.text
            assert not task.done()
            # Hai tầng khác nhau: QC/data đang chờ không chặn validator còn lại.
            if case.startswith("qc-") or case in {"csv", "xlsx", "gsheet", "sheets"}:
                other = await asyncio.wait_for(client.post(
                    "/api/vdp/validate", data={"fields": "[]", "rows": '[{"Tên":"Khác"}]'},
                ), timeout=1)
                assert other.status_code == 200 and other.json()["gating"] == "allow"
                assert not task.done()
        finally:
            gate.release.set()
            # Thu hồi cả task lỗi để không rò tác vụ sang test kế tiếp.
            outcome = await asyncio.gather(task, return_exceptions=True)

    response = outcome[0]
    assert isinstance(response, httpx.Response), response
    assert response.status_code == 200, response.text
    assert len(gate.calls) == 1
    args, kwargs = gate.calls[0]
    if case.startswith("qc-"):
        assert response.json() == {"errors": ["Lỗi thử"]}
        assert kwargs == {"text": "Bản in", "api_key": "fixture", "provider": case[3:]}
    elif case in {"csv", "xlsx", "gsheet"}:
        body = response.json()
        assert body == {"columns": ["Tên"], "record_count": 35, "preview_rows": rows[:20], "rows": rows}
        assert args[0] == case
        assert kwargs == {"sheet": "Khách hàng" if case == "xlsx" else None, "has_header": False}
        if case == "xlsx":
            assert args[1] == b"fixture-bytes"
    elif case == "sheets":
        assert args == (b"fixture-bytes",)
        assert response.json() == {"sheets": result}
    elif case == "error-report":
        assert response.content.startswith(b"\xef\xbb\xbf")
        assert "34,Tên,Ảnh còn thiếu" in response.text
    else:
        assert response.json() == {"gating": "allow", "issues": []}


@pytest.mark.asyncio
@pytest.mark.parametrize("provider", ["openai", "gemini", "deepseek"])
@pytest.mark.parametrize("failure", [None, "timeout", "status"])
async def test_qc_real_checker_preserves_provider_response_and_errors(monkeypatch, provider, failure):
    """Chỉ giả transport; parser/timeout/error contract vẫn là checker thật."""
    calls = []
    loop_thread = threading.get_ident()

    class FakeClient:
        def __init__(self, **kwargs):
            assert kwargs == {"timeout": 60.0}

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def post(self, url, **kwargs):
            calls.append((threading.get_ident(), url, kwargs))
            if failure == "timeout":
                raise httpx.ReadTimeout("Hết giờ giả lập")
            payload = ({"candidates": [{"content": {"parts": [{"text": "- lỗi một\n- lỗi hai"}]}}]}
                       if provider == "gemini" else {"choices": [{"message": {"content": "- lỗi một\n- lỗi hai"}}]})
            return httpx.Response(503 if failure == "status" else 200,
                                  request=httpx.Request("POST", url), json=payload)

    monkeypatch.setattr("app.core.llm_checker.httpx.Client", FakeClient)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/api/qc/check-text", json={
            "text": "Bản in", "api_key": "fixture", "llm_mode": provider,
        })
    assert response.status_code == 200
    assert len(calls) == 1 and calls[0][0] != loop_thread
    expected_host = {"gemini": "generativelanguage.googleapis.com", "openai": "api.openai.com", "deepseek": "api.deepseek.com"}
    assert httpx.URL(calls[0][1]).host == expected_host[provider]
    if failure:
        assert response.json()["errors"][0].startswith(f"Lỗi kết nối API ({provider}):")
    else:
        assert response.json() == {"errors": ["lỗi một", "lỗi hai"]}


@pytest.mark.asyncio
@pytest.mark.parametrize("payload,status", [
    ({"text": "   ", "api_key": "fixture", "llm_mode": "openai"}, 400),
    ({"text": "Bản in", "api_key": "", "llm_mode": "openai"}, 400),
    ({"text": "Bản in", "api_key": "fixture", "llm_mode": "off"}, 200),
    ({"text": "Bản in", "api_key": "fixture", "llm_mode": "unknown"}, 400),
])
async def test_qc_rejected_or_disabled_input_never_starts_worker(monkeypatch, payload, status):
    def forbidden(*args, **kwargs):
        pytest.fail("Input không hợp lệ không được gọi nhà cung cấp")

    monkeypatch.setattr(qc.LLMChecker, "check_text_cloud", forbidden)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/api/qc/check-text", json=payload)
    assert response.status_code == status, response.text


@pytest.mark.asyncio
@pytest.mark.parametrize("sheets", [False, True])
async def test_datasource_error_keeps_400_and_next_request_succeeds(monkeypatch, sheets):
    calls = 0

    def flaky(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise DataSourceError("XLSX_INVALID", "Nguồn lỗi giả lập")
        return ["Sheet1"] if sheets else RecordTable(["Tên"], [{"Tên": "Khách"}])

    monkeypatch.setattr(vdp, "list_xlsx_sheets" if sheets else "read_source", flaky)
    path = "/api/vdp/datasource" + ("/sheets" if sheets else "")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        for status in [400, 200]:
            response = await client.post(path, data={"kind": "xlsx"}, files={"file": ("x.xlsx", b"fixture")})
            assert response.status_code == status, response.text
            if status == 400:
                assert response.json() == {"detail": "Nguồn lỗi giả lập"}
    assert calls == 2


@pytest.mark.asyncio
async def test_real_xlsx_parallel_sheets_keep_all_rows_and_unicode():
    from openpyxl import Workbook

    workbook = Workbook()
    for index, name in enumerate(["Khách hàng", "Sản phẩm"]):
        sheet = workbook.active if index == 0 else workbook.create_sheet()
        sheet.title = name
        sheet.append(["Tên", "Mã"])
        for row in range(35):
            sheet.append([f"{name} {row}", f"00{row}"])
    data = io.BytesIO()
    workbook.save(data)
    workbook.close()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        responses = await asyncio.gather(*[
            client.post("/api/vdp/datasource", data={"kind": "xlsx", "sheet": name, "include_all_rows": "true"},
                        files={"file": ("data.xlsx", data.getvalue())})
            for name in ["Khách hàng", "Sản phẩm"]
        ])
    for name, response in zip(["Khách hàng", "Sản phẩm"], responses):
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["record_count"] == 35 and len(body["preview_rows"]) == 20
        assert body["rows"] == [{"Tên": f"{name} {i}", "Mã": f"00{i}"} for i in range(35)]


@pytest.mark.asyncio
@pytest.mark.parametrize("rows,columns", [("{}", None), ("not-json", None), ('[{"Tên":"A"}]', "not-json")])
async def test_invalid_rows_and_columns_still_return_400(rows, columns):
    data = {"fields": "[]", "rows": rows}
    if columns is not None:
        data["columns"] = columns
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/api/vdp/validate", data=data)
    assert response.status_code == 400, response.text


@pytest.mark.asyncio
@pytest.mark.parametrize("case", ["qc", "datasource"])
async def test_cancelled_request_does_not_poison_health_or_next_request(monkeypatch, case):
    """Hủy coroutine không giết thread; worker chỉ giữ dữ liệu riêng của request."""
    result = [] if case == "qc" else RecordTable(["Tên"], [{"Tên": "Khách"}])
    gate = WorkerGate(result)
    module, name = (qc.LLMChecker, "check_text_cloud") if case == "qc" else (vdp, "read_source")
    monkeypatch.setattr(module, name, gate)
    path = "/api/qc/check-text" if case == "qc" else "/api/vdp/datasource"
    request = ({"json": {"text": "Bản in", "api_key": "fixture", "llm_mode": "openai"}}
               if case == "qc" else {"data": {"kind": "csv", "text": "Tên\nKhách"}})
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        task = asyncio.create_task(client.post(path, **request))
        try:
            async def wait_for_event(event):
                while not event.is_set():
                    await asyncio.sleep(0.001)

            await asyncio.wait_for(wait_for_event(gate.entered), timeout=1)
            assert gate.thread_id != threading.get_ident()
            task.cancel()
            health = await asyncio.wait_for(client.get("/health"), timeout=1)
            assert health.status_code == 200
        finally:
            gate.release.set()
            cancelled = (await asyncio.gather(task, return_exceptions=True))[0]
            await asyncio.wait_for(wait_for_event(gate.finished), timeout=1)
        assert isinstance(cancelled, asyncio.CancelledError)
        monkeypatch.setattr(module, name, lambda *args, **kwargs: result)
        response = await client.post(path, **request)
        assert response.status_code == 200, response.text
