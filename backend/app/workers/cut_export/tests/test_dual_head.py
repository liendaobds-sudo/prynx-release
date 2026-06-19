"""Test dual-head (song đạo) command-stream + đối chiếu cấu trúc mẫu thật. Req 4.6, 4.7."""

import os

from app.workers.cut_export.cut_model import CutModel, CutPath, RegMark
from app.workers.cut_export.profile import load_builtin_profiles
from app.workers.cut_export.emitters.command_stream import CommandStreamEmitter

FIXTURE = os.path.join(os.path.dirname(__file__), "fixtures", "yuty_sample.plt")


def _model_tagged():
    return CutModel(
        paths=[
            CutPath(points=[(10, 10), (30, 10), (30, 30)], closed=True, tool_tag="left"),
            CutPath(points=[(60, 10), (80, 10), (80, 30)], closed=True, tool_tag="right"),
        ],
        marks=[RegMark(0, 0), RegMark(100, 0), RegMark(0, 150)],
        sheet_w_mm=100, sheet_h_mm=150,
    )


def test_dual_head_header_offset_and_switching():
    p = load_builtin_profiles()["yuty_a3_max_dual"]
    out = CommandStreamEmitter(p).emit(_model_tagged()).decode("ascii")
    # Offset song đạo trong header.
    assert "CMD:35,2,1,6344;" in out
    # Chuỗi mồi + chuyển dao 0/1/2.
    assert "CMD:35,0;U-39,440 D-39,440 D-31,479 " in out
    assert "U;CMD:35,1;" in out
    assert "U;CMD:35,2;" in out
    assert out.rstrip().endswith("@ @")


def test_dual_head_structure_matches_sample_prefix():
    p = load_builtin_profiles()["yuty_a3_max_dual"]
    out = CommandStreamEmitter(p).emit(_model_tagged()).decode("ascii")
    sample = open(FIXTURE, "rb").read().decode("ascii")
    # Cùng mẫu mở đầu thân: ...TB26,.. CMD:35,0;U-39,440 D-39,440 D-31,479 U;CMD:35,1;
    marker = "CMD:35,0;U-39,440 D-39,440 D-31,479 "
    assert marker in sample
    assert marker in out
    assert "U;CMD:35,1;" in sample
    assert "U;CMD:35,1;" in out


def test_dual_head_position_split_when_untagged():
    p = load_builtin_profiles()["yuty_a3_max_dual"]
    cm = CutModel(
        paths=[
            CutPath(points=[(10, 10), (20, 10), (20, 20)], closed=True),  # trái (cx<50)
            CutPath(points=[(70, 10), (80, 10), (80, 20)], closed=True),  # phải (cx>50)
        ],
        marks=[RegMark(0, 0), RegMark(100, 0), RegMark(0, 100)],
        sheet_w_mm=100, sheet_h_mm=100,
    )
    out = CommandStreamEmitter(p).emit(cm).decode("ascii")
    assert "U;CMD:35,1;" in out  # nhóm trái
    assert "U;CMD:35,2;" in out  # nhóm phải


def test_single_head_still_no_blade_switch():
    p = load_builtin_profiles()["yuty_a3_max"]
    out = CommandStreamEmitter(p).emit(_model_tagged()).decode("ascii")
    assert "CMD:35,0;" not in out  # bản 1 dao không chuyển dao
    assert "CMD:35,2,1,0;" in out
