"""PERF (audit 2026-09-07 §TEMPERF.1): gộp cache miss của preview tem bế."""

from __future__ import annotations

import os
import threading
from collections import OrderedDict
from contextlib import contextmanager
from types import SimpleNamespace

import pikepdf
import pytest
from fastapi import HTTPException

from app.api.routes import imposition
from app.core.source_revision import (
    SourceRevisionChangedError,
    capture_source_fingerprint,
)
from tests.license_helpers import PRO_LICENSE


class _ObservedFlights(dict):
    """Quan sát follower đã thấy flight, không phụ thuộc Event/Future nội bộ."""

    def __init__(self):
        super().__init__()
        self.owner_ident = None
        self.expected_followers = 1
        self.followers = set()
        self.followers_seen = threading.Event()

    def _observe(self, value):
        current = threading.get_ident()
        if value is not None and self.owner_ident is not None and current != self.owner_ident:
            self.followers.add(current)
            if len(self.followers) >= self.expected_followers:
                self.followers_seen.set()
        return value

    def get(self, key, default=None):
        return self._observe(super().get(key, default))

    def __getitem__(self, key):
        return self._observe(super().__getitem__(key))


class _ComputeGate:
    """Giữ owner đủ lâu để follower nhập flight; không đòi compute thứ hai."""

    def __init__(self, flights, compute):
        self.flights = flights
        self.compute = compute
        self.entered = threading.Event()
        self.release = threading.Event()
        self.calls = []

    def __call__(self, *args, **kwargs):
        current = threading.get_ident()
        if self.flights.owner_ident is None:
            self.flights.owner_ident = current
        self.calls.append(current)
        self.entered.set()
        assert self.release.wait(8.0), "test chưa nhả owner đang tính layout"
        return self.compute(*args, **kwargs)


def _start_call(callback):
    outcome = {}

    def run():
        try:
            outcome["value"] = callback()
        except BaseException as error:
            outcome["error"] = error

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    return thread, outcome


def _join_calls(calls):
    for thread, _ in calls:
        thread.join(timeout=8.0)
    assert all(not thread.is_alive() for thread, _ in calls), "singleflight bị deadlock"
    return [outcome for _, outcome in calls]


def _run_contended(flights, gate, owner, follower=None, *, followers=2, while_waiting=None):
    """Deadline chỉ thuộc harness: mọi thread được nhả trong cả nhánh assert lỗi."""
    flights.expected_followers = followers
    calls = [_start_call(owner)]
    try:
        assert gate.entered.wait(8.0), "owner chưa vào compute"
        calls.extend(_start_call(follower or owner) for _ in range(followers))
        assert flights.followers_seen.wait(8.0), "follower chưa nhập cùng flight"
        if while_waiting is not None:
            while_waiting()
    finally:
        gate.release.set()
        outcomes = _join_calls(calls)
    return outcomes


@pytest.fixture
def layout_source(tmp_path):
    """Helper chỉ đọc identity nguồn; ca API bên dưới tạo PDF thật riêng."""
    source = tmp_path / "nguon-cache.pdf"
    source.write_bytes(b"nguon cho kiem thu singleflight")
    return source, capture_source_fingerprint(source)


@pytest.fixture
def isolated_layout_cache(monkeypatch):
    """Không chia sẻ cache/in-flight giữa các ca hoặc với test bên cạnh."""
    cache = OrderedDict()
    monkeypatch.setattr(imposition, "_NEST_A_CACHE", cache)
    monkeypatch.setattr(imposition, "_NEST_A_INFLIGHT", _ObservedFlights(), raising=False)
    monkeypatch.setattr(imposition, "_NEST_CACHE_LOCK", threading.RLock())
    return cache


def _lookup(key, compute, fingerprint):
    return imposition._get_or_compute_sticker_layout(
        key, compute, source_fingerprint=fingerprint,
    )


