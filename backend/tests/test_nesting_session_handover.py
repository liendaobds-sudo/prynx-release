"""Chuyển phiên nesting qua RANH GIỚI PROCESS, và đường route thật.

NEST (audit 2026-08-28 §A4b-6). Lô §A4b-5 dựng kho phiên trong RAM và chứng minh
"một lượt solve dùng cho cả preview lẫn export" — nhưng chỉ **trong cùng một
process**. Đường chạy thật không như vậy::

    POST /nup-start → process API        ← preview solve, session nằm ở RAM đây
        ↓ multiprocessing.Process
    run_nup_engine  → process CON        ← export chạy ở đây, RAM rỗng

`_spawn_nup_process` tạo `multiprocessing.Process` thật (`imposition.py`), nên
process con khởi động với kho phiên **rỗng** và sẽ solve lại — mất đúng bất biến
preview ≡ output mà §A4b-5 vừa dựng.

Bản vá: process API công bố manifest xuống kho trên đĩa rồi gắn hai identity
layout (`manifestId` + `layoutFingerprint`) cùng `reportHash` server-owned vào
`settings`. Process con nạp lại, xác minh overlay mới nhất và render, không solve.

Cách mô phỏng: `reset_preview_session_store()` cho RAM trống **đúng như** một
process mới, trong khi manifest vẫn nằm trên đĩa. Đó là trạng thái thật của process
con. Có thêm một test chạy `multiprocessing.Process` thật để chốt phần mà mô phỏng
không chứng minh được.
"""

from __future__ import annotations

import asyncio
import multiprocessing
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace

import pikepdf
import pytest

from app.workers.imposition_pdf_form import PT_PER_MM

MM = PT_PER_MM
DIE_MM = 40.0
HOLE_LO_MM = 14.0
HOLE_HI_MM = 26.0


def _make_die_source(path: Path) -> None:
    size = DIE_MM * MM
    lo = HOLE_LO_MM * MM
    hi = HOLE_HI_MM * MM
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(size, size))
    page = pdf.pages[0]
    outer = f"0 0 m {size} 0 l {size} {size} l 0 {size} l h "
    hole = f"{lo} {lo} m {lo} {hi} l {hi} {hi} l {hi} {lo} l h "
    page.contents_add(
        pikepdf.Stream(
            pdf,
            (
                f"q 0 0 0 rg 0 0 {size} {size} re f Q\n"
                f"q 0 1 0 0 K 0.5 w {outer}{hole}S Q\n"
            ).encode("ascii"),
        )
    )
    pdf.save(str(path))
    pdf.close()


def _settings(**overrides):
    from app.workers.nup_true_shape_nesting import TRUE_SHAPE_NESTING_STRATEGY

    base = {
        "gridStrategy": TRUE_SHAPE_NESTING_STRATEGY,
        "isDieCutMode": True,
        "sheetWidth": 320.0,
        "sheetHeight": 230.0,
        "gapX": 2.0,
        "gapY": 3.0,
        "marginLeft": 5.0,
        "marginRight": 5.0,
        "marginTop": 5.0,
        "marginBottom": 5.0,
        "targetQuantitiesByPage": {"0": 6},
    }
    base.update(overrides)
    return base


@pytest.mark.parametrize("marks, expected_obstacles", [(True, 4), (False, 0)])
def test_preview_request_cnc_duplex_marks_map_to_solver_obstacles(
    monkeypatch, tmp_path: Path, marks: bool, expected_obstacles: int
):
    """PARITY (audit 2026-09-05 §NEST26.1): preview và export cùng vật cản dấu canh."""

    from app.api.routes.imposition import PreviewLayoutRequest
    from app.core.nesting_preview_capacity import settings_from_preview_request
    from app.core.nesting_preview_session import job_identity_key
    from app.workers import nup_true_shape_nesting as module

    request = PreviewLayoutRequest(
        usable_w=300.0,
        usable_h=220.0,
        item_w=40.0,
        item_h=40.0,
        gap_x=2.0,
        gap_y=2.0,
        strategy="true_shape_nesting",
        is_die_cut=True,
        imposer_mode="cnc",
        cnc_two_sided=True,
        cnc_duplex_marks=marks,
        cnc_flip_edge="long",
        sheet_w=320.0 * PT_PER_MM,
        sheet_h=230.0 * PT_PER_MM,
        target_quantities_by_page={"0": 6},
        detected_shapes_by_page={"0": "CUSTOM", "1": "CUSTOM"},
    )
    settings = settings_from_preview_request(request)
    assert settings["cncDuplexMarks"] is marks

    # Chỉ cần shape tối thiểu để dựng job; detector thật được test riêng ở các ca PDF.
    contour = SimpleNamespace(
        page_index=0,
        outer_top_down_user_units=((0.0, 0.0), (40.0, 0.0), (40.0, 40.0)),
        holes_top_down_user_units=(),
    )
    shape = SimpleNamespace(page_contour=contour)
    monkeypatch.setattr(
        module, "_detect_shapes_for_nesting", lambda _source: {0: shape, 1: shape}
    )
    source = tmp_path / "cnc-preview.pdf"
    source.write_bytes(b"audit fixture")
    job = module.build_true_shape_nesting_job(str(source), settings, job_id="marks")
    assert len(job.fixed_obstacles) == expected_obstacles
    opposite_settings = {**settings, "cncDuplexMarks": not marks}
    opposite_job = module.build_true_shape_nesting_job(
        str(source), opposite_settings, job_id="marks-opposite"
    )
    assert job_identity_key(job) != job_identity_key(opposite_job)


@pytest.fixture
def source(tmp_path: Path) -> Path:
    path = tmp_path / "khuon.pdf"
    _make_die_source(path)
    return path


@pytest.fixture
def _env(monkeypatch, tmp_path):
    """Cờ bật + artifact root riêng, để không ghi vào thư mục dùng chung."""

    from app.core.nesting_preview_session import reset_preview_session_store

    monkeypatch.setattr(
        "app.core.nesting_rollout.true_shape_nesting_enabled", lambda: True
    )
    monkeypatch.setenv("PRYNX_MIXED_NESTING_DATA_DIR", str(tmp_path / "artifacts"))
    reset_preview_session_store()
    yield
    reset_preview_session_store()


