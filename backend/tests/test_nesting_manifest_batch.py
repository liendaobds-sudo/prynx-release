"""PERF (audit 2026-09-07 §TEMPERF.F): batch decode không nới chốt production."""

from __future__ import annotations

import json
import hashlib
import math
import random
import re
import threading
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from pathlib import Path

import pytest

from app.core import heavy_job_scheduler as scheduler
from app.core import mixed_nesting_service as service
from app.core import nesting_manifest_batch as batch


def _payload(*, placements=2, vertices=4, obstacles=1, value=0):
    ring = [[index, index % 2] for index in range(vertices)]
    return json.dumps({
        "manifest": {
            "placements": [{"partId": "part"} for _ in range(placements)],
            "value": value,
        },
        "productionRequest": {"engineRequest": {
            "parts": [{"partId": "part", "outer": ring, "holes": []}],
            "productionContract": {"fixedObstacles": [
                {"outer": [[0, 0], [1, 0], [1, 1], [0, 1]]}
                for _ in range(obstacles)
            ]},
        }},
    }, separators=(",", ":")).encode()


def _reserved():
    with scheduler._MEMORY_RESERVATION_LOCK:
        return scheduler._RESERVED_MEMORY_MB_BY_KIND.get(service.MIXED_NESTING_KIND, 0.0)


@pytest.fixture(autouse=True)
def _isolated_runtime(monkeypatch):
    coordinator = service.SharedBatchWorkerGrantCoordinator()
    monkeypatch.setattr(service, "_SHARED_BATCH_WORKER_GRANTS", coordinator)
    monkeypatch.setattr("app.core.system_memory.os.cpu_count", lambda: 4)
    monkeypatch.setattr(
        "app.core.system_memory.read_memory_status_mb", lambda: (32768.0, 16384.0)
    )
    monkeypatch.setattr(batch, "memory_budget_mb", lambda: 4096.0)
    monkeypatch.delenv(service.WORKER_COUNT_ENV, raising=False)
    assert _reserved() == 0.0
    yield coordinator
    assert coordinator.snapshot() == {"capacity": 0, "held": 0, "batches": 0, "waiters": 0}
    assert _reserved() == 0.0


def _context(payloads, *, decode=None, read=None, get_size=None, cancelled=None):
    return batch.decode_manifest_batch(
        tuple(range(len(payloads))),
        get_size=get_size or (lambda i: len(payloads[i])),
        read_payload=read or (lambda i, _size: payloads[i]),
        decode=decode or (lambda _i, payload: json.loads(payload)),
        queue_cancelled=cancelled,
    )


def test_empty_khong_doc_hoac_xin_grant(monkeypatch):
    def forbidden(*_args, **_kwargs):
        raise AssertionError("Batch rỗng không được làm việc.")
    monkeypatch.setattr(batch, "plan_batch_hardware", forbidden)
    with batch.decode_manifest_batch((), get_size=forbidden, read_payload=forbidden, decode=forbidden) as values:
        assert values == []
        assert _reserved() == 0.0


def test_giu_input_order_du_hoan_tat_dao_thu_tu():
    payloads = [_payload(value=i) for i in range(5)]
    first_wave = threading.Barrier(3)
    completed = []
    lock = threading.Lock()
    def decode(i, payload):
        if i < 3:
            first_wave.wait(timeout=3)
            if i == 0:
                time.sleep(0.04)
        with lock:
            completed.append(i)
        return json.loads(payload)
    with _context(payloads, decode=decode) as values:
        assert [v["manifest"]["value"] for v in values] == list(range(5))
    assert completed[0] != 0


def test_duplicate_reference_van_doc_decode_rieng_khong_chia_mutable_mapping():
    payload = _payload()
    reads = Counter()
    decodes = Counter()
    lock = threading.Lock()
    def read(item, size):
        assert size == len(payload)
        with lock:
            reads[item] += 1
        return payload
    def decode(item, raw):
        with lock:
            decodes[item] += 1
        return json.loads(raw)
    with batch.decode_manifest_batch(("same", "same"), get_size=lambda _: len(payload), read_payload=read, decode=decode) as values:
        assert values[0] == values[1]
        values[0]["manifest"]["placements"][0]["partId"] = "changed"
        assert values[1]["manifest"]["placements"][0]["partId"] == "part"
    assert reads == {"same": 4}
    assert decodes == {"same": 2}