def test_cache_hit_reuses_layout_without_sharing_nested_data(
    layout_source, isolated_layout_cache,
):
    """Owner, cache và lượt hit phải sở hữu riêng cả danh sách lồng nhau."""
    _, fingerprint = layout_source
    raw = {"items": [{"x": 3.0, "points": [[1.0, 2.0]]}], "totalItems": 1}
    calls = []

    def compute():
        calls.append(True)
        return raw

    first, first_reused = _lookup(("cung-khoa",), compute, fingerprint)
    second, second_reused = _lookup(("cung-khoa",), compute, fingerprint)
    first["items"][0]["points"][0][0] = 99.0
    raw["items"][0]["x"] = 88.0
    third, third_reused = _lookup(("cung-khoa",), compute, fingerprint)

    assert calls == [True]
    assert (first_reused, second_reused, third_reused) == (False, True, True)
    assert second == third == {
        "items": [{"x": 3.0, "points": [[1.0, 2.0]]}], "totalItems": 1,
    }
    assert first is not second
    assert second["items"][0]["points"] is not third["items"][0]["points"]
    assert imposition._NEST_A_INFLIGHT == {}


def test_same_key_concurrent_callers_compute_once_and_own_separate_results(
    layout_source, isolated_layout_cache,
):
    """Ba request cùng khóa chỉ tính một lần, không chia sẻ dữ liệu ô tem."""
    _, fingerprint = layout_source
    flights = imposition._NEST_A_INFLIGHT
    gate = _ComputeGate(flights, lambda: {"items": [{"points": [[1.0, 2.0]]}]})
    outcomes = _run_contended(
        flights, gate, lambda: _lookup((fingerprint, "chung"), gate, fingerprint),
    )

    assert len(gate.calls) == 1
    assert all("error" not in outcome for outcome in outcomes)
    assert [outcome["value"][1] for outcome in outcomes] == [False, True, True]
    values = [outcome["value"][0] for outcome in outcomes]
    values[0]["items"][0]["points"][0][0] = 42.0
    values[1]["items"][0]["points"].append([7.0, 8.0])
    assert values[2] == {"items": [{"points": [[1.0, 2.0]]}]}
    assert next(iter(isolated_layout_cache.values())) == values[2]
    assert flights == {}


def test_different_keys_compute_concurrently_without_holding_global_lock(
    layout_source, isolated_layout_cache,
):
    """Barrier hai owner chỉ hoàn tất nếu compute không giữ khóa toàn cục."""
    _, fingerprint = layout_source
    barrier = threading.Barrier(2, timeout=5.0)

    def compute(label):
        barrier.wait()
        return {"items": [], "label": label}

    calls = [
        _start_call(lambda label=label: _lookup(
            (fingerprint, label), lambda: compute(label), fingerprint,
        ))
        for label in ("khổ-A", "khổ-B")
    ]
    outcomes = _join_calls(calls)

    assert all("error" not in outcome for outcome in outcomes)
    assert [outcome["value"] for outcome in outcomes] == [
        ({"items": [], "label": "khổ-A"}, False),
        ({"items": [], "label": "khổ-B"}, False),
    ]
    assert len(isolated_layout_cache) == 2
    assert imposition._NEST_A_INFLIGHT == {}


class _OwnerAborted(BaseException):
    """Mô phỏng ngắt owner ngoài nhánh Exception thông thường."""


@pytest.mark.parametrize("error_type", [ValueError, InterruptedError, _OwnerAborted])
def test_owner_failure_wakes_all_followers_and_allows_retry(
    layout_source, isolated_layout_cache, error_type,
):
    """Lỗi hoặc ngắt owner không để follower treo, không làm cache lỗi vĩnh viễn."""
    _, fingerprint = layout_source
    flights = imposition._NEST_A_INFLIGHT

    def fail():
        raise error_type("lỗi owner thử nghiệm")

    gate = _ComputeGate(flights, fail)
    key = (fingerprint, "thử-lại")
    outcomes = _run_contended(flights, gate, lambda: _lookup(key, gate, fingerprint))

    assert len(gate.calls) == 1
    assert all(isinstance(outcome.get("error"), error_type) for outcome in outcomes)
    assert all(str(outcome["error"]) == "lỗi owner thử nghiệm" for outcome in outcomes)
    assert flights == {}
    assert isolated_layout_cache == {}
    assert _lookup(key, lambda: {"items": []}, fingerprint) == ({"items": []}, False)


