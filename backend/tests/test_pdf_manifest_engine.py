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


def test_merge_manifest_missing_page_index_appends_whole_file(tmp_path: Path):
    # A non-expanded multi-page PDF node omits page_index. It must expand to ALL
    # pages, not silently collapse to page 0 (the data-loss regression).
    source_a = tmp_path / "a.pdf"
    source_b = tmp_path / "b.pdf"
    output = tmp_path / "output.pdf"
    _make_pdf(source_a, count=3)
    _make_pdf(source_b, count=2)

    merge_manifest(
        [str(source_a), str(source_b)],
        [
            {"file_index": 0},              # whole 3-page file
            {"file_index": 1, "page_index": 1},  # single page
        ],
        str(output),
    )

    with pikepdf.Pdf.open(output) as pdf:
        assert len(pdf.pages) == 4  # 3 + 1, not 1 + 1

        # Missing page_index expands every source page without changing order.
        assert [int(page.obj.get("/Rotate", 0)) % 360 for page in pdf.pages[:3]] == [0, 90, 180]


def test_merge_manifest_blank_without_size_inherits_first_page(tmp_path: Path):
    # A blank with no explicit dimensions mirrors the old frontend behavior:
    # it takes the size of the first output page.
    source = tmp_path / "source.pdf"
    output = tmp_path / "output.pdf"
    _make_pdf(source, count=1)  # first page is 200x300

    merge_manifest(
        [str(source)],
        [
            {"file_index": 0, "page_index": 0},
            {"blank": True},  # no width/height → inherit 200x300
        ],
        str(output),
    )

    with pikepdf.Pdf.open(output) as pdf:
        assert len(pdf.pages) == 2
        assert tuple(float(v) for v in pdf.pages[1].mediabox) == (0.0, 0.0, 200.0, 300.0)


def test_merge_manifest_rotated_blank_uses_visible_first_page_size(tmp_path: Path):
    source = tmp_path / "source.pdf"
    output = tmp_path / "output.pdf"
    _make_pdf(source, count=2)

    # Source page 1 has MediaBox 201x301 and /Rotate=90, so its visible size is
    # 301x201. The blank starts at that visible size and then rotates by 90.
    merge_manifest(
        [str(source)],
        [
            {"file_index": 0, "page_index": 1},
            {"blank": True, "rotation": 90},
        ],
        str(output),
    )

    with pikepdf.Pdf.open(output) as pdf:
        assert len(pdf.pages) == 2
        assert tuple(float(v) for v in pdf.pages[1].mediabox) == (0.0, 0.0, 301.0, 201.0)
        assert int(pdf.pages[1].obj.get("/Rotate", 0)) % 360 == 90