def test_moi_read_duoc_reserve_truoc_cpu_nha_truoc_yield_ram_giu_den_cuoi(_isolated_runtime):
    payloads = [_payload(value=i) for i in range(3)]
    reads = []
    lock = threading.Lock()
    def read(i, size):
        assert _reserved() > 0
        held = _isolated_runtime.snapshot()["held"]
        assert held > 0
        with lock:
            reads.append((i, held, _reserved()))
        return payloads[i]
    with _context(payloads, read=read) as values:
        assert len(values) == 3
        assert _isolated_runtime.snapshot()["held"] == 0
        assert _isolated_runtime.snapshot()["batches"] == 0
        assert _reserved() > 0
    assert len(reads) == 6
    assert [held for _, held, _ in reads[:3]] == [1, 1, 1]
    assert [held for _, held, _ in reads[3:]] == [3, 3, 3]


def test_caller_source_phase_loi_van_nha_ram():
    with pytest.raises(RuntimeError, match="source"):
        with _context([_payload()]) as _values:
            assert _reserved() > 0
            raise RuntimeError("source")


@pytest.mark.parametrize("bad", [b"", b"not-json", b"\xff", b"{}", b"[]", b'{"productionRequest":null}', b'{"manifest":{"placements":[null]}}'])
def test_metadata_meo_khong_bao_gio_thay_the_full_decode(bad):
    calls = []
    sentinel = RuntimeError("full-validator")
    def decode(i, payload):
        calls.append((i, payload))
        raise sentinel
    with pytest.raises(RuntimeError) as error:
        with _context([bad], decode=decode):
            pytest.fail("Manifest lỗi không được yield.")
    assert error.value is sentinel
    assert calls == [(0, bad)]


@pytest.mark.parametrize("size", [-1, True, 1.25, "10", None])
def test_size_khong_hop_le_fail_truoc_read(size):
    def read(*_args):
        pytest.fail("Không được đọc bằng size sai kiểu.")
    with pytest.raises(batch.ManifestBatchIntegrityError):
        with _context([_payload()], get_size=lambda _: size, read=read):
            pytest.fail("Không được yield.")


@pytest.mark.parametrize("phase", ["prepass", "decode"])
@pytest.mark.parametrize("mutation", ["short", "long", "bytearray", "same-size"])
def test_read_size_va_sha256_bind_exact_ca_hai_luot(phase, mutation):
    payload = _payload(value=1)
    reads = 0
    decoded = []
    def read(_i, _size):
        nonlocal reads
        reads += 1
        tamper = phase == "prepass" or reads == 2
        if not tamper:
            return payload
        if mutation == "short":
            return payload[:-1]
        if mutation == "long":
            return payload + b" "
        if mutation == "bytearray":
            return bytearray(payload)
        return payload.replace(b'"value":1', b'"value":2')
    # Đổi trước prepass trở thành bytes đầu vào mới; helper không tự đoán authority.
    if phase == "prepass" and mutation == "same-size":
        with _context([payload], read=read) as values:
            assert values[0]["manifest"]["value"] == 2
        return
    with pytest.raises(batch.ManifestBatchIntegrityError):
        with _context([payload], read=read, decode=lambda *args: decoded.append(args)):
            pytest.fail("Nội dung đổi không được yield.")
    assert decoded == []


class _Abort(BaseException):
    pass


@pytest.mark.parametrize("failure", [RuntimeError("native"), _Abort("native")])
def test_decode_exception_giu_nguyen_va_drain_truoc_nha_ram(failure):
    running = threading.Event()
    finished = threading.Event()
    def decode(i, payload):
        if i == 0:
            running.set()
            time.sleep(0.05)
            finished.set()
            return json.loads(payload)
        assert running.wait(timeout=3)
        raise failure
    with pytest.raises(type(failure)) as error:
        with _context([_payload()] * 5, decode=decode):
            pytest.fail("Không được yield batch một phần.")
    assert error.value is failure
    assert finished.is_set()
    # Không để exception độc làm hỏng lượt tiếp theo.
    with _context([_payload()]) as values:
        assert len(values) == 1