def test_snapshot_copy_failure_also_unblocks_followers(
    layout_source, isolated_layout_cache,
):
    """Không chỉ solver: deepcopy lỗi trước publication cũng phải dọn flight."""
    _, fingerprint = layout_source
    flights = imposition._NEST_A_INFLIGHT

    class Uncopyable:
        def __deepcopy__(self, memo):
            raise ValueError("không sao chép được layout thử nghiệm")

    gate = _ComputeGate(flights, lambda: {"items": [], "bad": Uncopyable()})
    key = (fingerprint, "copy-error")
    outcomes = _run_contended(flights, gate, lambda: _lookup(key, gate, fingerprint))

    assert len(gate.calls) == 1
    assert all(isinstance(outcome.get("error"), ValueError) for outcome in outcomes)
    assert flights == {}
    assert isolated_layout_cache == {}
    assert _lookup(key, lambda: {"items": []}, fingerprint)[1] is False


def test_same_thread_recursive_key_fails_without_waiting_on_itself(
    layout_source, isolated_layout_cache,
):
    """Hàng rào đệ quy phải ném lỗi thay vì chờ chính owner trong cùng thread."""
    _, fingerprint = layout_source
    key = (fingerprint, "đệ-quy")

    def recursive():
        return _lookup(key, lambda: {"items": []}, fingerprint)[0]

    outcomes = _join_calls([_start_call(lambda: _lookup(key, recursive, fingerprint))])
    assert isinstance(outcomes[0].get("error"), RuntimeError)
    assert imposition._NEST_A_INFLIGHT == {}
    assert isolated_layout_cache == {}
    assert _lookup(key, lambda: {"items": []}, fingerprint)[1] is False


def test_same_thread_may_compute_an_independent_key(layout_source, isolated_layout_cache):
    """Chống đệ quy chỉ áp cùng khóa; khóa độc lập không bị khóa oan."""
    _, fingerprint = layout_source

    def outer():
        inner, reused = _lookup((fingerprint, "trong"), lambda: {"items": []}, fingerprint)
        assert reused is False
        return {"items": [], "inner": inner}

    result, reused = _lookup((fingerprint, "ngoài"), outer, fingerprint)
    assert result == {"items": [], "inner": {"items": []}}
    assert reused is False
    assert len(isolated_layout_cache) == 2


@pytest.mark.parametrize("warm_cache", [False, True], ids=["cache-miss", "cache-hit"])
def test_changed_source_rejected_before_cache_or_compute(
    layout_source, isolated_layout_cache, warm_cache,
):
    """Revision cũ không được nhận hit hay khởi động compute mới."""
    source, fingerprint = layout_source
    key = (fingerprint, "nguồn-cũ")
    calls = []

    def compute():
        calls.append(True)
        return {"items": []}

    if warm_cache:
        _lookup(key, compute, fingerprint)
    before = len(calls)
    source.write_bytes(b"noi dung revision moi dai hon ban dau")

    with pytest.raises(SourceRevisionChangedError):
        _lookup(key, compute, fingerprint)
    assert len(calls) == before
    assert imposition._NEST_A_INFLIGHT == {}


def test_revision_change_rejects_old_owner_and_followers_but_new_key_runs(
    layout_source, isolated_layout_cache,
):
    """Nguồn đổi giữa compute: không cache/trả bản cũ, revision mới không chờ nó."""
    source, fingerprint = layout_source
    flights = imposition._NEST_A_INFLIGHT
    old_key = (fingerprint, "layout")
    gate = _ComputeGate(flights, lambda: {"items": [], "revision": "cũ"})
    fresh = {}
    fresh_calls = []

    def replace_source():
        source.write_bytes(b"revision moi hoan toan khac nguon cu")
        new_fingerprint = capture_source_fingerprint(source)
        assert new_fingerprint != fingerprint
        fresh["key"] = (new_fingerprint, "layout")
        fresh_calls.append(_start_call(lambda: _lookup(
            fresh["key"], lambda: {"items": [], "revision": "mới"}, new_fingerprint,
        )))
        fresh_outcome = _join_calls(fresh_calls)[0]
        assert "error" not in fresh_outcome
        fresh["value"] = fresh_outcome["value"]

    try:
        outcomes = _run_contended(
            flights, gate, lambda: _lookup(old_key, gate, fingerprint),
            while_waiting=replace_source,
        )
    finally:
        _join_calls(fresh_calls)

    assert len(gate.calls) == 1
    assert all(isinstance(outcome.get("error"), SourceRevisionChangedError) for outcome in outcomes)
    assert fresh["value"] == ({"items": [], "revision": "mới"}, False)
    assert old_key not in isolated_layout_cache
    assert list(isolated_layout_cache) == [fresh["key"]]
    assert flights == {}


