"""Integration tests cho export Bình cắt xén nhiều kích thước."""

from __future__ import annotations

import copy
import re

import pikepdf
import pytest

from app.workers import nup_engine
from app.workers import nup_artwork
from app.workers import nup_process_chunk
from app.workers import nup_report
from app.workers import pdf_wrapper as pdf_lib
from app.workers.cluster_tile_engine import draw_segment_cut_marks


MM_TO_PT = 2.83465


_RECT_CLIP_RE = re.compile(
    rb"([-+]?\d+(?:\.\d+)?)\s+([-+]?\d+(?:\.\d+)?)\s+"
    rb"(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+re\s+W\s+n"
)


def _make_pdf(path: str, sizes: list[tuple[float, float]]) -> None:
    doc = pdf_lib.open()
    for index, (width, height) in enumerate(sizes):
        page = doc.new_page(width=width, height=height)
        # Nội dung lệch tâm giúp ca duplex bắt được phép lật/đảo bị áp hai lần.
        page.insert_text(pdf_lib.Point(8 + index, min(height - 5, 35)), f"P{index + 1}")
    doc.save(path)
    doc.close()


def _make_opaque_a5_bleed_pdf(path: str) -> None:
    """Hai A5 thành phẩm có nền bleed trắng opaque trên MediaBox lớn hơn 3 mm."""
    media_width = 154.0 * MM_TO_PT
    media_height = 216.0 * MM_TO_PT
    trim_offset = 3.0 * MM_TO_PT
    trim_width = 148.0 * MM_TO_PT
    trim_height = 210.0 * MM_TO_PT
    pdf = pikepdf.Pdf.new()
    for red, green, blue in ((1, 0, 0), (0, 0, 1)):
        page = pdf.add_blank_page(page_size=(media_width, media_height))
        page.obj[pikepdf.Name("/TrimBox")] = pikepdf.Array(
            [
                trim_offset,
                trim_offset,
                trim_offset + trim_width,
                trim_offset + trim_height,
            ]
        )
        # REGRESSION (audit 2026-09-01 §CLIPOWN.1): nền trắng phải được paint
        # thật; nền trang trong suốt sẽ che mất lỗi bleed của Form vẽ sau.
        page.contents_add(
            pikepdf.Stream(
                pdf,
                (
                    f"q 1 1 1 rg 0 0 {media_width:.6f} {media_height:.6f} re f Q\n"
                    f"q {red} {green} {blue} rg "
                    f"{trim_offset:.6f} {trim_offset:.6f} "
                    f"{trim_width:.6f} {trim_height:.6f} re f Q\n"
                ).encode("ascii"),
            )
        )
    pdf.save(path)
    pdf.close()


def _settings(**overrides) -> dict:
    settings = {
        "isDieCutMode": False,
        "sheetWidth": 160.0,
        "sheetHeight": 120.0,
        "layoutType": "mixed_guillotine",
        "mixedGuillotineStrategy": "auto_zone",
        "duplexFlow": "normal",
        "duplexFlipEdge": "long",
        "targetQuantity": 0,
        "targetQuantitiesByPage": {"0": 1, "1": 1},
        "gapX": 2.0,
        "gapY": 2.0,
        "marginTop": 5.0,
        "marginBottom": 5.0,
        "marginLeft": 5.0,
        "marginRight": 5.0,
        "markType": "none",
        "pontType": "none",
        "exportUniqueSheets": False,
    }
    settings.update(overrides)
    return settings


def _do_count(page: pikepdf.Page) -> int:
    return sum(
        str(instruction.operator) == "Do"
        for instruction in pikepdf.parse_content_stream(page)
    )


def _rect_output_clips(page: pikepdf.Page) -> list[tuple[float, float]]:
    """Đọc các khoảng clip theo trục X từ content stream của trang kết quả."""
    contents = page.obj.get("/Contents")
    streams = contents if isinstance(contents, pikepdf.Array) else [contents]
    raw = b"\n".join(
        stream.read_bytes() for stream in streams if stream is not None
    )
    return sorted(
        (
            float(match.group(1)),
            float(match.group(1)) + float(match.group(3)),
        )
        for match in _RECT_CLIP_RE.finditer(raw)
    )


def _render_first_page_rgb(path: str, scale: float = 4.0):
    """Raster PDF thật để bắt lớp trắng opaque mà phép đo rectangle không thấy."""
    import numpy as np
    import pypdfium2 as pdfium

    document = pdfium.PdfDocument(path)
    try:
        bitmap = document[0].render(scale=scale)
        return np.asarray(bitmap.to_pil().convert("RGB")), scale
    finally:
        document.close()


