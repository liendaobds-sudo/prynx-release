"""Hồi quy đường viền cắt thủ công của Bình bài cắt xén."""

from __future__ import annotations

import math

import pikepdf
import pytest

from app.workers import nup_engine, nup_process_chunk
from app.workers import pdf_wrapper as pdf_lib
from app.workers.nup_cut_border import (
    MM_TO_PTS,
    cut_border_is_applicable,
    cut_border_rect,
    draw_cut_borders,
    normalize_cut_border_settings,
    resolve_cut_border_config,
)


class _FakeShape:
    def __init__(self):
        self.rects = []
        self.finish_kwargs = None
        self.committed = False

    def draw_rect(self, rect):
        self.rects.append(rect)

    def finish(self, **kwargs):
        self.finish_kwargs = kwargs

    def commit(self):
        self.committed = True


class _FakePage:
    def __init__(self):
        self.shape = _FakeShape()

    def new_shape(self):
        return self.shape


def _settings(**overrides):
    values = {
        "cutBorderEnabled": True,
        "cutBorderPosition": "trim",
        "cutBorderColor": "#000000",
        "cutBorderThickness": 0.3,
    }
    values.update(overrides)
    return values


def test_normalize_uses_pure_k_and_mm_to_points():
    config = normalize_cut_border_settings(_settings(), strict=True)
    assert config is not None
    assert config["color_cmyk"] == (0.0, 0.0, 0.0, 1.0)
    assert config["color_hex"] == "#000000"
    assert math.isclose(config["thickness_pt"], 0.3 * MM_TO_PTS)


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"cutBorderEnabled": 1}, "boolean"),
        ({"cutBorderPosition": "outside"}, "trim.*bleed"),
        ({"cutBorderColor": "black"}, "#RRGGBB"),
        ({"cutBorderThickness": True}, "hữu hạn"),
        ({"cutBorderThickness": "0.3"}, "hữu hạn"),
        ({"cutBorderThickness": float("nan")}, "hữu hạn"),
        ({"cutBorderThickness": 2.1}, "0,1–2,0"),
    ],
)
def test_strict_validation_rejects_malformed_settings(overrides, message):
    with pytest.raises(ValueError, match=message):
        normalize_cut_border_settings(_settings(**overrides), strict=True)


def test_bleed_rect_expands_each_edge_and_zero_bleed_equals_trim():
    trim = pdf_lib.Rect(10, 20, 110, 70)
    expanded = cut_border_rect(trim, 6, "bleed")
    assert (expanded.x0, expanded.y0, expanded.x1, expanded.y1) == (4, 14, 116, 76)
    zero = cut_border_rect(trim, 0, "bleed")
    direct = cut_border_rect(trim, 99, "trim")
    assert (zero.x0, zero.y0, zero.x1, zero.y1) == (10, 20, 110, 70)
    assert (direct.x0, direct.y0, direct.x1, direct.y1) == (10, 20, 110, 70)


def test_draws_multiple_vector_rectangles_in_one_shape():
    page = _FakePage()
    config = normalize_cut_border_settings(
        _settings(cutBorderPosition="bleed", cutBorderColor="#FF0000"),
        strict=True,
    )
    count = draw_cut_borders(
        page,
        [pdf_lib.Rect(10, 20, 30, 40), pdf_lib.Rect(50, 60, 90, 100)],
        config,
        bleed_pt=2,
    )
    assert count == 2
    assert [(r.x0, r.y0, r.x1, r.y1) for r in page.shape.rects] == [
        (8, 18, 32, 42),
        (48, 58, 92, 102),
    ]
    assert page.shape.finish_kwargs["color"] == pytest.approx((0.0, 1.0, 1.0, 0.0))
    assert page.shape.finish_kwargs["width"] == pytest.approx(0.3 * MM_TO_PTS)
    assert page.shape.finish_kwargs["fill"] is None
    assert page.shape.finish_kwargs["line_join"] == 0
    assert page.shape.committed is True


@pytest.mark.parametrize(
    ("overrides", "is_die_cut", "page_sheet_mode"),
    [
        ({}, True, False),
        ({}, False, True),
        ({"imposerMode": "cnc"}, False, False),
        ({"imposerMode": "diecut"}, False, False),
        ({"taskMode": "booklet"}, False, False),
        ({"taskMode": "sticker"}, False, False),
        ({"taskMode": "sticker_imposer"}, False, False),
        ({"taskMode": "cnc"}, False, False),
        ({"taskMode": "cnc_imposer"}, False, False),
    ],
)
def test_scope_gate_excludes_other_workflows(overrides, is_die_cut, page_sheet_mode):
    settings = _settings(**overrides)
    assert cut_border_is_applicable(
        settings,
        is_die_cut=is_die_cut,
        page_sheet_mode=page_sheet_mode,
    ) is False
    assert resolve_cut_border_config(
        settings,
        is_die_cut=is_die_cut,
        page_sheet_mode=page_sheet_mode,
    ) is None


