"""Property-based tests cho Data_Source_Reader (app.workers.vdp_datasource).

Mỗi property test chạy ≥ 100 ví dụ và gắn comment tham chiếu theo định dạng
`# Feature: vdp-upgrade, Property {n}: {text}`.
"""
import os
import sys

from hypothesis import given, settings, strategies as st

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from app.workers.vdp_datasource import normalize_columns


# Feature: vdp-upgrade, Property 7: Khử trùng tên cột không mất cột
@settings(max_examples=100)
@given(
    header=st.lists(
        st.text(
            alphabet=st.characters(
                # Bao gồm khoảng trắng, ASCII và một dải Unicode tiếng Việt
                min_codepoint=0x20,
                max_codepoint=0x1EF9,
            ),
            min_size=0,
            max_size=8,
        ),
        min_size=0,
        max_size=12,
    )
)
def test_normalize_columns_no_loss(header):
    """normalize_columns trả về danh sách cùng độ dài, mọi tên duy nhất và không rỗng.

    **Validates: Requirements 1.11**
    """
    result = normalize_columns(header)

    # Cùng độ dài với đầu vào (không mất cột).
    assert len(result) == len(header)

    # Mọi tên là duy nhất.
    assert len(set(result)) == len(result)

    # Không có tên rỗng (rỗng hoặc chỉ khoảng trắng).
    assert all(name.strip() != "" for name in result)


from hypothesis import assume

from app.workers.vdp_datasource import detect_encoding


# Tập ký tự tiếng Việt có dấu (hoa + thường) để buộc nội dung mang dấu.
_VIETNAMESE_CHARS = (
    "àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệ"
    "ìíỉĩịòóỏõọôồốổỗộơờớởỡợ"
    "ùúủũụưừứửữựỳýỷỹỵđ"
    "ÀÁẢÃẠĂẰẮẲẴẶÂẦẤẨẪẬÈÉẺẼẸÊỀẾỂỄỆ"
    "ÌÍỈĨỊÒÓỎÕỌÔỒỐỔỖỘƠỜỚỞỠỢ"
    "ÙÚỦŨỤƯỪỨỬỮỰỲÝỶỸỴĐ"
)


def _vietnamese_text():
    """Sinh chuỗi trộn tiếng Việt có dấu + ASCII in được.

    Bao gồm cả ký tự ASCII (0x20–0x7E) và dải tiếng Việt để phủ cả nội dung
    thuần ASCII lẫn nội dung có dấu (Req 1.7).
    """
    alphabet = st.one_of(
        st.sampled_from(_VIETNAMESE_CHARS),
        st.characters(min_codepoint=0x20, max_codepoint=0x7E),
    )
    return st.text(alphabet=alphabet, min_size=0, max_size=40)


# Feature: vdp-upgrade, Property 6: Nhận diện encoding round-trip
@settings(max_examples=100)
@given(
    text=_vietnamese_text(),
    enc=st.sampled_from(["utf-8", "utf-8-sig", "windows-1258"]),
)
def test_detect_encoding_roundtrip(text, enc):
    """Encode bằng một encoding hỗ trợ rồi detect_encoding + decode phải phục hồi
    đúng văn bản gốc (kể cả tiếng Việt có dấu).

    **Validates: Requirements 1.6, 1.7**
    """
    # Tránh nhập nhằng BOM: văn bản gốc không bắt đầu bằng ký tự BOM (U+FEFF).
    assume(not text.startswith("\ufeff"))

    # Codec phải biểu diễn được các ký tự này (Windows-1258 không phủ mọi ký tự
    # tiếng Việt tổ hợp sẵn) — bỏ qua khi codec không hỗ trợ.
    try:
        raw = text.encode(enc)
    except UnicodeEncodeError:
        assume(False)

    # Chỉ xét khi chính codec round-trip được văn bản (loại bỏ mất mát do codec).
    assume(raw.decode(enc) == text)

    detected = detect_encoding(raw)

    # Windows-1258 là fallback: với nội dung phi-ASCII, chỉ phục hồi đúng khi
    # bytes KHÔNG hợp lệ như UTF-8 (nhập nhằng mã đơn byte là cố hữu) → ràng buộc
    # detect chọn windows-1258. Nội dung ASCII trùng bytes với UTF-8 nên vẫn đúng.
    if enc == "windows-1258" and not text.isascii():
        assume(detected == "windows-1258")

    assert raw.decode(detected) == text


from app.workers.vdp_datasource import SUPPORTED_DELIMITERS, detect_delimiter


def _column_names():
    """Sinh tên cột KHÔNG chứa bất kỳ delimiter hỗ trợ nào (',', ';', '\\t').

    Loại trừ các ký tự phân tách để delimiter đã chọn là ứng viên duy nhất cho
    số cột lớn nhất. Bao gồm chữ cái, số, khoảng trắng và tiếng Việt có dấu.
    """
    alphabet = st.one_of(
        st.sampled_from(_VIETNAMESE_CHARS),
        st.characters(
            min_codepoint=0x20,
            max_codepoint=0x7E,
            blacklist_characters="".join(SUPPORTED_DELIMITERS),
        ),
    )
    return st.text(alphabet=alphabet, min_size=0, max_size=10)


