"""Test profile_store + diff_sample (task 9.3). Requirements: 7.1, 7.2, 7.3."""

import pytest

from app.workers.cut_export.profile import ProfileError, load_builtin_profiles
from app.workers.cut_export import profile_store
from app.workers.cut_export import diff_sample


def _valid():
    return {
        "id": "my_machine", "vendor": "v", "model": "m",
        "emitter": "command_stream", "dialect": "hpgl_pupd",
        "resolution_plu_per_mm": 40.0,
    }


def test_save_and_list_profile(tmp_path):
    path = profile_store.save_profile(_valid(), str(tmp_path))
    assert path.endswith("my_machine.json")
    profs = profile_store.list_profiles(str(tmp_path))
    assert "my_machine" in profs


def test_save_rejects_invalid(tmp_path):
    bad = _valid(); del bad["resolution_plu_per_mm"]
    with pytest.raises(ProfileError):
        profile_store.save_profile(bad, str(tmp_path))


def test_delete_profile(tmp_path):
    profile_store.save_profile(_valid(), str(tmp_path))
    assert profile_store.delete_profile("my_machine", str(tmp_path)) is True
    assert profile_store.delete_profile("my_machine", str(tmp_path)) is False


def test_clone_profile():
    base = load_builtin_profiles()["yuty_a3_max"]
    data = profile_store.clone_profile(base, "yuty_copy", model="A4 Mini")
    assert data["id"] == "yuty_copy"
    assert data["model"] == "A4 Mini"
    assert data["dialect"] == "skycut_ud"


# ── diff_sample ──────────────────────────────────────────

def test_signature_detects_ud_and_fsize():
    sig = diff_sample.signature(b"IN FSIZE100,200 U0,0 D10,10 D20,20 U0,0 @ @ ")
    assert sig.has_fsize is True
    assert sig.pen_tokens.get("U", 0) >= 1
    assert sig.pen_tokens.get("D", 0) >= 1


def test_diff_detects_pen_token_mismatch():
    sample = b"IN;SP1;PU0,0;PD10,10;PU;"
    generated = b"IN FSIZE0,0 U0,0 D10,10 @ @ "
    res = diff_sample.diff_signatures(sample, generated)
    assert res["match"] is False
    assert "pen_tokens" in res["diffs"]


def test_diff_match_when_same_structure():
    a = b"IN;SP1;PU0,0;PD10,10;PU;"
    b = b"IN;SP1;PU5,5;PD20,20;PU;"
    res = diff_sample.diff_signatures(a, b)
    assert res["match"] is True