def test_submit_loi_drain_worker_da_chay_va_nha_moi_resource(monkeypatch):
    original = batch.ThreadPoolExecutor
    started = threading.Event()
    finished = threading.Event()
    sentinel = RuntimeError("submit")
    class BrokenExecutor(original):
        count = 0
        def submit(self, fn, *args, **kwargs):
            self.count += 1
            if self.count == 2:
                assert started.wait(timeout=3)
                raise sentinel
            return super().submit(fn, *args, **kwargs)
    monkeypatch.setattr(batch, "ThreadPoolExecutor", BrokenExecutor)
    def decode(_i, payload):
        started.set()
        time.sleep(0.04)
        finished.set()
        return json.loads(payload)
    with pytest.raises(RuntimeError) as error:
        with _context([_payload()] * 3, decode=decode):
            pytest.fail("Không được yield.")
    assert error.value is sentinel
    assert finished.is_set()


def test_executor_constructor_loi_van_nha_grant_va_ram(monkeypatch):
    sentinel = RuntimeError("executor")
    def broken(**_kwargs):
        assert _reserved() > 0
        raise sentinel
    monkeypatch.setattr(batch, "ThreadPoolExecutor", broken)
    with pytest.raises(RuntimeError) as error:
        with _context([_payload()] * 3):
            pytest.fail("Không được yield.")
    assert error.value is sentinel


@pytest.mark.parametrize("callback", ["get_size", "read", "cancel"])
def test_callback_baseexception_khong_poison_grant_hoac_reservation(callback):
    failure = _Abort(callback)
    def abort(*_args):
        raise failure
    kwargs = {"get_size": abort} if callback == "get_size" else {"read": abort} if callback == "read" else {"cancelled": abort}
    with pytest.raises(_Abort) as error:
        with _context([_payload()], **kwargs):
            pytest.fail("Không được yield.")
    assert error.value is failure


def test_cancel_truoc_prepass_khong_doc():
    def read(*_args):
        pytest.fail("Đã cancel không được đọc.")
    with pytest.raises(scheduler.HeavyJobQueueCancelled):
        with _context([_payload()], read=read, cancelled=lambda: True):
            pytest.fail("Không được yield.")


def test_cancel_khi_native_dang_chay_drain_khong_yield():
    cancel = threading.Event()
    finished = threading.Event()
    def decode(_i, payload):
        cancel.set()
        time.sleep(0.02)
        finished.set()
        return json.loads(payload)
    with pytest.raises(scheduler.HeavyJobQueueCancelled):
        with _context([_payload()] * 6, decode=decode, cancelled=cancel.is_set):
            pytest.fail("Không được yield.")
    assert finished.is_set()


def test_cancel_khi_cho_cpu_grant(_isolated_runtime):
    cancel = threading.Event()
    blocker = service.register_shared_batch_worker_grants(3)
    try:
        with blocker.request(3).claim():
            with ThreadPoolExecutor(max_workers=1) as pool:
                def run():
                    with _context([_payload()], cancelled=cancel.is_set):
                        pytest.fail("Không được yield.")
                future = pool.submit(run)
                deadline = time.monotonic() + 3
                while _isolated_runtime.snapshot()["waiters"] == 0:
                    assert time.monotonic() < deadline
                    time.sleep(0.005)
                cancel.set()
                with pytest.raises((InterruptedError, scheduler.HeavyJobQueueCancelled)):
                    future.result(timeout=3)
    finally:
        blocker.close()


def test_cancel_khi_cho_ram_van_nha_cpu(monkeypatch, _isolated_runtime):
    monkeypatch.setattr(batch, "memory_budget_mb", lambda: 128.0)
    cancel = threading.Event()
    with scheduler.memory_reservation(service.MIXED_NESTING_KIND, 128.0, lambda: 128.0):
        with ThreadPoolExecutor(max_workers=1) as pool:
            def run():
                with _context([_payload()], cancelled=cancel.is_set):
                    pytest.fail("Không được yield.")
            future = pool.submit(run)
            deadline = time.monotonic() + 3
            while _isolated_runtime.snapshot()["held"] == 0:
                assert time.monotonic() < deadline
                time.sleep(0.005)
            cancel.set()
            with pytest.raises(scheduler.HeavyJobQueueCancelled):
                future.result(timeout=3)
            assert _isolated_runtime.snapshot()["held"] == 0


