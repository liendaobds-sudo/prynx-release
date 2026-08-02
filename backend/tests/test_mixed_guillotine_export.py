"""Integration tests cho export Bình cắt xén nhiều kích thước."""

from __future__ import annotations

import copy

import pikepdf
import pytest

from app.workers import nup_engine
from app.workers import nup_process_chunk
from app.workers import nup_report
from app.workers import pdf_wrapper as pdf_lib
from app.workers.cluster_tile_engine import draw_segment_cut_marks


MM_TO_PT = 2.83465


def _make_pdf(path: str, sizes: list[tuple[float, float]]) -> None:
    doc = pdf_lib.open()
    for index, (width, height) in enumerate(sizes):
        page = doc.new_page(width=width, height=height)
        # Nội dung lệch tâm giúp ca duplex bắt được phép lật/đảo bị áp hai lần.
        page.insert_text(pdf_lib.Point(8 + index, min(height - 5, 35)), f"P{index + 1}")
    doc.save(path)
    doc.close()


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
