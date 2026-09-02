"""Điều phối solver production của Bình tem bế/CNC trong job N-Up hiện hữu.

Module này không tạo job/admission mới và không render PDF. Nó dựng request bằng
identity server, gọi native đúng một lần, rồi chuyển chính session đó cho writer
và bước commit manifest sau khi artifact đã hoàn tất.
"""

from __future__ import annotations

import json
import logging
import multiprocessing
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable, Mapping

from app.core.heavy_job_scheduler import (
    HeavyJobQueueCancelled,
    memory_reservation,
)
from app.core.mixed_nesting_service import (
    HardwarePlan,
    MIXED_NESTING_KIND,
    MixedNestingError,
    MixedNestingRunHandle,
    assert_fits_memory,
    create_run,
    memory_budget_mb,
    plan_hardware,
)
from app.core.nesting_manifest_store import (
    NestingManifestStore,
    StoredNestingManifest,
    canonical_json_bytes as canonical_manifest_json_bytes,
    preflight_production_source_pins,
)
from app.core.nesting_production_adapter import (
    ProductionNestingRequest,
    build_production_request,
    canonical_json_bytes,
)
from app.core.nesting_source_pin import (
    PinnedNestingSource,
    VerifiedNestingSourceProof,
)


logger = logging.getLogger(__name__)

RunFactory = Callable[[], MixedNestingRunHandle]
ProgressCallback = Callable[[Mapping[str, Any]], None]
ReceiptPublisher = Callable[[StoredNestingManifest], None]

_COMMIT_OPEN = 0
_COMMIT_CANCEL_REQUESTED = 1
_COMMITTING = 2
_COMMITTED = 3
_COMMIT_FAILED = 4
_COMMIT_STATE_NAMES = {
    _COMMIT_OPEN: "open",
    _COMMIT_CANCEL_REQUESTED: "cancel_requested",
    _COMMITTING: "committing",
    _COMMITTED: "committed",
    _COMMIT_FAILED: "failed",
}


@dataclass(frozen=True, slots=True)
class ProductionCommitFence:
    """Chốt nguyên tử giữa yêu cầu hủy và commit manifest + receipt."""

    cancel_event: Any
    _state: Any
    _lock: Any

    @property
    def state(self) -> str:
        with self._lock:
            return _COMMIT_STATE_NAMES.get(int(self._state.value), "unknown")

    def request_cancel(self) -> bool:
        """Trả False khi commit đã bắt đầu và không còn được phép hủy."""

        with self._lock:
            state = int(self._state.value)
            if state == _COMMIT_OPEN:
                self.cancel_event.set()
                self._state.value = _COMMIT_CANCEL_REQUESTED
                return True
            return state == _COMMIT_CANCEL_REQUESTED

    def begin_commit(self) -> None:
        with self._lock:
            state = int(self._state.value)
            if self.cancel_event.is_set() or state == _COMMIT_CANCEL_REQUESTED:
                self._state.value = _COMMIT_CANCEL_REQUESTED
                _raise_cancelled()
            if state != _COMMIT_OPEN:
                raise RuntimeError("Commit fence không còn ở trạng thái open.")
            self._state.value = _COMMITTING

    def finish_commit(self) -> None:
        with self._lock:
            if int(self._state.value) != _COMMITTING:
                raise RuntimeError("Commit fence không ở trạng thái committing.")
            self._state.value = _COMMITTED

    def fail_commit(self) -> None:
        with self._lock:
            if int(self._state.value) == _COMMITTING:
                self._state.value = _COMMIT_FAILED


def create_production_commit_fence(*, context: Any = None) -> ProductionCommitFence:
    """Tạo primitive spawn-safe để parent cancel và child commit dùng chung."""

    process_context = multiprocessing.get_context() if context is None else context
    return ProductionCommitFence(
        cancel_event=process_context.Event(),
        _state=process_context.Value("b", _COMMIT_OPEN, lock=False),
        _lock=process_context.RLock(),
    )


@dataclass(frozen=True, slots=True)
class ProductionNestingInput:
    """Toàn bộ input server-owned cho đúng một lần solve production."""

    manifest_id: str
    request_revision: int
    public_request: Mapping[str, Any]
    render_bundle: Mapping[str, Any]
    clearance: Mapping[str, Any]
    fixed_obstacles: tuple[Mapping[str, Any], ...]
    source_pins: tuple[PinnedNestingSource, ...]
    #: Ý định căn cụm được Rust áp dụng trước publication và validator cuối.
    alignment: str = "center"
    #: Ý định chia vùng + association server-owned, độc lập layoutIntent số lượng.
    grouping_intent: str = "free_gang"
    placement_zones: tuple[Mapping[str, Any], ...] = ()


