"""Integration & smoke tests cho action REMOVE_CHANNELS (task 11.3).

Feature: channel-remover

Phủ ba nhóm kiểm thử trong Testing Strategy của design:

  1. SMOKE — ``REMOVE_CHANNELS`` có trong ``AVAILABLE_ACTIONS`` và được wiring tới
     handler ``_action_remove_channels`` của ``ActionEngine`` (Req 9.3).
  2. API INTEGRATION — ``POST /api/preflight/fix`` với ``action_id=REMOVE_CHANNELS``
     ghi file kết quả vào ``RESULTS_DIR/preflight_output`` và trả ``output_filename``
     tải được qua ``GET /api/preflight/download/{filename}`` (Req 9.1, 9.2); response
     surface trường ``report`` (ΔE / OOG) cho UI (Req 4.1, 4.2).
  3. RASTER (pypdfium2) — render file output qua ``SeparationEngine`` (pypdfium2),
     xác nhận kênh BỎ (vd Yellow) có mật độ mực ≈ 0 trên bản tách, trong khi kênh
     GIỮ vẫn còn mực (Req 13.2).

Mọi test dùng ``mode="direct"`` để xác định và độc lập với ICC profile (FOGRA39).
Test API dùng FastAPI ``TestClient`` + chèn một bản ghi ``UploadedFile`` vào DB
(DEV_MODE → SQLite) để ``/preflight/fix`` phân giải được ``file_id``; license guard
được bỏ qua ở DEV_MODE.
"""
import base64
import os
import uuid
import zlib
from pathlib import Path

import numpy as np
import pikepdf
import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.core.action_engine import AVAILABLE_ACTIONS, ActionEngine
from app.core.channel_remover import remove_channels
from app.core.separations import SeparationEngine
from app.database import SessionLocal
from app.main import app
from app.models.job import UploadedFile

client = TestClient(app)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _build_cmyk_pdf(path: str, cmyk_operands=("0", "0", "0.9", "0.3")) -> None:
    """Dựng PDF 1 trang phủ kín một màu DeviceCMYK (toán tử ``k``).

    Mặc định màu = Yellow 0.9 + Black 0.3 (KHÔNG có Cyan/Magenta). Khi gỡ kênh
    Yellow (giữ C/M/K) màu kết quả thành xám trung tính (0,0,0,0.3): bản tách
    Yellow ≈ 0 còn bản tách Black vẫn còn mực. Chọn cặp Y+K (không Magenta) để
    raster qua pypdfium2 không bị "lẫn" sang bản tách Yellow giả (màu pha M làm
    giảm Blue → nhiễu pseudo-Yellow), giữ phép kiểm "kênh bỏ ≈ 0" trung thực.
    """
    ops = " ".join(cmyk_operands)
    content = (f"{ops} k\n0 0 200 200 re\nf\n").encode("latin-1")

    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(200, 200))
    page.obj[pikepdf.Name("/Contents")] = pdf.make_stream(content)
    page.obj[pikepdf.Name("/Resources")] = pikepdf.Dictionary()
    pdf.save(path)
    pdf.close()


def _decode_plate_density(plate: dict, width: int, height: int) -> np.ndarray:
    """Giải nén ``alpha_data`` (zlib+base64) của một bản tách → mảng mật độ mực.

    Mảng trả về kiểu uint8 (0..255), trong đó 255 = phủ mực tối đa, 0 = không mực.
    """
    raw = zlib.decompress(base64.b64decode(plate["alpha_data"]))
    arr = np.frombuffer(raw, dtype=np.uint8)
    return arr.reshape(height, width)


def _plate_by_name(result: dict, name: str) -> dict:
    for plate in result["plates"]:
        if plate["name"] == name:
            return plate
    raise AssertionError(f"Không tìm thấy bản tách {name!r} trong {[p['name'] for p in result['plates']]}")


# ---------------------------------------------------------------------------
# 1) SMOKE — action đăng ký + handler wiring (Req 9.3)
# ---------------------------------------------------------------------------

def test_remove_channels_registered_in_available_actions():
    assert "REMOVE_CHANNELS" in AVAILABLE_ACTIONS
    meta = AVAILABLE_ACTIONS["REMOVE_CHANNELS"]
    # Metadata tối thiểu để UI render được action.
    assert meta.get("title")
    assert meta.get("engine") == "channel_remover"


def test_remove_channels_handler_is_wired():
    engine = ActionEngine()
    handler = getattr(engine, "_action_remove_channels", None)
    assert handler is not None, "Thiếu handler _action_remove_channels"
    assert callable(handler)


# ---------------------------------------------------------------------------
# 2) API INTEGRATION — /preflight/fix → /preflight/download (Req 9.1, 9.2, 4.1)
# ---------------------------------------------------------------------------

@pytest.fixture
def uploaded_cmyk_file(tmp_path):
    """Chèn một UploadedFile (PDF CMYK) vào DB, dọn dẹp sau test."""
    pdf_path = tmp_path / "cmyk_input.pdf"
    _build_cmyk_pdf(str(pdf_path))

    file_id = str(uuid.uuid4())
    db = SessionLocal()
    try:
        row = UploadedFile(
            id=file_id,
            filename="cmyk_input.pdf",
            original_name="cmyk_input.pdf",
            file_path=str(pdf_path),
            file_size=os.path.getsize(pdf_path),
            page_count=1,
        )
        db.add(row)
        db.commit()
    finally:
        db.close()

    yield file_id

    db = SessionLocal()
    try:
        obj = db.query(UploadedFile).filter(UploadedFile.id == file_id).first()
        if obj:
            db.delete(obj)
            db.commit()
    finally:
        db.close()


