"""exportUniqueSheets + report stamp cho nhánh multi-sheet die-cut (layout sequential).

Trước đây nhánh sequential/MaxRects luôn nhân bản sheets_needed trang giống hệt
và KHÔNG dựng report → file phình + Lưu file in tạo quá nhiều file, report không
vẽ lên tờ. Spec binh-tem-be-report: 1 tờ duy nhất + lệnh in N tờ trên report.
"""
from __future__ import annotations

import io
import os
from pathlib import Path

import pikepdf
import pytest
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas

from app.workers import nup_engine


def _make_rect_pdf(path: str, w_mm: float = 50, h_mm: float = 50) -> None:
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=(w_mm * mm, h_mm * mm))
    c.setFillColorRGB(0, 0, 0)
    c.rect(5 * mm, 5 * mm, (w_mm - 10) * mm, (h_mm - 10) * mm, fill=1, stroke=0)
    c.save()
    Path(path).write_bytes(buf.getvalue())


def _base_settings(**over):
    cfg = {
        "isDieCutMode": True,
        "sheetWidth": 200,
        "sheetHeight": 200,
        "layoutType": "sequential",
        "targetQuantity": 100,
        "targetQuantitiesByPage": {"0": 100},
        "exportUniqueSheets": True,
        "reportDisplay": {
            "enabled": True,
            "fieldOrder": ["labelName", "sheetCount", "itemsPerSheet"],
            "showLabelName": True,
            "showSheetCount": True,
            "showItemsPerSheet": True,
            "showIdentifier": False,
            "showDimensions": False,
            "showPaperSize": False,
            "showActualQty": False,
            "showMaterial": False,
            "showLamination": False,
            "showMode": False,
            "showOrderCode": False,
            "showGangCount": False,
            "labelNameText": "Tem test",
            "position": "top",
            "fontSize": 12,
            "centered": True,
            "offsetX": 5,
            "offsetY": 5,
            "removeDiacritics": False,
        },
        "gridStrategy": "optimal_auto",
        "groupingStrategy": "maximize_area",
        "pontType": "none",
        "bleed": 0,
        "separateCutPage": False,
        "gapX": 2,
        "gapY": 2,
        "marginTop": 10,
        "marginBottom": 10,
        "marginLeft": 10,
        "marginRight": 10,
    }
    cfg.update(over)
    return cfg


def _page_count(path: str) -> int:
    with pikepdf.Pdf.open(path) as pdf:
        return len(pdf.pages)


def _xobject_names(path: str) -> list[str]:
    with pikepdf.Pdf.open(path) as pdf:
        res = pdf.pages[0].get("/Resources") or {}
        xobj = res.get("/XObject") if res else None
        return [str(k) for k in xobj.keys()] if xobj else []


def test_export_unique_one_page_and_report_summary(tmp_path):
    src = str(tmp_path / "src.pdf")
    out = str(tmp_path / "out.pdf")
    _make_rect_pdf(src)

    report = nup_engine.run_nup_engine(src, out, _base_settings(), job_id="eu-1")
    assert _page_count(out) == 1, "exportUniqueSheets=True → đúng 1 tờ (không nhân bản)"
    assert "LỆNH IN" in (report or "")
    assert "tờ" in (report or "").lower() or "Tờ" in (report or "")


def test_export_unique_false_multiplies_pages(tmp_path):
    src = str(tmp_path / "src.pdf")
    out = str(tmp_path / "out.pdf")
    _make_rect_pdf(src)

    nup_engine.run_nup_engine(
        src, out, _base_settings(exportUniqueSheets=False), job_id="eu-multi"
    )
    n = _page_count(out)
    assert n > 1, f"exportUniqueSheets=False phải nhân bản nhiều tờ, nhận {n}"


def test_report_stamped_as_overlay_xobject(tmp_path):
    src = str(tmp_path / "src.pdf")
    out_on = str(tmp_path / "on.pdf")
    out_off = str(tmp_path / "off.pdf")
    _make_rect_pdf(src)

    nup_engine.run_nup_engine(src, out_on, _base_settings(), job_id="eu-stamp-on")
    off = _base_settings()
    off["reportDisplay"] = {**off["reportDisplay"], "enabled": False}
    nup_engine.run_nup_engine(src, out_off, off, job_id="eu-stamp-off")

    xo_on = _xobject_names(out_on)
    xo_off = _xobject_names(out_off)
    assert len(xo_on) > len(xo_off), (
        f"report bật phải thêm overlay XObject (on={xo_on}, off={xo_off})"
    )
