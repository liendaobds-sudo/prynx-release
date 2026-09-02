"""Phiên nesting dùng chung giữa preview và export.

NEST (audit 2026-08-28 §A4b-5) — phương án (c) cho finding A4b-4a.

Bất biến cần khoá:

1. **Cùng đầu vào ⇒ một lượt solve.** Đây là toàn bộ lý do tồn tại của kho phiên;
   nếu solve hai lần thì tờ bình khác con số preview vì mỗi `pin_pdf_path` sinh
   locator mới ⇒ khác `layoutFingerprint`.
2. **Đổi bất kỳ thứ ảnh hưởng layout ⇒ phiên khác.** Khoá bỏ sót một field nào là
   phục vụ layout CŨ cho thiết lập MỚI — sai âm thầm, tệ hơn cả solve lại.
3. **Loại phiên phải thu hồi snapshot.** `solve_production_nesting_job` chỉ dọn pin
   ở nhánh lỗi; solve thành công thì phiên giữ pin sống, nên ai giữ phải tự dọn.
4. **Trần theo RAM**, đúng quy tắc dự án: chỉ máy yếu mới giảm.
"""

from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

import pytest

from app.core.nesting_quality_gate import (
    QUALITY_GATE_PROOF_FIELD,
    build_quality_gate_decision_proof,
)
from app.core.nesting_preview_session import (
    NestingPreviewSessionStore,
    commit_and_reference,
    job_identity_key,
    preview_session_capacity_for_ram,
    session_capacity,
    session_sheet_count,
    step_repeat_subscriber_id,
)


# ── Test double: phiên và solver giả, không chạm engine ───────────────────────

@dataclass
class _FakePin:
    name: str


@dataclass
class _FakeSolved:
    manifest: dict


@dataclass
class _FakeSession:
    """Đủ hình dạng mà kho phiên đọc: `.solved.manifest` và `.source_pins`."""

    tag: int
    solved: _FakeSolved
    source_pins: tuple = ()
    manifest_id: str | None = None
    layout_fingerprint: str | None = None


@dataclass
class _FakeGap:
    x_mm: float = 0.0
    y_mm: float = 0.0


@dataclass
class _FakeBounds:
    min_x_mm: float
    min_y_mm: float
    max_x_mm: float
    max_y_mm: float


@dataclass
class _FakeZone:
    part_id: str
    bounds: _FakeBounds


@dataclass
class _FakePart:
    part_id: str
    source_path: str
    page_index: int = 0
    quantity: int | None = 6
    back_page_index: int | None = None
    detected_shape: Any = None


def _spec(name: str):
    """Instance mặc định của một spec render, lấy từ module thật."""

    from app.core import nesting_imposition_bundle

    return getattr(nesting_imposition_bundle, name)()


@dataclass
class _FakeJob:
    """Cùng bề mặt field với `ProductionNestingJobInput` ở phần khoá đọc tới."""

    parts: tuple
    tool: str = "sticker_imposer"
    layout_intent: str = "quantity_fulfillment"
    sheet_width_mm: float = 320.0
    sheet_height_mm: float = 230.0
    margin_mm: dict = field(
        default_factory=lambda: {"left": 5.0, "right": 5.0, "top": 5.0, "bottom": 5.0}
    )
    max_sheets: int = 4
    seed: int = 0
    profile: str = "balanced"
    time_budget_ms: int | None = None
    grouping_intent: str = "free_gang"
    placement_zones: tuple = ()
    part_gap: _FakeGap = field(default_factory=lambda: _FakeGap(2.0, 3.0))
    sheet_edge_gap: _FakeGap = field(default_factory=_FakeGap)
    obstacle_gap: _FakeGap | None = None
    fixed_obstacles: tuple = ()
    duplex_mode: str = "simplex"
    flip_edge: str = "none"
    duplex_registration: bool = False
    # FIX (audit 2026-08-29 §NEST-AUD-06): năm spec gia công/render nay nằm trong khoá phiên.
    # Dùng CHÍNH kiểu thật, không phải stub: fake này tự khai "cùng bề mặt field với
    # ProductionNestingJobInput ở phần khoá đọc tới", nên để nó lệch là làm mất hiệu lực mọi
    # test khoá bên dưới.
    trim: Any = field(default_factory=lambda: _spec("ImpositionTrimSpec"))
    pont: Any = field(default_factory=lambda: _spec("ImpositionPontSpec"))
    cut: Any = field(default_factory=lambda: _spec("ImpositionCutSpec"))
    cut_style: Any = field(default_factory=lambda: _spec("ImpositionCutStyleSpec"))
    artifact_options: Any = field(
        default_factory=lambda: _spec("ImpositionArtifactOptions")
    )
    manifest_id: str = "0" * 32
    request_revision: int = 1


@pytest.fixture
def source(tmp_path: Path) -> Path:
    path = tmp_path / "nguon.pdf"
    path.write_bytes(b"%PDF-1.7\n%%EOF\n")
    return path


@pytest.fixture
def job(source: Path) -> _FakeJob:
    return _FakeJob(parts=(_FakePart(part_id="tem", source_path=str(source)),))


class _CountingSolver:
    """Đếm số lượt solve thật và trả phiên mới mỗi lượt."""

    def __init__(self) -> None:
        self.calls = 0

    def __call__(self, job, **kwargs) -> _FakeSession:
        self.calls += 1
        manifest_id = f"{self.calls:032x}"
        layout_fingerprint = f"sha256:{self.calls:064x}"
        return _FakeSession(
            tag=self.calls,
            solved=_FakeSolved(
                manifest={
                    "manifestId": manifest_id,
                    "stats": {"placedCount": 10 + self.calls, "sheetCount": 2},
                }
            ),
            source_pins=(_FakePin(f"pin-{self.calls}"),),
            manifest_id=manifest_id,
            layout_fingerprint=layout_fingerprint,
        )


class _ConcurrentSolver:
    """Giữ lượt đầu đủ lâu để lượt thứ hai chắc chắn đụng cùng cache miss."""

    def __init__(self, *, fail: bool = False) -> None:
        self.calls = 0
        self.fail = fail
        self.first_started = threading.Event()
        self.second_solver_call = threading.Event()
        self._lock = threading.Lock()

    def __call__(self, job, **kwargs) -> _FakeSession:
        with self._lock:
            self.calls += 1
            call_number = self.calls

        if call_number == 1:
            self.first_started.set()
            # Bản cũ gọi solver lần hai và đánh thức ngay. Với singleflight, lượt
            # đầu tự nhả sau timeout ngắn để caller đang chờ nhận kết quả.
            self.second_solver_call.wait(timeout=0.5)
        else:
            self.second_solver_call.set()

        if self.fail:
            raise RuntimeError("solver cố ý lỗi")
        return _FakeSession(
            tag=call_number,
            solved=_FakeSolved(
                manifest={"stats": {"placedCount": 20, "sheetCount": 1}}
            ),
            source_pins=(_FakePin(f"concurrent-pin-{call_number}"),),
        )


