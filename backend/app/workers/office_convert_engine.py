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
import time
from pathlib import Path
from typing import Any, Optional
from urllib.parse import parse_qs, urlparse

logger = logging.getLogger(__name__)

OFFICE_EXTENSIONS = {
    ".doc", ".docx", ".odt", ".rtf",
    ".xls", ".xlsx", ".ods", ".csv",
    ".ppt", ".pptx", ".odp",
}

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
    return {
        "ms_office": ms,
        "libreoffice": bool(lo),
        "libreoffice_path": lo or "",
        "google_export": True,  # HTTP export — no local install
        "can_convert_office": bool(ms.get("word") or ms.get("excel") or lo),
        "hint": _hint(ms, lo),
    }


def _hint(ms: dict, lo: Optional[str]) -> str:
    if ms.get("word") or ms.get("excel"):
        return "Microsoft Office (COM) sẵn sàng — chất lượng cao nhất."
    if lo:
        return "LibreOffice sẵn sàng (headless)."
    return (
        "Chưa có Microsoft Office hay LibreOffice. "
        "Cài Word/Excel hoặc LibreOffice để chuyển .docx/.xlsx → PDF. "
        "Link Google Docs/Sheets công khai vẫn dùng được."
    )


def _probe_ms_office() -> dict[str, bool]:
    """Detect Word/Excel without launching COM (Dispatch+Quit can RPC-crash)."""
    out = {"word": False, "excel": False}
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


def convert_office_file(source_path: str, output_pdf: str, excel_layout: str = "preserve") -> str:
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
            if ext in (".doc", ".docx", ".rtf", ".odt") and ms.get("word"):
                return _convert_word_com(source_path, output_pdf)
            if ext in (".xls", ".xlsx", ".csv") and ms.get("excel"):
                return _convert_excel_com(source_path, output_pdf, excel_layout)
            # PPT via LibreOffice only (no COM path here)
        except Exception as e:
            ms_office_error = e
            logger.warning("MS Office convert failed, try LibreOffice: %s", e)

    lo = _find_soffice()
    if lo:
        try:
            return _convert_libreoffice(lo, source_path, output_pdf)
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


def _convert_word_com(source_path: str, output_pdf: str) -> str:
    import win32com.client  # type: ignore
    import pythoncom  # type: ignore

    source_path = os.path.abspath(source_path)
    output_pdf = os.path.abspath(output_pdf)
    pythoncom.CoInitialize()
    word = None
    doc = None
    try:
        word = win32com.client.DispatchEx("Word.Application")
        word.Visible = False
        word.DisplayAlerts = 0
        doc = word.Documents.Open(source_path, ReadOnly=True)
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


def _convert_excel_com(source_path: str, output_pdf: str, excel_layout: str = "preserve") -> str:
    import win32com.client  # type: ignore
    import pythoncom  # type: ignore

    source_path = os.path.abspath(source_path)
    output_pdf = os.path.abspath(output_pdf)
    pythoncom.CoInitialize()
    excel = None
    wb = None
    try:
        excel = win32com.client.DispatchEx("Excel.Application")
        excel.Visible = False
        excel.DisplayAlerts = False
        wb = excel.Workbooks.Open(source_path, ReadOnly=True)

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


def _convert_libreoffice(soffice: str, source_path: str, output_pdf: str) -> str:
    out_dir = os.path.dirname(os.path.abspath(output_pdf)) or tempfile.gettempdir()
    base = Path(source_path).stem
    # LibreOffice names output from source basename
    expected = os.path.join(out_dir, f"{base}.pdf")
    # Use unique out dir to avoid collisions
    work = tempfile.mkdtemp(prefix="prynx_lo_")
    try:
        src_copy = os.path.join(work, Path(source_path).name)
        shutil.copy2(source_path, src_copy)
        cmd = [
            soffice,
            "--headless",
            "--nologo",
            "--nofirststartwizard",
            "--convert-to",
            "pdf",
            "--outdir",
            work,
            src_copy,
        ]
        # Windows: hide console
        kwargs: dict = {
            "stdout": subprocess.PIPE,
            "stderr": subprocess.PIPE,
            "timeout": 180,
        }
        if os.name == "nt":
            kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        r = subprocess.run(cmd, **kwargs)
        produced = os.path.join(work, f"{Path(src_copy).stem}.pdf")
        if r.returncode != 0 or not os.path.isfile(produced):
            err = (r.stderr or b"").decode("utf-8", errors="ignore")[:400]
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
    """Download PDF export from a shareable Google Docs/Sheets/Slides link."""
    import httpx

    kind, file_id = parse_google_url(url)
    export_url = google_export_pdf_url(kind, file_id)
    headers = {
        "User-Agent": "PrynX/1.0 (OfficeConvert; +https://printsolutions.vn)",
        "Accept": "application/pdf,*/*",
    }
    try:
        with httpx.Client(follow_redirects=True, timeout=timeout, headers=headers) as client:
            r = client.get(export_url)
    except httpx.HTTPError as e:
        raise ValueError(f"Không tải được từ Google: {e}") from e

    ctype = (r.headers.get("content-type") or "").lower()
    body = r.content or b""

    if r.status_code in (401, 403):
        raise ValueError(
            "Google từ chối (401/403). Hãy đặt quyền chia sẻ "
            "«Anyone with the link» (Người có link) hoặc «Public», rồi thử lại. "
            "File chỉ mình bạn xem cần đăng nhập — PrynX chưa hỗ trợ OAuth Google."
        )
    if r.status_code >= 400:
        raise ValueError(f"Google trả lỗi HTTP {r.status_code}.")

    # HTML login / virus-scan interstitial instead of PDF
    if body[:4] != b"%PDF" and ("text/html" in ctype or body.lstrip()[:1] == b"<"):
        raise ValueError(
            "Google trả trang HTML thay vì PDF (thường do file private hoặc cần đăng nhập). "
            "Đặt chia sẻ public/anyone-with-link, hoặc File → Download → PDF rồi mở trong PrynX."
        )
    if body[:4] != b"%PDF":
        # Drive uc download sometimes wraps; still reject non-PDF
        raise ValueError(
            "Nội dung tải về không phải PDF. Kiểm tra link và quyền chia sẻ."
        )

    os.makedirs(os.path.dirname(output_pdf) or ".", exist_ok=True)
    with open(output_pdf, "wb") as f:
        f.write(body)
    return output_pdf
