"""Test Machine Profile loader + validate (task 5.3). Requirements: 2.1–2.6."""

import json

import pytest

from app.workers.cut_export.profile import (
    MachineProfile,
    ProfileError,
    profile_from_dict,
    load_profile,
    load_builtin_profiles,
)


def _valid():
    return {
        "id": "x", "vendor": "v", "model": "m",
        "emitter": "command_stream", "dialect": "hpgl_pupd",
        "resolution_plu_per_mm": 40.0,
    }


def test_load_builtin_profiles_has_yuty_and_generic():
    profs = load_builtin_profiles()
    assert "yuty_a3_max" in profs
    assert "generic_hpgl" in profs
    assert profs["yuty_a3_max"].dialect == "skycut_ud"
    assert profs["yuty_a3_max"].resolution_plu_per_mm == 40.0
    assert profs["yuty_a3_max"].reg_mode == "onboard_frame"


def test_profile_from_dict_ok():
    p = profile_from_dict(_valid())
    assert isinstance(p, MachineProfile)
    assert p.origin == "bottom_left"


def test_reject_missing_required():
    d = _valid(); del d["resolution_plu_per_mm"]
    with pytest.raises(ProfileError):
        profile_from_dict(d)


def test_reject_bad_resolution():
    d = _valid(); d["resolution_plu_per_mm"] = 0
    with pytest.raises(ProfileError):
        profile_from_dict(d)


def test_reject_bad_emitter():
    d = _valid(); d["emitter"] = "magic"
    with pytest.raises(ProfileError):
        profile_from_dict(d)


def test_command_stream_requires_dialect():
    d = _valid(); del d["dialect"]
    with pytest.raises(ProfileError):
        profile_from_dict(d)


def test_reject_bad_origin():
    d = _valid(); d["origin"] = "middle"
    with pytest.raises(ProfileError):
        profile_from_dict(d)


def test_load_profile_bad_json(tmp_path):
    f = tmp_path / "p.json"
    f.write_text("{ not json", encoding="utf-8")
    with pytest.raises(ProfileError):
        load_profile(str(f))


def test_load_profile_roundtrip(tmp_path):
    f = tmp_path / "p.json"
    f.write_text(json.dumps(_valid()), encoding="utf-8")
    p = load_profile(str(f))
    assert p.id == "x"