def _count_real_solves(monkeypatch):
    from app.core import nesting_production_pipeline as pipeline

    original = pipeline.solve_production_nesting_job
    calls: list[int] = []

    def _counting(job, **kwargs):
        calls.append(1)
        return original(job, **kwargs)

    monkeypatch.setattr(pipeline, "solve_production_nesting_job", _counting)
    return calls


def _page_streams(path: Path) -> list[bytes]:
    pages: list[bytes] = []
    with pikepdf.Pdf.open(str(path)) as pdf:
        for page in pdf.pages:
            contents = page.obj.get("/Contents")
            streams = contents if isinstance(contents, pikepdf.Array) else [contents]
            pages.append(b"".join(stream.read_bytes() for stream in streams))
    return pages


def _pose_records(manifest) -> list[tuple]:
    """So layout canonical, bỏ identity nguồn/manifest thay đổi theo publication."""

    records: list[tuple] = []
    for placement in manifest.get("placements") or ():
        pose = placement.get("pose") or {}
        records.append(
            (
                str(placement.get("partId")),
                int(placement.get("sheetIndex") or 0),
                round(float(pose.get("rotationDeg") or 0.0), 6),
                round(float(pose.get("translateXmm") or 0.0), 6),
                round(float(pose.get("translateYmm") or 0.0), 6),
            )
        )
    return sorted(records)


# ── 1. Tham chiếu phiên: gắn ở process API ───────────────────────────────────

def test_khong_co_phien_thi_settings_khong_doi(source: Path, _env):
    """Bấm Bình mà chưa preview ⇒ không gắn gì, process con tự solve."""

    from app.core.nesting_preview_session import SESSION_REFERENCE_SETTING
    from app.workers.nup_true_shape_nesting import attach_preview_session_reference

    settings = _settings()
    result = attach_preview_session_reference(settings, str(source), job_id="abc12345")

    assert SESSION_REFERENCE_SETTING not in result


def test_strategy_khac_thi_khong_gan_gi(source: Path, _env):
    # §B10: "Lưới đơn giản" = job KHÔNG nesting ⇒ không gắn gì. (optimal_auto+CUSTOM nay LÀ
    # nesting nên không còn là ca "strategy khác"; xem test_auto_route_optimal_tai_dung_phien.)
    from app.core.nesting_preview_session import SESSION_REFERENCE_SETTING
    from app.workers.nup_true_shape_nesting import attach_preview_session_reference

    settings = _settings(gridStrategy="simple_auto")
    result = attach_preview_session_reference(settings, str(source), job_id="abc12345")

    assert SESSION_REFERENCE_SETTING not in result


def test_auto_route_optimal_tai_dung_phien(source: Path, _env):
    """§B10: export auto-route ("Xếp tối ưu" + CUSTOM, KHÔNG token) TÁI DÙNG phiên preview.

    Preview gửi token nên settings preview mang `true_shape_nesting`; export lại mang
    `optimal_auto`. `job_identity_key` không phụ thuộc gridStrategy nên hai bên cùng khoá ⇒
    `attach_preview_session_reference` phải tra thấy phiên và gắn tham chiếu (không solve lại).
    """

    from app.core.nesting_preview_session import (
        SESSION_REFERENCE_SETTING,
        get_preview_session_store,
    )
    from app.workers.nup_true_shape_nesting import (
        REPORT_HASH_FIELD,
        _report_hash_for_job,
        attach_preview_session_reference,
        build_true_shape_nesting_job,
    )

    # Preview tạo phiên (đường token).
    preview_settings = _settings(detectedShapesByPage={"0": "CUSTOM"})
    preview_job = build_true_shape_nesting_job(
        str(source), preview_settings, job_id="auto01"
    )
    session = get_preview_session_store().get_or_solve(preview_job).session

    # Export auto-route: gridStrategy=optimal_auto (không token), cùng hình học.
    export_settings = _settings(
        gridStrategy="optimal_auto", detectedShapesByPage={"0": "CUSTOM"}
    )
    result = attach_preview_session_reference(
        export_settings, str(source), job_id="auto01"
    )
    export_job = build_true_shape_nesting_job(
        str(source), export_settings, job_id="auto01"
    )

    assert result[SESSION_REFERENCE_SETTING] == {
        "manifestId": session.manifest_id,
        "layoutFingerprint": session.layout_fingerprint,
        REPORT_HASH_FIELD: _report_hash_for_job(export_job),
    }


def test_co_phien_thi_gan_identity_va_report_hash(source: Path, _env, monkeypatch):
    """Đã preview ⇒ gắn hai identity layout + hash overlay, không gắn dữ liệu thô."""

    from app.core.nesting_preview_session import (
        SESSION_REFERENCE_SETTING,
        get_preview_session_store,
    )
    from app.workers.nup_true_shape_nesting import (
        REPORT_HASH_FIELD,
        _report_hash_for_job,
        attach_preview_session_reference,
        build_true_shape_nesting_job,
    )

    settings = _settings()
    job = build_true_shape_nesting_job(str(source), settings, job_id="abc12345")
    session = get_preview_session_store().get_or_solve(job).session

    attach_preview_session_reference(settings, str(source), job_id="abc12345")
    reference = settings[SESSION_REFERENCE_SETTING]

    assert set(reference) == {"manifestId", "layoutFingerprint", REPORT_HASH_FIELD}
    assert reference["manifestId"] == session.manifest_id
    assert reference["layoutFingerprint"] == session.layout_fingerprint
    assert reference[REPORT_HASH_FIELD] == _report_hash_for_job(job)
    # Tham chiếu phải pickle được: nó đi qua `multiprocessing.Process(args=...)`.
    import pickle

    assert pickle.loads(pickle.dumps(reference)) == reference


