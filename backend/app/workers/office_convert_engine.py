"""
Office / Google → PDF conversion (optional external engines).

Backends (runtime detect, nothing bundled GPL into PrynX binary):
  1. Microsoft Word / Excel COM (Windows + Office installed) — best fidelity
  2. LibreOffice soffice --headless (if installed separately by user)
  3. Google Docs/Sheets: public export URL (Anyone-with-link or published)

Does NOT ship LibreOffice or MS Office. Does NOT use AGPL libs in-process.
"""

from __future__ import annotations

import logging
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Optional
from urllib.parse import parse_qs, urlparse

logger = logging.getLogger(__name__)

OFFICE_EXTENSIONS = {
    ".doc", ".docx", ".odt", ".rtf",
    ".xls", ".xlsx", ".ods", ".csv",
    ".ppt", ".pptx", ".odp",
}

_WORD_EXTENSIONS = frozenset({".doc", ".docx", ".odt", ".rtf"})
_EXCEL_EXTENSIONS = frozenset({".xls", ".xlsx", ".ods", ".csv"})
_POWERPOINT_EXTENSIONS = frozenset({".ppt", ".pptx", ".odp"})

# Google export patterns
_RE_GDOC = re.compile(
    r"docs\.google\.com/document/d/([a-zA-Z0-9_-]+)",
    re.I,
)
_RE_GSHEET = re.compile(
    r"docs\.google\.com/spreadsheets/d/([a-zA-Z0-9_-]+)",
    re.I,
)
_RE_GSLIDE = re.compile(
    r"docs\.google\.com/presentation/d/([a-zA-Z0-9_-]+)",
    re.I,
)
_RE_DRIVE_FILE = re.compile(
    r"drive\.google\.com/file/d/([a-zA-Z0-9_-]+)",
    re.I,
)


def probe_converters() -> dict[str, Any]:
    """What conversion backends are available on this machine."""
    ms = _probe_ms_office()
    lo = _find_soffice()
    engine_by_extension = _engine_by_extension(ms, bool(lo))
    supported_extensions = sorted(
        ext for ext, engine in engine_by_extension.items() if engine != "unavailable"
    )
    return {
        "ms_office": ms,
        "libreoffice": bool(lo),
        "libreoffice_path": lo or "",
        "google_export": True,  # HTTP export — no local install
        "can_convert_office": bool(supported_extensions),
        "supported_extensions": supported_extensions,
        "unsupported_extensions": sorted(OFFICE_EXTENSIONS - set(supported_extensions)),
        "engine_by_extension": engine_by_extension,
        "hint": _hint(ms, lo),
    }


def _hint(ms: dict, lo: Optional[str]) -> str:
    available = [
        label
        for key, label in (("word", "Word"), ("excel", "Excel"), ("powerpoint", "PowerPoint"))
        if ms.get(key)
    ]
    if available:
        suffix = "; LibreOffice sẵn sàng cho các định dạng còn lại." if lo else "."
        return f"Microsoft {' / '.join(available)} sẵn sàng{suffix}"
    if lo:
        return "LibreOffice sẵn sàng (headless)."
    return (
        "Chưa có Microsoft Office hay LibreOffice. "
        "Cài Word/Excel hoặc LibreOffice để chuyển .docx/.xlsx → PDF. "
        "Link Google Docs/Sheets công khai vẫn dùng được."
    )


def _engine_by_extension(ms: dict[str, bool], has_libreoffice: bool) -> dict[str, str]:
    """Trả engine thật cho từng đuôi; UI không được suy diễn từ một cờ Office chung."""
    result: dict[str, str] = {}
    for ext in sorted(OFFICE_EXTENSIONS):
        if ext in _WORD_EXTENSIONS and ms.get("word"):
            result[ext] = "word"
        elif ext in _EXCEL_EXTENSIONS and ms.get("excel"):
            result[ext] = "excel"
        elif ext in _POWERPOINT_EXTENSIONS and ms.get("powerpoint"):
            result[ext] = "powerpoint"
        elif has_libreoffice:
            result[ext] = "libreoffice"
        else:
            result[ext] = "unavailable"
    return result


