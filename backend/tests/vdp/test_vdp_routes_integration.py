"""Integration test cho các route VDP mới (Tier-1) qua FastAPI ``TestClient``.

Phủ end-to-end các route nối ở task 13.1 (`backend/app/api/routes/vdp.py`),
mount dưới prefix ``/api/vdp``:

- POST ``/api/vdp/datasource``         — đọc CSV → cột + số record (Req 1.1).
- POST ``/api/vdp/datasource/sheets``  — liệt kê sheet của ``.xlsx`` (Req 1.3).
- POST ``/api/vdp/validate``           — gating ``block`` / ``allow`` (Req 5.8, 5.10)
  và XÁC NHẬN /validate KHÔNG sinh bất kỳ artifact PDF nào (Req 5.7).
- POST ``/api/vdp/preview``            — PNG base64 + field_errors (Req 4.1–4.6).
- POST ``/api/vdp/error-report``       — tải CSV báo cáo lỗi (Req 4.7).

Mọi route dùng ``Depends(require_license)``. Test bỏ qua xác thực license bằng
``app.dependency_overrides`` (không phụ thuộc DEV_MODE / sidecar token / Supabase).

**Validates: Requirements 5.7**
"""

import base64
import io
import json
import os

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.config import settings
from app.core.license_guard import require_license


# ─── Fixtures: client với license được override ──────────────────────────────


@pytest.fixture()
def client():
    """TestClient với ``require_license`` bị override để bỏ qua xác thực.

    Trả credential giả như chữ ký yêu cầu của dependency, để mọi route nối
    ``Depends(require_license)`` chạy được mà không cần sidecar token / Supabase.
    """
    app.dependency_overrides[require_license] = lambda: {
        "license_key": "test",
        "hwid": "test",
        "verified": True,
    }
    try:
        with TestClient(app) as c:
            yield c
    finally:
        app.dependency_overrides.pop(require_license, None)


# ─── Trợ giúp dựng nguồn dữ liệu trong bộ nhớ ────────────────────────────────


def _make_xlsx_bytes() -> bytes:
    """Dựng một workbook ``.xlsx`` nhiều sheet trong bộ nhớ bằng openpyxl."""
    from openpyxl import Workbook

    wb = Workbook()
    ws1 = wb.active
    ws1.title = "Khách hàng"
    ws1.append(["Tên", "Mã", "Số lượng"])
    ws1.append(["Nguyễn Văn A", "SP001", "10"])
    ws1.append(["Trần Thị B", "SP002", "20"])

    ws2 = wb.create_sheet("Sản phẩm")
    ws2.append(["SKU", "Giá"])
    ws2.append(["X1", "1000"])

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def _make_template_pdf_bytes() -> bytes:
    """Dựng một template PDF A6 một trang bằng reportlab (trong bộ nhớ)."""
    from reportlab.pdfgen import canvas
    from reportlab.lib.pagesizes import A6

    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A6)
    c.setFont("Helvetica", 12)
    c.drawString(20, 20, "TEMPLATE")
    c.showPage()
    c.save()
    return buf.getvalue()


def _text_field(field_id: str, name: str, text_content: str, *, x=5.0, y=5.0):
    """Tạo một VdpField text tối thiểu (mm theo đơn vị frontend)."""
    return {
        "id": field_id,
        "name": name,
        "type": "text",
        "x": x,
        "y": y,
        "width": 40.0,
        "height": 10.0,
        "textContent": text_content,
    }


# ─── /api/vdp/datasource (CSV) ───────────────────────────────────────────────