def test_manifest_cu_sau_restart_khong_ep_preview_moi_solve_lai_khi_export(
    source: Path, tmp_path: Path, _env, monkeypatch
):
    """RA-NEST-08: publication cũ không được xung đột với phiên preview mới.

    Locator nguồn thuộc từng lượt pin nên RenderBundle/fingerprint của hai phiên
    hợp lệ có thể khác, dù pose canonical giống nhau. Manifest ID phải nhận dạng
    publication immutable, không được tái dùng như cache key cấu hình.
    """

    from app.core.nesting_preview_session import (
        SESSION_REFERENCE_SETTING,
        commit_and_reference,
        get_preview_session_store,
        reset_preview_session_store,
    )
    from app.workers.nup_true_shape_nesting import (
        REPORT_HASH_FIELD,
        _report_hash_for_job,
        attach_preview_session_reference,
        build_true_shape_nesting_job,
        run_true_shape_nesting,
    )

    first_settings = _settings()
    first_job = build_true_shape_nesting_job(
        str(source), first_settings, job_id="restart-same-job"
    )
    first_session = get_preview_session_store().get_or_solve(first_job).session
    first_reference = commit_and_reference(first_session)
    assert first_reference["manifestId"] == first_session.manifest_id

    # Mô phỏng backend restart: session RAM mất, kho manifest immutable vẫn còn.
    reset_preview_session_store()

    second_settings = _settings()
    second_job = build_true_shape_nesting_job(
        str(source), second_settings, job_id="restart-same-job"
    )
    second_session = get_preview_session_store().get_or_solve(second_job).session
    assert _pose_records(first_session.solved.manifest) == _pose_records(
        second_session.solved.manifest
    )

    attach_preview_session_reference(
        second_settings, str(source), job_id="restart-same-job"
    )
    second_reference = second_settings.get(SESSION_REFERENCE_SETTING)
    assert second_reference == {
        "manifestId": second_session.manifest_id,
        "layoutFingerprint": second_session.layout_fingerprint,
        REPORT_HASH_FIELD: _report_hash_for_job(second_job),
    }
    assert second_reference != first_reference

    # Process export chỉ render publication B; tuyệt đối không solve lần ba.
    reset_preview_session_store()
    calls = _count_real_solves(monkeypatch)
    output = tmp_path / "restart-publication-b.pdf"
    run_true_shape_nesting(
        str(source), str(output), second_settings, job_id="restart-same-job"
    )

    assert calls == [], "export phải render manifest preview B, không solve lại"
    assert output.is_file()


def test_loi_khi_gan_khong_lam_vo_job(source: Path, _env, monkeypatch):
    """Fail-soft: gắn tham chiếu lỗi chỉ mất đường tăng tốc, job vẫn hợp lệ."""

    from app.core.nesting_preview_session import SESSION_REFERENCE_SETTING
    from app.workers import nup_true_shape_nesting as module

    def _boom(*_args, **_kwargs):
        raise RuntimeError("kho phien loi")

    monkeypatch.setattr(module, "build_true_shape_nesting_job", _boom)

    settings = _settings()
    result = module.attach_preview_session_reference(
        settings, str(source), job_id="abc12345"
    )

    assert SESSION_REFERENCE_SETTING not in result


def test_loi_commit_sau_khi_co_phien_giu_marker_de_export_fail_closed(
    source: Path, _env, monkeypatch
):
    """Đã nhận dạng được preview thì lỗi storage không được mở đường solve lại."""

    from app.core import nesting_preview_session as preview_session
    from app.core.nesting_preview_session import SESSION_REFERENCE_SETTING
    from app.workers import nup_true_shape_nesting as module

    report_hash = "sha256:" + "c" * 64

    fake_session = SimpleNamespace(
        manifest_id="a" * 32,
        layout_fingerprint="sha256:" + "b" * 64,
    )
    fake_store = SimpleNamespace(peek_or_wait=lambda _job: fake_session)
    monkeypatch.setattr(module, "build_true_shape_nesting_job", lambda *_a, **_k: object())
    monkeypatch.setattr(module, "_report_hash_for_job", lambda _job: report_hash)
    monkeypatch.setattr(
        preview_session, "get_preview_session_store", lambda: fake_store
    )
    monkeypatch.setattr(
        preview_session,
        "commit_and_reference",
        lambda *_a, **_k: (_ for _ in ()).throw(OSError("disk unavailable")),
    )

    settings = _settings()
    result = module.attach_preview_session_reference(
        settings, str(source), job_id="abc12345"
    )

    assert result[SESSION_REFERENCE_SETTING] == {
        "manifestId": fake_session.manifest_id,
        "layoutFingerprint": fake_session.layout_fingerprint,
        module.REPORT_HASH_FIELD: report_hash,
    }


# ── 2. Process con: nạp lại và render, KHÔNG solve ───────────────────────────

def test_ram_rong_van_render_duoc_tu_tham_chieu(
    source: Path, tmp_path, _env, monkeypatch
):
    """Ca quyết định của §A4b-6.

    Mô phỏng process con: kho phiên bị reset (RAM rỗng đúng như process mới), chỉ
    còn manifest trên đĩa cộng hai chuỗi identity trong `settings`.
    """

    from app.core.nesting_preview_session import (
        get_preview_session_store,
        reset_preview_session_store,
    )
    from app.workers.nup_true_shape_nesting import (
        attach_preview_session_reference,
        build_true_shape_nesting_job,
        run_true_shape_nesting,
    )

    settings = _settings()

    # (1) Process API: preview solve rồi gắn tham chiếu.
    job = build_true_shape_nesting_job(str(source), settings, job_id="abc12345")
    get_preview_session_store().get_or_solve(job)
    attach_preview_session_reference(settings, str(source), job_id="abc12345")

    # (2) Ranh giới process: RAM mất hết, đĩa còn.
    reset_preview_session_store()

    # (3) Process con: chỉ được render, không được solve.
    calls = _count_real_solves(monkeypatch)
    output = tmp_path / "con.pdf"
    report = run_true_shape_nesting(str(source), str(output), settings, "abc12345")

    assert calls == [], "process con KHÔNG được solve lại"
    assert output.is_file()
    assert "Nesting tối ưu theo đường bế" in report