def _clip_placement(
    x: float,
    y: float,
    width: float,
    height: float,
    *,
    block_id: int,
    cluster_idx: int,
) -> dict:
    """Placement tối thiểu cho helper phân quyền clip toàn tờ."""
    return {
        "cluster_idx": cluster_idx,
        "cell": {
            "width": width,
            "height": height,
            "blockId": block_id,
        },
        "abs_x": x,
        "original_cell_y": y,
    }


def _rotation(placement: dict) -> int:
    rotated = bool(placement["cell"].get("isRotated"))
    rotated_180 = bool(placement["cell"].get("isRotated180"))
    if rotated and rotated_180:
        return 270
    if rotated_180:
        return 180
    if rotated:
        return 90
    return 0


class _FakeShape:
    def __init__(self):
        self.lines = []
        self.finished = False
        self.committed = False

    def draw_line(self, p1, p2):
        self.lines.append(((p1.x, p1.y), (p2.x, p2.y)))

    def finish(self, **_kwargs):
        self.finished = True

    def commit(self):
        self.committed = True


class _FakePage:
    def __init__(self):
        self.shape = _FakeShape()

    def new_shape(self):
        return self.shape


def test_segment_marks_draw_only_two_endpoints_per_zone_cut():
    page = _FakePage()
    draw_segment_cut_marks(
        page,
        {
            "segments": [
                {"axis": "x", "coordinate": 50.0, "start": 10.0, "end": 90.0},
                {"axis": "y", "coordinate": 60.0, "start": 20.0, "end": 120.0},
            ]
        },
        mark_off=3.0,
        mark_len=5.0,
    )

    assert len(page.shape.lines) == 4
    assert page.shape.finished is True
    assert page.shape.committed is True


def test_mixed_mark_none_skips_both_cluster_mark_renderers(tmp_path, monkeypatch):
    source = str(tmp_path / "mixed-no-marks.pdf")
    output = str(tmp_path / "mixed-no-marks-out.pdf")
    _make_pdf(source, [(100.0, 80.0), (60.0, 40.0)])

    def unexpected_call(*_args, **_kwargs):
        raise AssertionError("markType='none' không được gọi renderer dấu xén")

    monkeypatch.setattr(nup_process_chunk, "draw_tile_cut_marks", unexpected_call)
    monkeypatch.setattr(nup_process_chunk, "draw_segment_cut_marks", unexpected_call)
    nup_engine.run_nup_engine(
        source,
        output,
        _settings(markType="none"),
        job_id="mixed-guillotine-no-marks",
    )


def test_mixed_guillotine_routes_only_zone_segments_to_segment_renderer(
    tmp_path, monkeypatch
):
    source = str(tmp_path / "mixed-zone-marks.pdf")
    output = str(tmp_path / "mixed-zone-marks-out.pdf")
    _make_pdf(source, [(100.0, 80.0), (60.0, 40.0)])
    captured: list[dict] = []

    def reject_grid_renderer(*_args, **_kwargs):
        raise AssertionError("mixed-guillotine không được dùng renderer lưới tile")

    def capture_segments(_page, cuts, **_kwargs):
        captured.extend(copy.deepcopy(cuts.get("segments", [])))

    monkeypatch.setattr(nup_process_chunk, "draw_tile_cut_marks", reject_grid_renderer)
    monkeypatch.setattr(nup_process_chunk, "draw_segment_cut_marks", capture_segments)
    nup_engine.run_nup_engine(
        source,
        output,
        _settings(markType="guillotine"),
        job_id="mixed-guillotine-zone-marks",
    )

    assert len(captured) == 1  # Một rãnh chỉ có một đường phân cách ở tâm.

    assert all(
        set(segment) == {"axis", "coordinate", "start", "end"}
        for segment in captured
    )


def test_mixed_export_places_two_different_sizes_on_one_output_page(tmp_path):
    source = str(tmp_path / "mixed-one-side.pdf")
    output = str(tmp_path / "mixed-one-side-out.pdf")
    _make_pdf(source, [(100.0, 80.0), (60.0, 40.0)])

    nup_engine.run_nup_engine(
        source,
        output,
        _settings(),
        job_id="mixed-guillotine-one-side",
    )

    with pikepdf.open(output) as pdf:
        assert len(pdf.pages) == 1
        assert _do_count(pdf.pages[0]) == 2


def test_output_clips_split_positive_gap_and_keep_outer_bleed():
    """Khe 4 pt được chia 2 pt mỗi bên; bốn mép lộ vẫn giữ bleed 10 pt."""
    left = _clip_placement(
        10.0, 20.0, 100.0, 80.0, block_id=7, cluster_idx=2
    )
    right = _clip_placement(
        114.0, 20.0, 100.0, 80.0, block_id=11, cluster_idx=9
    )

    clips = nup_artwork.compute_output_clips([left, right], bleed_pt=10.0)
    left_clip = clips[id(left)]
    right_clip = clips[id(right)]

    assert tuple(left_clip) == pytest.approx((0.0, 10.0, 112.0, 110.0))
    assert tuple(right_clip) == pytest.approx((112.0, 10.0, 224.0, 110.0))