def test_source_change_during_cache_copy_is_rejected(
    monkeypatch, layout_source, isolated_layout_cache,
):
    """Guard cuối phải đọc lại revision sau thao tác sao chép, không chỉ trước hit."""
    source, fingerprint = layout_source
    key = (fingerprint, "copy-fence")
    _lookup(key, lambda: {"items": [{"x": 1.0}]}, fingerprint)
    real_copy = imposition._copy_mod.deepcopy
    copying = threading.Event()
    release = threading.Event()

    def paused_copy(value, *args, **kwargs):
        copying.set()
        assert release.wait(8.0), "test chưa nhả deepcopy"
        return real_copy(value, *args, **kwargs)

    monkeypatch.setattr(imposition, "_copy_mod", SimpleNamespace(deepcopy=paused_copy))
    call = _start_call(lambda: _lookup(key, lambda: pytest.fail("cache phải hit"), fingerprint))
    try:
        assert copying.wait(8.0)
        source.write_bytes(b"revision moi xuat hien trong khi copy ket qua")
    finally:
        release.set()
        outcomes = _join_calls([call])

    assert isinstance(outcomes[0].get("error"), SourceRevisionChangedError)
    assert imposition._NEST_A_INFLIGHT == {}


@pytest.mark.parametrize(
    "parameter",
    ["compute_w", "compute_h", "gap_x", "gap_y", "bleed_pt", "secondary_gap", "die_offset_mm"],
)
def test_cache_key_keeps_exact_solver_float_values(layout_source, parameter):
    """Sai khác dưới 0,001 vẫn đổi placement; khóa không được tự làm tròn mất nó."""
    source, fingerprint = layout_source
    arguments = dict(
        file_path=str(source), mtime=fingerprint, page_idx=0,
        compute_w=100.0, compute_h=100.0, gap_x=1.0, gap_y=1.0,
        strategy="simple_auto", shape_override="RECTANGLE", shape_props={},
        bleed_pt=0.0, secondary_gap=None, cut_type="one_dao", die_size_mode="page",
        die_offset_mm=0.0, alternate_rotation="none",
    )
    low = imposition._sticker_nest_cache_key(**{**arguments, parameter: 1.0001})
    high = imposition._sticker_nest_cache_key(**{**arguments, parameter: 1.0004})
    assert low != high


def _real_preview_requests(tmp_path):
    """PDF thật hai khuôn độc lập; trang xoay đi qua chuẩn hóa của cả hai route."""
    source = tmp_path / "hai-khuon-singleflight.pdf"
    with pikepdf.Pdf.new() as pdf:
        for index, (width, height) in enumerate(((200, 100), (140, 110))):
            page = pdf.add_blank_page(page_size=(width, height))
            if index == 0:
                page.obj[pikepdf.Name("/Rotate")] = 90
            page.obj[pikepdf.Name("/Contents")] = pdf.make_stream(
                f"0 1 0 0 K 0.5 w 10 10 {width - 20} {height - 20} re S\n".encode("ascii")
            )
        pdf.save(source)
    common = dict(
        path=str(source), usable_w=500.0, usable_h=400.0,
        sheet_w=520.0, sheet_h=420.0, gap_x=0.0, gap_y=0.0,
        strategy="simple_auto", task_mode="step_repeat", is_die_cut=True,
    )
    page = dict(page_idx=0, item_w=80.0, item_h=180.0, shape_type="RECTANGLE", shape_props={})
    single = imposition.PreviewLayoutRequest(**common, layout_type="repeat", **page)
    batch = imposition.PreviewLayoutBatchRequest(**common, pages=[page])
    return source, single, batch