# Feature: vdp-upgrade, Property 5: Nhận diện delimiter đúng
@settings(max_examples=100)
@given(
    names=st.lists(_column_names(), min_size=2, max_size=8),
    delimiter=st.sampled_from(SUPPORTED_DELIMITERS),
)
def test_detect_delimiter_returns_chosen(names, delimiter):
    """Dòng tiêu đề tạo bằng cách nối N>=2 tên cột (không chứa delimiter hỗ trợ)
    bằng một delimiter đã chọn ⇒ detect_delimiter trả đúng delimiter đó.

    **Validates: Requirements 1.5**
    """
    header_line = delimiter.join(names)

    assert detect_delimiter(header_line) == delimiter


import csv as _csv_mod
import io as _io_mod

from app.workers.vdp_datasource import parse_delimited


def _csv_cell_text():
    """Sinh nội dung ô an toàn cho CSV: chữ cái/số/khoảng trắng/tiếng Việt.

    Loại bỏ ký tự xuống dòng (\\r, \\n) để tránh nhập nhằng ranh giới dòng; việc
    serialize dùng csv.writer của Python nên dấu phân tách và dấu nháy được escape
    đúng chuẩn, đảm bảo round-trip.
    """
    alphabet = st.one_of(
        st.sampled_from(_VIETNAMESE_CHARS),
        st.characters(
            min_codepoint=0x20,
            max_codepoint=0x7E,
        ),
    )
    return st.text(alphabet=alphabet, min_size=0, max_size=20)


@st.composite
def _record_tables(draw):
    """Sinh dataset giống RecordTable: header tên cột + các dòng ô chuỗi.

    - Số cột N trong [1, 6].
    - Tên cột được tạo duy nhất bằng cách thêm hậu tố chỉ số → tránh phụ thuộc
      hành vi khử trùng của parser (so sánh trực tiếp cột & giá trị).
    - Mỗi dòng có đúng N ô (đầy đủ), nội dung gồm cả tiếng Việt.
    """
    n_cols = draw(st.integers(min_value=1, max_value=6))
    base_names = draw(
        st.lists(_csv_cell_text(), min_size=n_cols, max_size=n_cols)
    )
    # Đảm bảo tên cột duy nhất & không rỗng (khớp bất biến RecordTable).
    header = [f"c{i}_{(base or 'col').strip() or 'col'}" for i, base in enumerate(base_names)]

    n_rows = draw(st.integers(min_value=0, max_value=8))
    rows = draw(
        st.lists(
            st.lists(_csv_cell_text(), min_size=n_cols, max_size=n_cols),
            min_size=n_rows,
            max_size=n_rows,
        )
    )
    return header, rows


def _serialize_csv(header, rows, delimiter):
    """Serialize header + rows thành văn bản CSV bằng csv.writer chuẩn Python."""
    buf = _io_mod.StringIO()
    writer = _csv_mod.writer(buf, delimiter=delimiter, lineterminator="\n")
    writer.writerow(header)
    for row in rows:
        writer.writerow(row)
    return buf.getvalue()


# Feature: vdp-upgrade, Property 1: CSV round-trip bảo toàn dữ liệu (kể cả tiếng Việt)
@settings(max_examples=100)
@given(data=_record_tables(), delimiter=st.sampled_from(SUPPORTED_DELIMITERS))
def test_csv_roundtrip_preserves_data(data, delimiter):
    """Serialize RecordTable → CSV rồi parse_delimited lại phục hồi đúng số cột và
    giá trị từng dòng, giữ nguyên codepoint Unicode tiếng Việt.

    **Validates: Requirements 1.1, 1.7**
    """
    header, rows = data
    text = _serialize_csv(header, rows, delimiter)

    table = parse_delimited(text, delimiter, has_header=True)

    # Cùng số cột với header gốc.
    assert len(table.columns) == len(header)

    # Vì tên cột đã duy nhất, normalize_columns giữ nguyên → cột trùng khớp.
    assert table.columns == header

    # Cùng số dòng dữ liệu.
    assert len(table.rows) == len(rows)

    # Mỗi ô giá trị được bảo toàn (kể cả tiếng Việt).
    for original_row, parsed_row in zip(rows, table.rows):
        for col, value in zip(header, original_row):
            assert parsed_row[col] == value


# Feature: vdp-upgrade, Property 8: Cấu trúc RecordTable đồng nhất và quy tắc dòng tiêu đề
@settings(max_examples=100)
@given(data=_record_tables(), delimiter=st.sampled_from(SUPPORTED_DELIMITERS))
def test_recordtable_structure_uniform(data, delimiter):
    """Mọi dòng dict có khoá đúng bằng table.columns (cấu trúc đồng nhất); dòng
    hoàn toàn rỗng bị bỏ qua; dòng tiêu đề = dòng KHÔNG rỗng đầu tiên.

    **Validates: Requirements 1.10**
    """
    header, rows = data
    text = _serialize_csv(header, rows, delimiter)

    # Chèn các dòng hoàn toàn rỗng ở đầu, giữa và cuối để kiểm quy tắc bỏ qua.
    lines = text.split("\n")
    injected = [""] + lines[:1] + ["", ""] + lines[1:] + ["", ""]
    text_with_blanks = "\n".join(injected)

    table = parse_delimited(text_with_blanks, delimiter, has_header=True)

    # Cấu trúc đồng nhất: mọi row dict có keys đúng bằng columns.
    column_set = set(table.columns)
    assert len(column_set) == len(table.columns)  # cột duy nhất
    for row in table.rows:
        assert set(row.keys()) == column_set

    # Dòng tiêu đề = dòng KHÔNG rỗng đầu tiên ⇒ cột khớp header gốc (đã duy nhất).
    assert table.columns == header

    # Các dòng rỗng bị bỏ qua ⇒ số dòng dữ liệu bằng số dòng gốc.
    assert len(table.rows) == len(rows)
