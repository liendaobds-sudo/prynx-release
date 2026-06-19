"""Test command-stream emitter (task 6). Requirements: 4.1–4.7."""

from app.workers.cut_export.cut_model import CutModel, CutPath, RegMark
from app.workers.cut_export.profile import load_builtin_profiles
from app.workers.cut_export.emitters.command_stream import CommandStreamEmitter


def _profiles():
    return load_builtin_profiles()


def _model_with_marks():
    # Ốc tạo khung 0..100mm x 0..200mm; 1 ô vuông 10mm.
    return CutModel(
        paths=[CutPath(points=[(10, 10), (20, 10), (20, 20), (10, 20)], closed=True)],
        marks=[RegMark(0, 0), RegMark(100, 0), RegMark(0, 200), RegMark(100, 200)],
        sheet_w_mm=100, sheet_h_mm=200,
    )


# ── Yuty / skycut_ud ─────────────────────────────────────

def test_yuty_header_footer_and_ud():
    p = _profiles()["yuty_a3_max"]
    out = CommandStreamEmitter(p).emit(_model_with_marks()).decode("ascii")
    assert out.startswith("IN FSIZE")
    assert out.rstrip().endswith("@ @")
    assert " U" in (" " + out)  # có lệnh U (pen up)
    assert "D" in out           # có lệnh D (pen down)
    # FSIZE = khung ốc = 100mm*40, 200mm*40 = 4000,8000
    assert "FSIZE4000,8000" in out


def test_yuty_units_plu_40():
    p = _profiles()["yuty_a3_max"]
    out = CommandStreamEmitter(p).emit(_model_with_marks()).decode("ascii")
    # Điểm (10,10)mm rel gốc khung (0,0): x = 10*40 = 400; flip_y: y = 8000 - 400 = 7600
    assert "U400,7600" in out


def test_yuty_no_spotcolor_dependency():
    # Không cần spot-color: model không mang thông tin màu, vẫn emit được.
    p = _profiles()["yuty_a3_max"]
    out = CommandStreamEmitter(p).emit(_model_with_marks()).decode("ascii")
    assert len(out) > 20


# ── Generic HPGL / PU-PD ─────────────────────────────────

def test_generic_hpgl_pupd():
    p = _profiles()["generic_hpgl"]
    cm = CutModel(
        paths=[CutPath(points=[(0, 0), (10, 0), (10, 10)], closed=True)],
        sheet_w_mm=50, sheet_h_mm=50,
    )
    out = CommandStreamEmitter(p).emit(cm).decode("ascii")
    assert out.startswith("IN;SP1;")
    assert "PU0,0;" in out
    assert "PD400,0;" in out   # 10mm * 40 = 400
    assert out.rstrip().endswith("PU;")


def test_closed_path_returns_to_start():
    p = _profiles()["generic_hpgl"]
    cm = CutModel(paths=[CutPath(points=[(0, 0), (5, 0), (5, 5)], closed=True)], sheet_w_mm=20, sheet_h_mm=20)
    out = CommandStreamEmitter(p).emit(cm).decode("ascii")
    # Lệnh PD cuối phải quay về điểm đầu (0,0).
    assert out.count("PD0,0;") >= 1


def test_deterministic_output():
    p = _profiles()["yuty_a3_max"]
    m = _model_with_marks()
    a = CommandStreamEmitter(p).emit(m)
    b = CommandStreamEmitter(p).emit(m)
    assert a == b


def test_skips_empty_paths():
    p = _profiles()["generic_hpgl"]
    cm = CutModel(paths=[CutPath(points=[(0, 0)])], sheet_w_mm=10, sheet_h_mm=10)
    out = CommandStreamEmitter(p).emit(cm).decode("ascii")
    # Chỉ header + footer, không có lệnh PD toạ độ.
    assert out == "IN;SP1;PU;"