class _GatedCompletedEvent:
    """Event test cho phép giữ waiter sau lúc publisher đã gọi ``set()``."""

    def __init__(self) -> None:
        self._completed = threading.Event()
        self.waiting = threading.Event()
        self.release = threading.Event()
        self.wait_timeout: float | None = -1.0

    def is_set(self) -> bool:
        return self._completed.is_set()

    def set(self) -> None:
        self._completed.set()

    def wait(self, timeout: float | None = None) -> bool:
        self.wait_timeout = timeout
        self.waiting.set()
        if not self._completed.wait(timeout):
            return False
        return self.release.wait(timeout)


def _store(solver, *, capacity: int = 4):
    discarded: list[_FakePin] = []
    store = NestingPreviewSessionStore(
        capacity=capacity,
        solver=solver,
        pin_discarder=discarded.append,
    )
    return store, discarded


@dataclass
class _FakeResolvedSource:
    locator_id: str
    content_hash: str
    path: Path


@dataclass
class _FakeProductionRequest:
    engine_request: dict
    render_bundle: dict
    render_bundle_hash: str
    input_hash: str
    solver_config_hash: str
    geometry_constraints_hash: str
    layout_fingerprint: str
    algorithm_versions: dict
    native_build_identity: str


@dataclass
class _FakeStoredManifest:
    manifest_id: str
    layout_fingerprint: str
    manifest: dict
    production_request: _FakeProductionRequest
    resolved_sources: dict[str, _FakeResolvedSource]


def _reference_records(jobs: list[_FakeJob], source: Path):
    references: list[dict[str, str]] = []
    stored: list[_FakeStoredManifest] = []
    for index, one_job in enumerate(jobs, start=1):
        manifest_id = f"{index:032x}"
        layout_fingerprint = f"sha256:{index:064x}"
        locator_id = f"locator-{index}"
        content_hash = f"sha256:{index + 100:064x}"
        references.append(
            {
                "manifestId": manifest_id,
                "layoutFingerprint": layout_fingerprint,
            }
        )
        production = _FakeProductionRequest(
            engine_request={},
            render_bundle={
                "parts": [
                    {
                        "partId": one_job.parts[0].part_id,
                        "source": {
                            "locatorId": locator_id,
                            "contentHash": content_hash,
                        },
                    }
                ],
                "sheetFrames": {"cut": [0.0, 0.0, 320.0, 230.0]},
            },
            render_bundle_hash=f"sha256:{index + 200:064x}",
            input_hash=f"sha256:{index + 300:064x}",
            solver_config_hash=f"sha256:{index + 400:064x}",
            geometry_constraints_hash=f"sha256:{index + 500:064x}",
            layout_fingerprint=layout_fingerprint,
            algorithm_versions={"schema": 1},
            native_build_identity="test-native",
        )
        resolved = _FakeResolvedSource(
            locator_id=locator_id,
            content_hash=content_hash,
            path=source,
        )
        stored.append(
            _FakeStoredManifest(
                manifest_id=manifest_id,
                layout_fingerprint=layout_fingerprint,
                manifest={
                    "manifestId": manifest_id,
                    "stats": {"placedCount": 20 + index, "sheetCount": 1},
                    "placements": [],
                },
                production_request=production,
                resolved_sources={locator_id: resolved},
            )
        )
    return references, stored


class _ReferenceLoader:
    def __init__(self) -> None:
        self.calls = 0
        self.received: list[tuple[dict[str, Any], ...]] = []
        self.stored: list[_FakeStoredManifest] = []
        self.error: BaseException | None = None

    def __call__(self, references):
        self.calls += 1
        values = tuple(dict(reference) for reference in references)
        self.received.append(values)
        if self.error is not None:
            raise self.error
        by_identity = {
            (item.manifest_id, item.layout_fingerprint): item
            for item in self.stored
        }
        selected = tuple(
            by_identity[(
                reference.get("manifestId"),
                reference.get("layoutFingerprint"),
            )]
            for reference in values
        )
        return selected


# ── 1. Cùng đầu vào ⇒ một lượt solve ─────────────────────────────────────────

def test_tra_lai_hai_lan_chi_solve_mot_lan(job):
    """Bất biến trung tâm: preview rồi export không được solve hai lần."""

    solver = _CountingSolver()
    store, _ = _store(solver)

    first = store.get_or_solve(job)
    second = store.get_or_solve(job)

    assert solver.calls == 1
    assert first.reused is False
    assert second.reused is True
    assert first.session is second.session, "phải là CÙNG object phiên"


def test_hai_thread_cung_khoa_chi_mot_thread_solve(job):
    """PERF/FIX (audit 2026-08-29): request preview trùng phải singleflight."""

    solver = _ConcurrentSolver()
    store, _ = _store(solver)

    with ThreadPoolExecutor(max_workers=1) as executor:
        owner_future = executor.submit(store.get_or_solve, job)
        assert solver.first_started.wait(timeout=2.0), "owner chưa vào solver"
        follower = store.get_or_solve(job)
        owner = owner_future.result(timeout=2.0)

    assert solver.calls == 1
    assert owner.reused is False
    assert follower.reused is True
    assert owner.session is follower.session
    assert store._inflight == {}, "nhánh thành công phải dọn trạng thái inflight"


def test_session_callback_bao_ve_phien_khoi_lru_va_chay_ngoai_lock(source: Path):
    """Publication chậm không bị wave khác thu hồi pin trước khi commit xong."""

    solver = _CountingSolver()
    store, discarded = _store(solver, capacity=1)
    first = _FakeJob(parts=(_FakePart(part_id="a", source_path=str(source)),))
    second = _FakeJob(parts=(_FakePart(part_id="b", source_path=str(source)),))
    callback_started = threading.Event()
    release_callback = threading.Event()

    def publish_first(session):
        assert store.peek(first) is session, "callback phải re-enter store không deadlock"
        callback_started.set()
        assert release_callback.wait(timeout=2.0)
        assert store.peek(first) is session, "key protected không được LRU loại giữa commit"

    with ThreadPoolExecutor(max_workers=1) as executor:
        publishing = executor.submit(
            store.get_or_solve, first, session_callback=publish_first
        )
        assert callback_started.wait(timeout=2.0)
        store.get_or_solve(second)
        assert len(store) == 1, "kho vẫn phải giữ cap khi còn key khác để loại"
        assert store.peek(first) is not None
        assert store.peek(second) is None
        assert [pin.name for pin in discarded] == ["pin-2"]
        release_callback.set()
        publishing.result(timeout=2.0)

    assert len(store) == 1
    assert store.peek(first) is not None
    assert store.peek(second) is None
    assert [pin.name for pin in discarded] == ["pin-2"]