def test_budget_race_reservation_cuoi_doc_lai_va_khong_decode(monkeypatch):
    payload = _payload()
    calls = 0
    def budget():
        nonlocal calls
        calls += 1
        return 4096.0 if calls <= 2 else 1.0
    monkeypatch.setattr(batch, "memory_budget_mb", budget)
    def decode(*_args):
        pytest.fail("RAM đổi trước reserve thì không được decode.")
    with pytest.raises(scheduler.HeavyJobMemoryUnavailable):
        with _context([payload], decode=decode):
            pytest.fail("Không được yield.")


def test_ba_batch_va_solve_chia_quota_khong_deadlock(_isolated_runtime):
    starts = threading.Barrier(4)
    peak = 0
    lock = threading.Lock()
    def track():
        nonlocal peak
        with lock:
            held = _isolated_runtime.snapshot()["held"]
            assert held <= 3
            peak = max(peak, held)
    def decode(_i, raw):
        track()
        time.sleep(0.002)
        return json.loads(raw)
    def load():
        starts.wait(timeout=3)
        with _context([_payload()] * 7, decode=decode) as values:
            assert len(values) == 7
            assert _reserved() > 0
    def solve():
        starts.wait(timeout=3)
        lease = service.register_shared_batch_worker_grants(3)
        try:
            # Giữ ordering của pipeline thật: CPU trước, RAM sau.
            with lease.request(1).claim():
                with scheduler.memory_reservation(service.MIXED_NESTING_KIND, 256.0, lambda: 4096.0):
                    track()
                    time.sleep(0.01)
        finally:
            lease.close()
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = [pool.submit(load) for _ in range(3)] + [pool.submit(solve)]
        for future in futures:
            future.result(timeout=5)
    assert peak == 3


def test_memory_model_tinh_dung_tich_placement_vertex_va_linear_spatial():
    base = batch._estimate_native_bytes(_payload(placements=0, vertices=0, obstacles=0))
    assert base == batch._FIXED_NATIVE_BYTES
    got = batch._estimate_native_bytes(_payload(placements=10, vertices=20, obstacles=3))
    expected = (base + 48 * 10 * 20 + 256 * (20 + 3 * 4)
                + 1024 * 10 + 16 * 1036 * (10 + 3))
    assert got == expected
    assert batch.MANIFEST_BATCH_MEMORY_MODEL_VERSION == 1


def test_memory_model_part_binding_holes_duplicate_va_unknown_khong_danh_gia_thap():
    value = json.loads(_payload(placements=3, vertices=4, obstacles=0))
    parts = value["productionRequest"]["engineRequest"]["parts"]
    parts.append({"partId": "part", "outer": [[0, 0]] * 10, "holes": [[[0, 0]] * 6]})
    value["manifest"]["placements"] = [{"partId": "part"}, {"partId": "unknown"}, {"partId": []}]
    assert batch._estimate_native_bytes(json.dumps(value).encode()) == (
        batch._FIXED_NATIVE_BYTES + 48 * 30 + 256 * 20 + 1024 * 3 + 16 * 1036 * 3
    )


def test_spatial_sum_bound_quet_ratio_cuc_lech_va_ngau_nhien():
    rng = random.Random(20260907)
    maximum = batch._MAX_SPATIAL_CELLS_PER_AXIS
    distributions = [[1.0], [1e-120, 1e120], [1.0] * 100, [1e-30] * 99 + [1e30]]
    distributions.extend([10 ** rng.uniform(-20, 20) for _ in range(n)] for n in range(2, 100))
    for extents in distributions:
        mean = math.fsum(extents) / len(extents)
        upper = math.fsum(min(maximum**2, (2 * e / mean + 2)**2) for e in extents)
        assert upper <= batch._SPATIAL_MEMBERS_PER_ENTRY * len(extents) + 1e-6


