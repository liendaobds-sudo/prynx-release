import io

import pytest

from app.api.routes import vdp


def test_parse_csv_upload_preserves_header_rows_and_delimiter():
    stream = io.BytesIO("Name;Code\nAlice;A-1\nBob;B-2\n".encode("utf-8"))

    rows = vdp._parse_csv_upload(stream, has_header=True)

    assert rows == [
        {"Name": "Alice", "Code": "A-1"},
        {"Name": "Bob", "Code": "B-2"},
    ]
    assert stream.tell() == 0


def test_parse_csv_upload_assigns_positional_columns_without_header():
    stream = io.BytesIO("Alice,A-1\nBob,B-2\n".encode("utf-8"))

    rows = vdp._parse_csv_upload(stream, has_header=False)

    assert rows == [
        {"Cột 1": "Alice", "Cột 2": "A-1"},
        {"Cột 1": "Bob", "Cột 2": "B-2"},
    ]


def test_parse_csv_upload_rejects_rows_above_cap(monkeypatch):
    monkeypatch.setattr(vdp, "MAX_VDP_ROWS", 1)
    stream = io.BytesIO("Name\nAlice\nBob\n".encode("utf-8"))

    with pytest.raises(ValueError, match="Quá nhiều bản ghi"):
        vdp._parse_csv_upload(stream, has_header=True)
