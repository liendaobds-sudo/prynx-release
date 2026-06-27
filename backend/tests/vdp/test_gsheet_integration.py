"""Integration test cho fetch Google Sheets (mock httpx).

Kiểm đường tải Google Sheets export CSV của ``app.workers.vdp_datasource``
mà KHÔNG dùng mạng thật: monkeypatch ``httpx.get`` bằng một response giả khớp
đúng những thuộc tính mà mã đọc (``url.host``, ``status_code``,
``raise_for_status``, ``content``).

Phủ hai requirement:
- Req 1.4  — chuyển link Google Sheets thành URL export CSV (format=csv, gid).
- Req 1.13 — sheet không công khai (HTTP 4xx hoặc redirect tới trang đăng nhập)
  → ``DataSourceError`` mã ``GSHEET_FORBIDDEN``, không trả HTML đăng nhập.
"""
import os
import sys

import httpx
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from app.workers import vdp_datasource
from app.workers.vdp_datasource import (
    DataSourceError,
    RecordTable,
    fetch_gsheet_csv,
    read_source,
)


# ─── Đối tượng response giả khớp những gì mã đọc ─────────────────────────────


class _FakeURL:
    """URL giả chỉ phơi thuộc tính ``host`` mà ``fetch_gsheet_csv`` đọc."""

    def __init__(self, host: str) -> None:
        self.host = host


class _FakeResponse:
    """Response giả mô phỏng đối tượng ``httpx.Response`` ở mức cần thiết."""

    def __init__(
        self,
        *,
        status_code: int = 200,
        content: bytes = b"",
        final_host: str = "docs.google.com",
    ) -> None:
        self.status_code = status_code
        self.content = content
        self.url = _FakeURL(final_host)

    def raise_for_status(self) -> None:
        # Mô phỏng hành vi httpx: chỉ ném cho 4xx/5xx. Các nhánh forbidden đã được
        # xử lý trước khi gọi hàm này nên ở đây chỉ cần chặn 5xx.
        if self.status_code >= 500:
            raise httpx.HTTPStatusError(
                "server error", request=None, response=None
            )


def _patch_httpx_get(monkeypatch, response, capture):
    """Monkeypatch ``httpx.get`` để trả ``response`` và bắt URL/kwargs đã gọi."""

    def fake_get(url, *args, **kwargs):
        capture["url"] = url
        capture["kwargs"] = kwargs
        return response

    monkeypatch.setattr(httpx, "get", fake_get)


# ─── Case 1: thành công, dựng URL export đúng ────────────────────────────────


def test_read_source_gsheet_success_builds_csv_export_url(monkeypatch):
    """200 + CSV bytes → RecordTable đúng cột/dòng; URL export dựng đúng (Req 1.4)."""
    csv_bytes = (
        "Tên,Mã,Số lượng\r\n"
        "Nguyễn Văn A,SP001,10\r\n"
        "Trần Thị B,SP002,20\r\n"
    ).encode("utf-8")

    capture: dict = {}
    response = _FakeResponse(status_code=200, content=csv_bytes)
    _patch_httpx_get(monkeypatch, response, capture)

    # gid nằm ở fragment (#gid=123) như link "edit" thông thường.
    url = "https://docs.google.com/spreadsheets/d/ABC123_def-456/edit#gid=789"
    table = read_source("gsheet", url)

    # Trả về RecordTable đúng cấu trúc.
    assert isinstance(table, RecordTable)
    assert table.columns == ["Tên", "Mã", "Số lượng"]
    assert len(table.rows) == 2
    assert table.rows[0] == {"Tên": "Nguyễn Văn A", "Mã": "SP001", "Số lượng": "10"}
    assert table.rows[1] == {"Tên": "Trần Thị B", "Mã": "SP002", "Số lượng": "20"}

    # URL export được dựng đúng: id, format=csv và gid.
    called_url = capture["url"]
    assert "/spreadsheets/d/ABC123_def-456/export" in called_url
    assert "format=csv" in called_url
    assert "gid=789" in called_url

    # follow_redirects bật để kiểm host đích phát hiện redirect đăng nhập.
    assert capture["kwargs"].get("follow_redirects") is True


def test_fetch_gsheet_csv_without_gid_omits_gid_param(monkeypatch):
    """Link không có gid → URL export không kèm tham số gid (Req 1.4)."""
    capture: dict = {}
    response = _FakeResponse(status_code=200, content=b"a,b\r\n1,2\r\n")
    _patch_httpx_get(monkeypatch, response, capture)

    url = "https://docs.google.com/spreadsheets/d/SHEETID999"
    data = fetch_gsheet_csv(url)

    assert data == b"a,b\r\n1,2\r\n"
    called_url = capture["url"]
    assert "/spreadsheets/d/SHEETID999/export" in called_url
    assert "format=csv" in called_url
    assert "gid=" not in called_url


# ─── Case 2: HTTP 4xx → GSHEET_FORBIDDEN ─────────────────────────────────────


@pytest.mark.parametrize("status_code", [401, 403, 404])
def test_read_source_gsheet_http_4xx_forbidden(monkeypatch, status_code):
    """HTTP 4xx (thiếu quyền / không tồn tại) → DataSourceError GSHEET_FORBIDDEN (Req 1.13)."""
    response = _FakeResponse(status_code=status_code, content=b"<html>forbidden</html>")
    _patch_httpx_get(monkeypatch, response, {})

    url = "https://docs.google.com/spreadsheets/d/PRIVATE123/edit#gid=0"
    with pytest.raises(DataSourceError) as exc_info:
        read_source("gsheet", url)

    assert exc_info.value.code == "GSHEET_FORBIDDEN"


# ─── Case 3: redirect tới trang đăng nhập → GSHEET_FORBIDDEN ──────────────────


def test_read_source_gsheet_login_redirect_forbidden(monkeypatch):
    """Redirect tới accounts.google.com (login) → GSHEET_FORBIDDEN, không trả HTML (Req 1.13)."""
    # status 200 nhưng host đích là trang đăng nhập → sheet không công khai.
    response = _FakeResponse(
        status_code=200,
        content=b"<html>Sign in - Google Accounts</html>",
        final_host="accounts.google.com",
    )
    _patch_httpx_get(monkeypatch, response, {})

    url = "https://docs.google.com/spreadsheets/d/PRIVATE456/edit#gid=0"
    with pytest.raises(DataSourceError) as exc_info:
        fetch_gsheet_csv(url)

    assert exc_info.value.code == "GSHEET_FORBIDDEN"


def test_fetch_gsheet_csv_network_error_forbidden(monkeypatch):
    """Lỗi kết nối httpx → GSHEET_FORBIDDEN với thông báo tiếng Việt (Req 1.13)."""

    def fake_get(url, *args, **kwargs):
        raise httpx.ConnectError("no network")

    monkeypatch.setattr(httpx, "get", fake_get)

    url = "https://docs.google.com/spreadsheets/d/SOMEID/edit"
    with pytest.raises(DataSourceError) as exc_info:
        fetch_gsheet_csv(url)

    assert exc_info.value.code == "GSHEET_FORBIDDEN"