def test_spatial_bound_so_voi_cell_span_grid_that_ke_ca_mot_o():
    rng = random.Random(70609)
    maximum = batch._MAX_SPATIAL_CELLS_PER_AXIS
    for count in (1, 2, 8, 31, 100):
        for width, height in ((1e-6, 1e-5), (320.0, 430.0), (1e8, 3e8)):
            extents = [10 ** rng.uniform(-8, 8) for _ in range(count)]
            hint = max(math.fsum(extents) / count, 1e-6)
            cols = max(1, min(maximum, math.ceil(width / hint)))
            rows = max(1, min(maximum, math.ceil(height / hint)))
            cell = max(width / cols, height / rows)
            members = 0
            for extent in extents:
                x = rng.uniform(-width, width * 2)
                y = rng.uniform(-height, height * 2)
                span = lambda start, end, limit: max(0, min(limit-1, math.floor(end/cell))) - max(0, min(limit-1, math.floor(start/cell))) + 1
                members += span(x, x + extent, cols) * span(y, y + extent, rows)
            assert members <= batch._SPATIAL_MEMBERS_PER_ENTRY * count


def test_rust_assumptions_tripwire_khi_doi_grid_hoac_retained_ring():
    root = Path(__file__).resolve().parents[2] / "imposition_core/src/mixed_nesting"
    spatial = (root / "spatial.rs").read_text(encoding="utf-8")
    validator = (root / "validator.rs").read_text(encoding="utf-8")
    assert int(re.search(r"MAX_CELLS_PER_AXIS: usize = (\d+)", spatial).group(1)) == batch._MAX_SPATIAL_CELLS_PER_AXIS
    assert "((width / hint).ceil() as usize).clamp(1, MAX_CELLS_PER_AXIS)" in spatial
    assert "(width / cols as f64).max(height / rows as f64)" in spatial
    assert "cells: Vec<Vec<usize>>" in spatial
    assert "self.cells[row * self.cols + col].push(index)" in spatial
    assert "ring: Vec<PointMm>" in validator
    assert "average_extent_mm(&placed_rings.iter().map(|p| p.bounds).collect::<Vec<_>>())" in validator
    assert "boxes.iter().map(|b| b.width_mm().max(b.height_mm())).sum()" in validator
    assert "(total / boxes.len() as f64).max(1e-6)" in validator
    assert "grid.insert(index, placed_rings[index].bounds)" in validator


def test_ngan_sach_batch_giu_trees_va_top_k_native_khong_cap_hang_so():
    costs = [batch._ReadBudget(1024, b"x", n * batch._MIB) for n in (10, 30, 20)]
    resident = batch._BATCH_OVERHEAD_BYTES + 64 * 3 * 1024
    assert batch._batch_memory_plan(costs, 15, None) == (3, resident + 60 * batch._MIB)
    assert batch._batch_memory_plan(costs, 15, (resident + 50 * batch._MIB) / batch._MIB) == (2, resident + 50 * batch._MIB)
    with pytest.raises(scheduler.HeavyJobMemoryUnavailable):
        batch._batch_memory_plan(costs, 15, (resident + 29 * batch._MIB) / batch._MIB)


@pytest.mark.parametrize(("total", "forced", "expected"), [
    (4096.0, None, 1), (12288.0, None, 2), (32768.0, None, 7),
    (None, None, 7), (4096.0, "5", 5), (32768.0, "2", 2),
])
def test_tier_env_unknown_deu_di_qua_planner(monkeypatch, total, forced, expected):
    monkeypatch.setattr("app.core.system_memory.os.cpu_count", lambda: 8)
    monkeypatch.setattr("app.core.system_memory.read_memory_status_mb", lambda: (total, None if total is None else total / 2))
    if forced is not None:
        monkeypatch.setenv(service.WORKER_COUNT_ENV, forced)
    captured = []
    original = batch._decode_parallel
    def record(items, budgets, workers, *args):
        captured.append(workers)
        return original(items, budgets, workers, *args)
    monkeypatch.setattr(batch, "_decode_parallel", record)
    with _context([_payload()] * 8) as values:
        assert len(values) == 8
    assert captured == [expected]


def test_ram_unknown_khong_tu_bia_reservation_hoac_giam_worker(monkeypatch):
    monkeypatch.setattr(batch, "memory_budget_mb", lambda: None)
    observed = []
    def decode(_i, raw):
        observed.append(_reserved())
        return json.loads(raw)
    with _context([_payload()] * 3, decode=decode) as values:
        assert len(values) == 3
        assert _reserved() == 0.0
    assert observed == [0.0, 0.0, 0.0]