@pytest.mark.parametrize(
    "overrides",
    [
        {"taskMode": "step_repeat"},
        {"layoutType": "repeat"},
        {"taskMode": "step_repeat", "layoutType": "repeat"},
    ],
)
def test_scope_gate_includes_step_repeat_workflow(overrides):
    settings = _settings(**overrides)
    assert cut_border_is_applicable(
        settings,
        is_die_cut=False,
        page_sheet_mode=False,
    ) is True
    config = resolve_cut_border_config(
        settings,
        is_die_cut=False,
        page_sheet_mode=False,
    )
    assert config is not None
    assert config["position"] == "trim"


def test_disabled_border_does_not_create_a_shape():
    page = _FakePage()
    assert normalize_cut_border_settings({"cutBorderEnabled": False}, strict=True) is None
    assert draw_cut_borders(page, [pdf_lib.Rect(0, 0, 10, 10)], None, bleed_pt=0) == 0
    assert page.shape.finish_kwargs is None


def _make_mixed_pdf(path, sizes=((100.0, 80.0), (60.0, 40.0))):
    """Tạo hai trang lệch khổ để buộc engine đi đúng nhánh mixed-size."""
    doc = pdf_lib.open()
    for index, (width, height) in enumerate(sizes):
        page = doc.new_page(width=width, height=height)
        page.insert_text(pdf_lib.Point(8, min(height - 5, 30)), f"P{index + 1}")
    doc.save(str(path))
    doc.close()


def _mixed_settings(**overrides):
    values = {
        "isDieCutMode": False,
        "sheetWidth": 160.0,
        "sheetHeight": 120.0,
        "layoutType": "mixed_guillotine",
        "mixedGuillotineStrategy": "auto_zone",
        "duplexFlow": "normal",
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
        "bleed": 2.0,
        "cutBorderEnabled": True,
        "cutBorderPosition": "bleed",
        "cutBorderColor": "#12A34B",
        "cutBorderThickness": 0.6,
    }
    values.update(overrides)
    return values


def test_engine_forwards_border_to_worker_and_uses_each_mixed_placement_rect(
    tmp_path,
    monkeypatch,
):
    """Chốt hợp đồng engine→worker và hình học cuối của mixed-size/rotation."""
    source = tmp_path / "mixed-border.pdf"
    output = tmp_path / "mixed-border-out.pdf"
    _make_mixed_pdf(source)

    placed = []
    border_calls = []

    def capture_placement(_page, _src, placement, **_kwargs):
        placed.append(placement)
        return (
            pdf_lib.Rect(
                placement["abs_x"],
                placement["original_cell_y"],
                placement["abs_x"] + placement["width"],
                placement["original_cell_y"] + placement["height"],
            ),
            placement["src_page_idx"],
        )

    def capture_borders(_page, trim_rects, config, *, bleed_pt):
        border_calls.append((list(trim_rects), dict(config), bleed_pt))
        return len(trim_rects)

    monkeypatch.setattr(nup_process_chunk, "place_one_artwork", capture_placement)
    monkeypatch.setattr(nup_process_chunk, "draw_cut_borders", capture_borders)

    nup_engine.run_nup_engine(
        str(source),
        str(output),
        _mixed_settings(),
        job_id="mixed-cut-border",
    )

    assert len(border_calls) == 1
    rects, config, bleed_pt = border_calls[0]
    assert len(rects) == len(placed) == 2
    assert bleed_pt == pytest.approx(2.0 * MM_TO_PTS)
    assert config["position"] == "bleed"
    assert config["color_hex"] == "#12A34B"
    assert config["thickness_mm"] == pytest.approx(0.6)

    # place_one_artwork đã trả trim_rect trong hệ cuối; worker không được xoay
    # hoặc đổi kích thước thêm lần nữa trước khi vẽ viền.
    for rect, placement in zip(rects, placed):
        assert (rect.x0, rect.y0) == pytest.approx(
            (placement["abs_x"], placement["original_cell_y"]),
        )
        assert (rect.width, rect.height) == pytest.approx(
            (placement["width"], placement["height"]),
        )


