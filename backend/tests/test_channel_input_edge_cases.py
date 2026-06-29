"""Unit tests: input edge cases & hidden-layer (OCG) handling cho remove_channels.

Feature: channel-remover (task 8.7)

Phủ các nhánh điều phối của ``remove_channels`` và OCG gating của
``_traverse_pages`` / ``ContentStreamTransformer``:

  - File 0 byte → lỗi rõ ràng ("rỗng") (Req 11.1).
  - File không phải PDF hợp lệ → lỗi rõ ràng (Req 11.2).
  - PDF hợp lệ không chứa nội dung CMYK → vẫn ghi bản sao hợp lệ + cảnh báo
    ``NO_CMYK_WARNING``; ``identical_to_original`` True (Req 11.5).
  - OCG ẩn (``/OCProperties/D/OFF`` + ``/OC /Name BDC … EMC``): với
    ``process_hidden_layers=False`` (mặc định) nội dung CMYK trong layer ẩn được
    GIỮ NGUYÊN (Req 12.2); với ``process_hidden_layers=True`` thì layer ẩn cũng
    bị gỡ kênh (Req 12.3).

Mọi test dùng ``mode="direct"`` (không phụ thuộc ICC profile) để xác định và
độc lập với môi trường.
"""
import re

import pikepdf
import pytest

from app.core.channel_remover import (
    NO_CMYK_WARNING,
    remove_channels,
)

# Tham số hợp lệ tối thiểu: giữ C/M/K, gỡ Y (validate_params phải pass trước khi
# tới bước validate file / mở PDF).
_VALID_PARAMS = {"kept_channels": ["C", "M", "K"], "mode": "direct"}


# ---------------------------------------------------------------------------
# Helpers — đọc lại content stream + parse toán hạng của toán tử `k`
# ---------------------------------------------------------------------------

def _read_page_content(pdf_path: str, page_index: int = 0) -> str:
    """Đọc & nối content stream của một trang trong PDF đã ghi, trả về str."""
    with pikepdf.open(pdf_path) as pdf:
        page = pdf.pages[page_index]
        contents = page.get("/Contents")
        if contents is None:
            return ""
        if isinstance(contents, pikepdf.Array):
            chunks = [bytes(ref.read_bytes()) for ref in contents]
            data = b"\n".join(chunks)
        else:
            data = bytes(contents.read_bytes())
    return data.decode("latin-1")


def _parse_k_operands(content: str):
    """Trả list các bộ 4 toán hạng (str) của mọi toán tử fill ``k`` trong content."""
    results = []
    for match in re.finditer(
        r"([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+k\b", content
    ):
        results.append(match.groups())
    return results


def _build_ocg_pdf(path: str) -> None:
    """Dựng PDF 1 trang với nội dung CMYK nằm trong một OCG ẩn (OFF).

    Cấu trúc bám đúng những gì implementation kiểm tra:
      - ``/Root/OCProperties/D/OFF`` chứa OCG (object gián tiếp) → ẩn (Req 12).
      - ``/Resources/Properties /MC0`` trỏ tới chính OCG ẩn đó.
      - Content: ``/OC /MC0 BDC <cmyk> k … EMC`` — marked content gate bởi OCG ẩn.
    """
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(200, 200))

    # OCG (object gián tiếp để có objgen định danh được).
    ocg = pdf.make_indirect(
        pikepdf.Dictionary(Type=pikepdf.Name("/OCG"), Name="Hidden Layer")
    )

    # Cấu hình hiển thị mặc định: OCG nằm trong /OFF → ẩn.
    pdf.Root[pikepdf.Name("/OCProperties")] = pikepdf.Dictionary(
        OCGs=pikepdf.Array([ocg]),
        D=pikepdf.Dictionary(
            Order=pikepdf.Array([ocg]),
            ON=pikepdf.Array([]),
            OFF=pikepdf.Array([ocg]),
        ),
    )

    # Resources/Properties: /MC0 -> OCG ẩn (phân giải /OC /MC0 BDC).
    page.obj[pikepdf.Name("/Resources")] = pikepdf.Dictionary(
        Properties=pikepdf.Dictionary(MC0=ocg)
    )

    # Nội dung CMYK (toán tử `k`) bọc trong marked content của OCG ẩn.
    content = (
        b"/OC /MC0 BDC\n"
        b"0.4 0.5 0.6 0.7 k\n"
        b"10 10 50 50 re f\n"
        b"EMC\n"
    )
    page.obj[pikepdf.Name("/Contents")] = pdf.make_stream(content)
    pdf.save(path)
    pdf.close()


# ---------------------------------------------------------------------------
# 1) File 0 byte → lỗi rõ ràng ("rỗng") — Req 11.1
# ---------------------------------------------------------------------------

def test_zero_byte_input_raises_clear_error(tmp_path):
    empty = tmp_path / "empty.pdf"
    empty.write_bytes(b"")  # 0 byte
    out = tmp_path / "out.pdf"

    with pytest.raises(ValueError) as excinfo:
        remove_channels(str(empty), str(out), dict(_VALID_PARAMS))

    assert "rỗng" in str(excinfo.value).lower() or "0 byte" in str(excinfo.value)
    # Không tạo output cho input không hợp lệ.
    assert not out.exists()