def test_session_callback_loi_van_tha_bao_ve_lru(job):
    solver = _CountingSolver()
    store, _discarded = _store(solver, capacity=1)

    with pytest.raises(OSError, match="commit lỗi"):
        store.get_or_solve(
            job,
            session_callback=lambda _session: (_ for _ in ()).throw(
                OSError("commit lỗi")
            ),
        )

    assert store._protected_keys == {}
    assert len(store) == 1


def test_huy_subscriber_cha_tach_moi_lane_sr(job):
    solver = _ConcurrentSolver()
    store, _discarded = _store(solver)
    child = step_repeat_subscriber_id("preview-cha", 3)
    assert child is not None

    with ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(store.get_or_solve, job, subscriber_id=child)
        assert solver.first_started.wait(timeout=2.0)
        assert store.cancel_subscriber("preview-cha") is True
        with pytest.raises(InterruptedError):
            future.result(timeout=2.0)


def test_handoff_cho_batch_reference_thay_vi_gom_session_qua_lru(source: Path):
    """Bấm Bình giữa preview wave phải nhận đủ ordered reference sau publication."""

    store, _discarded = _store(_CountingSolver(), capacity=1)
    jobs = [
        _FakeJob(parts=(_FakePart(part_id=f"tem-{index}", source_path=str(source)),))
        for index in range(3)
    ]
    state = store.begin_reference_batch(jobs)
    references = [
        {
            "manifestId": f"{index:032x}",
            "layoutFingerprint": f"sha256:{index:064x}",
        }
        for index in range(3)
    ]

    with ThreadPoolExecutor(max_workers=1) as executor:
        handoff = executor.submit(
            store.peek_reference_batch_or_wait, jobs, timeout=2.0
        )
        assert not handoff.done(), "handoff phải chờ batch thay vì coi là cache miss"
        store.finish_reference_batch(jobs, state, references=references)
        assert handoff.result(timeout=2.0) == references


def test_warm_batch_13_mau_khong_solve_lai_khi_capacity_7(source: Path):
    """PERF-NEST-10: spill khỏi LRU được rehydrate trong wave, không tăng cap."""

    solver = _CountingSolver()
    loader = _ReferenceLoader()
    discarded: list[_FakePin] = []
    store = NestingPreviewSessionStore(
        capacity=7,
        solver=solver,
        pin_discarder=discarded.append,
        reference_loader=loader,
    )
    jobs = [
        _FakeJob(parts=(_FakePart(part_id=f"tem-{index}", source_path=str(source)),))
        for index in range(13)
    ]
    references, loader.stored = _reference_records(jobs, source)

    cold = store.begin_reference_batch(jobs)
    cold_lookups = [store.get_or_solve(one_job) for one_job in jobs]
    store.finish_reference_batch(jobs, cold, references=references)

    assert solver.calls == 13
    assert all(not lookup.reused for lookup in cold_lookups)
    assert len(store) == 7

    warm = store.begin_reference_batch(jobs)
    warm_lookups = [store.get_or_solve(one_job) for one_job in jobs]

    assert loader.calls == 1
    assert len(loader.received) == 1
    assert len(loader.received[0]) == 6, (
        "load_many chỉ được nhận sáu mẫu đã spill; bảy session nóng không cần "
        "full-validate lại"
    )
    assert [
        reference["manifestId"] for reference in loader.received[0]
    ] == [f"{index:032x}" for index in range(1, 7)]
    assert solver.calls == 13, "lượt warm không được solve lại sáu mẫu đã spill"
    assert all(lookup.reused for lookup in warm_lookups)
    assert len(store) == 7, "rehydrate không được lách capacity session nóng"
    detached = warm_lookups[0].session
    assert all(
        not hasattr(binding, "lease_token") for binding in detached.source_pins
    ), "session tạm không được nhận ownership lease token"
    assert warm.restored_sessions is not None

    store.finish_reference_batch(jobs, warm, references=references)

    assert warm.restored_sessions is None
    assert warm.key not in store._reference_batch_inflight
    assert store._protected_keys == {}


def test_hot_session_identity_lech_bat_buoc_load_lai_durable_reference(
    source: Path,
):
    """PERF-NEST-10: hot cache lệch identity không được bypass full validation."""

    solver = _CountingSolver()
    loader = _ReferenceLoader()
    store = NestingPreviewSessionStore(
        capacity=1,
        solver=solver,
        pin_discarder=lambda _pin: None,
        reference_loader=loader,
    )
    jobs = [
        _FakeJob(
            parts=(_FakePart(part_id=f"tem-{index}", source_path=str(source)),)
        )
        for index in range(2)
    ]
    references, loader.stored = _reference_records(jobs, source)

    cold = store.begin_reference_batch(jobs)
    store.get_or_solve(jobs[0])
    store.get_or_solve(jobs[1])
    store.finish_reference_batch(jobs, cold, references=references)

    # Với capacity=1, job thứ hai là hot. Làm lệch identity của nó để mô phỏng
    # memory cache bị tamper; đường warm phải nạp lại cả job này từ durable ref.
    hot = store.peek(jobs[1])
    assert hot is not None
    hot.manifest_id = "f" * 32

    warm = store.begin_reference_batch(jobs)

    assert loader.calls == 1
    assert len(loader.received[0]) == 2
    restored = store.get_or_solve(jobs[1])
    assert restored.reused is True
    assert restored.session.manifest_id == references[1]["manifestId"]
    assert warm.restored_sessions is not None

    store.finish_reference_batch(jobs, warm, references=references)


