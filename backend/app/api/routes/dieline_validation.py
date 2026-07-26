"""Strict, dependency-free validation for the native dieline boundary."""
from __future__ import annotations

import math
from typing import Any

from fastapi import HTTPException

NUMERIC_PARAMS = {
    "L", "W", "D", "T", "C", "G", "TH", "HH", "HW", "HHL", "HFH",
    "SLW", "SLH", "TRW", "SLP", "LTW", "LTH", "DFH", "BF", "HR", "HM",
    "HS", "cupD1", "cupD2", "cupH", "cupCoverage", "envW", "envH", "envFH",
    "envSF", "envWindowW", "envWindowH", "envWindowX", "envWindowY", "trayTongueW",
    "sleeveGlue", "pizzaVentD",
}
BOOLEAN_PARAMS = {
    "lockTab", "handleHoles", "envWindow", "pizzaVent", "pizzaFrontLock", "pizzaCornerLock",
}
ENUM_PARAMS: dict[str, set[str]] = {
    "glueSide": {"left", "right"},
    "boxType": {"rte", "slb", "auto_bottom", "gable", "paper_bag", "cup_sleeve", "pizza", "envelope", "tray"},
    "panelOrder": {"WLWL", "LWLW"},
    "handleShape": {"oval", "roundRect"},
    "handleY": {"bottom", "center"},
    "gableStyle": {"flat", "pitched"},
    "cupHeightType": {"slant", "vertical"},
    "cupFlapPosition": {"right", "left", "none"},
    "envFlapShape": {"straight", "pointed", "rounded"},
    "envStyle": {"wallet", "pocket"},
}
ALL_PARAMS = NUMERIC_PARAMS | BOOLEAN_PARAMS | set(ENUM_PARAMS)


def _fail(message: str) -> None:
    raise HTTPException(status_code=422, detail=message)


def _finite(value: Any, label: str, minimum: float, maximum: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        _fail(f"{label} phải là số hữu hạn.")
    numeric = float(value)
    if numeric < minimum or numeric > maximum:
        _fail(f"{label} nằm ngoài giới hạn {minimum:g}–{maximum:g} mm.")
    return numeric


def validate_dieline_body(body: dict[str, Any]) -> None:
    params = body.get("params")
    nesting = body.get("nestingConfig")
    if not isinstance(params, dict) or not isinstance(nesting, dict):
        _fail("Thiếu tham số tạo khuôn hoặc cấu hình xếp khuôn.")

    missing = sorted(ALL_PARAMS - set(params))
    if missing:
        _fail(f"Thiếu tham số tạo khuôn: {', '.join(missing)}.")
    for key in NUMERIC_PARAMS:
        _finite(params[key], f"params.{key}", 0, 10_000)
    for key in BOOLEAN_PARAMS:
        if not isinstance(params[key], bool):
            _fail(f"params.{key} phải là boolean.")
    for key, allowed in ENUM_PARAMS.items():
        if params[key] not in allowed:
            _fail(f"params.{key} không hợp lệ.")

    changed_key = body.get("changedKey")
    if changed_key is not None and changed_key not in ALL_PARAMS:
        _fail("changedKey không hợp lệ.")
    include_nesting = body.get("includeNesting")
    if include_nesting is not None and not isinstance(include_nesting, bool):
        _fail("includeNesting phải là boolean.")

    sheet = nesting.get("sheet")
    margin = nesting.get("margin")
    sleeve_sheet = nesting.get("sleeveSheet")
    if not isinstance(sheet, dict) or not isinstance(margin, dict) or not isinstance(sleeve_sheet, dict):
        _fail("Cấu trúc khổ giấy hoặc lề không hợp lệ.")
    for label, value in (("sheet.width", sheet.get("width")), ("sheet.height", sheet.get("height")),
                         ("sleeveSheet.width", sleeve_sheet.get("width")), ("sleeveSheet.height", sleeve_sheet.get("height"))):
        _finite(value, label, 50, 5_000)
    for key in ("top", "right", "bottom", "left"):
        _finite(margin.get(key), f"margin.{key}", 0, 500)
    _finite(nesting.get("gripperMargin"), "gripperMargin", 0, 500)
    _finite(nesting.get("dieGap"), "dieGap", 0, 100)
    _finite(nesting.get("gutter"), "gutter", 0, 100)
    enums = {
        "rotation": {"none", "90", "auto"},
        "sheetOrientation": {"auto", "portrait", "landscape"},
        "nestingMode": {"grid", "smart"},
        "trayNestingMode": {"combined", "split"},
    }
    for key, allowed in enums.items():
        if nesting.get(key) not in allowed:
            _fail(f"nestingConfig.{key} không hợp lệ.")