@dataclass(frozen=True, slots=True)
class SolvedProductionNesting:
    """Session snapshot; mỗi consumer chỉ nhận một bản JSON tách biệt."""

    production_request_canonical_bytes: bytes
    manifest_canonical_bytes: bytes
    source_pins: tuple[PinnedNestingSource, ...]
    #: PERF (audit 2026-08-30 §NEST-D0-B): snapshot progress hậu-solve. Dữ liệu
    #: chẩn đoán tách khỏi manifest immutable và không tham gia fingerprint.
    runtime_diagnostics_canonical_bytes: bytes = b"{}"
    #: PERF (audit 2026-09-01 §PERF-NEST-02): proof full hash + inspect từ
    #: preflight. Persist vẫn băm lại snapshot; chỉ metadata PDF được tái dùng.
    source_verification_proofs: tuple[VerifiedNestingSourceProof, ...] = ()

    @property
    def production_request(self) -> ProductionNestingRequest:
        payload = json.loads(self.production_request_canonical_bytes.decode("utf-8"))
        return ProductionNestingRequest(
            engine_request=payload["engineRequest"],
            render_bundle=payload["renderBundle"],
            render_bundle_hash=payload["renderBundleHash"],
            input_hash=payload["inputHash"],
            solver_config_hash=payload["solverConfigHash"],
            geometry_constraints_hash=payload["geometryConstraintsHash"],
            layout_fingerprint=payload["layoutFingerprint"],
            algorithm_versions=payload["algorithmVersions"],
            native_build_identity=payload["nativeBuildIdentity"],
        )

    @property
    def manifest(self) -> dict[str, Any]:
        payload = json.loads(self.manifest_canonical_bytes.decode("utf-8"))
        if not isinstance(payload, dict):
            raise RuntimeError("Manifest snapshot production không phải object.")
        return payload

    @property
    def runtime_diagnostics(self) -> dict[str, Any]:
        payload = json.loads(self.runtime_diagnostics_canonical_bytes.decode("utf-8"))
        if not isinstance(payload, dict):
            raise RuntimeError("Runtime diagnostics nesting không phải object.")
        return payload


def _snapshot_production_request(production: ProductionNestingRequest) -> bytes:
    return canonical_json_bytes(
        {
            "engineRequest": production.engine_request,
            "renderBundle": production.render_bundle,
            "renderBundleHash": production.render_bundle_hash,
            "inputHash": production.input_hash,
            "solverConfigHash": production.solver_config_hash,
            "geometryConstraintsHash": production.geometry_constraints_hash,
            "layoutFingerprint": production.layout_fingerprint,
            "algorithmVersions": production.algorithm_versions,
            "nativeBuildIdentity": production.native_build_identity,
        }
    )


def _snapshot_runtime_diagnostics(
    handle: Any, *, solve_production_wall_ms: float
) -> bytes:
    """Chụp progress hậu-solve nếu native hỗ trợ; telemetry lỗi không phá output."""

    progress = getattr(handle, "progress", None)
    if not callable(progress):
        return b"{}"
    try:
        payload = progress()
        if not isinstance(payload, Mapping):
            raise TypeError("progress nesting không phải object")
        diagnostics = dict(payload)
        boundary: dict[str, float] = {
            "solveProductionWallMs": round(solve_production_wall_ms, 3)
        }
        native_boundary = diagnostics.get("nativeBoundaryTimings")
        if isinstance(native_boundary, Mapping):
            native_total_ms = native_boundary.get("nativeTotalMs")
            if isinstance(native_total_ms, (int, float)) and not isinstance(
                native_total_ms, bool
            ):
                boundary["postNativeWallMs"] = round(
                    max(0.0, solve_production_wall_ms - float(native_total_ms)), 3
                )
        diagnostics["productionBoundaryTimings"] = boundary
        return canonical_json_bytes(diagnostics)
    except Exception:  # noqa: BLE001 - diagnostics phải fail-soft
        logger.debug(
            "Không chụp được runtime diagnostics hậu-solve của nesting.",
            exc_info=True,
        )
        return b"{}"