def test_chi_co_lane_khi_ngan_sach_thuc_khong_chua_du_full_batch(monkeypatch):
    payload = _payload()
    receipt = batch._ReadBudget(len(payload), b"", batch._estimate_native_bytes(payload))
    resident = batch._BATCH_OVERHEAD_BYTES + 64 * len(payload) * 3
    two_lane_budget = (resident + 2 * receipt.native_bytes) / batch._MIB
    monkeypatch.setattr(batch, "memory_budget_mb", lambda: two_lane_budget)
    observed = []
    original = batch._decode_parallel
    def record(items, budgets, workers, *args):
        observed.append(workers)
        return original(items, budgets, workers, *args)
    monkeypatch.setattr(batch, "_decode_parallel", record)
    with _context([payload] * 3) as values:
        assert len(values) == 3
        assert _reserved() == pytest.approx(two_lane_budget)
    assert observed == [2]


def test_prepass_ton_ram_khong_du_thi_khong_doc_payload(monkeypatch):
    monkeypatch.setattr(batch, "memory_budget_mb", lambda: 1.0)
    def read(*_args):
        pytest.fail("Không được đọc trước khi admission đạt.")
    with pytest.raises(scheduler.HeavyJobMemoryUnavailable):
        with _context([_payload()], read=read):
            pytest.fail("Không được yield.")


@pytest.fixture
def _published_manifest_store(tmp_path):
    """Pin/solve/commit thật, chỉ hai tem mỗi mẫu để fixture không thành benchmark."""
    native = pytest.importorskip("pdfcompare_native")
    assert callable(getattr(native.MixedNestingRun, "validate_manifest", None))
    from app.core.nesting_manifest_store import NestingManifestStore
    from app.core.nesting_production_pipeline import (
        commit_production_nesting_session,
        solve_production_nesting_job,
    )
    from tests.test_nesting_production_pipeline import _job

    manifest_store = NestingManifestStore(root=tmp_path / "real-manifests")
    records = []
    originals = {}
    for index in range(3):
        folder = tmp_path / f"source-{index}"
        folder.mkdir()
        job = _job(folder, manifest_id=f"{index + 1:032x}", quantity=2)
        session = solve_production_nesting_job(job, runtime_worker_grant_limit=1)
        record = commit_production_nesting_session(session, store=manifest_store)
        assert record.manifest["stats"]["placedCount"] == 2
        records.append(record)
        for part in job.parts:
            originals[part.source_path] = hashlib.sha256(part.source_path.read_bytes()).digest()
    references = tuple({
        "manifestId": record.manifest_id,
        "layoutFingerprint": record.layout_fingerprint,
    } for record in records)
    yield manifest_store, records, references
    for path, digest in originals.items():
        assert hashlib.sha256(path.read_bytes()).digest() == digest


def _forbid_store_source_phase(monkeypatch):
    from app.core import nesting_manifest_store as manifest_module
    from app.core import nesting_source_pin as source_module

    calls = []
    def forbidden(*_args, **_kwargs):
        calls.append(True)
        raise AssertionError("Manifest chưa đạt không được resolve/gia hạn source.")
    monkeypatch.setattr(manifest_module, "resolve_nesting_source_leases", forbidden)
    monkeypatch.setattr(manifest_module, "_resolve_stored_sources", forbidden)
    monkeypatch.setattr(source_module, "renew_resolved_nesting_source_lease", forbidden)
    return calls


def _write_envelope(manifest_store, record, value, *, refresh_sha=True):
    from app.core.nesting_manifest_store import canonical_json_bytes
    if refresh_sha:
        body = {key: item for key, item in value.items() if key != "contentSha256"}
        value["contentSha256"] = hashlib.sha256(canonical_json_bytes(body)).hexdigest()
    (manifest_store.root / f"{record.manifest_id}.json").write_bytes(canonical_json_bytes(value))