@pytest.mark.parametrize("failure", ["raise", "identity"])
def test_reference_stale_hoac_tamper_fail_soft_sang_solve(
    source: Path, failure: str
):
    solver = _CountingSolver()
    loader = _ReferenceLoader()
    store = NestingPreviewSessionStore(
        capacity=1,
        solver=solver,
        pin_discarder=lambda _pin: None,
        reference_loader=loader,
    )
    jobs = [
        _FakeJob(parts=(_FakePart(part_id=f"tem-{index}", source_path=str(source)),))
        for index in range(2)
    ]
    references, loader.stored = _reference_records(jobs, source)
    cold = store.begin_reference_batch(jobs)
    for one_job in jobs:
        store.get_or_solve(one_job)
    store.finish_reference_batch(jobs, cold, references=references)
    assert store.peek(jobs[0]) is None

    if failure == "raise":
        loader.error = OSError("lease stale")
    else:
        loader.stored[0] = replace(
            loader.stored[0], manifest_id="f" * 32
        )

    warm = store.begin_reference_batch(jobs)
    lookup = store.get_or_solve(jobs[0])

    assert lookup.reused is False
    assert solver.calls == 3
    assert warm.restored_sessions is None
    store.finish_reference_batch(
        jobs, warm, error=RuntimeError("test kết thúc không publication")
    )


def test_source_fingerprint_doi_khong_nap_reference_cu(source: Path):
    solver = _CountingSolver()
    loader = _ReferenceLoader()
    store = NestingPreviewSessionStore(
        capacity=1,
        solver=solver,
        pin_discarder=lambda _pin: None,
        reference_loader=loader,
    )
    jobs = [_FakeJob(parts=(_FakePart(part_id="tem", source_path=str(source)),))]
    references, loader.stored = _reference_records(jobs, source)
    cold = store.begin_reference_batch(jobs)
    store.get_or_solve(jobs[0])
    store.finish_reference_batch(jobs, cold, references=references)

    source.write_bytes(b"%PDF-1.7\n% source revision moi\n%%EOF\n")
    changed = store.begin_reference_batch(jobs)
    lookup = store.get_or_solve(jobs[0])

    assert loader.calls == 0, "batch key mới không được mở reference của source cũ"
    assert lookup.reused is False
    assert solver.calls == 2
    store.finish_reference_batch(
        jobs, changed, error=RuntimeError("test kết thúc không publication")
    )


def test_commit_session_rehydrate_tra_identity_cu_khong_persist(source: Path):
    jobs = [
        _FakeJob(parts=(_FakePart(part_id=f"tem-{index}", source_path=str(source)),))
        for index in range(2)
    ]
    references, stored = _reference_records(jobs, source)
    sessions = NestingPreviewSessionStore._rehydrate_reference_sessions(
        tuple(jobs), tuple(references), tuple(stored)
    )
    detached = sessions[job_identity_key(jobs[0])]

    class _MustNotPersist:
        def persist(self, *_args, **_kwargs):
            raise AssertionError("session rehydrate không được persist lại")

    assert commit_and_reference(detached, store=_MustNotPersist()) == references[0]

    tampered = replace(detached, authoritative_manifest_id="f" * 32)
    with pytest.raises(ValueError, match="Identity session khôi phục"):
        commit_and_reference(tampered, store=_MustNotPersist())


def test_rehydrate_giu_nguyen_pose_f64_cua_manifest(source: Path):
    """PARITY (audit 2026-09-02 §PERF-NEST-10): không lượng tử pose khi nạp lại."""

    jobs = [_FakeJob(parts=(_FakePart(part_id="tem", source_path=str(source)),))]
    references, stored = _reference_records(jobs, source)
    native_y_mm = 31.55139349999998
    stored[0].manifest["placements"] = [
        {
            "instanceId": "tem#0001",
            "partId": "tem",
            "sheetIndex": 0,
            "pose": {
                "rotationDeg": 0.0,
                "translateXmm": 26.546135,
                "translateYmm": native_y_mm,
            },
            "sourceRevision": stored[0].production_request.render_bundle_hash,
        }
    ]

    sessions = NestingPreviewSessionStore._rehydrate_reference_sessions(
        tuple(jobs), tuple(references), tuple(stored)
    )
    rehydrated = sessions[job_identity_key(jobs[0])]

    from app.core.nesting_manifest_store import canonical_json_bytes
    from app.core.nesting_production_adapter import (
        canonical_json_bytes as canonical_production_json_bytes,
    )

    assert rehydrated.solved.manifest_canonical_bytes == canonical_json_bytes(
        stored[0].manifest
    )
    assert rehydrated.solved.manifest_canonical_bytes != canonical_production_json_bytes(
        stored[0].manifest
    ), "canonicalizer production 6 số không được dùng cho placement manifest"
    pose = rehydrated.solved.manifest["placements"][0]["pose"]
    assert pose["translateYmm"] == native_y_mm


def test_hai_publisher_trung_batch_chi_load_reference_mot_lan(source: Path):
    jobs = [_FakeJob(parts=(_FakePart(part_id="tem", source_path=str(source)),))]
    references, stored = _reference_records(jobs, source)
    entered = threading.Event()
    release = threading.Event()
    calls = 0

    def gated_loader(_references):
        nonlocal calls
        calls += 1
        entered.set()
        assert release.wait(timeout=2.0)
        return tuple(stored)

    store = NestingPreviewSessionStore(
        capacity=1,
        solver=_CountingSolver(),
        pin_discarder=lambda _pin: None,
        reference_loader=gated_loader,
    )
    store.remember_reference_batch(jobs, references)

    with ThreadPoolExecutor(max_workers=2) as executor:
        first = executor.submit(store.begin_reference_batch, jobs)
        assert entered.wait(timeout=2.0)
        second = executor.submit(store.begin_reference_batch, jobs)
        assert not second.done(), "publisher sau phải chờ owner xác minh reference"
        release.set()
        first_state = first.result(timeout=2.0)
        second_state = second.result(timeout=2.0)

    assert first_state is second_state
    assert calls == 1
    store.finish_reference_batch(jobs, first_state, references=references)
    store.finish_reference_batch(jobs, second_state, references=references)


def _quality_gate_proof_for_reference() -> dict[str, Any]:
    return build_quality_gate_decision_proof(
        {
            "sheetWidth": 320.0,
            "sheetHeight": 430.0,
            "marginLeft": 5.0,
            "marginRight": 5.0,
            "marginTop": 5.0,
            "marginBottom": 5.0,
            "gapX": 2.0,
            "gapY": 2.0,
            "detectedShapesByPage": {"0": "CUSTOM"},
            "pontType": "none",
        },
        source_locator_id="locator-server-1",
        source_content_hash="sha256:" + "a" * 64,
        input_hash="sha256:" + "b" * 64,
        layout_fingerprint="sha256:" + "c" * 64,
        page_index=0,
        layout_intent="autofill_single_sheet",
        nesting_placed=43,
        nesting_sheets=1,
        total_quantity=0,
        grid_capacity=54,
    )


