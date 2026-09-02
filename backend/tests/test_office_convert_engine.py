"""Unit tests for office/google → PDF helpers (no real Office required)."""
from __future__ import annotations

import pytest

from app.workers import office_convert_engine as engine
from app.workers.office_convert_engine import (
    OFFICE_EXTENSIONS,
    google_export_pdf_url,
    parse_google_url,
    probe_converters,
)
OFFICE_EXTENSION_ORACLE = {
    ".doc", ".docx", ".odt", ".rtf",
    ".xls", ".xlsx", ".ods", ".csv",
    ".ppt", ".pptx", ".odp",
}


def test_parse_google_docs():
    kind, fid = parse_google_url(
        "https://docs.google.com/document/d/1AbC_xYz-99/edit?usp=sharing"
    )
    assert kind == "document"
    assert fid == "1AbC_xYz-99"


def test_parse_google_sheets():
    kind, fid = parse_google_url(
        "https://docs.google.com/spreadsheets/d/SheetId99/edit#gid=0"
    )
    assert kind == "spreadsheets"
    assert fid == "SheetId99"


def test_parse_google_slides():
    kind, fid = parse_google_url(
        "https://docs.google.com/presentation/d/Pres99/edit"
    )
    assert kind == "presentation"
    assert fid == "Pres99"


def test_parse_invalid():
    with pytest.raises(ValueError):
        parse_google_url("https://example.com/not-google")


def test_export_urls():
    assert "export?format=pdf" in google_export_pdf_url("document", "x")
    assert "spreadsheets" in google_export_pdf_url("spreadsheets", "x")
    assert "export/pdf" in google_export_pdf_url("presentation", "x")


def test_probe_shape():
    p = probe_converters()
    assert "can_convert_office" in p
    assert p.get("google_export") is True
    assert OFFICE_EXTENSIONS == OFFICE_EXTENSION_ORACLE
    assert set(p["supported_extensions"]) | set(p["unsupported_extensions"]) == OFFICE_EXTENSION_ORACLE
    assert set(p["engine_by_extension"]) == OFFICE_EXTENSION_ORACLE

def test_parse_google_drive_open_id():
    kind, fid = parse_google_url("https://drive.google.com/open?id=DriveFile99")
    assert (kind, fid) == ("drive_file", "DriveFile99")


def test_parse_google_drive_file_path_and_reject_folder():
    assert parse_google_url("https://drive.google.com/file/d/DriveFile88/view") == (
        "drive_file",
        "DriveFile88",
    )
    with pytest.raises(ValueError):
        parse_google_url("https://drive.google.com/drive/folders/Folder99")

def test_engine_matrix_matches_actual_dispatch():
    matrix = engine._engine_by_extension(
        {"word": True, "excel": True, "powerpoint": True},
        has_libreoffice=False,
    )
    assert set(matrix) == OFFICE_EXTENSIONS
    assert all(value != "unavailable" for value in matrix.values())
    assert matrix[".odt"] == "word"
    assert matrix[".ods"] == "excel"
    assert matrix[".odp"] == "powerpoint"


def test_engine_matrix_does_not_overpromise_partial_office():
    matrix = engine._engine_by_extension(
        {"word": True, "excel": False, "powerpoint": False},
        has_libreoffice=False,
    )
    assert matrix[".docx"] == "word"
    assert matrix[".xlsx"] == "unavailable"
    assert matrix[".pptx"] == "unavailable"
    assert matrix[".ods"] == "unavailable"


def test_libreoffice_fallback_covers_all_extensions():
    matrix = engine._engine_by_extension({}, has_libreoffice=True)
    assert set(matrix) == OFFICE_EXTENSIONS
    assert set(matrix.values()) == {"libreoffice"}


def test_probe_reports_powerpoint_and_per_extension(monkeypatch):
    monkeypatch.setattr(
        engine,
        "_probe_ms_office",
        lambda: {"word": True, "excel": False, "powerpoint": True},
    )
    monkeypatch.setattr(engine, "_find_soffice", lambda: None)

    status = probe_converters()

    assert status["ms_office"]["powerpoint"] is True
    assert status["engine_by_extension"][".pptx"] == "powerpoint"
    assert status["engine_by_extension"][".xlsx"] == "unavailable"
    assert ".xlsx" in status["unsupported_extensions"]


def test_non_preserve_excel_layout_never_falls_back_silently(monkeypatch, tmp_path):
    source = tmp_path / "sheet.ods"
    source.write_bytes(b"ods")
    monkeypatch.setattr(
        engine,
        "_probe_ms_office",
        lambda: {"word": False, "excel": False, "powerpoint": False},
    )
    monkeypatch.setattr(engine, "_find_soffice", lambda: "soffice")
    monkeypatch.setattr(
        engine,
        "_convert_libreoffice",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("Không được gọi LibreOffice khi layout sẽ bị bỏ qua")
        ),
    )

    with pytest.raises(ValueError, match="phân trang Excel"):
        engine.convert_office_file(
            str(source),
            str(tmp_path / "out.pdf"),
            excel_layout="fit_width",
        )