def _probe_ms_office() -> dict[str, bool]:
    """Detect Word/Excel without launching COM (Dispatch+Quit can RPC-crash)."""
    out = {"word": False, "excel": False, "powerpoint": False}
    if os.name != "nt":
        return out
    # 1) win32com import available?
    try:
        import win32com.client  # noqa: F401  # type: ignore
    except ImportError:
        return out
    # 2) Registry ProgIDs (no process spawn)
    try:
        import winreg
        for key, flag in (
            (r"Word.Application", "word"),
            (r"Excel.Application", "excel"),
            (r"PowerPoint.Application", "powerpoint"),
        ):
            try:
                winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, key)
                out[flag] = True
            except OSError:
                pass
    except Exception as ex:
        logger.debug("MS Office registry probe: %s", ex)
    return out


def _find_soffice() -> Optional[str]:
    """Locate soffice.exe / soffice on PATH or common Windows install dirs."""
    for name in ("soffice", "soffice.exe"):
        p = shutil.which(name)
        if p:
            return p
    candidates = [
        r"C:\Program Files\LibreOffice\program\soffice.exe",
        r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
        "/usr/bin/soffice",
        "/usr/lib/libreoffice/program/soffice",
        "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    ]
    for c in candidates:
        if os.path.isfile(c):
            return c
    return None


def _append_owned_pid(owned_pid_path: Optional[str], pid: int) -> None:
    """Ghi đúng PID instance do DispatchEx/Popen của job tạo; không kill theo tên app."""
    if not owned_pid_path or pid <= 0:
        return
    with open(owned_pid_path, "a", encoding="ascii") as pid_file:
        pid_file.write(f"{pid}\n")


def _report_com_pid(application: Any, owned_pid_path: Optional[str]) -> None:
    if not owned_pid_path or os.name != "nt":
        return
    try:
        import ctypes

        raw_hwnd = getattr(application, "Hwnd", 0)
        if callable(raw_hwnd):
            raw_hwnd = raw_hwnd()
        if not raw_hwnd:
            raw_hwnd = getattr(application, "HWND", 0)
            if callable(raw_hwnd):
                raw_hwnd = raw_hwnd()
        hwnd = int(raw_hwnd or 0)
        if hwnd <= 0:
            raise RuntimeError("Office không trả về HWND hợp lệ.")
        pid = ctypes.c_ulong(0)
        resolved = ctypes.windll.user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if not resolved or pid.value <= 0:
            raise RuntimeError("Không ánh xạ được HWND Office sang PID.")
        _append_owned_pid(owned_pid_path, int(pid.value))
    except Exception as exc:  # noqa: BLE001 — PID report là lớp cleanup phòng hờ
        logger.warning("Không lấy được PID instance Office: %s", exc)

def convert_office_file(
    source_path: str,
    output_pdf: str,
    excel_layout: str = "preserve",
    owned_pid_path: Optional[str] = None,
) -> str:
    """Convert local Office file → PDF. Raises ValueError on user-facing errors."""
    ext = Path(source_path).suffix.lower()
    if excel_layout not in {"preserve", "fit_width", "one_page"}:
        raise ValueError(f"Chế độ phân trang Excel không hợp lệ: {excel_layout}")
    if ext not in OFFICE_EXTENSIONS:
        raise ValueError(
            f"Định dạng không hỗ trợ: {ext or '(không có)'}. "
            f"Hỗ trợ: {', '.join(sorted(OFFICE_EXTENSIONS))}"
        )
    if not os.path.isfile(source_path):
        raise ValueError("File nguồn không tồn tại.")

    os.makedirs(os.path.dirname(output_pdf) or ".", exist_ok=True)

    # Prefer MS Office for native fidelity on Windows
    ms_office_error: Optional[Exception] = None
    if os.name == "nt":
        ms = _probe_ms_office()
        try:
            if ext in _WORD_EXTENSIONS and ms.get("word"):
                return _convert_word_com(source_path, output_pdf, owned_pid_path)
            if ext in _EXCEL_EXTENSIONS and ms.get("excel"):
                return _convert_excel_com(source_path, output_pdf, excel_layout, owned_pid_path)
            if ext in _POWERPOINT_EXTENSIONS and ms.get("powerpoint"):
                return _convert_powerpoint_com(source_path, output_pdf, owned_pid_path)
        except Exception as e:
            ms_office_error = e
            logger.warning("MS Office convert failed, try LibreOffice: %s", e)

    lo = _find_soffice()
    if lo:
        if ext in _EXCEL_EXTENSIONS and excel_layout != "preserve":
            raise ValueError(
                "Tùy chọn phân trang Excel cần Microsoft Excel. "
                "Hãy chọn ‘Giữ nguyên thiết lập’ để dùng LibreOffice."
            )
        try:
            return _convert_libreoffice(lo, source_path, output_pdf, owned_pid_path)
        except Exception as lo_error:
            if ms_office_error is not None:
                raise ValueError(
                    f"Microsoft Office lỗi: {ms_office_error}; "
                    f"LibreOffice cũng lỗi: {lo_error}"
                ) from lo_error
            raise

    if ms_office_error is not None:
        raise ValueError(str(ms_office_error)) from ms_office_error

    raise ValueError(
        "Không chuyển được file Office. Cài Microsoft Word/Excel "
        "hoặc LibreOffice (https://www.libreoffice.org/), rồi thử lại."
    )


def _convert_word_com(
    source_path: str,
    output_pdf: str,
    owned_pid_path: Optional[str] = None,
) -> str:
    import win32com.client  # type: ignore
    import pythoncom  # type: ignore

    source_path = os.path.abspath(source_path)
    output_pdf = os.path.abspath(output_pdf)
    pythoncom.CoInitialize()
    word = None
    doc = None
    try:
        word = win32com.client.DispatchEx("Word.Application")
        _report_com_pid(word, owned_pid_path)
        word.Visible = False
        word.DisplayAlerts = 0
        doc = word.Documents.Open(
            source_path,
            ConfirmConversions=False,
            ReadOnly=True,
            AddToRecentFiles=False,
            PasswordDocument="__PRYNX_NO_PASSWORD__",
            WritePasswordDocument="__PRYNX_NO_PASSWORD__",
            Revert=False,
            OpenAndRepair=False,
            NoEncodingDialog=True,
        )
        # 17 = wdFormatPDF
        doc.SaveAs(output_pdf, FileFormat=17)
        if not os.path.isfile(output_pdf):
            raise RuntimeError("Word không tạo được file PDF.")
        return output_pdf
    except Exception as e:
        raise ValueError(f"Word COM lỗi: {e}") from e
    finally:
        try:
            if doc is not None:
                doc.Close(False)
        except Exception:
            pass
        try:
            if word is not None:
                word.Quit()
        except Exception:
            pass
        try:
            pythoncom.CoUninitialize()
        except Exception:
            pass


def _convert_excel_com(
    source_path: str,
    output_pdf: str,
    excel_layout: str = "preserve",
    owned_pid_path: Optional[str] = None,
) -> str:
    import win32com.client  # type: ignore
    import pythoncom  # type: ignore

    source_path = os.path.abspath(source_path)
    output_pdf = os.path.abspath(output_pdf)
    pythoncom.CoInitialize()
    excel = None
    wb = None
    try:
        excel = win32com.client.DispatchEx("Excel.Application")
        _report_com_pid(excel, owned_pid_path)
        excel.Visible = False
        excel.DisplayAlerts = False
        wb = excel.Workbooks.Open(
            source_path,
            UpdateLinks=0,
            ReadOnly=True,
            AddToMru=False,
            IgnoreReadOnlyRecommended=True,
            Password="__PRYNX_NO_PASSWORD__",
            WriteResPassword="__PRYNX_NO_PASSWORD__",
        )

        # Apply layout in memory only; the original workbook is closed without saving.
        if excel_layout != "preserve":
            for ws in wb.Worksheets:
                page_setup = ws.PageSetup
                page_setup.Zoom = False
                page_setup.FitToPagesWide = 1
                page_setup.FitToPagesTall = 1 if excel_layout == "one_page" else False

        # 0 = xlTypePDF
        wb.ExportAsFixedFormat(0, output_pdf)
        if not os.path.isfile(output_pdf):
            raise RuntimeError("Excel không tạo được file PDF.")
        return output_pdf
    except Exception as e:
        raise ValueError(f"Excel COM lỗi: {e}") from e
    finally:
        try:
            if wb is not None:
                wb.Close(False)
        except Exception:
            pass
        try:
            if excel is not None:
                excel.Quit()
        except Exception:
            pass
        try:
            pythoncom.CoUninitialize()
        except Exception:
            pass


def _convert_powerpoint_com(
    source_path: str,
    output_pdf: str,
    owned_pid_path: Optional[str] = None,
) -> str:
    """Chuyển PPT/PPTX/ODP bằng instance PowerPoint riêng, không bật cửa sổ."""
    import pythoncom  # type: ignore
    import win32com.client  # type: ignore

    source_path = os.path.abspath(source_path)
    output_pdf = os.path.abspath(output_pdf)
    pythoncom.CoInitialize()
    powerpoint = None
    presentation = None
    try:
        powerpoint = win32com.client.DispatchEx("PowerPoint.Application")
        _report_com_pid(powerpoint, owned_pid_path)
        powerpoint.DisplayAlerts = 1
        presentation = powerpoint.Presentations.Open(
            source_path,
            ReadOnly=True,
            Untitled=False,
            WithWindow=False,
        )
        # 32 = ppSaveAsPDF.
        presentation.SaveAs(output_pdf, 32)
        if not os.path.isfile(output_pdf):
            raise RuntimeError("PowerPoint không tạo được file PDF.")
        return output_pdf
    except Exception as e:
        raise ValueError(f"PowerPoint COM lỗi: {e}") from e
    finally:
        try:
            if presentation is not None:
                presentation.Close()
        except Exception:
            pass
        try:
            if powerpoint is not None:
                powerpoint.Quit()
        except Exception:
            pass
        try:
            pythoncom.CoUninitialize()
        except Exception:
            pass

def _convert_libreoffice(
    soffice: str,
    source_path: str,
    output_pdf: str,
    owned_pid_path: Optional[str] = None,
) -> str:
    # Profile riêng tránh nhập vào instance LibreOffice người dùng đang mở.
    work = tempfile.mkdtemp(prefix="prynx_lo_")
    try:
        src_copy = os.path.join(work, Path(source_path).name)
        profile_dir = os.path.join(work, "profile")
        os.makedirs(profile_dir, exist_ok=True)
        shutil.copy2(source_path, src_copy)
        cmd = [
            soffice,
            f"-env:UserInstallation={Path(profile_dir).resolve().as_uri()}",
            "--headless",
            "--nologo",
            "--nofirststartwizard",
            "--convert-to",
            "pdf",
            "--outdir",
            work,
            src_copy,
        ]
        kwargs: dict[str, Any] = {
            "stdout": subprocess.PIPE,
            "stderr": subprocess.PIPE,
        }
        if os.name == "nt":
            kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        process = subprocess.Popen(cmd, **kwargs)
        _append_owned_pid(owned_pid_path, process.pid)
        try:
            _stdout, stderr = process.communicate(timeout=180)
        except subprocess.TimeoutExpired as exc:
            process.kill()
            process.communicate()
            raise ValueError("LibreOffice mất quá nhiều thời gian và đã được dừng.") from exc
        produced = os.path.join(work, f"{Path(src_copy).stem}.pdf")
        if process.returncode != 0 or not os.path.isfile(produced):
            err = (stderr or b"").decode("utf-8", errors="ignore")[:400]
            raise ValueError(f"LibreOffice chuyển đổi thất bại. {err}")
        shutil.copy2(produced, output_pdf)
        return output_pdf
    finally:
        shutil.rmtree(work, ignore_errors=True)


def parse_google_url(url: str) -> tuple[str, str]:
    """Return (kind, file_id). kind: document | spreadsheets | presentation | drive_file."""
    url = (url or "").strip()
    if not url:
        raise ValueError("Chưa dán link Google.")
    m = _RE_GDOC.search(url)
    if m:
        return "document", m.group(1)
    m = _RE_GSHEET.search(url)
    if m:
        return "spreadsheets", m.group(1)
    m = _RE_GSLIDE.search(url)
    if m:
        return "presentation", m.group(1)
    m = _RE_DRIVE_FILE.search(url)
    if m:
        return "drive_file", m.group(1)
    # open?id=
    try:
        q = parse_qs(urlparse(url).query)
        if "id" in q and q["id"]:
            return "drive_file", q["id"][0]
    except Exception:
        pass
    raise ValueError(
        "Link không nhận diện được. Dán URL Google Docs / Sheets / Slides "
        "(dạng docs.google.com/document/d/... hoặc spreadsheets/d/...)."
    )


def google_export_pdf_url(kind: str, file_id: str) -> str:
    if kind == "document":
        return f"https://docs.google.com/document/d/{file_id}/export?format=pdf"
    if kind == "spreadsheets":
        return f"https://docs.google.com/spreadsheets/d/{file_id}/export?format=pdf"
    if kind == "presentation":
        return f"https://docs.google.com/presentation/d/{file_id}/export/pdf"
    if kind == "drive_file":
        return f"https://drive.google.com/uc?export=download&id={file_id}"
    raise ValueError(f"Loại Google không hỗ trợ: {kind}")


def convert_google_link(url: str, output_pdf: str, timeout: float = 90.0) -> str:
    """Stream PDF export từ link Google public vào output của isolated runner."""
    import httpx

    kind, file_id = parse_google_url(url)
    export_url = google_export_pdf_url(kind, file_id)
    headers = {
        "User-Agent": "PrynX/1.0 (OfficeConvert; +https://printsolutions.vn)",
        "Accept": "application/pdf,*/*",
    }
    output_dir = os.path.dirname(output_pdf) or "."
    os.makedirs(output_dir, exist_ok=True)

    try:
        with httpx.Client(
            follow_redirects=True,
            timeout=timeout,
            headers=headers,
        ) as client:
            with client.stream("GET", export_url) as response:
                content_type = (response.headers.get("content-type") or "").lower()
                if response.status_code in (401, 403):
                    raise ValueError(
                        "Google từ chối (401/403). Hãy đặt quyền chia sẻ "
                        "«Anyone with the link» (Người có link) hoặc «Public», rồi thử lại. "
                        "File chỉ mình bạn xem cần đăng nhập — PrynX chưa hỗ trợ OAuth Google."
                    )
                if response.status_code >= 400:
                    raise ValueError(f"Google trả lỗi HTTP {response.status_code}.")

                try:
                    expected = int(response.headers.get("content-length") or 0)
                except (TypeError, ValueError):
                    expected = 0
                if expected > 0:
                    reserve = max(8 * 1024 * 1024, expected // 20)
                    if shutil.disk_usage(output_dir).free < expected + reserve:
                        raise ValueError("Không đủ dung lượng đĩa để tải PDF từ Google.")

                prefix = bytearray()
                total = 0
                header_checked = False
                # BE (audit 2026-08-02 §BE.2): chỉ giữ tối đa một chunk 1 MiB,
                # không materialize `response.content` cho file Google lớn.
                with open(output_pdf, "wb") as output_file:
                    for chunk in response.iter_bytes(chunk_size=1024 * 1024):
                        if not chunk:
                            continue
                        if not header_checked:
                            prefix.extend(chunk)
                            if len(prefix) < 5:
                                continue
                            if prefix[:4] != b"%PDF":
                                if "text/html" in content_type or prefix.lstrip()[:1] == b"<":
                                    raise ValueError(
                                        "Google trả trang HTML thay vì PDF (thường do file private hoặc cần đăng nhập). "
                                        "Đặt chia sẻ public/anyone-with-link, hoặc File → Download → PDF rồi mở trong PrynX."
                                    )
                                raise ValueError(
                                    "Nội dung tải về không phải PDF. Kiểm tra link và quyền chia sẻ."
                                )
                            output_file.write(prefix)
                            total += len(prefix)
                            prefix.clear()
                            header_checked = True
                            continue
                        output_file.write(chunk)
                        total += len(chunk)

                if not header_checked or total < 32:
                    raise ValueError("Google trả về PDF rỗng hoặc không hợp lệ.")
    except httpx.HTTPError as exc:
        try:
            os.remove(output_pdf)
        except OSError:
            pass
        raise ValueError(f"Không tải được từ Google: {exc}") from exc
    except Exception:
        try:
            os.remove(output_pdf)
        except OSError:
            pass
        raise

    return output_pdf