def test_artifact_tu_tham_chieu_giong_artifact_tu_phien(
    source: Path, tmp_path, _env, monkeypatch
):
    """Hai đường phải cho artifact giống nhau tới byte — nếu không, preview ≠ output."""

    from app.core.nesting_preview_session import (
        get_preview_session_store,
        reset_preview_session_store,
    )
    from app.core.nesting_production_pipeline import render_production_nesting_session
    from app.workers.nup_true_shape_nesting import (
        attach_preview_session_reference,
        build_true_shape_nesting_job,
        run_true_shape_nesting,
    )

    settings = _settings()
    job = build_true_shape_nesting_job(str(source), settings, job_id="abc12345")
    session = get_preview_session_store().get_or_solve(job).session

    # Đường A: render trực tiếp từ session (trong process API).
    from_session = tmp_path / "tu-phien.pdf"
    render_production_nesting_session(session, output_path=from_session)

    # Đường B: qua tham chiếu, sau khi RAM đã mất.
    attach_preview_session_reference(settings, str(source), job_id="abc12345")
    reset_preview_session_store()
    from_reference = tmp_path / "tu-tham-chieu.pdf"
    run_true_shape_nesting(str(source), str(from_reference), settings, "abc12345")

    left = _page_streams(from_session)
    right = _page_streams(from_reference)
    assert len(left) == len(right) and len(left) > 0
    for index, (one, two) in enumerate(zip(left, right)):
        assert one == two, f"trang {index} lệch giữa hai đường render"


def test_tham_chieu_rac_thi_fail_closed_khong_solve_lai(
    source: Path, tmp_path, _env, monkeypatch
):
    """Manifest bị dọn/fingerprint lệch không được sinh layout khác preview."""

    from app.core.nesting_preview_session import SESSION_REFERENCE_SETTING
    from app.workers.nup_true_shape_nesting import (
        REPORT_HASH_FIELD,
        _report_hash_for_job,
        build_true_shape_nesting_job,
        run_true_shape_nesting,
    )

    settings = _settings()
    job = build_true_shape_nesting_job(str(source), settings, job_id="abc12345")
    settings[SESSION_REFERENCE_SETTING] = {
        "manifestId": "0" * 32,
        "layoutFingerprint": "sha256:" + "0" * 64,
        REPORT_HASH_FIELD: _report_hash_for_job(job),
    }

    calls = _count_real_solves(monkeypatch)
    output = tmp_path / "solve-lai.pdf"
    with pytest.raises(ValueError, match="manifest của bản xem trước nesting"):
        run_true_shape_nesting(str(source), str(output), settings, "abc12345")

    assert calls == [], "tham chiếu preview lỗi phải fail-closed, không solve lại"
    assert not output.exists()


def test_report_hash_single_lech_fail_truoc_khi_load_manifest(
    source: Path, tmp_path, _env, monkeypatch
):
    """Reference single bind report cũ phải dừng trước I/O và không solve lại."""

    from app.core.nesting_preview_session import SESSION_REFERENCE_SETTING
    from app.workers.nup_true_shape_nesting import run_true_shape_nesting

    settings = _settings()
    settings[SESSION_REFERENCE_SETTING] = {
        "manifestId": "0" * 32,
        "layoutFingerprint": "sha256:" + "0" * 64,
        "reportHash": "sha256:" + "f" * 64,
    }
    monkeypatch.setattr(
        "app.core.nesting_preview_session.load_referenced_manifest",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("reportHash phải được kiểm trước khi đọc manifest")
        ),
    )
    calls = _count_real_solves(monkeypatch)
    output = tmp_path / "report-hash-lech.pdf"

    with pytest.raises(ValueError, match="Metadata bản xem trước nesting"):
        run_true_shape_nesting(str(source), str(output), settings, "abc12345")

    assert calls == [], "reportHash lệch không được rơi về solve"
    assert not output.exists()


@pytest.mark.parametrize(
    "reference",
    [
        None,
        {},
        {"manifestId": "0" * 32},
        {"layoutFingerprint": "sha256:" + "0" * 64},
        {"manifestId": 123, "layoutFingerprint": "sha256:" + "0" * 64},
        "khong-phai-map",
    ],
)
def test_tham_chieu_sai_kieu_bi_bo_qua(reference):
    """Tham chiếu méo mó phải bị bỏ qua êm, không ném."""

    from app.core.nesting_preview_session import load_referenced_manifest

    assert load_referenced_manifest(reference) is None


# ── 3. Process CON thật ──────────────────────────────────────────────────────

def _render_in_child(source_path, output_path, settings, artifact_root, queue):
    """Chạy trong process CON thật: RAM riêng, kho phiên riêng, rỗng."""

    try:
        os.environ["PRYNX_MIXED_NESTING_DATA_DIR"] = artifact_root
        import app.core.nesting_rollout as rollout

        rollout.true_shape_nesting_enabled = lambda **_kwargs: True

        from app.core import nesting_production_pipeline as pipeline

        solved: list[int] = []
        original = pipeline.solve_production_nesting_job

        def _counting(job, **kwargs):
            solved.append(1)
            return original(job, **kwargs)

        pipeline.solve_production_nesting_job = _counting

        from app.workers.nup_true_shape_nesting import run_true_shape_nesting

        run_true_shape_nesting(source_path, output_path, settings, "child001")
        queue.put(("ok", len(solved)))
    except BaseException as exc:  # noqa: BLE001 - phải báo lỗi về process cha
        queue.put(("err", f"{type(exc).__name__}: {exc}"))


def test_process_con_that_render_khong_solve(source: Path, tmp_path, _env):
    """Chốt phần mà mô phỏng không chứng minh được: `multiprocessing.Process` thật.

    Mô phỏng ở trên reset kho phiên trong CÙNG interpreter. Test này spawn process
    riêng — đúng cơ chế `_spawn_nup_process` dùng — để chắc tham chiếu đi qua pickle
    và manifest resolve được từ process khác qua lease trên đĩa.
    """

    from app.core.nesting_preview_session import get_preview_session_store
    from app.workers.nup_true_shape_nesting import (
        attach_preview_session_reference,
        build_true_shape_nesting_job,
    )

    settings = _settings()
    job = build_true_shape_nesting_job(str(source), settings, job_id="abc12345")
    get_preview_session_store().get_or_solve(job)
    attach_preview_session_reference(settings, str(source), job_id="abc12345")

    artifact_root = os.environ["PRYNX_MIXED_NESTING_DATA_DIR"]
    output = tmp_path / "process-con.pdf"
    queue = multiprocessing.Queue()
    child = multiprocessing.Process(
        target=_render_in_child,
        args=(str(source), str(output), settings, artifact_root, queue),
        daemon=False,
    )
    child.start()
    try:
        status, payload = queue.get(timeout=240)
    finally:
        child.join(timeout=60)

    assert status == "ok", f"process con lỗi: {payload}"
    assert payload == 0, "process con KHÔNG được solve lại"
    assert output.is_file()


