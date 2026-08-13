"""Unit tests cho app/workers/nup_report.py (logic thuần)."""
import math
import re
import pytest

from app.workers.nup_report import (
    sanitize_filename,
    remove_diacritics,
    compute_report_data,
    build_report_string,
)

ILLEGAL = '\\/:*?"<>|'


# ── sanitize_filename ──
class TestSanitizeFilename:
    def test_removes_illegal_chars(self):
        out = sanitize_filename('DH1/2: A*B?"<>|\\C')
        for ch in ILLEGAL:
            assert ch not in out

    def test_empty(self):
        assert sanitize_filename("") == ""
        assert sanitize_filename(None) == ""

    def test_collapses_dashes(self):
        assert "- -" not in sanitize_filename("a - - b")


# ── remove_diacritics ──
class TestRemoveDiacritics:
    def test_basic(self):
        assert remove_diacritics("Tem sầu riêng đỏ") == "Tem sau rieng do"

    def test_no_diacritics_unchanged(self):
        assert remove_diacritics("Decal PP 123") == "Decal PP 123"

    def test_empty(self):
        assert remove_diacritics("") == ""


# ── compute_report_data ──
class TestComputeReportData:
    def test_sheet_count_and_actual(self):
        d = compute_report_data(items_per_sheet=48, requested_qty=1000)
        assert d["raw"]["sheet_count"] == 21
        assert d["raw"]["actual_qty"] == 1008

    def test_qty_zero_means_one_sheet(self):
        d = compute_report_data(items_per_sheet=48, requested_qty=0)
        assert d["raw"]["sheet_count"] == 1
        assert d["raw"]["actual_qty"] == 48

    def test_ips_zero_safe(self):
        d = compute_report_data(items_per_sheet=0, requested_qty=1000)
        assert d["raw"]["sheet_count"] == 0
        assert d["raw"]["actual_qty"] == 0
        assert d["labelsPerSheet"] == ""  # field rỗng

    def test_lamination_format(self):
        d = compute_report_data(items_per_sheet=10, lamination_type=2)
        assert d["lamination"] == "Cán mờ"
        d1 = compute_report_data(items_per_sheet=10, lamination_type=1)
        assert d1["lamination"] == "Cán bóng"
        d0 = compute_report_data(items_per_sheet=10, lamination_type=0)
        assert d0["lamination"] == ""

    def test_dimensions(self):
        d = compute_report_data(items_per_sheet=10, width_mm=50, height_mm=70)
        assert d["dimensions"] == "50 x 70 mm"

    def test_dimensions_keep_one_decimal_for_precise_pdf_size(self):
        d = compute_report_data(
            items_per_sheet=10,
            width_mm=147.1215,
            height_mm=51.3327,
        )
        assert d["dimensions"] == "147.1 x 51.3 mm"

    def test_dimensions_round_half_up_and_drop_trailing_zero(self):
        d = compute_report_data(items_per_sheet=10, width_mm=148.55, height_mm=50.0)
        assert d["dimensions"] == "148.6 x 50 mm"


# ── build_report_string ──
class TestBuildReportString:
    def _data(self):
        return compute_report_data(
            label_name="Tem A", width_mm=50, height_mm=50, items_per_sheet=48,
            requested_qty=1000, material="Decal PP", lamination_type=1, lamination_sides=1,
            order_code="DH1", mode_label="Be tem",
        )

    def test_default_order_keeps_order_code_first(self):
        s = build_report_string({}, self._data())
        assert s.startswith("DH1")

    def test_custom_field_order_includes_order_code_at_requested_position(self):
        rd = {"fieldOrder": ["material", "lamination", "orderCode"]}
        s = build_report_string(rd, self._data())
        assert s == "Decal PP - Cán bóng - DH1"

    def test_custom_field_order_skips_duplicate_keys(self):
        rd = {"fieldOrder": ["material", "material", "orderCode"]}
        s = build_report_string(rd, self._data())
        assert s == "Decal PP - DH1"

    def test_no_double_dash(self):
        s = build_report_string({}, self._data())
        assert "- -" not in s

    def test_hidden_field_excluded(self):
        rd = {"showMaterial": False}
        s = build_report_string(rd, self._data())
        assert "Decal PP" not in s

    def test_empty_fields_skipped(self):
        d = compute_report_data(items_per_sheet=48, requested_qty=1000)  # no labelName/material
        s = build_report_string({}, d)
        # Chỉ còn các field có nội dung, không có đoạn rỗng
        assert not s.startswith(" - ") and not s.endswith(" - ")

    def test_remove_diacritics_applied(self):
        d = compute_report_data(label_name="Tem sầu riêng", items_per_sheet=10, requested_qty=10)
        s = build_report_string({"removeDiacritics": True}, d)
        assert "sầu" not in s and "sau rieng" in s


# ══ Property-based (tham số hóa) ══
class TestProperties:
    # Property 1: bảo toàn số lượng
    @pytest.mark.parametrize("qty,ips", [(1, 1), (1000, 48), (999, 50), (1, 1000), (5000, 7)])
    def test_property_quantity_preservation(self, qty, ips):
        d = compute_report_data(items_per_sheet=ips, requested_qty=qty)
        sc = d["raw"]["sheet_count"]
        assert sc * ips >= qty
        assert (sc - 1) * ips < qty

    # Property 4: tên file an toàn
    @pytest.mark.parametrize("name", [
        'a/b\\c:d*e?f"g<h>i|j', "DH-001: Tem * sầu", "normal name", "////", 'a"b',
    ])
    def test_property_filename_safe(self, name):
        out = sanitize_filename(name)
        for ch in ILLEGAL:
            assert ch not in out
