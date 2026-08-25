"""Regression cho workflow Trim & Shift: tách trang đã bình rồi bình lại."""

import os
import tempfile

import pikepdf
import pytest

from app.workers.trim_shift_engine import MM_TO_PTS, trim_shift


def _make_page(pdf: pikepdf.Pdf, width: float, height: float, content: bytes = b"q Q"):
    page = pdf.add_blank_page(page_size=(width, height))
    page.contents_add(pikepdf.Stream(pdf, content))
    return page


def _make_vertical_color_page(path: str) -> None:
    pdf = pikepdf.Pdf.new()
    _make_page(
        pdf,
        200,
        100,
        b"1 0 0 rg 0 0 100 100 re f\n0 0 1 rg 100 0 100 100 re f",
    )
    pdf.save(path)
    pdf.close()


def _make_horizontal_color_page(path: str) -> None:
    pdf = pikepdf.Pdf.new()
    _make_page(
        pdf,
        120,
        300,
        (
            b"1 0 0 rg 0 200 120 100 re f\n"
            b"0 1 0 rg 0 100 120 100 re f\n"
            b"0 0 1 rg 0 0 120 100 re f"
        ),
    )
    pdf.save(path)
    pdf.close()


def _box(page, key: str = "/MediaBox") -> list[float]:
    value = page.get(key)
    return [float(value[index]) for index in range(4)]


def _page_size(page) -> tuple[float, float]:
    box = _box(page)
    return box[2] - box[0], box[3] - box[1]


@pytest.fixture
def workdir():
    directory = tempfile.mkdtemp(prefix="test_trimshift_split_")
    yield directory
    for root, _dirs, files in os.walk(directory, topdown=False):
        for filename in files:
            try:
                os.remove(os.path.join(root, filename))
            except OSError:
                pass
        try:
            os.rmdir(root)
        except OSError:
            pass


def test_split_vertical_two_with_independent_white_margins(workdir):
    source = os.path.join(workdir, "source.pdf")
    output = os.path.join(workdir, "output.pdf")
    _make_vertical_color_page(source)

    trim_shift(
        source,
        output,
        split_config={
            "enabled": True,
            "axis": "vertical",
            "count": 2,
            "pieces": [
                {"right": 10},
                {"left": 5},
            ],
        },
    )

    with pikepdf.Pdf.open(output) as pdf:
        assert len(pdf.pages) == 2
        first_w, first_h = _page_size(pdf.pages[0])
        second_w, second_h = _page_size(pdf.pages[1])
        assert first_w == pytest.approx(100 + 10 * MM_TO_PTS, abs=0.01)
        assert second_w == pytest.approx(100 + 5 * MM_TO_PTS, abs=0.01)
        assert first_h == pytest.approx(100, abs=0.01)
        assert second_h == pytest.approx(100, abs=0.01)

        for page in pdf.pages:
            assert _box(page, "/CropBox") == pytest.approx(_box(page))
            assert _box(page, "/TrimBox") == pytest.approx(_box(page))
            assert _box(page, "/BleedBox") == pytest.approx(_box(page))
            assert int(page.get("/Rotate", 0)) == 0
            streams = page.obj.get("/Contents")
            streams = streams if isinstance(streams, pikepdf.Array) else [streams]
            raw = b"\n".join(stream.read_bytes() for stream in streams)
            assert b"1 1 1 rg" in raw  # nền giấy trắng được vẽ thật
            assert b"re W n" in raw    # nội dung bị clip đúng trong mảnh