@pytest.mark.parametrize("follower_kind", ["single", "batch"])
def test_real_preview_routes_share_one_cold_compute(
    tmp_path, monkeypatch, isolated_layout_cache, follower_kind,
):
    """Route thật + PDF/QPDF/solver thật: đơn–đơn và đơn–batch dùng cùng flight."""
    from app.workers import nup_engine, nup_sticker

    source, single, batch = _real_preview_requests(tmp_path)
    original = source.read_bytes()
    monkeypatch.setattr(nup_engine.tempfile, "gettempdir", lambda: str(tmp_path))
    flights = imposition._NEST_A_INFLIGHT
    gate = _ComputeGate(flights, nup_sticker.compute_sticker_layout_for_page)
    monkeypatch.setattr(nup_sticker, "compute_sticker_layout_for_page", gate)
    owner = lambda: imposition.preview_layout(single.model_copy(deep=True), PRO_LICENSE)
    follower = (
        owner if follower_kind == "single"
        else lambda: imposition.preview_layouts_batch(batch.model_copy(deep=True), PRO_LICENSE)
    )
    outcomes = _run_contended(flights, gate, owner, follower, followers=1)

    assert all("error" not in outcome for outcome in outcomes), outcomes
    assert len(gate.calls) == 1
    first, second = [outcome["value"] for outcome in outcomes]
    assert first["success"] is True
    assert first["cells"]
    if follower_kind == "single":
        assert first == second
    else:
        assert second["success"] is True
        assert second["capacities"] == {0: len(first["cells"])}
    assert len(isolated_layout_cache) == 1
    assert flights == {}
    assert source.read_bytes() == original
    assert list(tmp_path.glob("nup_canon_*.pdf")) == []


@pytest.mark.parametrize("route_kind", ["single", "batch"])
def test_real_routes_report_source_revision_change_as_conflict(
    tmp_path, monkeypatch, isolated_layout_cache, route_kind,
):
    """Lỗi revision phải là 409; batch không được nuốt rồi trả sức chứa 0 thành công."""
    from app.workers import nup_engine

    source, single, batch = _real_preview_requests(tmp_path)
    original = source.read_bytes()
    monkeypatch.setattr(nup_engine.tempfile, "gettempdir", lambda: str(tmp_path))

    def changed_source(*args, **kwargs):
        raise SourceRevisionChangedError("nguồn thử nghiệm đã đổi revision")

    monkeypatch.setattr(imposition, "_get_or_compute_sticker_layout", changed_source)
    with pytest.raises(HTTPException) as raised:
        if route_kind == "single":
            imposition.preview_layout(single, PRO_LICENSE)
        else:
            imposition.preview_layouts_batch(batch, PRO_LICENSE)

    assert raised.value.status_code == 409
    assert source.read_bytes() == original
    assert list(tmp_path.glob("nup_canon_*.pdf")) == []
    assert isolated_layout_cache == {}


@pytest.mark.parametrize("route_kind", ["single", "batch"])
def test_source_revision_captured_before_real_canonicalization(
    tmp_path, monkeypatch, isolated_layout_cache, route_kind,
):
    """Không gắn hình học canonical đã đọc vào revision nguồn vừa đổi sau đó."""
    from app.workers import nup_engine, nup_sticker

    source, single, batch = _real_preview_requests(tmp_path)
    original = source.read_bytes()
    before = capture_source_fingerprint(source)
    canonical_paths = []
    compute_calls = []
    real_canonical = nup_engine.canonical_page_space
    monkeypatch.setattr(nup_engine.tempfile, "gettempdir", lambda: str(tmp_path))

    @contextmanager
    def source_changed_after_materialize(path, *args, **kwargs):
        with real_canonical(path, *args, **kwargs) as canonical:
            assert canonical != str(source), "fixture xoay phải tạo PDF canonical thật"
            canonical_paths.append(canonical)
            stat = source.stat()
            # Chỉ đổi metadata trong fixture; không ghi vào stream PDF đang mở.
            os.utime(source, ns=(stat.st_atime_ns, stat.st_mtime_ns + 10_000_000))
            yield canonical

    def unexpected_compute(*args, **kwargs):
        compute_calls.append(True)
        pytest.fail("revision đã đổi trước compute, phải từ chối ngay")

    monkeypatch.setattr(nup_engine, "canonical_page_space", source_changed_after_materialize)
    monkeypatch.setattr(nup_sticker, "compute_sticker_layout_for_page", unexpected_compute)
    with pytest.raises(HTTPException) as raised:
        if route_kind == "single":
            imposition.preview_layout(single, PRO_LICENSE)
        else:
            imposition.preview_layouts_batch(batch, PRO_LICENSE)

    assert raised.value.status_code == 409
    assert len(canonical_paths) == 1
    assert capture_source_fingerprint(source) != before
    assert compute_calls == []
    assert source.read_bytes() == original
    assert list(tmp_path.glob("nup_canon_*.pdf")) == []
    assert isolated_layout_cache == {}
    assert imposition._NEST_A_INFLIGHT == {}