def test_batch_reference_bao_toan_proof_optional_va_tach_quyen_mutation(source: Path):
    """PERF-NEST-05: proof nhỏ đi cùng ref; legacy hai field vẫn giữ nguyên."""

    store, _discarded = _store(_CountingSolver(), capacity=2)
    jobs = [
        _FakeJob(parts=(_FakePart(part_id=f"tem-{index}", source_path=str(source)),))
        for index in range(2)
    ]
    proof = _quality_gate_proof_for_reference()
    references = [
        {
            "manifestId": "a" * 32,
            "layoutFingerprint": "sha256:" + "c" * 64,
            QUALITY_GATE_PROOF_FIELD: proof,
        },
        {
            "manifestId": "b" * 32,
            "layoutFingerprint": "sha256:" + "d" * 64,
        },
    ]

    store.remember_reference_batch(jobs, references)
    proof["decision"] = "nesting"
    first_read = store.peek_reference_batch(jobs)
    assert first_read is not None
    assert first_read[0][QUALITY_GATE_PROOF_FIELD]["decision"] == "grid"
    assert QUALITY_GATE_PROOF_FIELD not in first_read[1]

    first_read[0][QUALITY_GATE_PROOF_FIELD]["gridCapacity"] = 999
    second_read = store.peek_reference_batch(jobs)
    assert second_read is not None
    assert second_read[0][QUALITY_GATE_PROOF_FIELD]["gridCapacity"] == 54


def test_latch_bao_toan_proof_nhung_bo_proof_meo_de_export_do_lai(source: Path):
    store, _discarded = _store(_CountingSolver(), capacity=1)
    jobs = [_FakeJob(parts=(_FakePart(part_id="tem", source_path=str(source)),))]
    proof = _quality_gate_proof_for_reference()
    proof["decision"] = "nesting"  # trái phép so 54 ≥ 43
    references = [
        {
            "manifestId": "a" * 32,
            "layoutFingerprint": "sha256:" + "c" * 64,
            QUALITY_GATE_PROOF_FIELD: proof,
        }
    ]
    state = store.begin_reference_batch(jobs)

    store.finish_reference_batch(jobs, state, references=references)

    assert store.peek_reference_batch_or_wait(jobs, timeout=0.0) == [
        {
            "manifestId": "a" * 32,
            "layoutFingerprint": "sha256:" + "c" * 64,
        }
    ]


def test_waiter_giu_reference_trong_latch_khi_metadata_bi_lru_day(source: Path):
    """Waiter đã bắt latch không được phụ thuộc cache LRU sau lúc được đánh thức."""

    store, _discarded = _store(_CountingSolver(), capacity=1)
    jobs = [_FakeJob(parts=(_FakePart(part_id="tem-a", source_path=str(source)),))]
    other_jobs = [
        _FakeJob(parts=(_FakePart(part_id="tem-b", source_path=str(source)),))
    ]
    references = [
        {"manifestId": "a" * 32, "layoutFingerprint": "sha256:" + "b" * 64}
    ]
    other_references = [
        {"manifestId": "c" * 32, "layoutFingerprint": "sha256:" + "d" * 64}
    ]
    state = store.begin_reference_batch(jobs)
    gated = _GatedCompletedEvent()
    state.completed = gated

    with ThreadPoolExecutor(max_workers=1) as executor:
        handoff = executor.submit(
            store.peek_reference_batch_or_wait, jobs, timeout=2.0
        )
        assert gated.waiting.wait(timeout=2.0), "handoff chưa bắt latch publication"
        store.finish_reference_batch(jobs, state, references=references)
        store.remember_reference_batch(other_jobs, other_references)
        assert store.peek_reference_batch(jobs) is None
        gated.release.set()
        assert handoff.result(timeout=2.0) == references


def test_late_handoff_van_bat_latch_khi_publisher_trung_con_song(source: Path):
    """Success đầu không được pop latch khi publisher cùng identity còn sống."""

    store, _discarded = _store(_CountingSolver(), capacity=1)
    jobs = [_FakeJob(parts=(_FakePart(part_id="tem-a", source_path=str(source)),))]
    other_jobs = [
        _FakeJob(parts=(_FakePart(part_id="tem-b", source_path=str(source)),))
    ]
    references = [
        {"manifestId": "a" * 32, "layoutFingerprint": "sha256:" + "b" * 64}
    ]
    other_references = [
        {"manifestId": "c" * 32, "layoutFingerprint": "sha256:" + "d" * 64}
    ]
    first = store.begin_reference_batch(jobs)
    second = store.begin_reference_batch(jobs)
    assert second is first

    store.finish_reference_batch(jobs, first, references=references)
    store.remember_reference_batch(other_jobs, other_references)
    assert store.peek_reference_batch(jobs) is None
    assert store.peek_reference_batch_or_wait(jobs, timeout=0.0) == references

    store.finish_reference_batch(jobs, second, error=RuntimeError("publisher B lỗi"))
    assert store.peek_reference_batch(jobs) == references


def test_finish_batch_dung_identity_luc_begin_khi_source_doi(source: Path):
    """Source đổi giữa wave không được làm rơi Event của handoff đã bắt latch cũ."""

    store, _discarded = _store(_CountingSolver(), capacity=1)
    jobs = [_FakeJob(parts=(_FakePart(part_id="tem", source_path=str(source)),))]
    references = [
        {"manifestId": "a" * 32, "layoutFingerprint": "sha256:" + "b" * 64}
    ]
    state = store.begin_reference_batch(jobs)
    gated = _GatedCompletedEvent()
    state.completed = gated

    with ThreadPoolExecutor(max_workers=1) as executor:
        handoff = executor.submit(store.peek_reference_batch_or_wait, jobs)
        assert gated.waiting.wait(timeout=2.0), "handoff chưa bắt latch cũ"
        assert 0 < float(gated.wait_timeout or 0) <= 0.1
        source.write_bytes(b"%PDF-1.7\n% revision moi\n%%EOF\n")
        store.finish_reference_batch(jobs, state, references=references)
        gated.release.set()
        assert handoff.result(timeout=2.0) == references

    # Job mang revision mới không được thấy reference của source cũ.
    assert store.peek_reference_batch(jobs) is None


