"""
Unit tests cho run_zone_partition_sheets / compute_cluster_sheets (chia cụm — zone modes).

Lưới vùng do NGƯỜI DÙNG khai (zone_cols × zone_rows), chia đều khổ, mỗi vùng gán
1 loại (round-robin cho zone_per_type; số slot ∝ SL cho zone_ratio), loại đó nest
PHỦ ĐẦY vùng của mình. Các LOẠI rải sang NHIỀU TỜ khi hết vùng (17 loại, lưới 2×2
→ 5 tờ). Logic phân vùng THUẦN (không phụ thuộc Rust): dùng zone_layout_fn giả
trả lưới đều theo kích thước vùng.
"""
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from app.workers.cluster_tile_engine import (
    run_zone_partition_sheets,
    compute_cluster_sheets,
    _zone_type_slots,
)


def _make_grid_zone_fn(item_w, item_h, gap=0.0):
    """zone_layout_fn giả: lấp vùng bằng lưới đều item_w×item_h (origin 0, top-down)."""
    def _fn(p_idx, zone_w, zone_h):
        cols = max(0, int((zone_w + gap) / (item_w + gap)))
        rows = max(0, int((zone_h + gap) / (item_h + gap)))
        items = []
        for r in range(rows):
            for c in range(cols):
                items.append({
                    'x': c * (item_w + gap),
                    'y': r * (item_h + gap),
                    'width': item_w,
                    'height': item_h,
                    'isRotated': False,
                    'isRotated180': False,
                })
        return {'items': items}
    return _fn


def _types_in_sheet(placements):
    return {p['src_page_idx'] for p in placements}


class TestZonePerTypeSheets:
    def test_multi_sheet_17_types_2x2(self):
        # 17 loại, lưới 2×2 = 4 vùng/tờ → 5 tờ (4 tờ đủ 4 loại + 1 tờ cuối 1 loại).
        page_infos = [(i, 100, 40.0, 40.0) for i in range(17)]
        sheets = run_zone_partition_sheets(
            page_infos, _make_grid_zone_fn(40.0, 40.0),
            sheet_w=400.0, sheet_h=400.0, gap_x=0, gap_y=0,
            mode='zone_per_type', zone_cols=2, zone_rows=2,
        )
        assert len(sheets) == 5, f"17 loại / 4 vùng → 5 tờ, được {len(sheets)}"
        # Tờ cuối chỉ 1 loại (loại thứ 17, index 16).
        last_types = _types_in_sheet(sheets[-1][0])
        assert last_types == {16}, f"tờ cuối phải chỉ loại 16, được {last_types}"

    def test_each_type_appears_once_across_sheets(self):
        # zone_per_type: mỗi loại xuất hiện đúng 1 lần trên toàn bộ các tờ.
        page_infos = [(i, 100, 50.0, 50.0) for i in range(5)]
        sheets = run_zone_partition_sheets(
            page_infos, _make_grid_zone_fn(50.0, 50.0),
            sheet_w=600.0, sheet_h=600.0, gap_x=0, gap_y=0,
            mode='zone_per_type', zone_cols=2, zone_rows=1,
        )
        # 5 loại / 2 vùng/tờ → 3 tờ (2+2+1).
        assert len(sheets) == 3
        seen = []
        for pls, _ in sheets:
            seen.extend(sorted(_types_in_sheet(pls)))
        assert sorted(seen) == [0, 1, 2, 3, 4]

    def test_each_zone_single_type_within_sheet(self):
        # Trong 1 tờ, mỗi vùng (cluster_idx) chỉ chứa 1 loại.
        page_infos = [(i, 50, 50.0, 50.0) for i in range(4)]
        sheets = run_zone_partition_sheets(
            page_infos, _make_grid_zone_fn(50.0, 50.0),
            sheet_w=600.0, sheet_h=600.0, gap_x=0, gap_y=0,
            mode='zone_per_type', zone_cols=2, zone_rows=2,
        )
        assert len(sheets) == 1  # 4 loại vừa đúng 4 vùng → 1 tờ
        placements = sheets[0][0]
        type_of_zone = {}
        for p in placements:
            type_of_zone.setdefault(p['cluster_idx'], set()).add(p['src_page_idx'])
        for zi, types in type_of_zone.items():
            assert len(types) == 1, f"vùng {zi} chứa nhiều loại {types}"

    def test_cut_lines_partition(self):
        page_infos = [(0, 10, 40.0, 40.0), (1, 10, 40.0, 40.0)]
        sheets = run_zone_partition_sheets(
            page_infos, _make_grid_zone_fn(40.0, 40.0),
            sheet_w=400.0, sheet_h=400.0, gap_x=0, gap_y=0,
            mode='zone_per_type', zone_cols=2, zone_rows=1,
        )
        cuts = sheets[0][1]
        assert len(cuts['v']) >= 2
        assert len(cuts['h']) >= 2
        assert min(cuts['v']) == 0.0
        assert max(cuts['v']) == 400.0
        # Lưới 2 cột → có đường xén giữa ở x=200.
        assert 200.0 in cuts['v']