def test_fix_remove_channels_writes_output_and_downloadable(uploaded_cmyk_file):
    resp = client.post(
        "/api/preflight/fix",
        json={
            "file_id": uploaded_cmyk_file,
            "action_id": "REMOVE_CHANNELS",
            "params": {"kept_channels": ["C", "M", "K"], "mode": "direct"},
        },
    )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["success"] is True, body
    output_filename = body["output_filename"]
    assert output_filename, "Thiếu output_filename trong FixResponse"

    # (Req 9.1) File kết quả ghi dưới RESULTS_DIR/preflight_output.
    output_path = Path(settings.RESULTS_DIR) / "preflight_output" / output_filename
    assert output_path.exists(), f"Không thấy file output: {output_path}"

    # (Req 4.1, 4.2) Response surface trường report (thống kê ΔE / OOG).
    report = body.get("report")
    assert report is not None, "FixResponse.report phải được surface cho UI"
    assert report.get("total_colors", 0) >= 1
    assert report.get("out_of_gamut_count") == 0  # direct mode không đo OOG
    assert report.get("identical_to_original") is True

    # (Req 9.2) Tải lại qua Download_Endpoint → trả PDF bytes hợp lệ.
    dl = client.get(f"/api/preflight/download/{output_filename}")
    assert dl.status_code == 200, dl.text
    assert dl.content[:5] == b"%PDF-", "Nội dung tải về không phải PDF"

    # Output mở lại được bằng pikepdf (file PDF hợp lệ).
    with pikepdf.open(str(output_path)) as out_pdf:
        assert len(out_pdf.pages) == 1

    # Dọn file output.
    try:
        output_path.unlink()
    except OSError:
        pass


# ---------------------------------------------------------------------------
# 3) RASTER (pypdfium2) — kênh bỏ ≈ 0 trên bản tách (Req 13.2)
# ---------------------------------------------------------------------------

async def test_raster_removed_channel_is_near_zero(tmp_path):
    """Render output qua pypdfium2 + tách separations: kênh Yellow (bỏ) ≈ 0."""
    in_path = tmp_path / "in.pdf"
    out_path = tmp_path / "out.pdf"
    # Màu gốc: Yellow 0.9 + Black 0.3 (không Magenta) → gỡ Yellow cho ra xám trung tính.
    _build_cmyk_pdf(str(in_path), cmyk_operands=("0", "0", "0.9", "0.3"))

    # Gỡ kênh Yellow (giữ C/M/K) — chế độ direct, độc lập ICC.
    report = remove_channels(
        str(in_path), str(out_path),
        {"kept_channels": ["C", "M", "K"], "mode": "direct"},
    )
    assert report.output_filename == "out.pdf"
    assert out_path.exists()

    engine = SeparationEngine()

    # Bắt buộc đường xấp xỉ pypdfium2 (use_ghostscript=False):
    # FOGRA-managed GS tiffsep biến DeviceCMYK (0,0,0,0.3) thành multi-channel
    # (Yellow mean ~46) → false-fail dù stream PDF đã gỡ đúng kênh Y.
    # Mode direct + pseudo-CMYK khớp design test (độc lập ICC).
    # Bản tách của file GỐC: kênh Yellow phải có nhiều mực (sanity).
    in_sep = await engine.extract_separations(
        str(in_path), page_num=1, dpi=72, use_ghostscript=False
    )
    in_w, in_h = in_sep["width"], in_sep["height"]
    in_yellow = _decode_plate_density(_plate_by_name(in_sep, "Yellow"), in_w, in_h)
    in_yellow_mean = float(in_yellow.mean())
    assert in_yellow_mean > 80.0, (
        f"File gốc phải có nhiều mực Yellow (mean={in_yellow_mean:.1f})"
    )

    # Bản tách của file OUTPUT: kênh Yellow (đã bỏ) ≈ 0.
    out_sep = await engine.extract_separations(
        str(out_path), page_num=1, dpi=72, use_ghostscript=False
    )
    out_w, out_h = out_sep["width"], out_sep["height"]
    out_yellow = _decode_plate_density(_plate_by_name(out_sep, "Yellow"), out_w, out_h)
    out_yellow_mean = float(out_yellow.mean())

    assert out_yellow_mean < 20.0, (
        f"Kênh bỏ (Yellow) phải ≈ 0 ở output, nhưng mean={out_yellow_mean:.1f}"
    )
    assert out_yellow_mean < in_yellow_mean, (
        "Mực Yellow ở output phải giảm mạnh so với input"
    )

    # Kênh GIỮ (Black) vẫn còn mực → xác nhận test có ý nghĩa (không phải trang trắng).
    out_black = _decode_plate_density(_plate_by_name(out_sep, "Black"), out_w, out_h)
    assert float(out_black.mean()) > 20.0, (
        "Kênh giữ (Black) phải còn mực trong output"
    )