def test_huy_handoff_batch_thuc_waiter_nhung_khong_huy_publisher(source: Path):
    """PERF-NEST-03: cancel job không được giữ thread chờ hoặc phá preview owner."""

    store, _discarded = _store(_CountingSolver(), capacity=1)
    jobs = [_FakeJob(parts=(_FakePart(part_id="tem", source_path=str(source)),))]
    references = [
        {"manifestId": "a" * 32, "layoutFingerprint": "sha256:" + "b" * 64}
    ]
    state = store.begin_reference_batch(jobs)
    gated = _GatedCompletedEvent()
    state.completed = gated
    cancelled = threading.Event()

    with ThreadPoolExecutor(max_workers=1) as executor:
        handoff = executor.submit(
            store.peek_reference_batch_or_wait,
            jobs,
            cancel_check=cancelled,
        )
        assert gated.waiting.wait(timeout=2.0)
        cancelled.set()
        with pytest.raises(InterruptedError):
            handoff.result(timeout=1.0)

    store.finish_reference_batch(jobs, state, references=references)
    assert store.peek_reference_batch(jobs) == references


def test_batch_reference_loi_danh_thuc_handoff_va_luot_sau_retry_duoc(source: Path):
    store, _discarded = _store(_CountingSolver(), capacity=1)
    jobs = [_FakeJob(parts=(_FakePart(part_id="tem", source_path=str(source)),))]
    failed = store.begin_reference_batch(jobs)

    with ThreadPoolExecutor(max_workers=1) as executor:
        handoff = executor.submit(
            store.peek_reference_batch_or_wait, jobs, timeout=2.0
        )
        store.finish_reference_batch(
            jobs, failed, error=OSError("publication lỗi")
        )
        assert handoff.result(timeout=2.0) is None

    retry = store.begin_reference_batch(jobs)
    references = [
        {"manifestId": "a" * 32, "layoutFingerprint": "sha256:" + "b" * 64}
    ]
    store.finish_reference_batch(jobs, retry, references=references)
    assert store.peek_reference_batch_or_wait(jobs, timeout=0.0) == references


def test_handoff_cho_preview_dang_solve_thay_vi_bao_cache_miss(job):
    """Bấm Bình giữa cold preview vẫn phải lấy session owner, không solve/export kép."""

    solver = _ConcurrentSolver()
    store, _ = _store(solver)

    with ThreadPoolExecutor(max_workers=1) as executor:
        owner_future = executor.submit(store.get_or_solve, job)
        assert solver.first_started.wait(timeout=2.0), "owner chưa vào solver"
        handoff_session = store.peek_or_wait(job)
        owner = owner_future.result(timeout=2.0)

    assert solver.calls == 1
    assert handoff_session is owner.session
    assert store.peek(job) is owner.session


def test_singleflight_loi_danh_thuc_moi_thread_va_cho_phep_thu_lai(job):
    """Lỗi owner phải tới mọi waiter và không để lại inflight bị kẹt."""

    solver = _ConcurrentSolver(fail=True)
    store, _ = _store(solver)

    with ThreadPoolExecutor(max_workers=1) as executor:
        owner_future = executor.submit(store.get_or_solve, job)
        assert solver.first_started.wait(timeout=2.0), "owner chưa vào solver"
        with pytest.raises(RuntimeError, match="solver cố ý lỗi"):
            store.get_or_solve(job)
        with pytest.raises(RuntimeError, match="solver cố ý lỗi"):
            owner_future.result(timeout=2.0)

    assert solver.calls == 1
    assert len(store) == 0
    assert store._inflight == {}, "nhánh lỗi phải dọn trạng thái inflight"

    solver.fail = False
    retry = store.get_or_solve(job)
    reused = store.get_or_solve(job)

    assert solver.calls == 2, "lỗi cũ phải được dọn để lượt sau solve lại"
    assert retry.reused is False
    assert reused.reused is True
    assert retry.session is reused.session


def test_job_dung_bang_gia_tri_van_hit(source: Path):
    """Hai object job khác nhau nhưng cùng giá trị phải dùng chung phiên.

    Preview và export dựng job ở hai chỗ khác nhau nên không bao giờ là cùng object.
    """

    solver = _CountingSolver()
    store, _ = _store(solver)

    first = _FakeJob(parts=(_FakePart(part_id="tem", source_path=str(source)),))
    second = _FakeJob(parts=(_FakePart(part_id="tem", source_path=str(source)),))

    store.get_or_solve(first)
    lookup = store.get_or_solve(second)

    assert solver.calls == 1
    assert lookup.reused is True


def test_manifest_id_khong_vao_khoa(job):
    """Đổi `manifest_id` không đổi bài toán ⇒ vẫn phải hit."""

    solver = _CountingSolver()
    store, _ = _store(solver)

    store.get_or_solve(job)
    lookup = store.get_or_solve(replace(job, manifest_id="f" * 32))

    assert solver.calls == 1
    assert lookup.reused is True


def test_peek_khong_solve(job):
    solver = _CountingSolver()
    store, _ = _store(solver)

    assert store.peek(job) is None
    assert solver.calls == 0

    store.get_or_solve(job)
    assert store.peek(job) is not None
    assert solver.calls == 1


# ── 2. Đổi thiết lập ⇒ phiên khác ────────────────────────────────────────────

@pytest.mark.parametrize(
    "changes",
    [
        {"sheet_width_mm": 450.0},
        {"sheet_height_mm": 320.0},
        {"max_sheets": 9},
        {"seed": 7},
        {"profile": "tight"},
        {"time_budget_ms": 5000},
        {"grouping_intent": "maximize_area"},
        {"tool": "cnc_imposer"},
        {"layout_intent": "autofill_single_sheet"},
        {"duplex_mode": "duplex"},
        {"flip_edge": "long"},
        {"duplex_registration": True},
        {"part_gap": _FakeGap(4.0, 3.0)},
        {"part_gap": _FakeGap(2.0, 9.0)},
        {"sheet_edge_gap": _FakeGap(1.0, 1.0)},
        {"obstacle_gap": _FakeGap(1.0, 2.0)},
        {"margin_mm": {"left": 9.0, "right": 5.0, "top": 5.0, "bottom": 5.0}},
        {"fixed_obstacles": ({"id": "boong", "kind": "Gripper"},)},
    ],
)
def test_moi_field_anh_huong_layout_deu_doi_khoa(job, changes):
    """Bỏ sót một field là phục vụ layout CŨ cho thiết lập MỚI."""

    assert job_identity_key(job) != job_identity_key(replace(job, **changes))


@pytest.mark.parametrize(
    "part_changes",
    [
        {"page_index": 2},
        {"quantity": 12},
        {"quantity": None},
        {"back_page_index": 1},
        {"part_id": "khac"},
    ],
)
def test_doi_mau_thi_doi_khoa(job, part_changes):
    changed = replace(job, parts=(replace(job.parts[0], **part_changes),))

    assert job_identity_key(job) != job_identity_key(changed)