# ── 4. Route /nup-start thật (finding A4b-4c) ────────────────────────────────

class _CapturingExecutor:
    """Giữ task đến khi test chủ động chạy, mô phỏng hàng đợi executor."""

    def __init__(self) -> None:
        self.submissions: list[tuple[object, tuple, dict]] = []

    def submit(self, fn, *args, **kwargs):
        self.submissions.append((fn, args, kwargs))

        class _Future:
            def result(self_inner, timeout=None):  # noqa: N805 - stub tối giản
                return None

        return _Future()

    def run_next(self):
        fn, args, kwargs = self.submissions.pop(0)
        return fn(*args, **kwargs)


class _TrackingSubmissionSlot:
    def __init__(self) -> None:
        self.acquires = 0
        self.releases = 0

    def acquire(self, *, blocking=True):
        self.acquires += 1
        return True

    def release(self):
        self.releases += 1


@pytest.fixture
def _route(monkeypatch, tmp_path):
    """Cô lập route: bỏ license, không spawn process, kết quả vào tmp."""

    from app.api.routes import imposition as route

    prep_executor = _CapturingExecutor()
    render_executor = _CapturingExecutor()
    submission_slot = _TrackingSubmissionSlot()
    jobs_before = set(route.nup_jobs)
    monkeypatch.setattr(route, "enforce_feature", lambda *_a, **_k: None)
    monkeypatch.setattr(route, "_validate_file_path", lambda path: str(path))
    monkeypatch.setattr(route, "_NUP_PREP_EXECUTOR", prep_executor)
    monkeypatch.setattr(route, "_NUP_EXECUTOR", render_executor)
    monkeypatch.setattr(route, "_NUP_SUBMISSION_SLOTS", submission_slot)
    monkeypatch.setattr(route, "_purge_old_nup_jobs", lambda: None)
    monkeypatch.setattr(route.settings, "RESULTS_DIR", str(tmp_path / "results"))
    os.makedirs(tmp_path / "results", exist_ok=True)
    yield route, prep_executor, render_executor, submission_slot
    for job_id in set(route.nup_jobs) - jobs_before:
        route.nup_jobs.pop(job_id, None)


def _launch(route, source: Path, settings) -> dict:
    return route._launch_impose_job(
        {"source_path": str(source), "settings": settings}, "nup", {}
    )


def _run_captured_preparation(route_bundle) -> tuple:
    _route_module, prep_executor, render_executor, _slot = route_bundle
    assert len(prep_executor.submissions) == 1
    assert render_executor.submissions == []
    prep_executor.run_next()
    assert len(render_executor.submissions) == 1
    _fn, args, _kwargs = render_executor.submissions[0]
    return args


def test_route_gan_tham_chieu_khi_da_co_phien(source: Path, _env, _route):
    """Đường đầy đủ: preview solve ở process API ⇒ route chuyển tham chiếu xuống con.

    Đóng finding A4b-4c: trước lô này không test nào đi qua `_launch_impose_job`
    cho nhánh nesting, nên đoạn route → process con hoàn toàn không được phủ.
    """

    from app.core.nesting_preview_session import (
        SESSION_REFERENCE_SETTING,
        get_preview_session_store,
    )
    from app.workers.nup_true_shape_nesting import (
        REPORT_HASH_FIELD,
        _report_hash_for_job,
        build_true_shape_nesting_job,
    )

    route, prep_executor, render_executor, _slot = _route
    settings = _settings()

    job = build_true_shape_nesting_job(str(source), settings, job_id=None)
    session = get_preview_session_store().get_or_solve(job).session

    response = _launch(route, source, settings)
    assert "job_id" in response
    assert len(prep_executor.submissions) == 1
    assert render_executor.submissions == []
    child_args = _run_captured_preparation(_route)
    # args = (source_path, output_path, settings, job_id, source_fingerprint)
    child_settings = child_args[2]
    reference = child_settings.get(SESSION_REFERENCE_SETTING)

    assert reference == {
        "manifestId": session.manifest_id,
        "layoutFingerprint": session.layout_fingerprint,
        REPORT_HASH_FIELD: _report_hash_for_job(job),
    }, "route phải chuyển đủ identity layout và provenance report xuống con"