def test_datasource_csv_returns_columns_and_record_count(client):
    """POST /datasource với CSV (text) → 200, trả cột + số record (Req 1.1)."""
    csv_text = "Tên,Mã,Số lượng\nNguyễn Văn A,SP001,10\nTrần Thị B,SP002,20\n"
    resp = client.post(
        "/api/vdp/datasource",
        data={"kind": "csv", "text": csv_text, "has_header": "true"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["columns"] == ["Tên", "Mã", "Số lượng"]
    assert body["record_count"] == 2
    assert body["preview_rows"][0] == {
        "Tên": "Nguyễn Văn A",
        "Mã": "SP001",
        "Số lượng": "10",
    }


def test_datasource_csv_file_upload(client):
    """POST /datasource với file CSV tải lên → 200, cột + số record (Req 1.1)."""
    csv_bytes = "a,b,c\n1,2,3\n4,5,6\n7,8,9\n".encode("utf-8")
    resp = client.post(
        "/api/vdp/datasource",
        data={"kind": "csv"},
        files={"file": ("data.csv", csv_bytes, "text/csv")},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["columns"] == ["a", "b", "c"]
    assert body["record_count"] == 3


# ─── /api/vdp/datasource/sheets (XLSX) ───────────────────────────────────────


def test_datasource_sheets_lists_sheet_names(client):
    """POST /datasource/sheets với xlsx → 200, trả đúng danh sách tên sheet (Req 1.3)."""
    xlsx = _make_xlsx_bytes()
    resp = client.post(
        "/api/vdp/datasource/sheets",
        files={
            "file": (
                "book.xlsx",
                xlsx,
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            )
        },
    )
    assert resp.status_code == 200, resp.text
    sheets = resp.json()["sheets"]
    assert sheets == ["Khách hàng", "Sản phẩm"]


def test_datasource_reads_selected_xlsx_sheet(client):
    """POST /datasource (kind=xlsx) với sheet được chọn → đọc đúng dữ liệu sheet đó (Req 1.3)."""
    xlsx = _make_xlsx_bytes()
    resp = client.post(
        "/api/vdp/datasource",
        data={"kind": "xlsx", "sheet": "Sản phẩm"},
        files={
            "file": (
                "book.xlsx",
                xlsx,
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            )
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["columns"] == ["SKU", "Giá"]
    assert body["record_count"] == 1


# ─── /api/vdp/validate (gating + KHÔNG sinh PDF) ─────────────────────────────


def _list_pdf_artifacts() -> set:
    """Tập đường dẫn .pdf hiện có trong RESULTS_DIR và UPLOAD_DIR."""
    found = set()
    for d in (settings.RESULTS_DIR, settings.UPLOAD_DIR):
        if not d or not os.path.isdir(d):
            continue
        for name in os.listdir(d):
            if name.lower().endswith(".pdf"):
                found.add(os.path.join(d, name))
    return found


def test_validate_missing_column_blocks(client):
    """POST /validate với field tham chiếu cột thiếu → gating 'block' + issues (Req 5.8)."""
    fields = [_text_field("f1", "Thiếu", "{KhongCo}")]
    rows = [{"Name": "Alice"}, {"Name": "Bob"}]
    resp = client.post(
        "/api/vdp/validate",
        data={"fields": json.dumps(fields), "rows": json.dumps(rows)},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["gating"] == "block"
    assert len(body["issues"]) >= 1
    assert any(i["severity"] == "error" for i in body["issues"])


def test_validate_clean_allows(client):
    """POST /validate với cấu hình sạch → gating 'allow', không issue (Req 5.10)."""
    fields = [_text_field("f1", "Tên", "{Name}")]
    rows = [{"Name": "Alice"}, {"Name": "Bob"}]
    resp = client.post(
        "/api/vdp/validate",
        data={"fields": json.dumps(fields), "rows": json.dumps(rows)},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["gating"] == "allow"
    assert body["issues"] == []


def test_validate_does_not_create_pdf_artifact(client):
    """/validate KHÔNG sinh bất kỳ artifact PDF nào (Req 5.7).

    Chụp tập file .pdf trong RESULTS_DIR/UPLOAD_DIR trước và sau khi gọi
    /validate (cả ca block lẫn allow); không file PDF mới nào được tạo.
    """
    before = _list_pdf_artifacts()

    fields_block = [_text_field("f1", "Thiếu", "{KhongCo}")]
    rows = [{"Name": "Alice"}, {"Name": "Bob"}]
    r1 = client.post(
        "/api/vdp/validate",
        data={"fields": json.dumps(fields_block), "rows": json.dumps(rows)},
    )
    assert r1.status_code == 200, r1.text

    fields_ok = [_text_field("f1", "Tên", "{Name}")]
    r2 = client.post(
        "/api/vdp/validate",
        data={"fields": json.dumps(fields_ok), "rows": json.dumps(rows)},
    )
    assert r2.status_code == 200, r2.text

    after = _list_pdf_artifacts()
    new_pdfs = after - before
    assert new_pdfs == set(), f"/validate đã sinh artifact PDF không mong muốn: {new_pdfs}"


# ─── /api/vdp/preview ────────────────────────────────────────────────────────


def test_preview_returns_png_and_field_errors(client):
    """POST /preview với template PDF + fields + rows → 200, PNG base64 + field_errors (Req 4.1–4.6)."""
    template = _make_template_pdf_bytes()
    fields = [
        _text_field("f1", "Tên", "{Name}", x=5.0, y=5.0),       # có giá trị → vẽ bình thường
        _text_field("f2", "Trống", "{Blank}", x=5.0, y=20.0),   # giá trị rỗng → MISSING
    ]
    rows = [
        {"Name": "Alice", "Blank": ""},
        {"Name": "Bob", "Blank": ""},
    ]
    resp = client.post(
        "/api/vdp/preview",
        data={
            "fields": json.dumps(fields),
            "rows": json.dumps(rows),
            "requested_index": "1",
        },
        files={"template": ("tpl.pdf", template, "application/pdf")},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()

    # PNG base64 hợp lệ và là dữ liệu PNG thật (magic bytes).
    assert body["image_png_base64"]
    png = base64.b64decode(body["image_png_base64"])
    assert png[:8] == b"\x89PNG\r\n\x1a\n"

    assert body["record_index"] == 1
    assert body["clamped"] is False
    assert body["empty_source"] is False
    assert body["width"] > 0 and body["height"] > 0

    # field_errors là list và chứa MISSING cho field giá trị rỗng.
    assert isinstance(body["field_errors"], list)
    missing = [e for e in body["field_errors"] if e["kind"] == "MISSING"]
    assert any(e["field"] == "Trống" for e in missing)
    assert all({"x", "y", "w", "h"} <= set(e["rect"].keys()) for e in body["field_errors"])


def test_preview_clamps_out_of_range_index(client):
    """requested_index ngoài khoảng → kẹp về record cuối + cờ clamped (Req 4.5)."""
    template = _make_template_pdf_bytes()
    fields = [_text_field("f1", "Tên", "{Name}")]
    rows = [{"Name": "Alice"}, {"Name": "Bob"}]
    resp = client.post(
        "/api/vdp/preview",
        data={
            "fields": json.dumps(fields),
            "rows": json.dumps(rows),
            "requested_index": "99",
        },
        files={"template": ("tpl.pdf", template, "application/pdf")},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["record_index"] == 2  # kẹp về record cuối (total=2)
    assert body["clamped"] is True


# ─── /api/vdp/error-report ───────────────────────────────────────────────────


def test_error_report_returns_csv_download(client):
    """POST /error-report với issues JSON → 200, tải CSV chứa các dòng lỗi (Req 4.7)."""
    issues = [
        {"severity": "error", "record_idx": 0, "field": "Mã", "reason": "Cột thiếu"},
        {"severity": "warning", "record_idx": 3, "field": "Ảnh", "reason": "Không tìm thấy file"},
    ]
    resp = client.post(
        "/api/vdp/error-report",
        data={"issues": json.dumps(issues)},
    )
    assert resp.status_code == 200, resp.text
    assert "text/csv" in resp.headers["content-type"]
    assert "attachment" in resp.headers["content-disposition"]
    assert "vdp_error_report.csv" in resp.headers["content-disposition"]

    text = resp.content.decode("utf-8-sig")
    assert "Mã" in text
    assert "Cột thiếu" in text
    assert "Ảnh" in text
    # Mỗi issue sinh đúng một dòng dữ liệu (cộng dòng header).
    data_lines = [ln for ln in text.splitlines() if ln.strip()]
    assert len(data_lines) == 1 + len(issues)


def test_error_report_empty_issues_reports_no_errors(client):
    """POST /error-report với issues rỗng → CSV báo 'không phát hiện lỗi' (Req 4.8)."""
    resp = client.post(
        "/api/vdp/error-report",
        data={"issues": json.dumps([])},
    )
    assert resp.status_code == 200, resp.text
    text = resp.content.decode("utf-8-sig")
    assert "Không phát hiện lỗi" in text
