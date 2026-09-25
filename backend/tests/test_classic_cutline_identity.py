"""Identity preview vẫn phát hiện sửa byte giữ nguyên thông tin stat."""
from __future__ import annotations

from io import BytesIO
import os

import pikepdf
import pytest

from app.workers import sticker_classic_page_preview as preview


def test_digest_changes_for_source_rewrite_with_same_size_and_mtime(tmp_path):
    source = tmp_path / "source.pdf"
    source.write_bytes(b"source-a")
    before_stat = source.stat()
    before = preview.source_digest(source)
    source.write_bytes(b"source-b")
    os.utime(source, ns=(before_stat.st_atime_ns, before_stat.st_mtime_ns))
    assert source.stat().st_size == before_stat.st_size
    assert source.stat().st_mtime_ns == before_stat.st_mtime_ns
    assert preview.source_digest(source) != before


def test_digest_does_not_swallow_or_retry_io_errors(monkeypatch):
    calls = []

    def broken(*args, **kwargs):
        calls.append(True)
        raise PermissionError("nguồn không đọc được")

    monkeypatch.setattr(preview, "open", broken, raising=False)
    with pytest.raises(PermissionError):
        preview.source_digest("missing.pdf")
    assert len(calls) == 1


def test_worker_reuses_one_content_digest_for_key_and_identity(tmp_path, monkeypatch):
    from app.workers.sticker_engine import StickerEngine

    source = tmp_path / "source.pdf"
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(72, 72))
    pdf.save(source)
    pdf.pages[0].Contents = pikepdf.Stream(
        pdf, b"q /CutContour CS 1 SCN 0 0 m 20 0 l 20 20 l 0 0 l h S Q\n",
    )
    output = BytesIO()
    pdf.save(output)
    pdf.close()
    pdf_bytes = output.getvalue()
    calls = []
    real_digest = preview.source_digest

    def digest(path):
        calls.append(str(path))
        return real_digest(path)

    monkeypatch.setattr(preview, "source_digest", digest)
    monkeypatch.setattr(preview, "_classic_baseline_cache", {})
    monkeypatch.setattr(preview, "CutlineTimer", lambda *a, **k: _NullTimer())
    monkeypatch.setattr(StickerEngine, "process_pdf", lambda *a, **k: (pdf_bytes, []))
    first = preview._render_canonical_classic_page(str(source), 1, (100, 100), {})
    assert len(calls) == 1
    # Lượt khác vẫn đọc byte mới; không biến reuse nội bộ thành cache stat.
    second = preview._render_canonical_classic_page(str(source), 1, (100, 100), {})
    assert len(calls) == 2
    assert first == second


class _NullTimer:
    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False
