from pathlib import Path

import pikepdf
import pytest

from app.workers.pdf_manifest_engine import merge_manifest


def _make_pdf(path: Path, count: int = 2) -> None:
    pdf = pikepdf.Pdf.new()
    for index in range(count):
        page = pdf.add_blank_page(page_size=(200 + index, 300 + index))
        page.obj["/Rotate"] = index * 90
    pdf.save(path)


def test_merge_manifest_selects_pages_blanks_and_composes_rotation(tmp_path: Path):
    source = tmp_path / "source.pdf"
    output = tmp_path / "output.pdf"
    _make_pdf(source)

    merge_manifest(
        [str(source)],
        [
            {"file_index": 0, "page_index": 1, "rotation": 90},
            {"blank": True, "width": 400, "height": 500},
            {"file_index": 0, "page_index": 0},
        ],
        str(output),
    )

    with pikepdf.Pdf.open(output) as pdf:
        assert len(pdf.pages) == 3
        assert int(pdf.pages[0].obj.get("/Rotate", 0)) % 360 == 180
        assert tuple(float(v) for v in pdf.pages[1].mediabox) == (0.0, 0.0, 400.0, 500.0)
        assert int(pdf.pages[2].obj.get("/Rotate", 0)) == 0


def test_merge_manifest_rejects_bad_page_reference(tmp_path: Path):
    source = tmp_path / "source.pdf"
    _make_pdf(source, count=1)
    with pytest.raises(ValueError, match="page index"):
        merge_manifest([str(source)], [{"file_index": 0, "page_index": 9}], str(tmp_path / "out.pdf"))