def test_duplex_mixed_draws_one_border_set_on_each_output_side(tmp_path, monkeypatch):
    """Mặt sau đã materialize vẫn phải nhận cùng cấu hình, không rơi viền ở worker."""
    source = tmp_path / "mixed-border-duplex.pdf"
    output = tmp_path / "mixed-border-duplex-out.pdf"
    _make_mixed_pdf(
        source,
        sizes=((100.0, 80.0), (100.0, 80.0), (60.0, 40.0), (60.0, 40.0)),
    )
    rendered_sides = []
    border_calls = []

    def capture_placement(_page, _src, placement, **_kwargs):
        rendered_sides.append(placement.get("_mixed_side"))
        return (
            pdf_lib.Rect(
                placement["abs_x"],
                placement["original_cell_y"],
                placement["abs_x"] + placement["width"],
                placement["original_cell_y"] + placement["height"],
            ),
            placement["src_page_idx"],
        )

    def capture_borders(_page, trim_rects, config, *, bleed_pt):
        border_calls.append((list(trim_rects), dict(config), bleed_pt))
        return len(trim_rects)

    monkeypatch.setattr(nup_process_chunk, "place_one_artwork", capture_placement)
    monkeypatch.setattr(nup_process_chunk, "draw_cut_borders", capture_borders)
    nup_engine.run_nup_engine(
        str(source),
        str(output),
        _mixed_settings(
            duplexFlow="double",
            duplexFlipEdge="long",
            targetQuantitiesByPage={"0": 1, "2": 1},
        ),
        job_id="mixed-cut-border-duplex",
    )

    assert set(rendered_sides) == {"front", "back"}
    assert len(border_calls) == 2
    assert all(len(rects) == 2 for rects, _config, _bleed in border_calls)
    assert all(config["position"] == "bleed" for _rects, config, _bleed in border_calls)


def test_step_repeat_engine_forwards_border_config_to_pdf_worker(tmp_path, monkeypatch):
    """Bình trang phải chuyển cấu hình đến đúng renderer, không chỉ mở gate policy."""
    source = tmp_path / "step-repeat-border.pdf"
    output = tmp_path / "step-repeat-border-out.pdf"
    _make_mixed_pdf(source, sizes=((100.0, 80.0),))
    border_calls = []

    def capture_borders(_page, trim_rects, config, *, bleed_pt):
        border_calls.append((list(trim_rects), dict(config), bleed_pt))
        return len(trim_rects)

    monkeypatch.setattr(nup_process_chunk, "draw_cut_borders", capture_borders)
    nup_engine.run_nup_engine(
        str(source),
        str(output),
        {
            "isDieCutMode": False,
            "taskMode": "step_repeat",
            "layoutType": "repeat",
            "sheetWidth": 100.0,
            "sheetHeight": 80.0,
            "gridStrategy": "optimal_auto",
            "targetQuantity": 4,
            "targetQuantitiesByPage": {"0": 4},
            "gapX": 2.0,
            "gapY": 2.0,
            "marginTop": 5.0,
            "marginBottom": 5.0,
            "marginLeft": 5.0,
            "marginRight": 5.0,
            "markType": "none",
            "pontType": "none",
            "bleed": 2.0,
            "cutBorderEnabled": True,
            "cutBorderPosition": "bleed",
            "cutBorderColor": "#2468AC",
            "cutBorderThickness": 0.7,
        },
        job_id="step-repeat-cut-border",
    )

    assert output.exists()
    assert len(border_calls) == 1
    rects, config, bleed_pt = border_calls[0]
    assert rects
    assert config["position"] == "bleed"
    assert config["color_hex"] == "#2468AC"
    assert config["thickness_mm"] == pytest.approx(0.7)
    assert bleed_pt == pytest.approx(2.0 * MM_TO_PTS)


def _content_stream_text(path) -> str:
    with pikepdf.Pdf.open(path) as pdf:
        contents = pdf.pages[0].obj.get("/Contents")
        streams = contents if isinstance(contents, pikepdf.Array) else [contents]
        return b"\n".join(stream.read_bytes() for stream in streams).decode("latin-1")


def test_real_pdf_appends_cmyk_border_after_artwork(tmp_path):
    """Nét viền phải nằm sau toán tử Do và dùng stroke CMYK, nhất là K100."""
    source = pdf_lib.open()
    source.new_page(width=20, height=20)
    output = pdf_lib.open()
    page = output.new_page(width=100, height=100)
    page.show_pdf_page(pdf_lib.Rect(10, 10, 30, 30), source, 0)

    config = normalize_cut_border_settings(_settings(), strict=True)
    draw_cut_borders(
        page,
        [pdf_lib.Rect(10, 10, 30, 30)],
        config,
        bleed_pt=0,
    )
    output_path = tmp_path / "border-order.pdf"
    output.save(str(output_path))
    output.close()
    source.close()

    raw = _content_stream_text(output_path)
    artwork_pos = raw.find(" Do")
    border_pos = raw.rfind(" re")
    cmyk_pos = raw.rfind("0.0 0.0 0.0 1.0 K")
    assert artwork_pos >= 0
    assert border_pos > artwork_pos
    assert cmyk_pos > artwork_pos


def test_launch_rejects_invalid_border_before_queue(monkeypatch):
    from fastapi import HTTPException
    from app.api.routes import imposition

    monkeypatch.setattr(imposition, "_validate_file_path", lambda path: path)
    with pytest.raises(HTTPException) as caught:
        imposition._launch_impose_job(
            {
                "source_path": "D:/input.pdf",
                "settings": _settings(cutBorderThickness=0.0),
            },
            "nup",
            {},
        )
    assert caught.value.status_code == 422
    assert "0,1–2,0 mm" in str(caught.value.detail)
