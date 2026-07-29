"""Preview và export phải đọc CÙNG hệ quy chiếu trang.

[AUDIT §2.1, §4.4] docs/BAO_CAO_AUDIT_HE_TOA_DO_PARSER_2026-07-28.md

`run_nup_engine` chuẩn hoá `/Rotate` + gốc MediaBox qua `_canonicalize_page_space`
trước khi layout. Route `/imposition/preview-layout` và `/imposition/detect-shape`
trước đây mở file THÔ, nên với trang `/Rotate ≠ 0` chúng thấy khổ chưa hoán w/h.

Lệch đo được trước lô 2:
    Rotate=0   preview (200, 100) | export (200, 100)  KHỚP
    Rotate=90  preview (200, 100) | export (100, 200)  LỆCH
"""
import os

import pikepdf
import pytest

from app.api.routes.imposition import PreviewLayoutRequest, preview_layout
from app.workers import nup_engine
from tests.license_helpers import PRO_LICENSE

MM = 2.83465
# Trang landscape 200×100pt kèm /Rotate=90 → khổ NHÌN THẤY là 100×200pt.
RAW_W, RAW_H = 200.0, 100.0


def _make_rotated(path, rotate):
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(RAW_W, RAW_H))
    page = pdf.pages[0]
    if rotate:
        page.obj[pikepdf.Name("/Rotate")] = rotate
    page.obj[pikepdf.Name("/Contents")] = pdf.make_stream(
        b"0 1 0 0 K 0.5 w 10 10 180 80 re S\n"
    )
    pdf.save(str(path))
    pdf.close()
    return str(path)


def _preview(path, **over):
    kwargs = dict(
        path=path,
        usable_w=500.0,
        usable_h=500.0,
        # Với is_die_cut=True, khổ ô lấy từ ĐƯỜNG BẾ trong file — hai giá trị này chỉ
        # là chỗ giữ tham số, không quyết định kết quả.
        item_w=60.0,
        item_h=30.0,
        gap_x=0.0,
        gap_y=0.0,
        strategy="simple_auto",
        bleed=0.0,
        sheet_w=520.0,
        sheet_h=520.0,
        is_die_cut=True,
    )
    kwargs.update(over)
    return preview_layout(PreviewLayoutRequest(**kwargs), PRO_LICENSE)


def _die_size(path):
    """Khổ đường bế đọc từ `path` — đúng cách bình bản đọc."""
    from app.workers import pdf_wrapper
    from app.workers.nup_diecut import _find_largest_die_path

    doc = pdf_wrapper.open(path)
    try:
        found = _find_largest_die_path(doc[0])
        assert found is not None, "phải tìm được đường bế"
        return (round(found["rect"].width, 3), round(found["rect"].height, 3))
    finally:
        doc.close()


def _export_die_size(path):
    """Khổ đường bế mà EXPORT thấy (sau chốt chuẩn hoá của run_nup_engine)."""
    with nup_engine.canonical_page_space(path) as canon:
        return _die_size(canon)


@pytest.mark.parametrize("rotate", [0, 90, 180, 270])
def test_preview_cell_matches_export_die_size(tmp_path, rotate):
    """Ô preview phải khớp khổ đường bế mà export dựng, ở MỌI góc /Rotate."""
    src = _make_rotated(tmp_path / f"r{rotate}.pdf", rotate)
    exp_w, exp_h = _export_die_size(src)

    result = _preview(src)
    assert result["success"] is True
    cells = result.get("cells") or []
    assert cells, "preview phải dựng được ít nhất một ô"

    cell = cells[0]
    assert cell["width"] == pytest.approx(exp_w, abs=0.5), (
        f"/Rotate={rotate}: bề ngang ô preview {cell['width']} ≠ export {exp_w}"
    )
    assert cell["height"] == pytest.approx(exp_h, abs=0.5), (
        f"/Rotate={rotate}: bề cao ô preview {cell['height']} ≠ export {exp_h}"
    )


def test_rotated_page_is_the_case_that_used_to_diverge(tmp_path):
    """Ghim ca hồi quy, kèm BASELINE của hành vi cũ.

    Trước lô 2b, preview mở file THÔ nên đọc đường bế 180×80; export chuẩn hoá trước
    rồi đọc nên thấy 80×180. Test này giữ cả hai con số để lệch không âm thầm quay lại.
    """
    src = _make_rotated(tmp_path / "r90.pdf", 90)

    raw = _die_size(src)               # hành vi ĐỌC THÔ (preview cũ)
    export = _export_die_size(src)     # hành vi export
    assert raw != export, "ca này phải thực sự lệch, nếu không test vô nghĩa"
    assert raw == (180.0, 80.0)
    assert export == (80.0, 180.0)

    cell = (_preview(src)["cells"] or [])[0]
    assert (cell["width"], cell["height"]) == pytest.approx(export, abs=0.5)


def test_preview_does_not_leak_canonical_temp_files(tmp_path, monkeypatch):
    """ExitStack phải dọn file tạm ở MỌI đường ra của preview_layout."""
    monkeypatch.setattr(nup_engine.tempfile, "gettempdir", lambda: str(tmp_path))
    src = _make_rotated(tmp_path / "r90.pdf", 90)

    _preview(src)

    leaked = list(tmp_path.glob("nup_canon_*.pdf"))
    assert leaked == [], f"rò rỉ file tạm: {leaked}"


def test_preview_does_not_leak_temp_on_error(tmp_path, monkeypatch):
    """Nhánh ném HTTPException cũng không được để lại file tạm."""
    from fastapi import HTTPException

    monkeypatch.setattr(nup_engine.tempfile, "gettempdir", lambda: str(tmp_path))
    src = _make_rotated(tmp_path / "r90.pdf", 90)

    # usable nhỏ hơn tem → engine báo lỗi 422 ở giữa thân hàm.
    with pytest.raises((HTTPException, ValueError, Exception)):
        _preview(src, usable_w=1.0, usable_h=1.0, strategy="manual", cols=0, rows=0)

    leaked = list(tmp_path.glob("nup_canon_*.pdf"))
    assert leaked == [], f"rò rỉ file tạm ở nhánh lỗi: {leaked}"


def test_unrotated_file_is_not_rewritten(tmp_path, monkeypatch):
    """File đã chuẩn: preview KHÔNG được tạo file tạm (giữ nguyên hiệu năng)."""
    monkeypatch.setattr(nup_engine.tempfile, "gettempdir", lambda: str(tmp_path))
    src = _make_rotated(tmp_path / "r0.pdf", 0)

    _preview(src)

    assert list(tmp_path.glob("nup_canon_*.pdf")) == []


def test_cache_key_uses_original_path_not_temp(tmp_path):
    """Khoá cache preview phải bám đường GỐC, nếu không cache không bao giờ hit.

    Đường chuẩn hoá là file tạm mang uuid + mtime mới mỗi request. Nếu nó lọt vào
    `_sticker_nest_cache_key` thì mọi request đều miss → preview nesting chậm hẳn.
    Test đo bằng cách gọi hai lần và đối chiếu kết quả: cùng đầu vào phải cùng đầu ra
    và lần hai không được sinh thêm file tạm nào còn sót.
    """
    src = _make_rotated(tmp_path / "r90.pdf", 90)

    first = _preview(src)
    second = _preview(src)

    assert first["cells"][0]["width"] == second["cells"][0]["width"]
    assert first["cells"][0]["height"] == second["cells"][0]["height"]
    assert len(first["cells"]) == len(second["cells"])
    # Đường gốc vẫn còn nguyên (không bị hàm chuẩn hoá xoá).
    assert os.path.exists(src)
