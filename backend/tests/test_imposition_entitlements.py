"""Feature routing for imposition requests must fail closed by exact mode."""

from types import SimpleNamespace

from app.api.routes.imposition import _imposition_feature


def test_imposition_feature_for_json_settings():
    assert _imposition_feature({"imposerMode": "cnc", "isDieCutMode": True}) == "impo.cnc"
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