def _cancel_requested(cancel_event: Any) -> bool:
    return cancel_event is not None and bool(cancel_event.is_set())


def _raise_cancelled() -> None:
    raise MixedNestingError(
        "MIXED_NESTING_CANCELLED",
        "Đã hủy lệnh nesting trước khi công bố manifest.",
        409,
    )


def _solve_production_with_hardware_plan(
    handle: MixedNestingRunHandle,
    request: dict[str, Any],
    plan: HardwarePlan,
) -> dict[str, Any]:
    """Truyền grant cho native mới, giữ run_factory giả cũ không bị vỡ.

    Feature detection chỉ dành cho fake handle/test-double. Handle production thật là
    :class:`MixedNestingRunHandle`, luôn có method mới và method đó fail-closed nếu wheel
    native thiếu ``runtimeControlVersion``; không có fallback âm thầm cho native stale.
    """
    solve_with_hardware = getattr(handle, "solve_production_with_hardware", None)
    if callable(solve_with_hardware):
        return solve_with_hardware(
            request,
            worker_grant=plan.worker_grant,
            nfp_cache_max_bytes_per_trial=plan.nfp_cache_max_bytes_per_trial,
        )
    return handle.solve_production(request)


def _start_watchers(
    handle: MixedNestingRunHandle,
    *,
    cancel_event: Any,
    progress_callback: ProgressCallback | None,
) -> tuple[threading.Event, tuple[threading.Thread, ...]]:
    """Nối Event của process cha với handle Rust chỉ sống trong process con."""

    stop_event = threading.Event()
    threads: list[threading.Thread] = []

    if cancel_event is not None:
        def watch_cancel() -> None:
            while not stop_event.is_set():
                if cancel_event.wait(0.1):
                    try:
                        handle.cancel()
                    except Exception:
                        logger.exception("Không gửi được tín hiệu hủy tới native nesting.")
                    return

        cancel_thread = threading.Thread(
            target=watch_cancel,
            name="prynx-nesting-cancel",
            daemon=True,
        )
        cancel_thread.start()
        threads.append(cancel_thread)

    if progress_callback is not None:
        def watch_progress() -> None:
            while not stop_event.wait(0.1):
                try:
                    progress = handle.progress()
                    if stop_event.is_set():
                        return
                    progress_callback(progress)
                except Exception:
                    logger.debug(
                        "Không đọc/ghi được progress nesting production.",
                        exc_info=True,
                    )

        progress_thread = threading.Thread(
            target=watch_progress,
            name="prynx-nesting-progress",
            daemon=True,
        )
        progress_thread.start()
        threads.append(progress_thread)

    return stop_event, tuple(threads)