def test_output_clips_corner_touch_do_not_enter_other_trim():
    """Clip chữ nhật phải bảo thủ khi hai block chỉ chạm nhau tại một góc."""
    upper_left = _clip_placement(
        0.0, 0.0, 100.0, 100.0, block_id=1, cluster_idx=3
    )
    lower_right = _clip_placement(
        100.0, 100.0, 100.0, 100.0, block_id=2, cluster_idx=8
    )

    clips = nup_artwork.compute_output_clips(
        [upper_left, lower_right], bleed_pt=10.0
    )
    first_clip = clips[id(upper_left)]
    second_clip = clips[id(lower_right)]

    assert first_clip.x1 <= second_clip.x0
    assert first_clip.y1 <= second_clip.y0
    assert tuple(first_clip) == pytest.approx((-10.0, -10.0, 100.0, 100.0))
    assert tuple(second_clip) == pytest.approx((100.0, 100.0, 210.0, 210.0))


def test_output_clips_tolerate_sub_point_rounding_overlap_at_zero_gap():
    """Sai số cộng x + width không được làm mất láng giềng tại seam gap 0."""
    left = _clip_placement(
        0.0, 0.0, 100.0, 100.0, block_id=1, cluster_idx=1
    )
    right = _clip_placement(
        99.9999989, 0.0, 100.0, 100.0, block_id=2, cluster_idx=2
    )

    clips = nup_artwork.compute_output_clips([left, right], bleed_pt=10.0)
    left_clip = clips[id(left)]
    right_clip = clips[id(right)]

    assert left_clip.x1 == pytest.approx(100.0, abs=0.01)
    assert right_clip.x0 == pytest.approx(99.9999989, abs=0.01)
    assert left_clip.x1 - right_clip.x0 <= 0.01