def test_preview_contract_thuc_te_den_route_va_process_con_khong_solve_lai(
    source: Path, tmp_path: Path, _env, _route, monkeypatch
):
    """PARITY/FIX (audit 2026-08-29 §NEST-PARITY-1): khóa dọc cả Lô 1.

    Đây không phải test tự seed cùng một ``settings`` ở hai đầu. Preview nhận đúng
    contract snake_case + point như UI; export nhận camelCase + mm như
    ``processHandlers``. Route còn normalize ốc trước khi handoff. Nếu bất kỳ field nào
    (hệ số mm/pt, loại ốc, CUT hoặc report) lệch, process con sẽ không có reference và
    test đỏ vì phải solve lại.
    """

    from app.core.nesting_preview_capacity import (
        build_nesting_preview,
        settings_from_preview_request,
    )
    from app.core.nesting_preview_session import (
        SESSION_REFERENCE_SETTING,
        get_preview_session_store,
        reset_preview_session_store,
    )
    from app.workers.nup_true_shape_nesting import (
        REPORT_HASH_FIELD,
        _report_hash_for_job,
        build_true_shape_nesting_job,
        run_true_shape_nesting,
    )

    pont = {
        "shape": "circle",
        "size": 5.0,
        "thickness": 0.5,
        "isGraphtec": False,
        "layerInfoName": "SA info",
        "layerName": "Marks_Model_",
        "groupName": "MarkLine",
        "itemName": "MKLINE",
        "disableCollision": False,
        "marginTop": 7.0,
        "marginBottom": 7.0,
        "marginLeft": 7.0,
        "marginRight": 7.0,
    }
    report = {
        "enabled": True,
        "fieldOrder": [
            "orderCode", "identifier", "gangCount", "labelName", "material",
            "lamination", "labelsPerSheet", "actualQty", "sheetCount",
            "dimensions", "paperSize", "cutFileRef", "modeLabel",
        ],
        "showIdentifier": True,
        "showGangCount": True,
        "showLabelName": True,
        "showDimensions": True,
        "showPaperSize": True,
        "showLabelsPerSheet": True,
        "showSheetCount": True,
        "showActualQty": True,
        "showMaterial": True,
        "showLamination": True,
        "showCutFileRef": True,
        "showModeLabel": True,
        "labelNameText": "TEM",
        "position": "top",
        "centered": True,
        "offsetX": 5.0,
        "offsetY": 5.0,
        "fontSize": 8.0,
        "removeDiacritics": False,
    }
    request = SimpleNamespace(
        strategy="true_shape_nesting",
        is_die_cut=True,
        imposer_mode=None,
        task_mode="nup",
        layout_type="sequential",
        page_sheet_mode=False,
        sheet_w=320.0 * MM,
        sheet_h=230.0 * MM,
        gap_x=2.0 * MM,
        gap_y=3.0 * MM,
        margin_left=5.0 * MM,
        margin_right=5.0 * MM,
        margin_top=5.0 * MM,
        margin_bottom=5.0 * MM,
        align="center",
        target_quantities_by_page={"0": 6},
        detected_shapes_by_page={"0": "CUSTOM"},
        detected_shape_params_by_page={},
        pont_type="5mm",
        pont_config=pont,
        cut_type="default",
        fill_block_gap=0.0,
        die_size_mode="die",
        die_offset_mm=0.0,
        separate_cut_page=True,
        ponts_on_cut_file=True,
        export_unique_sheets=True,
        report_display=report,
        report_material="Decal PP",
        report_lamination=1,
        report_lamination_sides=1,
        report_order_code="DH-001",
        diagnostic_trace_id=None,
        diagnostic_request_id=None,
    )

    preview = build_nesting_preview(request, source_path=str(source))
    preview_job = build_true_shape_nesting_job(
        str(source), settings_from_preview_request(request)
    )
    session = get_preview_session_store().peek(preview_job)
    assert session is not None
    assert preview["totalItems"] > 0

    export_settings = _settings(
        layoutType="sequential",
        align="center",
        pontType="5mm",
        pontConfig=pont,
        cutType="default",
        fillBlockGap=0.0,
        dieSizeMode="die",
        dieOffsetMm=0.0,
        separateCutPage=True,
        pontsOnCutFile=True,
        exportUniqueSheets=True,
        reportDisplay=report,
        reportMaterial="Decal PP",
        reportLamination=1,
        reportLaminationSides=1,
        reportOrderCode="DH-001",
        detectedShapesByPage={"0": "CUSTOM"},
        detectedShapeParamsByPage={},
    )
    route, _prep_executor, _render_executor, _slot = _route
    _launch(route, source, export_settings)
    child_settings = _run_captured_preparation(_route)[2]
    reference = child_settings.get(SESSION_REFERENCE_SETTING)

    assert reference == {
        "manifestId": session.manifest_id,
        "layoutFingerprint": session.layout_fingerprint,
        REPORT_HASH_FIELD: _report_hash_for_job(preview_job),
    }

    # Process con thật có RAM rỗng: chỉ manifest đã công bố được phép nuôi renderer.
    reset_preview_session_store()
    calls = _count_real_solves(monkeypatch)
    output = tmp_path / "vertical-parity.pdf"
    run_true_shape_nesting(
        str(source), str(output), child_settings, job_id="vertical1"
    )

    assert calls == [], "process con phải render manifest preview, không solve lại"
    assert output.is_file()