# ---------------------------------------------------------------------------
# 2) File không phải PDF hợp lệ → lỗi rõ ràng — Req 11.2
# ---------------------------------------------------------------------------

def test_invalid_non_pdf_input_raises_clear_error(tmp_path):
    bogus = tmp_path / "not_a_pdf.pdf"
    bogus.write_bytes(b"This is definitely not a PDF file.\n" * 4)
    out = tmp_path / "out.pdf"

    with pytest.raises(ValueError) as excinfo:
        remove_channels(str(bogus), str(out), dict(_VALID_PARAMS))

    msg = str(excinfo.value).lower()
    assert "pdf" in msg  # thông điệp đề cập PDF không hợp lệ
    assert not out.exists()


def test_missing_input_file_raises_clear_error(tmp_path):
    missing = tmp_path / "does_not_exist.pdf"
    out = tmp_path / "out.pdf"

    with pytest.raises(ValueError) as excinfo:
        remove_channels(str(missing), str(out), dict(_VALID_PARAMS))

    assert "không tồn tại" in str(excinfo.value).lower() or "tồn tại" in str(
        excinfo.value
    ).lower()


# ---------------------------------------------------------------------------
# 3) PDF hợp lệ không CMYK → bản sao hợp lệ + NO_CMYK_WARNING — Req 11.5
# ---------------------------------------------------------------------------

def test_valid_pdf_no_cmyk_writes_copy_with_warning(tmp_path):
    src = tmp_path / "rgb_only.pdf"
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(200, 200))
    # Chỉ dùng DeviceRGB (rg) — không có toán hạng CMYK nào.
    page.obj[pikepdf.Name("/Contents")] = pdf.make_stream(
        b"1 0 0 rg\n10 10 80 80 re f\n"
    )
    pdf.save(str(src))
    pdf.close()

    out = tmp_path / "out.pdf"
    report = remove_channels(str(src), str(out), dict(_VALID_PARAMS))

    # Output luôn được ghi (bản sao hợp lệ) và mở lại được bằng pikepdf.
    assert out.exists() and out.stat().st_size > 0
    with pikepdf.open(str(out)) as result_pdf:
        assert len(result_pdf.pages) == 1

    # Không có nội dung CMYK nào bị thay đổi → cảnh báo no-op + identical.
    assert NO_CMYK_WARNING in report.warnings
    assert report.total_colors == 0
    assert report.out_of_gamut_count == 0
    assert report.identical_to_original is True


# ---------------------------------------------------------------------------
# 4) OCG ẩn — option tắt (mặc định) giữ nguyên layer ẩn — Req 12.2
# ---------------------------------------------------------------------------

def test_hidden_ocg_preserved_when_process_hidden_layers_off(tmp_path):
    src = tmp_path / "hidden_ocg.pdf"
    _build_ocg_pdf(str(src))

    out = tmp_path / "out_off.pdf"
    params = {"kept_channels": ["C", "M", "K"], "mode": "direct"}  # gỡ Y
    report = remove_channels(str(src), str(out), params)

    # Layer ẩn KHÔNG bị biến đổi → không thu ColorHit nào (no-op).
    assert report.total_colors == 0
    assert NO_CMYK_WARNING in report.warnings
    assert report.identical_to_original is True

    # Toán hạng CMYK của layer ẩn được giữ nguyên (kênh Y vẫn = 0.6, chưa bị 0 hoá).
    operands = _parse_k_operands(_read_page_content(str(out)))
    assert operands, "Phải còn toán tử `k` của layer ẩn trong output"
    c, m, y, k = operands[0]
    assert float(c) == pytest.approx(0.4)
    assert float(m) == pytest.approx(0.5)
    assert float(y) == pytest.approx(0.6)  # Y KHÔNG bị gỡ vì layer ẩn được giữ
    assert float(k) == pytest.approx(0.7)


# ---------------------------------------------------------------------------
# 5) OCG ẩn — option bật thì gỡ kênh cả layer ẩn — Req 12.3
# ---------------------------------------------------------------------------

def test_hidden_ocg_processed_when_process_hidden_layers_on(tmp_path):
    src = tmp_path / "hidden_ocg2.pdf"
    _build_ocg_pdf(str(src))

    out = tmp_path / "out_on.pdf"
    params = {
        "kept_channels": ["C", "M", "K"],  # gỡ Y
        "mode": "direct",
        "process_hidden_layers": True,
    }
    report = remove_channels(str(src), str(out), params)

    # Bật xử lý layer ẩn → màu CMYK của layer ẩn bị biến đổi (thu 1 ColorHit).
    assert report.total_colors == 1
    assert NO_CMYK_WARNING not in report.warnings

    # Kênh Y (removed) bị 0 hoá; các kênh giữ (C/M/K) bảo toàn.
    operands = _parse_k_operands(_read_page_content(str(out)))
    assert operands, "Phải còn toán tử `k` (đã biến đổi) trong output"
    c, m, y, k = operands[0]
    assert float(c) == pytest.approx(0.4)
    assert float(m) == pytest.approx(0.5)
    assert float(y) == pytest.approx(0.0)  # Y bị gỡ
    assert float(k) == pytest.approx(0.7)