def test_report_com_pid_accepts_callable_hwnd(monkeypatch, tmp_path):
    import ctypes

    class FakeApplication:
        def Hwnd(self):
            return 4242

    class FakeUser32:
        @staticmethod
        def GetWindowThreadProcessId(hwnd, pid_pointer):
            assert hwnd == 4242
            pid_pointer._obj.value = 9876
            return 1

    class FakeWindll:
        user32 = FakeUser32()

    pid_path = tmp_path / "owned-pids"
    monkeypatch.setattr(engine.os, "name", "nt")
    monkeypatch.setattr(ctypes, "windll", FakeWindll(), raising=False)

    engine._report_com_pid(FakeApplication(), str(pid_path))

    assert pid_path.read_text(encoding="ascii") == "9876\n"

def test_google_export_streams_chunks_without_response_content(monkeypatch, tmp_path):
    import httpx

    payload = b"%PDF-1.4\n" + b"x" * 64

    class FakeResponse:
        status_code = 200
        headers = {
            "content-type": "application/pdf",
            "content-length": str(len(payload)),
        }

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        @property
        def content(self):
            raise AssertionError("Không được materialize response.content")

        def iter_bytes(self, chunk_size: int):
            assert chunk_size == 1024 * 1024
            yield payload[:2]
            yield payload[2:]

    class FakeClient:
        def __init__(self, **_kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def stream(self, method: str, _url: str):
            assert method == "GET"
            return FakeResponse()

    monkeypatch.setattr(httpx, "Client", FakeClient)
    output = tmp_path / "google.pdf"

    assert engine.convert_google_link(
        "https://docs.google.com/document/d/Doc99/edit", str(output)
    ) == str(output)
    assert output.read_bytes() == payload


def test_google_html_stream_is_rejected_and_partial_is_removed(monkeypatch, tmp_path):
    import httpx

    class FakeResponse:
        status_code = 200
        headers = {"content-type": "text/html"}

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def iter_bytes(self, chunk_size: int):
            assert chunk_size == 1024 * 1024
            yield b"<html>private</html>"

    class FakeClient:
        def __init__(self, **_kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def stream(self, _method: str, _url: str):
            return FakeResponse()

    monkeypatch.setattr(httpx, "Client", FakeClient)
    output = tmp_path / "private.pdf"

    with pytest.raises(ValueError, match="HTML"):
        engine.convert_google_link(
            "https://docs.google.com/document/d/Private99/edit", str(output)
        )

    assert not output.exists()


# ── SEC (pentest 2026-08-28 §ATK.02): cưỡng chế tắt macro khi convert Office ──────
# Đường tấn công đã vá: .docm/.xlsm/.pptm có AutoOpen/Workbook_Open được convert qua COM
# mà KHÔNG tắt macro (ReadOnly/DisplayAlerts không chặn macro) → RCE trong tiến trình
# Office dưới quyền người dùng. Fix: đặt Application.AutomationSecurity = 3
# (msoAutomationSecurityForceDisable) TRƯỚC khi Open().
#
# Không cần Office thật: test helper bằng fake COM app, và ratchet đọc source chứng minh
# thứ tự gọi (tắt macro trước khi mở tài liệu).
import inspect


class _FakeComApp:
    """Giả một Application COM: cho gán thuộc tính tùy ý như win32com dispatch."""

    def __init__(self):
        self.AutomationSecurity = None


class _FakeComAppNoSecurity:
    """Phiên bản Office giả không expose AutomationSecurity (raise khi gán)."""

    def __setattr__(self, name, value):
        if name == "AutomationSecurity":
            raise AttributeError("AutomationSecurity not supported")
        object.__setattr__(self, name, value)


def test_harden_office_automation_ep_force_disable():
    app = _FakeComApp()
    engine._harden_office_automation(app, "Word")
    # 3 = msoAutomationSecurityForceDisable — tắt MỌI macro không hỏi.
    assert app.AutomationSecurity == 3
    assert engine._MSO_AUTOMATION_SECURITY_FORCE_DISABLE == 3


def test_harden_office_automation_khong_lam_gay_khi_thieu_thuoc_tinh(caplog):
    """Office lạ không expose AutomationSecurity → cảnh báo bảo mật, KHÔNG raise."""
    app = _FakeComAppNoSecurity()
    with caplog.at_level("WARNING"):
        engine._harden_office_automation(app, "Excel")  # không được ném
    assert any("ATK.02" in rec.message for rec in caplog.records)


def _com_body(func) -> str:
    """Phần thân hàm TỪ DispatchEx tới lời gọi .Open() — vùng thứ tự quan trọng."""
    return inspect.getsource(func)


def test_ca_ba_ham_com_tat_macro_truoc_khi_mo_tai_lieu():
    """Ratchet thứ tự: _harden_office_automation phải đứng TRƯỚC .Open()/.Documents.Open.

    Đặt sau Open() thì macro AutoOpen đã chạy xong — vá thành vô nghĩa.
    """
    cases = [
        (engine._convert_word_com, ".Documents.Open("),
        (engine._convert_excel_com, ".Workbooks.Open("),
        (engine._convert_powerpoint_com, ".Presentations.Open("),
    ]
    for func, open_marker in cases:
        src = _com_body(func)
        harden_at = src.find("_harden_office_automation(")
        open_at = src.find(open_marker)
        assert harden_at != -1, f"{func.__name__}: thiếu _harden_office_automation"
        assert open_at != -1, f"{func.__name__}: không tìm thấy {open_marker}"
        assert harden_at < open_at, (
            f"{func.__name__}: _harden_office_automation phải gọi TRƯỚC {open_marker} "
            f"(nếu không macro AutoOpen đã chạy trước khi bị tắt)"
        )