def test_real_store_native_moi_record_order_duplicate_va_source_fence(
    _published_manifest_store, monkeypatch, _isolated_runtime,
):
    from app.core import nesting_manifest_store as manifest_module
    from app.core import nesting_source_pin as source_module

    manifest_store, records, refs = _published_manifest_store
    requested = (refs[2], refs[1], refs[0], refs[2])
    wanted = [reference["manifestId"] for reference in requested]
    native_completed = []
    source_calls = []
    renew_calls = []
    lock = threading.Lock()
    native_validator = service._validate_manifest_with_native
    real_resolve = manifest_module.resolve_nesting_source_leases
    real_sources = manifest_module._resolve_stored_sources
    real_renew = source_module.renew_resolved_nesting_source_lease

    def validate(request, manifest):
        native_validator(request, manifest)
        with lock:
            native_completed.append(manifest["manifestId"])
    def assert_fence():
        assert Counter(native_completed) == Counter(wanted)
        assert _isolated_runtime.snapshot() == {"capacity": 0, "held": 0, "batches": 0, "waiters": 0}
        assert _reserved() > 0
    def resolve(*args, **kwargs):
        assert_fence()
        source_calls.append("batch")
        return real_resolve(*args, **kwargs)
    def sources(*args, **kwargs):
        assert_fence()
        source_calls.append("source")
        return real_sources(*args, **kwargs)
    def renew(*args, **kwargs):
        assert_fence()
        renew_calls.append(True)
        return real_renew(*args, **kwargs)
    def forbidden_solve(*_args, **_kwargs):
        pytest.fail("Load reference không được solve lại.")

    monkeypatch.setattr(service, "_validate_manifest_with_native", validate)
    monkeypatch.setattr(service.MixedNestingRunHandle, "solve_production_with_hardware", forbidden_solve)
    monkeypatch.setattr(manifest_module, "resolve_nesting_source_leases", resolve)
    monkeypatch.setattr(manifest_module, "_resolve_stored_sources", sources)
    monkeypatch.setattr(source_module, "renew_resolved_nesting_source_lease", renew)
    loaded = manifest_store.load_many(requested)

    assert [record.manifest_id for record in loaded] == wanted
    assert Counter(native_completed) == Counter(wanted)
    assert source_calls == ["batch"] + ["source"] * 4
    assert len(renew_calls) == 4
    canonical_by_id = {record.manifest_id: record.canonical_bytes for record in records}
    assert [record.canonical_bytes for record in loaded] == [canonical_by_id[key] for key in wanted]
    assert _reserved() == 0
    loaded[0].manifest["placements"][0]["pose"]["translateXmm"] = -999.0
    assert loaded[3].manifest["placements"][0]["pose"]["translateXmm"] != -999.0
    loaded[0].render_bundle["parts"][0]["partId"] = "changed"
    assert loaded[3].render_bundle["parts"][0]["partId"] != "changed"


@pytest.mark.parametrize("mutation", ["hash", "schema", "build", "production-schema", "native-pose"])
def test_real_store_middle_invalid_khong_resolve_hoac_renew(
    _published_manifest_store, monkeypatch, mutation,
):
    from app.core import nesting_manifest_store as manifest_module

    manifest_store, records, refs = _published_manifest_store
    target = records[1]
    envelope = json.loads(target.canonical_bytes)
    expected_error = manifest_module.ManifestIntegrityError
    if mutation == "hash":
        envelope["manifest"]["stats"]["placedCount"] += 1
    elif mutation == "schema":
        envelope["manifest"]["unknown-field"] = 1
    elif mutation == "build":
        # Băm lại envelope không được hợp pháp hóa identity chứa native build khác.
        envelope["productionRequest"]["nativeBuildIdentity"] = "f" * 64
    elif mutation == "production-schema":
        old = service.MIXED_NESTING_PRODUCTION_SCHEMA_VERSION - 1
        production = envelope["productionRequest"]
        production["algorithmVersions"]["productionSchemaVersion"] = old
        production["engineRequest"]["productionContract"]["schemaVersion"] = old
        expected_error = manifest_module.ManifestFingerprintMismatchError
    else:
        # Schema/identity vẫn nguyên; native thật phải từ chối score/pose giả này.
        envelope["manifest"]["placements"][0]["pose"]["translateXmm"] += 1000.0
    _write_envelope(manifest_store, target, envelope, refresh_sha=mutation != "hash")
    forbidden = _forbid_store_source_phase(monkeypatch)
    native_calls = []
    original = service._validate_manifest_with_native
    def validate(request, manifest):
        native_calls.append(manifest["manifestId"])
        return original(request, manifest)
    monkeypatch.setattr(service, "_validate_manifest_with_native", validate)
    with pytest.raises(expected_error) as error:
        manifest_store.load_many(refs)
    assert forbidden == []
    if mutation == "native-pose":
        assert native_calls.count(target.manifest_id) == 1
    else:
        assert target.manifest_id not in native_calls
    if mutation == "production-schema":
        assert error.value.status_code == 409