def test_step_repeat_doi_so_luong_va_metadata_tai_dung_layout_nhung_report_moi(
    source: Path, tmp_path: Path, _env, monkeypatch
):
    """Preview qty/report A → Bình qty/report B: giữ pose, không solve, đóng dấu B."""

    from app.core.nesting_preview_session import (
        SESSION_REFERENCE_SETTING,
        get_preview_session_store,
        job_identity_key,
        reset_preview_session_store,
    )
    from app.workers import nup_report
    from app.workers.nup_true_shape_nesting import (
        REPORT_HASH_FIELD,
        _report_hash_for_job,
        attach_preview_session_reference,
        build_true_shape_nesting_jobs,
        run_true_shape_nesting,
    )

    def report_display(label: str) -> dict:
        return {
            "enabled": True,
            "fieldOrder": [
                "orderCode",
                "labelName",
                "material",
                "labelsPerSheet",
                "actualQty",
                "sheetCount",
            ],
            "labelNameText": label,
            "position": "top",
            "centered": True,
            "offsetX": 5.0,
            "offsetY": 5.0,
            "fontSize": 8.0,
        }

    preview_settings = _settings(
        taskMode="step_repeat",
        layoutType="repeat",
        targetQuantitiesByPage={"0": 6},
        reportDisplay=report_display("Sản phẩm A"),
        reportMaterial="Decal A",
        reportOrderCode="DH-A",
    )
    preview_job = build_true_shape_nesting_jobs(
        str(source), preview_settings, job_id="report-overlay"
    )[0]
    preview_session = get_preview_session_store().get_or_solve(preview_job).session
    preview_poses = _pose_records(preview_session.solved.manifest)
    capacity = int(preview_session.solved.manifest["stats"]["placedCount"])
    assert capacity > 0

    # Chọn demand chắc chắn qua hai tờ để chứng minh sheetCount dùng SL mới,
    # không chỉ chứng minh text mã đơn/tên sản phẩm đã đổi.
    execute_quantity = capacity + 1
    execute_settings = _settings(
        taskMode="step_repeat",
        layoutType="repeat",
        targetQuantitiesByPage={"0": execute_quantity},
        reportDisplay=report_display("Sản phẩm B"),
        reportMaterial="Decal B",
        reportOrderCode="DH-B",
    )
    execute_job = build_true_shape_nesting_jobs(
        str(source), execute_settings, job_id="report-overlay"
    )[0]

    assert job_identity_key(preview_job) == job_identity_key(execute_job)
    assert _report_hash_for_job(preview_job) != _report_hash_for_job(execute_job)

    attach_preview_session_reference(
        execute_settings,
        str(source),
        job_id="report-overlay",
    )
    references = execute_settings[SESSION_REFERENCE_SETTING]
    assert len(references) == 1
    assert references[0]["manifestId"] == preview_session.manifest_id
    assert references[0]["layoutFingerprint"] == preview_session.layout_fingerprint
    assert references[0][REPORT_HASH_FIELD] == _report_hash_for_job(execute_job)

    captured_reports: list[str] = []
    original_stamp = nup_report.stamp_reports_on_pdf

    def capture_stamp(input_path, output_path, reports_by_page, **kwargs):
        captured_reports.extend(str(text) for text in reports_by_page.values())
        return original_stamp(input_path, output_path, reports_by_page, **kwargs)

    monkeypatch.setattr(nup_report, "stamp_reports_on_pdf", capture_stamp)

    # Mô phỏng process con: RAM preview rỗng, chỉ publication trên đĩa còn sống.
    reset_preview_session_store()
    calls = _count_real_solves(monkeypatch)
    output = tmp_path / "step-repeat-report-moi.pdf"
    run_true_shape_nesting(
        str(source),
        str(output),
        execute_settings,
        job_id="report-overlay",
    )

    assert calls == [], "đổi SL/metadata Bình trang không được solve lại"
    assert output.is_file()
    assert preview_poses, "preview phải có pose để chứng minh layout được tái dùng"
    assert len(captured_reports) == 1
    report_text = captured_reports[0]
    assert "DH-B" in report_text
    assert "Sản phẩm B" in report_text
    assert "Decal B" in report_text
    assert "Số tờ: 2" in report_text
    assert "DH-A" not in report_text
    assert "Sản phẩm A" not in report_text


def test_route_khong_gan_gi_khi_chua_preview(source: Path, _env, _route):
    """Bấm Bình mà chưa preview ⇒ không có tham chiếu, con tự solve."""

    from app.core.nesting_preview_session import SESSION_REFERENCE_SETTING

    route, _prep_executor, _render_executor, _slot = _route
    _launch(route, source, _settings())

    child_settings = _run_captured_preparation(_route)[2]
    assert SESSION_REFERENCE_SETTING not in child_settings


def test_route_khong_anh_huong_strategy_khac(source: Path, _env, _route):
    """Job lưới grid ("Lưới đơn giản") đi qua route không được mọc thêm field nào."""

    from app.core.nesting_preview_session import SESSION_REFERENCE_SETTING

    route, _prep_executor, _render_executor, _slot = _route
    _launch(route, source, _settings(gridStrategy="simple_auto"))

    child_settings = _run_captured_preparation(_route)[2]
    assert SESSION_REFERENCE_SETTING not in child_settings
    assert child_settings["gridStrategy"] == "simple_auto"


def test_route_gan_that_bai_van_xep_duoc_job(
    source: Path, _env, _route, monkeypatch
):
    """Fail-soft ở tầng route: lỗi gắn tham chiếu không được làm job 500."""

    from app.workers import nup_true_shape_nesting as module

    monkeypatch.setattr(
        module,
        "attach_preview_session_reference",
        lambda *_a, **_k: (_ for _ in ()).throw(RuntimeError("boom")),
    )

    from app.core.nesting_preview_session import SESSION_REFERENCE_SETTING

    route, prep_executor, render_executor, _slot = _route
    response = _launch(route, source, _settings())

    # Job vẫn được xếp: nhánh nesting hỏng chỉ mất đường tăng tốc.
    assert "job_id" in response
    assert len(prep_executor.submissions) == 1
    child_settings = _run_captured_preparation(_route)[2]
    assert len(render_executor.submissions) == 1
    assert SESSION_REFERENCE_SETTING not in child_settings


def test_route_khong_bi_nesting_lam_vo_job_luoi(source: Path, _env, _route, monkeypatch):
    """Bán kính ảnh hưởng: module nesting lỗi KHÔNG được làm hỏng job lưới grid.

    Đây là lý do lời gọi ở route được bọc try/except chứ không dựa vào fail-soft bên
    trong module: một `ImportError` lúc nạp module cũng phải bị chặn.
    """

    import builtins

    # Dựng settings TRƯỚC khi chặn import — helper của test cũng đọc module đó.
    grid_settings = _settings(gridStrategy="optimal_auto")
    route, prep_executor, render_executor, _slot = _route

    real_import = builtins.__import__

    def _fail_nesting_import(name, *args, **kwargs):
        if name == "app.workers.nup_true_shape_nesting":
            raise ImportError("mo phong module nesting hong")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", _fail_nesting_import)

    response = _launch(route, source, grid_settings)

    assert "job_id" in response
    assert len(prep_executor.submissions) == 1
    _run_captured_preparation(_route)
    assert len(render_executor.submissions) == 1


@pytest.mark.parametrize(
    ("total_ram_mb", "expected"),
    [
        (4 * 1024, 2),
        (12 * 1024, 4),
        (16 * 1024, 9),
        (32 * 1024, 9),
        (None, 9),
    ],
)
def test_prep_worker_chi_giam_tren_may_yeu(total_ram_mb, expected):
    from app.api.routes import imposition as route

    assert route.nup_preparation_workers_for_ram(
        total_ram_mb,
        cpu_count=16,
        admitted_jobs=9,
    ) == expected


