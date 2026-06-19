"""Golden test: đối chiếu CẤU TRÚC đầu ra Yuty với mẫu PLT thật (task 6.4).

Mẫu: fixtures/yuty_sample.plt (do plugin/script JSX xuất trên máy Skycut/Yuty A3 Max).
LƯU Ý: không byte-exact (không có artwork nguồn của mẫu) → đối chiếu CẤU TRÚC:
header tokens, separator, FSIZE, pen U/D, footer. Requirements: 4.1, 4.7.
"""

import os

from app.workers.cut_export.cut_model import CutModel, CutPath, RegMark
from app.workers.cut_export.profile import load_builtin_profiles
from app.workers.cut_export.emitters.command_stream import CommandStreamEmitter
from app.workers.cut_export import diff_sample

FIXTURE = os.path.join(os.path.dirname(__file__), "fixtures", "yuty_sample.plt")


def _sample() -> bytes:
    with open(FIXTURE, "rb") as f:
        return f.read()


def _model():
    return CutModel(
        paths=[CutPath(points=[(10, 10), (50, 10), (50, 40), (10, 40)], closed=True)],
        marks=[RegMark(0, 0), RegMark(200, 0), RegMark(0, 300), RegMark(200, 300)],
        sheet_w_mm=200, sheet_h_mm=300,
    )


def test_sample_fixture_exists_and_has_yuty_markers():
    s = _sample().decode("ascii")
    assert s.startswith("IN FSIZE")
    assert ",360,360;CMD:18,1;CMD:103,5;CMD:35," in s
    assert ";TB26," in s
    assert s.rstrip().endswith("@ @")


def test_emitter_header_matches_sample_static_tokens():
    p = load_builtin_profiles()["yuty_a3_max"]
    out = CommandStreamEmitter(p).emit(_model()).decode("ascii")
    # Các token TĨNH phải trùng cấu trúc mẫu thật (không phụ thuộc kích thước).
    assert out.startswith("IN FSIZE")
    assert ",360,360;CMD:18,1;CMD:103,5;CMD:35,2,1," in out
    assert ";TB26," in out
    assert out.rstrip().endswith("@ @")


def test_structural_signature_matches_sample():
    p = load_builtin_profiles()["yuty_a3_max"]
    out = CommandStreamEmitter(p).emit(_model())
    res = diff_sample.diff_signatures(_sample(), out)
    # Cùng họ cấu trúc: separator space, có FSIZE, pen U/D, header prefix.
    assert res["match"] is True, res["diffs"]


def test_pen_tokens_are_U_and_D():
    p = load_builtin_profiles()["yuty_a3_max"]
    out = CommandStreamEmitter(p).emit(_model())
    sig = diff_sample.signature(out)
    assert set(sig.pen_tokens) == {"U", "D"}
    sample_sig = diff_sample.signature(_sample())
    assert "U" in sample_sig.pen_tokens and "D" in sample_sig.pen_tokens
