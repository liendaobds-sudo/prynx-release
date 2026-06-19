"""
Unit tests for sticker_imposer.py layout algorithms.

Tests the core geometric solvers that determine sticker yield
on press sheets — these are critical business logic functions.
"""
import pytest
import sys
import os

# Add backend to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from app.workers.sticker_imposer import (
    solve_grid_layout,
    calculate_staggered_hex_layout,
    solve_cluster_grid_layout,
    solve_l_shape_layout,
    solve_optimal_sticker_layout,
    calculate_items_bounding_box,
)


# ═══════════════════════════════════════════════
#  Basic Grid Layout Tests
# ═══════════════════════════════════════════════

class TestSolveGridLayout:
    """Tests for the basic grid layout solver."""

    def test_basic_grid(self):
        """Standard grid: 320mm × 450mm sheet, 50mm × 50mm items, 2mm gap."""
        result = solve_grid_layout(320, 450, 50, 50, 2, 2)
        assert result['totalItems'] > 0
        assert result['cols'] == 6   # 320 / (50+2) = 6.15 → 6
        assert result['rows'] == 8   # 450 / (50+2) = 8.65 → 8
        assert result['totalItems'] == 48

    def test_item_larger_than_area(self):
        """Item bigger than usable area should yield 0 items."""
        result = solve_grid_layout(100, 100, 200, 200, 0, 0)
        assert result['totalItems'] == 0
        assert result['cols'] == 0
        assert result['rows'] == 0

    def test_single_item_fit(self):
        """Exactly one item fits."""
        result = solve_grid_layout(50, 50, 50, 50, 0, 0)
        assert result['totalItems'] == 1
        assert result['cols'] == 1
        assert result['rows'] == 1

    def test_tight_fit_with_gap(self):
        """100mm width, 48mm items, 4mm gap → only 2 cols (48+4+48=100)."""
        result = solve_grid_layout(100, 100, 48, 48, 4, 4)
        assert result['cols'] == 2
        assert result['rows'] == 2
        assert result['totalItems'] == 4

    def test_zero_gap(self):
        """No gap between items."""
        result = solve_grid_layout(200, 300, 50, 50, 0, 0)
        assert result['cols'] == 4
        assert result['rows'] == 6
        assert result['totalItems'] == 24

    def test_items_have_correct_coordinates(self):
        """Verify item positions are correctly calculated."""
        result = solve_grid_layout(200, 200, 50, 50, 10, 10)
        items = result['items']
        # First item at origin
        assert items[0]['x'] == pytest.approx(0, abs=0.1)
        assert items[0]['y'] == pytest.approx(0, abs=0.1)
        # Second item in first row
        assert items[1]['x'] == pytest.approx(60, abs=0.1)  # 50+10
        assert items[1]['y'] == pytest.approx(0, abs=0.1)


# ═══════════════════════════════════════════════
#  Staggered Hex Layout Tests
# ═══════════════════════════════════════════════

class TestStaggeredHexLayout:
    """Tests for the hexagonal/staggered nesting layout."""

    def test_basic_hex(self):
        """Hex layout should produce items."""
        result = calculate_staggered_hex_layout(320, 450, 50, 50, 2, 2)
        assert result['totalItems'] > 0

    def test_hex_better_than_grid_for_circles(self):
        """For circular items, hex nesting should yield same or more than grid."""
        grid = solve_grid_layout(320, 450, 40, 40, 2, 2)
        hex_layout = calculate_staggered_hex_layout(320, 450, 40, 40, 2, 2)
        assert hex_layout['totalItems'] >= grid['totalItems']

    def test_item_too_large(self):
        """Item bigger than area → empty."""
        result = calculate_staggered_hex_layout(30, 30, 50, 50, 0, 0)
        assert result['totalItems'] == 0

    def test_odd_rows_are_offset(self):
        """Odd rows in hex layout should be offset by half item width."""
        result = calculate_staggered_hex_layout(300, 300, 30, 30, 0, 0)
        if result['totalItems'] > 1:
            row0_items = [it for it in result['items'] if it['r'] == 0]
            row1_items = [it for it in result['items'] if it['r'] == 1]
            if row0_items and row1_items:
                # Row 1 should start at a different x than row 0
                assert abs(row0_items[0]['x'] - row1_items[0]['x']) > 1.0


