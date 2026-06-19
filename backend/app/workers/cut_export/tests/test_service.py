"""Test orchestrator service end-to-end (task 10.3). Requirements: 8.1–8.4, 9.3."""

import os

from app.workers.cut_export.cut_model import CutModel, CutPath, RegMark
from app.workers.cut_export.profile import load_builtin_profiles
from app.workers.cut_export import service


def _model():
    return CutModel(
        paths=[CutPath(points=[(10, 10), (20, 10), (20, 20), (10, 20)], closed=True)],
        marks=[RegMark(0, 0), RegMark(100, 0), RegMark(0, 200), RegMark(100, 200)],
        sheet_w_mm=100, sheet_h_mm=200,
    )


def test_export_yuty_command_stream_to_file(tmp_path):
    p = load_builtin_profiles()["yuty_a3_max"]
    r = service.export_cut(
        _model(), p,
        transport_kind="file", dest_dir=str(tmp_path), name="job001",
    )
    assert r.ok is True
    assert r.detail.endswith(".plt")
    data = open(r.detail, "rb").read().decode("ascii")
    assert data.startswith("IN FSIZE") and data.rstrip().endswith("@ @")


def test_export_generic_hpgl_to_file(tmp_path):
    p = load_builtin_profiles()["generic_hpgl"]
    r = service.export_cut(_model(), p, transport_kind="file", dest_dir=str(tmp_path), name="g")
    assert r.ok is True
    assert open(r.detail, "rb").read().startswith(b"IN;SP1;")


def test_export_dxf_vector(tmp_path):
    p = load_builtin_profiles()["generic_hpgl"]
    r = service.export_cut(
        _model(), p, emitter_kind="dxf",
        transport_kind="file", dest_dir=str(tmp_path), name="v",
    )
    assert r.ok is True
    assert r.detail.endswith(".dxf")
    assert b"LWPOLYLINE" in open(r.detail, "rb").read()


def test_oversize_sheet_still_sends(tmp_path):
    """Khổ lớn KHÔNG bị chặn — phần mềm không từ chối theo 'giới hạn máy' nữa."""
    p = load_builtin_profiles()["yuty_a3_max"]
    big = _model()
    big.sheet_w_mm = 500
    big.sheet_h_mm = 700
    r = service.export_cut(big, p, transport_kind="file", dest_dir=str(tmp_path), name="big")
    assert r.ok is True


def test_oversize_with_ignore_limits_param(tmp_path):
    """ignore_limits giữ lại cho tương thích API — vẫn gửi bình thường."""
    p = load_builtin_profiles()["yuty_a3_max"]
    big = _model()
    big.sheet_w_mm = 500
    big.sheet_h_mm = 700
    r = service.export_cut(big, p, transport_kind="file", dest_dir=str(tmp_path),
                           name="big", ignore_limits=True)
    assert r.ok is True


def test_manual_affine_registration_warps(tmp_path):
    p = load_builtin_profiles()["generic_hpgl"]
    m = _model()
    # Tịnh tiến đo thực +5mm theo X qua 3 ốc.
    design = [(0, 0), (100, 0), (0, 200)]
    measured = [(5, 0), (105, 0), (5, 200)]
    r = service.export_cut(
        m, p, transport_kind="file", dest_dir=str(tmp_path), name="aff",
        reg_mode="manual_affine", design_pts=design, measured_pts=measured,
    )
    assert r.ok is True
    # Điểm (10,10) → +5 = (15,10) → ×40 = PU600,400
    data = open(r.detail, "rb").read().decode("ascii")
    assert "PU600,400;" in data


def test_deterministic_export(tmp_path):
    p = load_builtin_profiles()["yuty_a3_max"]
    r1 = service.export_cut(_model(), p, transport_kind="file", dest_dir=str(tmp_path), name="d1")
    r2 = service.export_cut(_model(), p, transport_kind="file", dest_dir=str(tmp_path), name="d2")
    assert open(r1.detail, "rb").read() == open(r2.detail, "rb").read()
