from pathlib import Path

import pikepdf
import pytest

from app.api.routes import imposition
from app.workers import nup_engine


def _make_rotated_blank(path: Path) -> None:
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(200, 300))
    page.obj["/Rotate"] = 90
    pdf.save(path)
    pdf.close()


def test_rotated_blank_is_canonicalized_and_temp_is_removed(tmp_path, monkeypatch):
    source = tmp_path / "rotated-blank.pdf"
    output = tmp_path / "output.pdf"
    _make_rotated_blank(source)
    monkeypatch.setattr(nup_engine.tempfile, "gettempdir", lambda: str(tmp_path))

    seen = {}

    def _fake_impl(canonical_path, *_args, **_kwargs):
        seen["path"] = canonical_path
        assert Path(canonical_path).exists()
        with pikepdf.Pdf.open(canonical_path) as pdf:
            page = pdf.pages[0]
            assert int(page.obj.get("/Rotate", 0)) == 0
            assert [float(value) for value in page.MediaBox] == [0.0, 0.0, 300.0, 200.0]
            assert "/Contents" in page.obj
        return "done"

    monkeypatch.setattr(nup_engine, "_run_nup_engine_impl", _fake_impl)

    assert nup_engine.run_nup_engine(
        str(source), str(output), {}, job_id="job-7"
    ) == "done"
    assert Path(seen["path"]).name.startswith("nup_canon_job-7_")
    assert not Path(seen["path"]).exists()


def test_canonical_temp_is_removed_when_engine_fails(tmp_path, monkeypatch):
    source = tmp_path / "rotated-blank.pdf"
    _make_rotated_blank(source)
    monkeypatch.setattr(nup_engine.tempfile, "gettempdir", lambda: str(tmp_path))

    def _fail(*_args, **_kwargs):
        raise RuntimeError("render failed")

    monkeypatch.setattr(nup_engine, "_run_nup_engine_impl", _fail)

    with pytest.raises(RuntimeError, match="render failed"):
        nup_engine.run_nup_engine(
            str(source), str(tmp_path / "output.pdf"), {}, job_id="job-8"
        )
    assert list(tmp_path.glob("nup_canon_job-8_*.pdf")) == []


def test_outer_cleanup_removes_cancelled_canonical_temp(tmp_path, monkeypatch):
    chunk = tmp_path / "prynx_nup_cancel-me_0.pdf"
    canonical = tmp_path / "nup_canon_cancel-me_deadbeef.pdf"
    unrelated = tmp_path / "nup_canon_other_deadbeef.pdf"
    for path in (chunk, canonical, unrelated):
        path.write_bytes(b"pdf")

    monkeypatch.setattr(imposition.tempfile, "gettempdir", lambda: str(tmp_path))

    imposition._cleanup_nup_chunk_files("cancel-me")

    assert not chunk.exists()
    assert not canonical.exists()
    assert unrelated.exists()
