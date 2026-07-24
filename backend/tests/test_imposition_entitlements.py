"""Feature routing for imposition requests must fail closed by exact mode."""

from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from app.api.routes.imposition import (
    PreviewLayoutBatchRequest,
    PreviewLayoutRequest,
    _imposition_feature,
)


def test_imposition_feature_for_json_settings():
    assert _imposition_feature({"imposerMode": "cnc", "isDieCutMode": True}) == "impo.cnc"
    assert _imposition_feature({"page_sheet_mode": True}) == "impo.diecut"
    assert _imposition_feature({
        "imposerMode": "cnc",
        "isDieCutMode": True,
        "page_sheet_mode": True,
    }) == "impo.cnc"
    assert _imposition_feature({"isDieCutMode": True}) == "impo.diecut"
    assert _imposition_feature({"taskMode": "booklet"}) == "impo.booklet"
    assert _imposition_feature({}) == "impo.nup"


def test_imposition_feature_for_pydantic_style_settings():
    assert _imposition_feature(SimpleNamespace(
        imposer_mode="cnc", is_die_cut=True, task_mode="nup"
    )) == "impo.cnc"
    assert _imposition_feature(SimpleNamespace(
        imposer_mode=None, is_die_cut=True, task_mode="nup"
    )) == "impo.diecut"
    assert _imposition_feature(SimpleNamespace(
        imposer_mode=None, is_die_cut=False, task_mode="booklet"
    )) == "impo.booklet"
    assert _imposition_feature(SimpleNamespace(
        imposer_mode=None, is_die_cut=False, task_mode="nup"
    )) == "impo.nup"


@pytest.mark.parametrize("request_model,payload", [
    (
        PreviewLayoutRequest,
        {
            "usable_w": 100,
            "usable_h": 100,
            "item_w": 50,
            "item_h": 50,
            "gap_x": 0,
            "gap_y": 0,
            "strategy": "optimal_auto",
        },
    ),
    (
        PreviewLayoutBatchRequest,
        {
            "usable_w": 100,
            "usable_h": 100,
            "gap_x": 0,
            "gap_y": 0,
            "pages": [],
        },
    ),
])
def test_page_sheet_mode_rejects_string_boolean(request_model, payload):
    with pytest.raises(ValidationError):
        request_model.model_validate({
            **payload,
            "page_sheet_mode": "true",
        })
