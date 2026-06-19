"""Test FileTransport (task 4.2). Requirements: 5.1, 8.4."""

import os

from app.workers.cut_export.transport.file import FileTransport


def test_file_transport_writes_bytes(tmp_path):
    dest = str(tmp_path / "job.plt")
    t = FileTransport(dest)
    r = t.send(b"IN U0,0 D10,10 @ @ ")
    assert r.ok is True
    assert r.channel == "file"
    assert r.bytes_sent == 19
    assert os.path.isfile(dest)
    with open(dest, "rb") as f:
        assert f.read() == b"IN U0,0 D10,10 @ @ "


def test_file_transport_creates_parent_dirs(tmp_path):
    dest = str(tmp_path / "sub" / "deep" / "job.dxf")
    r = FileTransport(dest).send(b"0\nSECTION\n")
    assert r.ok is True
    assert os.path.isfile(dest)


def test_file_transport_deterministic(tmp_path):
    # Cùng dữ liệu → cùng nội dung byte (đơn định).
    d1 = str(tmp_path / "a.plt")
    d2 = str(tmp_path / "b.plt")
    data = b"U0,0 D5,5 "
    FileTransport(d1).send(data)
    FileTransport(d2).send(data)
    assert open(d1, "rb").read() == open(d2, "rb").read()


def test_file_transport_error_on_bad_path(tmp_path):
    # Đường dẫn là thư mục đã tồn tại → ghi file thất bại, trả ok=False, không ném.
    bad = str(tmp_path)  # chính tmp_path là directory
    r = FileTransport(bad).send(b"x")
    assert r.ok is False
    assert "Lỗi ghi file" in r.detail