@pytest.mark.parametrize(
    ("pont_config", "is_cluster"),
    [
        (None, False),
        ({"disableCollision": True}, False),
        ({"disableCollision": False}, False),
        ({"disableCollision": False}, True),
    ],
    ids=["no-pont", "disabled-pont", "active-pont", "cluster-active-pont"],
)
def test_warm_batch_opens_worker_documents_only_when_collision_needs_geometry(
    tmp_path, monkeypatch, isolated_layout_cache, pont_config, is_cluster,
):
    """Hit chỉ đếm ô không mở QPDF thừa; né ốc thật vẫn nhận đúng Page của worker."""
    from app.workers import nup_engine, nup_sticker, pdf_wrapper

    source, _, original_batch = _real_preview_requests(tmp_path)
    original = source.read_bytes()
    request_data = {
        **original_batch.model_dump(),
        "pages": [
            original_batch.pages[0],
            dict(page_idx=1, item_w=120.0, item_h=90.0, shape_type="RECTANGLE", shape_props={}),
        ],
        "pont_config": pont_config,
    }
    if is_cluster:
        request_data.update(task_mode="sticker_imposer", grouping_strategy="cluster_tile")
    batch = imposition.PreviewLayoutBatchRequest(**request_data)
    monkeypatch.setattr(nup_engine.tempfile, "gettempdir", lambda: str(tmp_path))
    cold = imposition.preview_layouts_batch(batch.model_copy(deep=True), PRO_LICENSE)
    assert cold["success"] is True
    assert set(cold["capacities"]) == {0, 1}
    assert all(capacity > 0 for capacity in cold["capacities"].values())
    assert len(isolated_layout_cache) == 2, "phải prime hai nhóm độc lập, không broadcast master"

    main_ident = threading.get_ident()
    opened = []
    capacity_calls = []
    compute_calls = []
    real_open = pdf_wrapper.open
    real_capacity = imposition._sticker_capacity_after_pont

    def tracked_open(path=None, *args, **kwargs):
        document = real_open(path, *args, **kwargs)
        record = dict(document=document, thread=threading.get_ident(), path=path, closed=False)
        opened.append(record)
        real_close = document.close

        def tracked_close():
            try:
                return real_close()
            finally:
                record["closed"] = True

        document.close = tracked_close
        return document

    needs_page = bool(pont_config) and not pont_config.get("disableCollision", False) and not is_cluster

    def tracked_capacity(layout_result, req, page, page_idx, shape_override, **kwargs):
        record = dict(page_idx=page_idx, thread=threading.get_ident(), document=None)
        if needs_page:
            assert isinstance(page, pdf_wrapper.Page), "né ốc đang bật phải nhận Page thật"
            assert page.rect.width > 0 and page.rect.height > 0
            record["document"] = page.doc
        else:
            assert page is None, "cache hit không né ốc phải giữ nguồn ở trạng thái chưa mở"
        capacity_calls.append(record)
        return real_capacity(layout_result, req, page, page_idx, shape_override, **kwargs)

    def unexpected_compute(*args, **kwargs):
        compute_calls.append(True)
        pytest.fail("batch warm không được tính raw layout lần nữa")

    monkeypatch.setattr(pdf_wrapper, "open", tracked_open)
    monkeypatch.setattr(imposition, "_sticker_capacity_after_pont", tracked_capacity)
    monkeypatch.setattr(nup_sticker, "compute_sticker_layout_for_page", unexpected_compute)
    warm = imposition.preview_layouts_batch(batch.model_copy(deep=True), PRO_LICENSE)

    assert warm == cold
    assert compute_calls == []
    assert len(capacity_calls) == 2
    assert all(call["thread"] != main_ident for call in capacity_calls)
    root_documents = [record for record in opened if record["thread"] == main_ident]
    worker_documents = [record for record in opened if record["thread"] != main_ident]
    assert len(root_documents) == 1
    if needs_page:
        assert len(worker_documents) == 2
        assert len({id(record["document"]) for record in worker_documents}) == 2
        assert {id(record["document"]) for record in worker_documents} == {
            id(call["document"]) for call in capacity_calls
        }
    else:
        assert worker_documents == []
    assert all(record["closed"] for record in opened)
    assert source.read_bytes() == original
    assert list(tmp_path.glob("nup_canon_*.pdf")) == []
    assert imposition._NEST_A_INFLIGHT == {}