def test_route_tra_job_id_truoc_khi_handoff_chay(
    source: Path, _env, _route, monkeypatch
):
    """PERF-NEST-03: POST không được chạy build/wait/commit trên event loop."""

    from app.workers import nup_true_shape_nesting as nesting

    called = []

    def _attach(settings, _source, **_kwargs):
        called.append(threading.current_thread().name)
        return settings

    monkeypatch.setattr(nesting, "attach_preview_session_reference", _attach)
    route, prep_executor, render_executor, _slot = _route

    response = _launch(route, source, _settings())
    job_id = response["job_id"]

    assert called == []
    assert len(prep_executor.submissions) == 1
    assert render_executor.submissions == []
    status = asyncio.run(route.get_nup_status(job_id, {}))
    assert status["status"] == "queued"
    assert status["progress"] == "0/0"

    _run_captured_preparation(_route)
    assert called
    assert route.nup_jobs[job_id]["status"] == "queued"
    assert route.nup_jobs[job_id]["progress"] == "0/0"


def test_huy_khi_handoff_dang_cho_khong_spawn_render_va_status_van_dap_ung(
    source: Path, _env, _route, monkeypatch
):
    """Cancel thức prep waiter, còn poll/status không bị thread handoff giữ lại."""

    from app.workers import nup_true_shape_nesting as nesting

    entered = threading.Event()
    left = threading.Event()

    def _blocking_attach(settings, _source, *, cancel_check=None, **_kwargs):
        entered.set()
        while cancel_check is None or not cancel_check():
            time.sleep(0.01)
        left.set()
        return settings

    monkeypatch.setattr(
        nesting,
        "attach_preview_session_reference",
        _blocking_attach,
    )
    route, _captured_prep, render_executor, submission_slot = _route

    with ThreadPoolExecutor(max_workers=1, thread_name_prefix="test-nup-prepare") as pool:
        monkeypatch.setattr(route, "_NUP_PREP_EXECUTOR", pool)
        started = time.monotonic()
        response = _launch(route, source, _settings())
        launch_elapsed = time.monotonic() - started
        job_id = response["job_id"]
        assert launch_elapsed < 0.5
        assert entered.wait(1.0)

        poll_started = time.monotonic()
        status = asyncio.run(route.get_nup_status(job_id, {}))
        assert time.monotonic() - poll_started < 0.5
        assert status["status"] == "queued"
        assert status["progress"] == "preparing_manifest"

        cancel_started = time.monotonic()
        cancelled = asyncio.run(route.cancel_nup_job(job_id, {}))
        assert time.monotonic() - cancel_started < 0.5
        assert cancelled["status"] == "cancelled"
        assert left.wait(1.0)

    deadline = time.monotonic() + 1.0
    while submission_slot.releases < 1 and time.monotonic() < deadline:
        time.sleep(0.01)
    assert submission_slot.acquires == 1
    assert submission_slot.releases == 1
    assert render_executor.submissions == []
    assert route.nup_jobs[job_id]["status"] == "cancelled"


def _make_die_source_pages(path: Path, page_count: int) -> None:
    """Nguồn khuôn N trang (mỗi trang một khuôn vuông có cửa sổ) — cho S&R nhiều mẫu."""

    size = DIE_MM * MM
    lo = HOLE_LO_MM * MM
    hi = HOLE_HI_MM * MM
    outer = f"0 0 m {size} 0 l {size} {size} l 0 {size} l h "
    hole = f"{lo} {lo} m {lo} {hi} l {hi} {hi} l {hi} {lo} l h "
    pdf = pikepdf.Pdf.new()
    for _ in range(page_count):
        pdf.add_blank_page(page_size=(size, size))
        page = pdf.pages[-1]
        page.contents_add(
            pikepdf.Stream(
                pdf,
                (
                    f"q 0 0 0 rg 0 0 {size} {size} re f Q\n"
                    f"q 0 1 0 0 K 0.5 w {outer}{hole}S Q\n"
                ).encode("ascii"),
            )
        )
    pdf.save(str(path))
    pdf.close()


def test_step_repeat_handoff_moi_mau_tai_dung(tmp_path, _env, monkeypatch):
    """§B10-4: S&R 2 mẫu — preview solve 2 phiên, launch gắn LIST ref, export tái dùng cả 2.

    Đây là bất biến parity của S&R: process con (RAM rỗng) render từ manifest đã công bố cho
    TỪNG mẫu, không solve lại — nếu không, ngân sách autofill nhỏ có thể cho pose khác preview.
    """

    from app.core.nesting_preview_session import (
        SESSION_REFERENCE_SETTING,
        get_preview_session_store,
        reset_preview_session_store,
    )
    from app.workers.nup_true_shape_nesting import (
        attach_preview_session_reference,
        build_true_shape_nesting_jobs,
        run_true_shape_nesting,
    )

    source = tmp_path / "khuon-2mau.pdf"
    _make_die_source_pages(source, 2)

    sr_settings = _settings(
        taskMode="step_repeat",
        targetQuantitiesByPage={"0": 6, "1": 6},
        detectedShapesByPage={"0": "CUSTOM", "1": "CUSTOM"},
    )

    # Preview: solve từng mẫu ⇒ tạo hai phiên trong kho.
    jobs = build_true_shape_nesting_jobs(str(source), sr_settings, job_id="sr-prev")
    assert len(jobs) == 2
    store = get_preview_session_store()
    for job in jobs:
        store.get_or_solve(job)

    # Launch: gắn danh sách tham chiếu (một mỗi mẫu, đúng thứ tự).
    export_settings = dict(sr_settings)
    attach_preview_session_reference(export_settings, str(source), job_id="sr-prev")
    refs = export_settings.get(SESSION_REFERENCE_SETTING)
    assert isinstance(refs, list) and len(refs) == 2

    # Export (mô phỏng process con): RAM rỗng ⇒ chỉ được render từ manifest, KHÔNG solve lại.
    reset_preview_session_store()
    calls = _count_real_solves(monkeypatch)
    output = tmp_path / "sr-handoff.pdf"
    run_true_shape_nesting(str(source), str(output), export_settings, job_id="sr-child")

    assert calls == [], "export S&R phải render manifest preview, KHÔNG solve lại"
    assert output.is_file()
    with pikepdf.open(str(output)) as out:
        page_count = len(out.pages)
    assert page_count >= len(jobs), "mỗi mẫu phải góp ít nhất một trang"
    assert page_count % len(jobs) == 0, "số trang phải chia đều theo số mẫu"
