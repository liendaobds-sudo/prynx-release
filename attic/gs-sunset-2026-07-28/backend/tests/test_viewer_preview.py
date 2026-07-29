from pathlib import Path
from types import SimpleNamespace

import app.core.viewer_preview as preview


def _install_fake_ghostscript(monkeypatch, tmp_path: Path):
    fake_exe = tmp_path / "gswin64c.exe"
    fake_exe.write_bytes(b"fake")
    monkeypatch.setattr(preview.settings, "GHOSTSCRIPT_PATH", str(fake_exe))
    monkeypatch.setattr(preview, "_CACHE_ROOT", tmp_path / "cache")
    preview._CACHE_ROOT.mkdir(parents=True, exist_ok=True)
    preview._locks.clear()
    calls = []

    def fake_run(cmd, **_kwargs):
        calls.append(cmd)
        output = next(arg.split("=", 1)[1] for arg in cmd if arg.startswith("-sOutputFile="))
        first = int(next((arg.split("=", 1)[1] for arg in cmd if arg.startswith("-dFirstPage=")), "1"))
        last = int(next((arg.split("=", 1)[1] for arg in cmd if arg.startswith("-dLastPage=")), str(first)))
        if "%06d" in output:
            for sequence in range(1, last - first + 2):
                path = Path(output.replace("%06d", f"{sequence:06d}"))
                path.write_bytes(f"thumb-{sequence}".encode())
        else:
            Path(output).write_bytes(b"page-preview")
        return SimpleNamespace(returncode=0, stderr=b"")

    monkeypatch.setattr(preview, "run_hidden", fake_run)
    return calls


def test_main_preview_is_cached_by_file_revision(monkeypatch, tmp_path):
    calls = _install_fake_ghostscript(monkeypatch, tmp_path)
    pdf = tmp_path / "source.pdf"
    pdf.write_bytes(b"pdf-v1")

    first = preview.render_page_preview(str(pdf), 2, 96)
    second = preview.render_page_preview(str(pdf), 2, 96)

    assert first.path.read_bytes() == b"page-preview"
    assert first.cache_hit is False
    assert second.cache_hit is True
    assert len(calls) == 1

    pdf.write_bytes(b"pdf-v2-with-a-different-size")
    third = preview.render_page_preview(str(pdf), 2, 96)
    assert third.cache_key != first.cache_key
    assert len(calls) == 2


def test_thumbnail_render_is_lazy_and_batched(monkeypatch, tmp_path):
    calls = _install_fake_ghostscript(monkeypatch, tmp_path)
    pdf = tmp_path / "booklet.pdf"
    pdf.write_bytes(b"booklet")

    first = preview.prepare_thumbnail_batch(str(pdf), 14, start_page=9, batch_size=8)

    assert (first.start_page, first.end_page) == (9, 14)
    assert preview.thumbnail_path(first.cache_key, 9).read_bytes() == b"thumb-1"
    assert preview.thumbnail_path(first.cache_key, 14).read_bytes() == b"thumb-6"
    assert not (preview._cache_dir(first.cache_key) / f"thumb_p000008_d{preview.THUMB_DPI:03d}_q{preview.THUMB_QUALITY:03d}.jpg").exists()
    assert len(calls) == 1

    second = preview.prepare_thumbnail_batch(str(pdf), 14, start_page=9, batch_size=8)
    assert second.cache_hit is True
    assert len(calls) == 1


def test_thumbnail_cache_key_and_page_are_strict(tmp_path, monkeypatch):
    monkeypatch.setattr(preview, "_CACHE_ROOT", tmp_path / "cache")
    preview._CACHE_ROOT.mkdir(parents=True)

    for cache_key, page in (("../escape", 1), ("f" * 32, 0)):
        try:
            preview.thumbnail_path(cache_key, page)
        except preview.ViewerPreviewError:
            pass
        else:
            raise AssertionError("unsafe thumbnail cache input was accepted")
