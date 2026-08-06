"""RESIZE (audit 2026-08-06 §G.5/§G.6): parser chọn trang DÙNG CHUNG.

Trước đây có ba bản parser (pdf_tools_engine, resize_background_engine, và
PdfSplitter.parseRanges bên frontend). Test này chốt hành vi bản chung và chốt
rằng hai engine backend gọi cùng một hàm.
"""
import pytest

from app.core.page_selection import parse_page_selection, validate_page_selection


@pytest.mark.parametrize(
    "value,total,expected",
    [
        ("all", 4, {0, 1, 2, 3}),
        ("ALL", 4, {0, 1, 2, 3}),
        ("even", 5, {1, 3}),
        ("odd", 5, {0, 2, 4}),
        ("1,3", 5, {0, 2}),
        ("2-4", 5, {1, 2, 3}),
        ("3-", 5, {2, 3, 4}),          # dải hở tới trang cuối
        ("1, ,3", 5, {0, 2}),          # token trắng bị bỏ
        ("4-99", 5, {3, 4}),           # cắt theo tổng số trang
        ("99", 5, set()),              # ngoài phạm vi
        ("", 3, {0, 1, 2}),            # rỗng = all
        ("2-4", 0, set()),             # tài liệu rỗng
    ],
)
def test_parse_page_selection(value, total, expected):
    assert parse_page_selection(value, total) == expected


@pytest.mark.parametrize("value", ["all", "even", "odd", "1,3,5-8", "7-", "", None])
def test_validate_chap_nhan_chuoi_hop_le(value):
    validate_page_selection(value)


@pytest.mark.parametrize("value", ["abc", "1,abc", "-3", "5-2", "0", "0-4", "1..3"])
def test_validate_bao_loi_chuoi_sai(value):
    with pytest.raises(ValueError):
        validate_page_selection(value)


def test_hai_engine_dung_chung_parser():
    from app.workers import pdf_tools_engine, resize_background_engine

    assert pdf_tools_engine.parse_page_selection is parse_page_selection
    assert resize_background_engine._parse_pages("2-4", 5) == parse_page_selection("2-4", 5)


def test_resize_smart_bao_loi_chuoi_trang_sai(tmp_path):
    """RESIZE §G.5: chuỗi trang sai cú pháp phải ném ValueError (route → 422),
    KHÔNG được im lặng trả về file y nguyên."""
    import pikepdf

    from app.workers.pdf_tools_engine import resize_pages_smart

    src = str(tmp_path / "src.pdf")
    out = str(tmp_path / "out.pdf")
    doc = pikepdf.Pdf.new()
    doc.add_blank_page(page_size=(595, 842))
    doc.save(src)
    doc.close()

    with pytest.raises(ValueError):
        resize_pages_smart(src, out, 100.0, 100.0, apply_to="1-abc")
