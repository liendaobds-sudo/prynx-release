"""Regression tests cho bất biến AN TOÀN DỮ LIỆU của edit_io (chưa có test trước đây).

Bất biến tối quan trọng: thao tác edit KHÔNG BAO GIỜ ghi đè file gốc người dùng.
  - save_working_file từ chối (ValueError) khi output trùng file gốc.
  - build_working_file_path luôn ra thư mục edit_output + tên uuid (khác gốc).
  - apply_and_save round-trip: file gốc byte-identical sau khi chạy; output là file
    riêng, hợp lệ.
"""
import hashlib
import io
import os

import pikepdf
import pytest

from app.core import edit_io


def _sha(p):
    with open(p, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def _make_src(tmp_path):
    from app.workers import pdf_wrapper as pdf_lib
    d = pdf_lib.open()
    for i in range(2):
        pg = d.new_page(width=300, height=400)
        sh = pg.new_shape(); sh.draw_rect(pdf_lib.Rect(20, 30, 200, 200)); sh.finish(color=(0, 0, 0), fill=(0, 0, 0)); sh.commit()
    p = str(tmp_path / "orig.pdf")
    buf = io.BytesIO(); d.save(buf); d.close(); open(p, "wb").write(buf.getvalue())
    return p


def test_save_working_file_refuses_overwriting_source(tmp_path):
    src = _make_src(tmp_path)
    before = _sha(src)
    with pikepdf.open(src) as pdf:
        with pytest.raises(ValueError):
            edit_io.save_working_file(pdf, src, original_path=src)
    # File gốc KHÔNG bị đụng.
    assert _sha(src) == before


def test_build_working_file_path_is_uuid_in_edit_output(tmp_path):
    src = _make_src(tmp_path)
    wp = str(edit_io.build_working_file_path(src, "orig.pdf", suffix="edited", output_subdir="edit_output"))
    norm = wp.replace("\\", "/")
    assert "edit_output" in norm
    assert os.path.abspath(wp) != os.path.abspath(src)
    assert wp.lower().endswith(".pdf")


def test_apply_and_save_roundtrip_keeps_source_byte_identical(tmp_path):
    src = _make_src(tmp_path)
    before = _sha(src)
    out_path, _ = edit_io.apply_and_save(
        src, None, original_name="orig.pdf", suffix="rt", output_subdir="edit_output"
    )
    try:
        # Gốc KHÔNG đổi (byte-identical).
        assert _sha(src) == before
        # Output là file KHÁC, hợp lệ.
        assert os.path.abspath(out_path) != os.path.abspath(src)
        with pikepdf.open(out_path) as op:
            assert len(op.pages) == 2
    finally:
        if os.path.exists(out_path):
            os.remove(out_path)


def test_apply_and_save_missing_source_raises(tmp_path):
    with pytest.raises(FileNotFoundError):
        edit_io.apply_and_save(str(tmp_path / "nope.pdf"), None)