def test_doi_noi_dung_file_nguon_thi_doi_khoa(job, source: Path):
    """Hàng rào tươi mới: sửa file nguồn phải làm phiên cũ hết giá trị.

    Dùng đúng `SourceFingerprint` mà `_launch_impose_job` đang dùng cho mọi job
    N-Up, nên độ tin cậy bằng hàng rào revision hiện hành, không yếu hơn.
    """

    before = job_identity_key(job)
    source.write_bytes(b"%PDF-1.7\n% da sua\n%%EOF\n")

    assert job_identity_key(job) != before


def test_them_mau_thi_doi_khoa(job, source: Path):
    changed = replace(
        job,
        parts=(
            job.parts[0],
            _FakePart(part_id="tem-2", source_path=str(source), page_index=1),
        ),
    )

    assert job_identity_key(job) != job_identity_key(changed)


def test_thu_tu_lang_trong_margin_khong_doi_khoa(job):
    """Lề là map: thứ tự khoá không được làm cache miss."""

    reordered = replace(
        job,
        margin_mm={"bottom": 5.0, "top": 5.0, "right": 5.0, "left": 5.0},
    )

    assert job_identity_key(job) == job_identity_key(reordered)


def test_placement_zone_vao_khoa_theo_association_bat_ke_thu_tu(job):
    top = _FakeZone("tem", _FakeBounds(5.0, 115.0, 315.0, 225.0))
    bottom = _FakeZone("tem-2", _FakeBounds(5.0, 5.0, 315.0, 115.0))
    grouped = replace(
        job,
        grouping_intent="maximize_area",
        placement_zones=(top, bottom),
    )
    reordered = replace(grouped, placement_zones=(bottom, top))
    assert job_identity_key(grouped) == job_identity_key(reordered)

    moved = replace(
        grouped,
        placement_zones=(
            replace(top, bounds=replace(top.bounds, min_y_mm=114.0)),
            bottom,
        ),
    )
    assert job_identity_key(grouped) != job_identity_key(moved)

    reassociated = replace(
        grouped,
        placement_zones=(
            replace(top, part_id="tem-2"),
            replace(bottom, part_id="tem"),
        ),
    )
    assert job_identity_key(grouped) != job_identity_key(reassociated)


# ── 3. Loại phiên phải thu hồi snapshot ──────────────────────────────────────

def test_vuot_tran_thi_loai_phien_cu_nhat_va_thu_hoi_pin(source: Path):
    solver = _CountingSolver()
    store, discarded = _store(solver, capacity=2)

    jobs = [
        _FakeJob(parts=(_FakePart(part_id=f"tem-{i}", source_path=str(source)),))
        for i in range(3)
    ]
    for one in jobs:
        store.get_or_solve(one)

    assert len(store) == 2
    assert [pin.name for pin in discarded] == ["pin-1"], "phiên cũ nhất bị loại"
    # Phiên vừa loại phải solve lại nếu quay lại; hai phiên còn lại vẫn hit.
    assert store.peek(jobs[0]) is None
    assert store.peek(jobs[1]) is not None
    assert store.peek(jobs[2]) is not None


def test_tra_lai_phien_lam_no_moi_hon_trong_lru(source: Path):
    solver = _CountingSolver()
    store, discarded = _store(solver, capacity=2)

    first = _FakeJob(parts=(_FakePart(part_id="a", source_path=str(source)),))
    second = _FakeJob(parts=(_FakePart(part_id="b", source_path=str(source)),))
    third = _FakeJob(parts=(_FakePart(part_id="c", source_path=str(source)),))

    store.get_or_solve(first)
    store.get_or_solve(second)
    store.get_or_solve(first)  # first thành mới nhất
    store.get_or_solve(third)

    assert [pin.name for pin in discarded] == ["pin-2"], "second mới là cũ nhất"
    assert store.peek(first) is not None


def test_invalidate_thu_hoi_pin(job):
    solver = _CountingSolver()
    store, discarded = _store(solver)

    store.get_or_solve(job)
    assert store.invalidate(job) is True
    assert [pin.name for pin in discarded] == ["pin-1"]
    assert store.invalidate(job) is False, "bỏ lần hai không có gì để bỏ"


def test_clear_thu_hoi_moi_pin(source: Path):
    solver = _CountingSolver()
    store, discarded = _store(solver)

    for index in range(3):
        store.get_or_solve(
            _FakeJob(parts=(_FakePart(part_id=f"t{index}", source_path=str(source)),))
        )
    store.clear()

    assert len(store) == 0
    assert sorted(pin.name for pin in discarded) == ["pin-1", "pin-2", "pin-3"]


def test_loi_thu_hoi_pin_khong_lam_vo_kho(job):
    """Dọn dẹp là best-effort: pin lỗi không được làm sập luồng bình."""

    def _boom(_pin):
        raise OSError("khong xoa duoc")

    store = NestingPreviewSessionStore(
        capacity=1, solver=_CountingSolver(), pin_discarder=_boom
    )
    store.get_or_solve(job)
    store.clear()

    assert len(store) == 0


# ── 4. Trần theo RAM ─────────────────────────────────────────────────────────

@pytest.mark.parametrize(
    "total_mb,expected",
    [
        (None, 2),
        (0, 2),
        (4 * 1024, 1),
        (8 * 1024, 3),
        (12 * 1024, 3),
        (16 * 1024, 6),
        (32 * 1024, 8),
        (64 * 1024, 16),
    ],
)
def test_tran_phien_gate_theo_ram(total_mb, expected):
    """Máy yếu mới giảm; máy ≥16GB tăng theo RAM, không trần cố định."""

    assert preview_session_capacity_for_ram(total_mb) == expected


def test_tran_khong_duoi_1():
    with pytest.raises(ValueError, match="capacity"):
        NestingPreviewSessionStore(capacity=0, solver=_CountingSolver())


# ── 5. Đọc số cho cột Tem/tờ ─────────────────────────────────────────────────

def test_doc_so_mau_va_so_to_tu_phien(job):
    solver = _CountingSolver()
    store, _ = _store(solver)

    session = store.get_or_solve(job).session

    assert session_capacity(session) == 11
    assert session_sheet_count(session) == 2


def test_manifest_thieu_stats_thi_doc_ve_0():
    session = _FakeSession(tag=0, solved=_FakeSolved(manifest={}))

    assert session_capacity(session) == 0
    assert session_sheet_count(session) == 0