# ═══════════════════════════════════════════════
#  L-Shape Layout Tests
# ═══════════════════════════════════════════════

class TestLShapeLayout:
    """Tests for L-shape fill (main block + rotated fill blocks)."""

    def test_l_shape_produces_items(self):
        """L-shape should produce at least as many items as a simple grid."""
        result = solve_l_shape_layout(320, 450, 80, 50, 2, 2)
        assert result['totalItems'] > 0

    def test_l_shape_vs_grid(self):
        """L-shape should yield >= grid for rectangular items."""
        grid_a = solve_grid_layout(320, 450, 80, 50, 2, 2)
        grid_b = solve_grid_layout(320, 450, 50, 80, 2, 2)
        best_grid = max(grid_a['totalItems'], grid_b['totalItems'])
        l_shape = solve_l_shape_layout(320, 450, 80, 50, 2, 2)
        assert l_shape['totalItems'] >= best_grid

    def test_l_shape_square_items(self):
        """For square items, L-shape should equal grid (no rotation benefit)."""
        grid = solve_grid_layout(320, 450, 50, 50, 2, 2)
        l_shape = solve_l_shape_layout(320, 450, 50, 50, 2, 2)
        # L-shape should not be worse than grid
        assert l_shape['totalItems'] >= grid['totalItems']


# ═══════════════════════════════════════════════
#  Cluster Grid (Head-to-Tail) Tests
# ═══════════════════════════════════════════════

class TestClusterGridLayout:
    """Tests for head-to-tail interlock layout."""

    def test_basic_cluster(self):
        """Head-to-tail should produce items."""
        result = solve_cluster_grid_layout(320, 450, 80, 50, 2, 2)
        assert result['totalItems'] > 0

    def test_has_rotated_180_items(self):
        """Head-to-tail layout should contain items rotated 180°."""
        result = solve_cluster_grid_layout(320, 450, 80, 50, 2, 2)
        has_rotated_180 = any(it.get('isRotated180', False) for it in result['items'])
        assert has_rotated_180, "Head-to-tail should have isRotated180 items"

    def test_rotated_90_variant(self):
        """Test the 90° rotated variant.

        Lưu ý: bản Rust (`sticker_cluster_grid`) trả cờ xoay theo TỪNG item
        (không có key 'isRotated' ở cấp top-level như bản Python cũ). Kiểm tra
        per-item cho khớp contract thực tế của engine đang chạy production.
        """
        result = solve_cluster_grid_layout(320, 450, 80, 50, 2, 2, is_rotated_90=True)
        assert result['totalItems'] > 0
        assert all(it.get('isRotated', False) for it in result['items']), \
            "Tất cả item phải được đánh dấu isRotated khi is_rotated_90=True"


# ═══════════════════════════════════════════════
#  Optimal Auto Selection Tests
# ═══════════════════════════════════════════════

class TestOptimalAutoLayout:
    """Tests for the optimal_auto strategy selector."""

    def test_optimal_auto_selects_best(self):
        """optimal_auto should yield >= any individual strategy."""
        grid_a = solve_grid_layout(320, 450, 70, 40, 2, 2)
        grid_b = solve_grid_layout(320, 450, 40, 70, 2, 2)
        optimal = solve_optimal_sticker_layout(320, 450, 70, 40, 2, 2, 'optimal_auto')
        assert optimal['totalItems'] >= grid_a['totalItems']
        assert optimal['totalItems'] >= grid_b['totalItems']

    def test_optimal_auto_has_strategy_label(self):
        """Result should include which strategy was selected."""
        result = solve_optimal_sticker_layout(320, 450, 70, 40, 2, 2, 'optimal_auto')
        assert 'strategyUsed' in result

    def test_grid_strategy_explicit(self):
        """Explicit grid strategy should match solve_grid_layout."""
        result = solve_optimal_sticker_layout(320, 450, 50, 50, 2, 2, 'grid')
        grid = solve_grid_layout(320, 450, 50, 50, 2, 2)
        assert result['totalItems'] >= grid['totalItems']

    def test_staggered_strategy_explicit(self):
        """Explicit staggered strategy."""
        result = solve_optimal_sticker_layout(320, 450, 40, 40, 2, 2, 'staggered')
        assert result['totalItems'] > 0