def test_split_white_margin_is_opaque(workdir):
    source = os.path.join(workdir, "source.pdf")
    output = os.path.join(workdir, "output.pdf")
    _make_vertical_color_page(source)

    try:
        import pypdfium2 as pdfium
    except ImportError:
        pytest.skip("pypdfium2 không có sẵn")

    trim_shift(
        source,
        output,
        split_config={
            "enabled": True,
            "axis": "vertical",
            "count": 2,
            "pieces": [{"right": 10}, {}],
        },
    )

    document = pdfium.PdfDocument(output)
    try:
        bitmap = document[0].render(
            scale=2,
            fill_color=(0, 0, 0, 0),
            rev_byteorder=True,
        )
        # Góc phải của mảnh trái nằm trong lề +10 mm: phải trắng RGB và alpha=255.
        pixel = bitmap.to_pil().getpixel((bitmap.width - 3, bitmap.height // 2))
        assert pixel == (255, 255, 255, 255)
    finally:
        document.close()


def test_split_horizontal_three_outputs_top_to_bottom(workdir):
    source = os.path.join(workdir, "source.pdf")
    output = os.path.join(workdir, "output.pdf")
    _make_horizontal_color_page(source)

    trim_shift(
        source,
        output,
        split_config={"enabled": True, "axis": "horizontal", "count": 3, "pieces": []},
    )

    with pikepdf.Pdf.open(output) as pdf:
        assert len(pdf.pages) == 3
        for page in pdf.pages:
            assert _page_size(page) == pytest.approx((120, 100), abs=0.01)

    try:
        import pypdfium2 as pdfium
    except ImportError:
        pytest.skip("pypdfium2 không có sẵn")

    document = pdfium.PdfDocument(output)
    try:
        centers = []
        for index in range(3):
            bitmap = document[index].render(scale=1)
            image = bitmap.to_pil().convert("RGB")
            centers.append(image.getpixel((image.width // 2, image.height // 2)))
        assert centers[0][0] > 200 and centers[0][1] < 30 and centers[0][2] < 30
        assert centers[1][1] > 200 and centers[1][0] < 30 and centers[1][2] < 30
        assert centers[2][2] > 200 and centers[2][0] < 30 and centers[2][1] < 30
    finally:
        document.close()


def test_split_replaces_only_selected_pages_and_keeps_order(workdir):
    source = os.path.join(workdir, "source.pdf")
    output = os.path.join(workdir, "output.pdf")
    pdf = pikepdf.Pdf.new()
    _make_page(pdf, 111, 80)
    _make_page(pdf, 200, 80)
    _make_page(pdf, 333, 80)
    pdf.save(source)
    pdf.close()

    trim_shift(
        source,
        output,
        apply_to="2",
        split_config={"enabled": True, "axis": "vertical", "count": 2, "pieces": []},
    )

    with pikepdf.Pdf.open(output) as pdf:
        assert len(pdf.pages) == 4
        assert [_page_size(page)[0] for page in pdf.pages] == pytest.approx(
            [111, 100, 100, 333], abs=0.01
        )


def test_split_bakes_rotate_before_cutting(workdir):
    source = os.path.join(workdir, "source.pdf")
    output = os.path.join(workdir, "output.pdf")
    pdf = pikepdf.Pdf.new()
    page = _make_page(pdf, 200, 100)
    page[pikepdf.Name("/Rotate")] = 90
    pdf.save(source)
    pdf.close()

    trim_shift(
        source,
        output,
        split_config={"enabled": True, "axis": "vertical", "count": 2, "pieces": []},
    )

    with pikepdf.Pdf.open(output) as pdf:
        assert len(pdf.pages) == 2
        assert _page_size(pdf.pages[0]) == pytest.approx((50, 200), abs=0.01)
        assert _page_size(pdf.pages[1]) == pytest.approx((50, 200), abs=0.01)
        assert all(int(page.get("/Rotate", 0)) == 0 for page in pdf.pages)


def test_split_rejects_negative_piece_margin(workdir):
    source = os.path.join(workdir, "source.pdf")
    output = os.path.join(workdir, "output.pdf")
    _make_vertical_color_page(source)

    with pytest.raises(ValueError, match="không được âm"):
        trim_shift(
            source,
            output,
            split_config={
                "enabled": True,
                "axis": "vertical",
                "count": 2,
                "pieces": [{"right": -1}, {}],
            },
        )


def test_split_rejects_empty_custom_page_range(workdir):
    source = os.path.join(workdir, "source.pdf")
    output = os.path.join(workdir, "output.pdf")
    _make_vertical_color_page(source)

    with pytest.raises(ValueError, match="Không có trang hợp lệ"):
        trim_shift(
            source,
            output,
            apply_to="custom",
            split_config={"enabled": True, "axis": "vertical", "count": 2, "pieces": []},
        )


def test_regular_trim_shift_rejects_empty_custom_page_range(workdir):
    source = os.path.join(workdir, "source.pdf")
    output = os.path.join(workdir, "output.pdf")
    _make_vertical_color_page(source)

    with pytest.raises(ValueError, match="Không có trang hợp lệ"):
        trim_shift(source, output, apply_to="custom", trim_left_mm=1)