# ─────────────────────────────────────────────────────────────────────────────
#  Khoá phiên phải phủ spec gia công — §NEST-AUD-06
# ─────────────────────────────────────────────────────────────────────────────
#
# `trim/pont/cut/cut_style` và `export_unique_sheets` đổi vật cản/nội dung nền/cấu trúc
# trang nên phải nằm trong khóa. Report là ngoại lệ có chủ đích: writer đóng overlay
# canonical mới nhất lên đúng placements preview và cấp fingerprint artifact riêng.
#
# Trước lô §NEST-PREVIEW-1 điều này còn tiềm ẩn vì chưa ai tạo phiên từ preview. Từ khi
# preview tạo phiên, nó thành lỗi thật — nên nhóm test này là chốt chặn bắt buộc.


def _bundle_mod():
    from app.core import nesting_imposition_bundle

    return nesting_imposition_bundle


def test_doi_oc_be_thi_khoa_phien_phai_doi(job: _FakeJob) -> None:
    mod = _bundle_mod()
    khong_oc = job_identity_key(job)

    co_oc = job_identity_key(
        replace(
            job,
            pont=mod.ImpositionPontSpec(
                type="corner",
                config=mod.ImpositionPontConfigSpec(
                    shape="circle",
                    size_mm=5.0,
                    thickness_mm=0.5,
                    is_graphtec=False,
                    layer_info_name="",
                    layer_name="Pont",
                    group_name="G",
                    item_name="MKLINE",
                    disable_collision=False,
                    margin_top_mm=7.0,
                    margin_bottom_mm=7.0,
                    margin_left_mm=7.0,
                    margin_right_mm=7.0,
                ),
            ),
        )
    )

    assert khong_oc != co_oc


def test_doi_mot_field_ben_trong_cau_hinh_oc_cung_doi_khoa(job: _FakeJob) -> None:
    """Khoá phải đệ quy vào dataclass lồng nhau, không chỉ so kiểu ngoài cùng."""

    mod = _bundle_mod()

    def voi_size(size_mm: float):
        return replace(
            job,
            pont=mod.ImpositionPontSpec(
                type="corner",
                config=mod.ImpositionPontConfigSpec(
                    shape="circle",
                    size_mm=size_mm,
                    thickness_mm=0.5,
                    is_graphtec=False,
                    layer_info_name="",
                    layer_name="Pont",
                    group_name="G",
                    item_name="MKLINE",
                    disable_collision=False,
                    margin_top_mm=7.0,
                    margin_bottom_mm=7.0,
                    margin_left_mm=7.0,
                    margin_right_mm=7.0,
                ),
            ),
        )

    assert job_identity_key(voi_size(5.0)) != job_identity_key(voi_size(6.0))


def test_doi_report_khong_doi_khoa_layout(job: _FakeJob) -> None:
    mod = _bundle_mod()
    tat = job_identity_key(job)

    bat = job_identity_key(
        replace(
            job,
            artifact_options=mod.ImpositionArtifactOptions(
                export_unique_sheets=True,
                report=mod.ImpositionReportEnabled(fields=("sheetCount",)),
            ),
        )
    )

    assert tat == bat


def test_doi_vi_tri_report_khong_doi_khoa_layout(job: _FakeJob) -> None:
    """Vị trí report là overlay sau solve nên không được làm miss phiên preview."""

    mod = _bundle_mod()

    def o_vi_tri(position: str):
        return replace(
            job,
            artifact_options=mod.ImpositionArtifactOptions(
                export_unique_sheets=True,
                report=mod.ImpositionReportEnabled(
                    fields=("sheetCount",),
                    placement=mod.ImpositionReportPlacement(position=position),
                ),
            ),
        )

    assert job_identity_key(o_vi_tri("top")) == job_identity_key(o_vi_tri("bottom"))


def test_doi_cau_truc_export_van_doi_khoa_layout(job: _FakeJob) -> None:
    """Dedup tờ đổi số trang artifact nên vẫn phải tách phiên."""

    mod = _bundle_mod()
    unique = replace(
        job,
        artifact_options=mod.ImpositionArtifactOptions(export_unique_sheets=True),
    )
    full = replace(
        job,
        artifact_options=mod.ImpositionArtifactOptions(export_unique_sheets=False),
    )

    assert job_identity_key(unique) != job_identity_key(full)


def test_doi_trang_cut_rieng_thi_khoa_phien_phai_doi(job: _FakeJob) -> None:
    mod = _bundle_mod()

    tach = job_identity_key(replace(job, cut=mod.ImpositionCutSpec(separate_page=True)))
    khong_tach = job_identity_key(
        replace(job, cut=mod.ImpositionCutSpec(separate_page=False))
    )

    assert tach != khong_tach


def test_doi_kieu_net_be_thi_khoa_phien_phai_doi(job: _FakeJob) -> None:
    mod = _bundle_mod()
    goc = job_identity_key(job)

    day_hon = job_identity_key(
        replace(
            job,
            cut_style=mod.ImpositionCutStyleSpec(
                stroke=mod.ImpositionCutStrokeSpec(width_mm=0.5)
            ),
        )
    )

    assert goc != day_hon


def test_doi_dau_xen_thi_khoa_phien_phai_doi(job: _FakeJob) -> None:
    mod = _bundle_mod()
    khong = job_identity_key(job)

    co = job_identity_key(replace(job, trim=mod.ImpositionTrimSpec(type="corners")))

    assert khong != co


def test_cung_thiet_lap_van_cho_cung_khoa(job: _FakeJob) -> None:
    """Khoá phải TẤT ĐỊNH: nếu không thì cache không bao giờ hit và preview luôn solve lại."""

    assert job_identity_key(job) == job_identity_key(job)
    assert job_identity_key(job) == job_identity_key(replace(job))


def test_khoa_phu_du_nam_spec_khong_bo_sot_cai_nao(job: _FakeJob) -> None:
    """Chốt chặn cho chính cách bug này sinh ra: liệt kê tay và bỏ sót.

    Đổi **từng** spec một phải đổi khoá. Nếu ai thêm spec render thứ sáu mà quên đưa vào
    `_render_spec_key`, test cụ thể của spec đó sẽ thiếu — nên test này thêm một lớp: khoá
    phải chứa tên của cả năm spec.
    """

    from app.core.nesting_preview_session import _render_spec_key

    ten = [name for name, _ in _render_spec_key(job)]

    assert ten == ["trim", "pont", "cut", "cut_style", "artifact_options"]
