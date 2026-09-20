"""CS.FILL: lấp kín nguyên tấm decal nhưng giữ nguyên cọc trang gốc."""
from collections import Counter

import pikepdf
import pytest

from app.api.routes.imposition import PreviewLayoutRequest, preview_layout
from app.core.mixed_nesting_service import MixedNestingRunHandle
from app.workers import nup_engine
from app.workers.nup_sheet_render import nup_sheet_plan
from tests.license_helpers import PRO_LICENSE

MM = 2.83465


def _source(path, count):
    with pikepdf.Pdf.new() as pdf:
        for index in range(count):
            page = pdf.add_blank_page(page_size=(70 * MM, 70 * MM))
            page.Contents = pdf.make_stream(
                f"% TYPE_{index}\n0.2 0.4 0.7 rg 5 5 180 180 re f\n".encode("ascii")
            )
        pdf.save(path)
    return str(path)


def _settings(page_sheet_mode=True):
    return {
        "imposerMode": "sticker_imposer" if page_sheet_mode else "guillotine",
        "page_sheet_mode": page_sheet_mode, "taskMode": "nup",
        "isDieCutMode": False, "layoutType": "cut_stacks", "duplexFlow": "normal",
        "sheetWidth": 320, "sheetHeight": 430, "gridStrategy": "simple_auto",
        "gapX": 0, "gapY": 0, "bleed": 0,
        "marginTop": 8, "marginBottom": 8, "marginLeft": 8, "marginRight": 8,
        "targetQuantity": 100, "targetQuantitiesByPage": {},
        "groupingStrategy": "none", "markType": "none", "pontType": "none",
        "separateCutPage": False,
    }


def _request(source, count, page_sheet_mode=True):
    return PreviewLayoutRequest(
        path=source, total_pages=count, page_sheet_mode=page_sheet_mode,
        usable_w=304 * MM, usable_h=414 * MM,
        sheet_w=320 * MM, sheet_h=430 * MM,
        item_w=70 * MM, item_h=70 * MM, gap_x=0, gap_y=0,
        margin_top=8 * MM, margin_bottom=8 * MM,
        margin_left=8 * MM, margin_right=8 * MM,
        strategy="simple_auto", layout_type="cut_stacks", task_mode="nup",
        target_quantity=100, is_die_cut=False,
    )


@pytest.mark.parametrize("count", [1, 19, 20, 21, 70, 72, 80])
def test_page_sheet_cut_stacks_fills_every_cell_and_preserves_collation(tmp_path, monkeypatch, count):
    source = _source(tmp_path / f"{count}.pdf", count)

    def forbidden(*args, **kwargs):
        raise AssertionError("Xếp chồng lưới đơn giản không được chạy nesting")

    monkeypatch.setattr(MixedNestingRunHandle, "_solve_native", forbidden)
    monkeypatch.setattr(nup_engine, "compute_sticker_layout_for_page", forbidden)
    preview = preview_layout(_request(source, count), PRO_LICENSE)
    depth = (count + 19) // 20
    assert preview["sheetsNeeded"] == depth
    assert preview["totalItems"] == 20
    preview_sheets = preview.get("sheets") or [preview]
    pages = [[cell["pageIdx"] for cell in sheet["cells"]] for sheet in preview_sheets]
    assert [len(sheet) for sheet in pages] == [20] * depth
    collated = [pages[s][j] for j in range(20) for s in range(depth)]
    assert collated[:count] == list(range(count))
    assert collated[count:] == [i % count for i in range(depth * 20 - count)]

    with nup_sheet_plan(source, _settings()) as plan:
        assert plan.capacity == 20
        assert plan.total_sheets == depth
        placed = plan.build_chunk_args(0, depth, 0)[37]
        assert [[p["src_page_idx"] for p in placed[s]] for s in range(depth)] == pages
        for s in range(depth):
            for actual, expected in zip(placed[s], preview_sheets[s]["cells"]):
                assert actual["abs_x"] == pytest.approx(expected["absX"], abs=.002)
                assert actual["abs_y"] == pytest.approx(expected["absY"], abs=.002)

    output = tmp_path / "out.pdf"
    nup_engine.run_nup_engine(source, str(output), _settings())
    with pikepdf.Pdf.open(output) as pdf:
        # Nguyên tấm decal luôn xuất cặp IN + CUT, kể cả profile cũ tắt tách trang.
        assert len(pdf.pages) == 2 * depth
        assert [
            sum(str(op.operator) == "Do" for op in pikepdf.parse_content_stream(page))
            for page in list(pdf.pages)[::2]
        ] == [20] * depth


def test_guillotine_cut_stacks_does_not_duplicate_numbered_pages(tmp_path):
    source = _source(tmp_path / "70.pdf", 70)
    preview = preview_layout(_request(source, 70, False), PRO_LICENSE)
    pages = [[cell["pageIdx"] for cell in sheet["cells"]] for sheet in preview["sheets"]]
    assert [len(sheet) for sheet in pages] == [18, 18, 17, 17]
    assert Counter(p for sheet in pages for p in sheet) == {i: 1 for i in range(70)}
    with nup_sheet_plan(source, _settings(False)) as plan:
        placed = plan.build_chunk_args(0, plan.total_sheets, 0)[37]
        assert [[p["src_page_idx"] for p in placed[s]] for s in range(4)] == pages