# ═══════════════════════════════════════════════
#  Bounding Box Utility Tests
# ═══════════════════════════════════════════════

class TestBoundingBox:
    """Tests for the bounding box calculator."""

    def test_empty_items(self):
        """Empty list should return zero bounding box."""
        result = calculate_items_bounding_box([])
        assert result['width'] == 0
        assert result['height'] == 0

    def test_single_item(self):
        """Single item bounding box should match item dimensions."""
        items = [{'x': 10, 'y': 20, 'width': 50, 'height': 30}]
        result = calculate_items_bounding_box(items)
        assert result['minX'] == 10
        assert result['minY'] == 20
        assert result['maxX'] == 60
        assert result['maxY'] == 50
        assert result['width'] == 50
        assert result['height'] == 30

    def test_multiple_items(self):
        """Multiple items bounding box should encompass all."""
        items = [
            {'x': 0, 'y': 0, 'width': 50, 'height': 50},
            {'x': 100, 'y': 100, 'width': 50, 'height': 50},
        ]
        result = calculate_items_bounding_box(items)
        assert result['minX'] == 0
        assert result['minY'] == 0
        assert result['maxX'] == 150
        assert result['maxY'] == 150
        assert result['width'] == 150
        assert result['height'] == 150


# ═══════════════════════════════════════════════
#  Regression / Edge Case Tests
# ═══════════════════════════════════════════════

class TestEdgeCases:
    """Edge cases and regression tests."""

    def test_very_small_items(self):
        """Tiny items on a large sheet."""
        result = solve_grid_layout(1000, 1000, 5, 5, 1, 1)
        assert result['totalItems'] > 100

    def test_fractional_dimensions(self):
        """Fractional mm dimensions (common in die-cut)."""
        result = solve_grid_layout(319.5, 449.2, 48.7, 63.3, 2.5, 2.5)
        assert result['totalItems'] > 0

    def test_no_items_returned_have_negative_coords(self):
        """All item coordinates should be non-negative."""
        result = solve_optimal_sticker_layout(320, 450, 60, 80, 3, 3, 'optimal_auto')
        for item in result['items']:
            assert item['x'] >= -0.01, f"Item has negative x: {item['x']}"
            assert item['y'] >= -0.01, f"Item has negative y: {item['y']}"

    def test_items_within_usable_area(self):
        """All items should fit within the usable area bounds."""
        usable_w, usable_h = 320, 450
        result = solve_grid_layout(usable_w, usable_h, 50, 50, 2, 2)
        for item in result['items']:
            assert item['x'] + item['width'] <= usable_w + 0.1
            assert item['y'] + item['height'] <= usable_h + 0.1


# ═══════════════════════════════════════════════
#  Collision Resolver Tests
# ═══════════════════════════════════════════════

class TestResolveLayoutCollisions:
    """Tests for the Shapely-based collision resolver."""

    def test_no_collision_kept(self):
        """Two shapes far apart should not be pruned."""
        from shapely.geometry import Polygon
        from app.workers.sticker_imposer_pkg.orchestrator import resolve_layout_collisions
        
        # 10x10 square
        base_poly = Polygon([(0,0), (10,0), (10,10), (0,10)])
        
        items = [
            {'x': 0, 'y': 0, 'width': 10, 'height': 10},
            {'x': 20, 'y': 20, 'width': 10, 'height': 10}
        ]
        
        cleaned = resolve_layout_collisions(items, base_poly, gap_pt=2.0)
        assert len(cleaned) == 2

    def test_collision_pruned(self):
        """Two shapes overlapping should have one pruned."""
        from shapely.geometry import Polygon
        from app.workers.sticker_imposer_pkg.orchestrator import resolve_layout_collisions
        
        # 10x10 square
        base_poly = Polygon([(0,0), (10,0), (10,10), (0,10)])
        
        # Overlapping placement (gap of 2.0 would require 12.0 distance, they are at 5.0 distance)
        items = [
            {'x': 0, 'y': 0, 'width': 10, 'height': 10},
            {'x': 5, 'y': 5, 'width': 10, 'height': 10}
        ]
        
        cleaned = resolve_layout_collisions(items, base_poly, gap_pt=2.0)
        assert len(cleaned) == 1