class TestZoneRatioSlots:
    def test_slots_by_ratio(self):
        # SL 3:1 → loại 0 có 3 slot, loại 1 có 1 slot.
        page_infos = [(0, 300, 40.0, 40.0), (1, 100, 40.0, 40.0)]
        slots = _zone_type_slots(page_infos, 'zone_ratio')
        assert slots.count(0) == 3
        assert slots.count(1) == 1

    def test_ratio_bigger_qty_more_sheets_share(self):
        # Loại 0 SL lớn → nhiều slot → chiếm nhiều vùng hơn tổng thể.
        page_infos = [(0, 400, 40.0, 40.0), (1, 100, 40.0, 40.0)]
        sheets = run_zone_partition_sheets(
            page_infos, _make_grid_zone_fn(40.0, 40.0),
            sheet_w=400.0, sheet_h=400.0, gap_x=0, gap_y=0,
            mode='zone_ratio', zone_cols=2, zone_rows=2,
        )
        cnt = {}
        for pls, _ in sheets:
            for p in pls:
                cnt[p['src_page_idx']] = cnt.get(p['src_page_idx'], 0) + 1
        assert cnt.get(0, 0) > cnt.get(1, 0), f"loại SL lớn phải nhiều con hơn: {cnt}"


class TestDispatcher:
    def test_dispatch_zone_returns_sheets(self):
        page_infos = [(i, 10, 40.0, 40.0) for i in range(6)]
        sheets = compute_cluster_sheets(
            page_infos=page_infos,
            full_layouts={},
            zone_layout_fn=_make_grid_zone_fn(40.0, 40.0),
            sheet_w=400.0, sheet_h=400.0,
            cluster_w=0, cluster_h=0,
            gap_x=0, gap_y=0,
            combine_mode='zone_per_type',
            zone_cols=2, zone_rows=1,
        )
        # 6 loại / 2 vùng → 3 tờ.
        assert len(sheets) == 3

    def test_placement_dict_shape(self):
        # placements phải cùng contract với run_cluster_tile (nup_engine dùng lại).
        page_infos = [(0, 10, 40.0, 40.0), (1, 10, 40.0, 40.0)]
        sheets = run_zone_partition_sheets(
            page_infos, _make_grid_zone_fn(40.0, 40.0),
            sheet_w=400.0, sheet_h=400.0, gap_x=0, gap_y=0,
            mode='zone_per_type', zone_cols=2, zone_rows=1,
        )
        p = sheets[0][0][0]
        for key in ('cluster_idx', 'src_page_idx', 'abs_x', 'abs_y',
                    'width', 'height', 'cell', 'original_cell_y'):
            assert key in p, f"thiếu key {key}"
        for key in ('x', 'y', 'width', 'height', 'isRotated', 'isRotated180'):
            assert key in p['cell'], f"cell thiếu key {key}"

    def test_replicate_mixed_returns_one_sheet_list(self):
        # replicate_mixed vẫn trả danh sách 1 tờ (dùng full_layouts sẵn).
        page_infos = [(0, 10, 40.0, 40.0), (1, 10, 40.0, 40.0)]
        full_layouts = {
            0: {'items': [{'x': 0, 'y': 0, 'width': 40, 'height': 40,
                           'isRotated': False, 'isRotated180': False}]},
            1: {'items': [{'x': 0, 'y': 0, 'width': 40, 'height': 40,
                           'isRotated': False, 'isRotated180': False}]},
        }
        sheets = compute_cluster_sheets(
            page_infos=page_infos,
            full_layouts=full_layouts,
            zone_layout_fn=_make_grid_zone_fn(40.0, 40.0),
            sheet_w=400.0, sheet_h=400.0,
            cluster_w=200.0, cluster_h=200.0,
            gap_x=0, gap_y=0,
            combine_mode='replicate_mixed',
        )
        assert isinstance(sheets, list)
        assert len(sheets) == 1


class TestEdgeCases:
    def test_empty_page_infos(self):
        sheets = run_zone_partition_sheets(
            [], _make_grid_zone_fn(40.0, 40.0),
            sheet_w=400.0, sheet_h=400.0, gap_x=0, gap_y=0,
            zone_cols=2, zone_rows=1,
        )
        assert sheets == []

    def test_sheet_too_small(self):
        # Vùng quá nhỏ cho item → mỗi tờ rỗng con (nhưng vẫn dựng đủ tờ).
        page_infos = [(0, 10, 500.0, 500.0), (1, 10, 500.0, 500.0)]
        sheets = run_zone_partition_sheets(
            page_infos, _make_grid_zone_fn(500.0, 500.0),
            sheet_w=100.0, sheet_h=100.0, gap_x=0, gap_y=0,
            mode='zone_per_type', zone_cols=2, zone_rows=1,
        )
        # Lưới 2×1 trên 100×100 → mỗi vùng 50px < 500px item → không con nào.
        total = sum(len(pls) for pls, _ in sheets)
        assert total == 0