def test_mixed_a5_on_a4_has_no_opaque_white_overlap_at_trim_seam(tmp_path):
    """Hai block khác nhau không được nhận bleed chồng nhau tại seam gap 0."""
    source = str(tmp_path / "two-a5-opaque-bleed.pdf")
    output = str(tmp_path / "two-a5-on-a4.pdf")
    _make_opaque_a5_bleed_pdf(source)

    nup_engine.run_nup_engine(
        source,
        output,
        _settings(
            sheetWidth=297.0,
            sheetHeight=210.0,
            gridStrategy="optimal_auto",
            bleed=3.0,
            gapX=0.0,
            gapY=0.0,
            splitGap=0.0,
            marginTop=0.0,
            marginBottom=0.0,
            marginLeft=0.0,
            marginRight=0.0,
        ),
        job_id="mixed-guillotine-a5-a4-clip-ownership",
    )

    trim_left = 0.5 * MM_TO_PT
    trim_seam = 148.5 * MM_TO_PT
    trim_right = 296.5 * MM_TO_PT
    bleed = 3.0 * MM_TO_PT
    with pikepdf.open(output) as pdf:
        assert len(pdf.pages) == 1
        assert _do_count(pdf.pages[0]) == 2
        clips = _rect_output_clips(pdf.pages[0])

    assert len(clips) == 2
    left_clip, right_clip = clips
    assert left_clip[1] == pytest.approx(trim_seam, abs=0.03)
    assert right_clip[0] == pytest.approx(trim_seam, abs=0.03)
    assert left_clip[1] == pytest.approx(right_clip[0], abs=0.03)
    # Mép ngoài vẫn giữ full bleed; chỉ cạnh giáp placement khác bị chặn ở seam.
    assert left_clip[0] == pytest.approx(trim_left - bleed, abs=0.03)
    assert right_clip[1] == pytest.approx(trim_right + bleed, abs=0.03)

    rgb, scale = _render_first_page_rgb(output)
    row = rgb[rgb.shape[0] // 2]
    seam_px = int(round(trim_seam * scale))
    probe_half_width = int(round(2.5 * MM_TO_PT * scale))
    seam_band = row[seam_px - probe_half_width : seam_px + probe_half_width]
    near_white = (seam_band >= 245).all(axis=1)
    assert int(near_white.sum()) <= 4, (
        "bleed trắng opaque của trang vẽ sau vẫn phủ vào thành phẩm tại seam"
    )


@pytest.mark.parametrize("flip_edge", ["long", "short"])
def test_duplex_export_uses_materialized_back_face_without_double_mirror(
    tmp_path, monkeypatch, flip_edge
):
    source = str(tmp_path / f"mixed-{flip_edge}.pdf")
    output = str(tmp_path / f"mixed-{flip_edge}-out.pdf")
    _make_pdf(
        source,
        [(100.0, 80.0), (100.0, 80.0), (60.0, 40.0), (60.0, 40.0)],
    )
    rendered: list[dict] = []

    def capture_placement(_out_page, _src_doc, placement, **_kwargs):
        rendered.append(copy.deepcopy(placement))
        return (
            pdf_lib.Rect(
                placement["abs_x"],
                placement["original_cell_y"],
                placement["abs_x"] + placement["width"],
                placement["original_cell_y"] + placement["height"],
            ),
            placement["src_page_idx"],
        )

    monkeypatch.setattr(nup_process_chunk, "place_one_artwork", capture_placement)
    nup_engine.run_nup_engine(
        source,
        output,
        _settings(
            duplexFlow="double",
            duplexFlipEdge=flip_edge,
            targetQuantitiesByPage={"0": 1, "2": 1},
        ),
        job_id=f"mixed-guillotine-{flip_edge}",
    )

    with pikepdf.open(output) as pdf:
        assert len(pdf.pages) == 2

    front = {item["src_page_idx"]: item for item in rendered if item["_mixed_side"] == "front"}
    back = {item["src_page_idx"]: item for item in rendered if item["_mixed_side"] == "back"}
    assert set(front) == {0, 2}
    assert set(back) == {1, 3}
    assert {
        (min(item["width"], item["height"]), max(item["width"], item["height"]))
        for item in front.values()
    } == {(80.0, 100.0), (40.0, 60.0)}
    assert all(
        not item["_duplex_transform_applied"] for item in front.values()
    )

    sheet_width = 160.0 * MM_TO_PT
    sheet_height = 120.0 * MM_TO_PT
    for front_page, front_item in front.items():
        back_item = back[front_page + 1]
        assert back_item["_duplex_transform_applied"] is True
        assert _rotation(back_item) == (-_rotation(front_item)) % 360
        if flip_edge == "long":
            assert back_item["abs_x"] == pytest.approx(
                sheet_width - front_item["abs_x"] - front_item["width"], abs=1e-4
            )
            assert back_item["original_cell_y"] == pytest.approx(
                front_item["original_cell_y"], abs=1e-4
            )
        else:
            assert back_item["abs_x"] == pytest.approx(front_item["abs_x"], abs=1e-4)
            assert back_item["original_cell_y"] == pytest.approx(
                sheet_height
                - front_item["original_cell_y"]
                - front_item["height"],
                abs=1e-4,
            )


def test_mixed_duplex_rejects_odd_page_count_before_solving(tmp_path):
    source = str(tmp_path / "mixed-odd.pdf")
    output = str(tmp_path / "mixed-odd-out.pdf")
    _make_pdf(source, [(100.0, 80.0)] * 3)

    with pytest.raises(ValueError, match="số trang CHẴN"):
        nup_engine.run_nup_engine(
            source,
            output,
            _settings(
                duplexFlow="double",
                targetQuantitiesByPage={"0": 1, "2": 1},
            ),
            job_id="mixed-guillotine-odd",
        )


def test_mixed_duplex_rejects_pair_larger_than_half_point_tolerance(tmp_path):
    source = str(tmp_path / "mixed-mismatch.pdf")
    output = str(tmp_path / "mixed-mismatch-out.pdf")
    _make_pdf(source, [(100.0, 80.0), (100.6, 80.0)])

    with pytest.raises(ValueError, match="Cặp trang 1–2"):
        nup_engine.run_nup_engine(
            source,
            output,
            _settings(
                duplexFlow="double",
                targetQuantitiesByPage={"0": 1},
            ),
            job_id="mixed-guillotine-mismatch",
        )


def test_duplex_report_counts_physical_sheet_and_stamps_front_only(
    tmp_path, monkeypatch
):
    source = str(tmp_path / "mixed-report.pdf")
    output = str(tmp_path / "mixed-report-out.pdf")
    _make_pdf(source, [(100.0, 80.0), (100.0, 80.0)])
    stamped: dict[int, str] = {}

    def capture_reports(_source, _output, reports, **_kwargs):
        stamped.update(reports)

    monkeypatch.setattr(nup_report, "stamp_reports_on_pdf", capture_reports)
    nup_engine.run_nup_engine(
        source,
        output,
        _settings(
            duplexFlow="double",
            targetQuantitiesByPage={"0": 1},
            reportDisplay={"enabled": True},
        ),
        job_id="mixed-guillotine-report",
    )

    with pikepdf.open(output) as pdf:
        assert len(pdf.pages) == 2
        assert [_do_count(page) for page in pdf.pages] == [1, 1]
    assert set(stamped) == {0}
    assert "Số tờ: 1" in stamped[0]