def solve_production_nesting(
    value: ProductionNestingInput,
    *,
    cancel_event: Any = None,
    progress_callback: ProgressCallback | None = None,
    runtime_worker_grant_limit: int | None = None,
    run_factory: RunFactory = create_run,
) -> SolvedProductionNesting:
    """Dựng request và gọi native đúng một lần, không persist hoặc render."""

    if not isinstance(value, ProductionNestingInput):
        raise TypeError("value phải là ProductionNestingInput.")
    if not value.source_pins:
        raise ValueError("Production nesting phải có ít nhất một source pin.")
    if _cancel_requested(cancel_event):
        _raise_cancelled()

    handle = run_factory()
    capabilities = handle.capabilities
    versions = capabilities.require_production_versions()
    native_build_identity = capabilities.native_build_identity
    if not isinstance(native_build_identity, str):
        # require_production_versions đã chặn wheel cũ; guard này giữ type hẹp.
        raise RuntimeError("Native build identity production không hợp lệ.")

    production = build_production_request(
        value.public_request,
        job_id=value.manifest_id,
        request_revision=value.request_revision,
        render_bundle=value.render_bundle,
        clearance=value.clearance,
        fixed_obstacles=value.fixed_obstacles,
        grouping_intent=value.grouping_intent,
        placement_zones=value.placement_zones,
        algorithm_versions=versions,
        native_build_identity=native_build_identity,
        alignment=value.alignment,
    )
    if _cancel_requested(cancel_event):
        _raise_cancelled()
    # NESTING (audit 2026-08-28 §SOURCE.3): writer không được chạy nếu
    # bundle chưa bind exact locator/hash/page metadata của source pin.
    source_verification_proofs = preflight_production_source_pins(
        production, value.source_pins
    )
    if _cancel_requested(cancel_event):
        _raise_cancelled()

    # PERF (audit 2026-08-30 §NEST-PORTFOLIO-L2): preview production dùng cùng
    # admission model với đường standalone. Reservation sống đúng bằng solve native;
    # hardware grant không tham gia request canonical/layout fingerprint.
    # PERF (audit 2026-09-01 §SR13-WAVE): chỉ truyền keyword mới khi batch thật sự
    # chia grant, để fake/monkeypatch cũ của đường đơn vẫn giữ contract một đối số.
    if runtime_worker_grant_limit is None:
        plan = plan_hardware(production.engine_request)
    else:
        plan = plan_hardware(
            production.engine_request,
            worker_grant_limit=runtime_worker_grant_limit,
        )
    assert_fits_memory(plan)
    logger.info(
        "[NESTING-PRODUCTION] %s admission: %s",
        value.manifest_id,
        plan.reason,
    )
    try:
        with memory_reservation(
            MIXED_NESTING_KIND,
            plan.estimated_peak_mb,
            memory_budget_mb,
            None if cancel_event is None else cancel_event.is_set,
        ):
            if _cancel_requested(cancel_event):
                _raise_cancelled()
            stop_event, watchers = _start_watchers(
                handle,
                cancel_event=cancel_event,
                progress_callback=progress_callback,
            )
            solve_production_started = time.perf_counter()
            try:
                manifest = _solve_production_with_hardware_plan(
                    handle,
                    production.engine_request,
                    plan,
                )
            finally:
                stop_event.set()
                for watcher in watchers:
                    watcher.join(timeout=1.0)
                    if watcher.is_alive():
                        logger.warning("Watcher nesting production chưa dừng sau solve.")
    except HeavyJobQueueCancelled:
        _raise_cancelled()
    solve_production_wall_ms = (time.perf_counter() - solve_production_started) * 1000.0

    if _cancel_requested(cancel_event):
        _raise_cancelled()
    if _cancel_requested(cancel_event):
        _raise_cancelled()
    # NESTING (audit 2026-08-28 §MANIFEST.1): snapshot canonical ngay sau
    # solve; writer và store nhận hai bản tách biệt nhưng cùng authoritative bytes.
    return SolvedProductionNesting(
        production_request_canonical_bytes=_snapshot_production_request(production),
        # NEST (fix 2026-08-29 §MANIFEST-SNAPSHOT): pose native phải round-trip lossless.
        # Serializer request cố ý lượng tử 6 số; dùng nó cho manifest làm score lệch layout.
        manifest_canonical_bytes=canonical_manifest_json_bytes(manifest),
        source_pins=tuple(value.source_pins),
        runtime_diagnostics_canonical_bytes=_snapshot_runtime_diagnostics(
            handle, solve_production_wall_ms=solve_production_wall_ms
        ),
        source_verification_proofs=source_verification_proofs,
    )


def persist_production_nesting(
    solved: SolvedProductionNesting,
    *,
    store: NestingManifestStore | None = None,
    commit_fence: ProductionCommitFence | None = None,
    receipt_publisher: ReceiptPublisher | None = None,
) -> StoredNestingManifest:
    """Commit cuối: chỉ gọi sau khi writer đã đóng artifact thành công."""

    if not isinstance(solved, SolvedProductionNesting):
        raise TypeError("solved phải là SolvedProductionNesting.")
    target = NestingManifestStore() if store is None else store
    if commit_fence is not None and not isinstance(
        commit_fence, ProductionCommitFence
    ):
        raise TypeError("commit_fence phải là ProductionCommitFence hoặc None.")
    if receipt_publisher is not None and not callable(receipt_publisher):
        raise TypeError("receipt_publisher phải callable hoặc None.")

    if commit_fence is not None:
        commit_fence.begin_commit()
    try:
        stored = target.persist(
            production_request=solved.production_request,
            manifest=solved.manifest,
            source_pins=solved.source_pins,
            source_proofs=solved.source_verification_proofs or None,
        )
        if receipt_publisher is not None:
            receipt_publisher(stored)
    except Exception:
        if commit_fence is not None:
            commit_fence.fail_commit()
        raise
    if commit_fence is not None:
        commit_fence.finish_commit()
    return stored
