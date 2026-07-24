import asyncio
import os
import tempfile

from app.api.routes.imposition import PreviewLayoutRequest, preview_layout
from app.workers import pdf_wrapper as pdf_lib
from app.workers.sticker_imposer_pkg.bin_packing import solve_auto_fill_mixed
from tests.license_helpers import PRO_LICENSE


def test_page_sized_equal_designs_use_one_regular_orientation():
    # 14 mẫu 50x30 trên tờ 150x210: lưới đúng là 3 cột x 7 hàng = 21 tem.
    page_dims = [(page, 50.0, 30.0) for page in range(14)]
    result = solve_auto_fill_mixed(
        150.0,
        210.0,
        page_dims,
        gap=0.0,
        allow_rotation=True,
        uniform_if_equal=True,
    )

    placements = result['placements']
    assert result['uniform_grid'] is True
    assert len(placements) == 21
    assert {(p['w'], p['h'], p['is_rotated']) for p in placements} == {
        (50.0, 30.0, False)
    }
    assert len({p['x'] for p in placements}) == 3
    assert len({p['y'] for p in placements}) == 7
    expected_order = [page for page in range(7) for _ in range(2)] + list(range(7, 14))
    assert [p['page_idx'] for p in placements] == expected_order


def test_uniform_grid_rotates_the_whole_sheet_only_when_capacity_is_higher():
    page_dims = [(page, 50.0, 30.0) for page in range(3)]
    result = solve_auto_fill_mixed(
        210.0,
        150.0,
        page_dims,
        gap=0.0,
        allow_rotation=True,
        uniform_if_equal=True,
    )

    assert len(result['placements']) == 21
    assert {(p['w'], p['h'], p['is_rotated']) for p in result['placements']} == {
        (30.0, 50.0, True)
    }


def test_uniform_grid_checks_corner_zones_after_centering():
    # The 150x210 grid is centered by 10pt inside a 170x230 usable area.
    # A small top-left zone overlaps the temporary origin, but not the final grid.
    result = solve_auto_fill_mixed(
        170.0,
        230.0,
        [(page, 50.0, 30.0) for page in range(14)],
        gap=0.0,
        allow_rotation=True,
        exclude_zones=[(0.0, 0.0, 8.0, 8.0)],
        uniform_if_equal=True,
    )

    assert result['uniform_grid'] is True
    assert result['total_placed'] == 21
    assert len({p['x'] for p in result['placements']}) == 3
    assert len({p['y'] for p in result['placements']}) == 7


def test_uniform_request_falls_back_to_maxrects_when_page_sizes_differ():
    result = solve_auto_fill_mixed(
        200.0,
        200.0,
        [(0, 50.0, 30.0), (1, 60.0, 30.0)],
        uniform_if_equal=True,
    )

    assert result.get('uniform_grid') is not True


def test_one_dao_page_mixed_preview_is_a_uniform_grid():
    def scenario(path):
        request = PreviewLayoutRequest(
            usable_w=150.0,
            usable_h=210.0,
            item_w=50.0,
            item_h=30.0,
            gap_x=0.0,
            gap_y=0.0,
            strategy='optimal_auto',
            path=path,
            task_mode='sticker_imposer',
            layout_type='sequential',
            is_die_cut=True,
            grouping_strategy='maximize_area',
            cut_type='one_dao',
            die_size_mode='page',
            target_quantity=0,
            target_quantities_by_page={},
            sheet_w=150.0,
            sheet_h=210.0,
        )
        return preview_layout(request, PRO_LICENSE)

    with tempfile.TemporaryDirectory() as temp_dir:
        path = os.path.join(temp_dir, 'same-size-pages.pdf')
        document = pdf_lib.open()
        for _ in range(14):
            document.new_page(width=50.0, height=30.0)
        document.save(path)
        document.close()

        result = scenario(path)

    assert result['success'] is True
    assert result['totalItems'] == 21
    assert {(c['width'], c['height'], c['isRotated']) for c in result['cells']} == {
        (50.0, 30.0, False)
    }
    expected_order = [page for page in range(7) for _ in range(2)] + list(range(7, 14))
    assert [c['pageIdx'] for c in result['cells']] == expected_order

    # What the user sees must keep equal designs adjacent, in page order.
    visual_order = sorted(result['cells'], key=lambda c: (-c['absY'], c['absX']))
    assert [c['pageIdx'] for c in visual_order] == expected_order