def test_real_store_current_build_doi_van_tra_stale_409_truoc_source(
    _published_manifest_store, monkeypatch,
):
    from app.core import nesting_manifest_store as manifest_module
    manifest_store, _records, refs = _published_manifest_store
    current = manifest_module.engine_capabilities()
    monkeypatch.setattr(manifest_module, "engine_capabilities", lambda: replace(current, native_build_identity="f" * 64))
    forbidden = _forbid_store_source_phase(monkeypatch)
    with pytest.raises(manifest_module.ManifestFingerprintMismatchError) as error:
        manifest_store.load_many(refs)
    assert error.value.status_code == 409
    assert error.value.code == "LAYOUT_MANIFEST_STALE"
    assert forbidden == []


def test_real_store_doi_cung_size_sau_prepass_map_integrity_va_khong_source(
    _published_manifest_store, monkeypatch,
):
    from app.core import nesting_manifest_store as manifest_module
    manifest_store, records, refs = _published_manifest_store
    target = manifest_store.root / f"{records[1].manifest_id}.json"
    original = manifest_module._read_regular_file
    changed = []
    def read(path, *, expected_size=None):
        payload = original(path, expected_size=expected_size)
        if Path(path) == target and expected_size is not None and not changed:
            marker = b'"contentSha256":"'
            position = payload.index(marker) + len(marker)
            replacement = b"b" if payload[position:position+1] == b"a" else b"a"
            target.write_bytes(payload[:position] + replacement + payload[position+1:])
            assert target.stat().st_size == len(payload)
            changed.append(True)
        return payload
    monkeypatch.setattr(manifest_module, "_read_regular_file", read)
    forbidden = _forbid_store_source_phase(monkeypatch)
    with pytest.raises(manifest_module.ManifestIntegrityError) as error:
        manifest_store.load_many(refs)
    assert isinstance(error.value.__cause__, batch.ManifestBatchIntegrityError)
    assert changed == [True]
    assert forbidden == []


@pytest.mark.parametrize("phase", ["before-check", "before-open", "before-read"])
def test_store_safe_read_growth_bounded_va_dong_handle(tmp_path, monkeypatch, phase):
    from app.core import nesting_manifest_store as manifest_module
    path = tmp_path / "bounded.json"
    original_bytes = b'{"item":"small"}'
    path.write_bytes(original_bytes)
    expected_size = manifest_module._regular_manifest_file_size(path)
    real_open = manifest_module.os.open
    real_fdopen = manifest_module.os.fdopen
    reads = []
    streams = []
    def grow():
        with path.open("ab") as append:
            append.write(b"x" * 512)
    if phase == "before-check":
        grow()
    elif phase == "before-open":
        def opened(value, *args, **kwargs):
            if Path(value) == path:
                grow()
            return real_open(value, *args, **kwargs)
        monkeypatch.setattr(manifest_module.os, "open", opened)
    else:
        class Reader:
            def __init__(self, stream):
                self.stream = stream
            def __enter__(self):
                return self
            def __exit__(self, *args):
                return self.stream.__exit__(*args)
            def fileno(self):
                return self.stream.fileno()
            def read(self, size=-1):
                reads.append(size)
                grow()
                return self.stream.read(size)
        def fdopen(*args, **kwargs):
            stream = real_fdopen(*args, **kwargs)
            streams.append(stream)
            return Reader(stream)
        monkeypatch.setattr(manifest_module.os, "fdopen", fdopen)
    with pytest.raises(manifest_module.ManifestIntegrityError):
        manifest_module._read_regular_file(path, expected_size=expected_size)
    if phase == "before-read":
        assert reads == [expected_size + 1]
        assert streams and all(stream.closed for stream in streams)
