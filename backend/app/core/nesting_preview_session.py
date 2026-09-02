"""Giữ phiên nesting đã solve để preview và export dùng CHUNG một lượt giải.

NEST (audit 2026-08-28 §A4b-5). Đây là phương án (c) chủ dự án đã duyệt cho finding
**A4b-4a** (preview lệch export).

## Vấn đề

Cột "Tem/tờ" và tờ bình thật phải bằng nhau — bất biến "preview ≡ output" của dự án.
Với lưới grid, hai bên bằng nhau vì gọi **cùng** `compute_sticker_layout_for_page`.
Nesting phá cấu trúc đó: export đi solver Rust, preview còn ở nhánh lưới ⇒ hai số khác nhau.

Cho preview gọi nesting mỗi lần gõ thì không được: tính lưới xong trong vài chục ms và
preview debounce 350ms, còn nesting là **tìm kiếm** với ngân sách 30k/100k/300k lượt thử
pose (fast/balanced/tight) — cỡ vài giây cho job nhỏ.

## Cách làm

Giải **một lần**, giữ phiên, rồi lấy cùng phiên đó ra cho cả hai việc::

    đổi thiết lập → get_or_solve(job) ─┬→ capacity_of(session)  → cột Tem/tờ
                                       └→ render(session)       → file bình

Tính đúng đắn đã có test khoá sẵn ở `test_nesting_production_pipeline.py`: giải một lần
rồi render hai file cho **cùng** `layoutFingerprint`, cùng `renderBundleHash`, và từng
trang giống nhau tới byte. Ngược lại, gọi pipeline hai lượt thì **không thể** trùng, vì mỗi
`pin_pdf_path` sinh locator mới. Đó chính là lý do phải giữ phiên thay vì gọi lại.

## Vì sao phải tự dọn pin

`solve_production_nesting_job` chỉ thu hồi pin ở nhánh **lỗi**; solve thành công thì phiên
giữ pin sống — nhờ vậy mới render lại được. Hệ quả: ai giữ phiên thì phải thu hồi pin khi
bỏ phiên, nếu không snapshot nằm lại trên đĩa cho tới khi TTL dọn.
"""

from __future__ import annotations

import logging
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any, Callable, Mapping, Sequence

from app.core.nesting_quality_gate import (
    QUALITY_GATE_PROOF_FIELD,
    parse_quality_gate_decision_proof,
)
from app.core.source_revision import SourceFingerprint, capture_source_fingerprint

logger = logging.getLogger(__name__)


# Separator nội bộ để một preview S&R đăng ký nhiều subscriber con mà thao tác hủy
# theo job cha vẫn tách được toàn bộ wave. Ký tự control tránh đụng job_id UUID thường.
_BATCH_SUBSCRIBER_SEPARATOR = "\x1f"


def step_repeat_subscriber_id(parent_id: str | None, design_index: int) -> str | None:
    """Identity subscriber riêng cho từng mẫu, vẫn hủy được theo job preview cha."""

    if parent_id is None:
        return None
    return f"{parent_id}{_BATCH_SUBSCRIBER_SEPARATOR}{int(design_index)}"


def preview_session_capacity_for_ram(total_ram_mb: float | None) -> int:
    """Số phiên giữ nóng, gate theo RAM máy.

    Một phiên giữ snapshot nguồn cộng manifest, nên không phải thứ giữ vô hạn. Theo
    quy tắc dự án: chỉ máy yếu mới giảm, máy ≥16GB không bị trần cố định. Không đọc
    RAM trong hàm này để test phủ đủ bậc mà không phụ thuộc máy chạy.
    """

    if total_ram_mb is None or total_ram_mb <= 0:
        return 2
    if total_ram_mb < 8 * 1024:
        return 1
    if total_ram_mb < 16 * 1024:
        return 3
    return max(6, int(total_ram_mb // 4096))


def _default_capacity() -> int:
    from app.core.system_memory import read_memory_status_mb

    total_ram_mb, _available_ram_mb = read_memory_status_mb()
    return preview_session_capacity_for_ram(total_ram_mb)


def _gap_key(gap: Any) -> tuple[float, float]:
    return (float(getattr(gap, "x_mm", 0.0)), float(getattr(gap, "y_mm", 0.0)))


def _placement_zone_key(zone: Any) -> tuple[str, float, float, float, float]:
    """Khoá canonical của association zone; thứ tự mảng không mang semantics."""

    bounds = getattr(zone, "bounds")
    return (
        str(getattr(zone, "part_id")),
        float(getattr(bounds, "min_x_mm")),
        float(getattr(bounds, "min_y_mm")),
        float(getattr(bounds, "max_x_mm")),
        float(getattr(bounds, "max_y_mm")),
    )


def _detected_shape_key(shape: Any) -> Any:
    """Khoá của khuôn CNC đã dò. Lấy đúng ĐƯỜNG BAO, không lấy id object.

    Dùng `id()` hay `repr()` sẽ cho hai lần dò cùng một file ra hai khoá khác nhau,
    làm cache không bao giờ hit ở lane CNC.
    """

    if shape is None:
        return None
    contour = getattr(shape, "page_contour", None)
    if contour is None:
        # Không có đường bao thì pipeline sẽ fail-closed; giữ khoá thô để không
        # gộp nhầm với phiên hợp lệ.
        return ("no-contour", int(getattr(shape, "page", -1)))
    return (
        int(getattr(contour, "page_index", -1)),
        tuple(contour.outer_top_down_user_units),
        tuple(contour.holes_top_down_user_units),
    )


def _fingerprint_key(fingerprint: SourceFingerprint) -> tuple:
    return (
        fingerprint.normalized_path,
        fingerprint.size,
        fingerprint.mtime_ns,
        fingerprint.device,
        fingerprint.inode,
    )


def job_identity_key(job: Any) -> tuple:
    """Nhận dạng job **trước khi** solve, đủ để tái dùng phiên an toàn.

    `inputHash` của contract là nhận dạng đúng nhất, nhưng nó chỉ có SAU khi đã pin
    nguồn và resolve hình học — dùng nó làm khoá cache thì mỗi lượt preview vẫn phải
    pin, tức mất phần lớn cái muốn tiết kiệm.

    Khoá này gồm **mọi** field ảnh hưởng layout, cộng `SourceFingerprint` của từng
    nguồn. Độ tin cậy về tươi mới bằng đúng hàng rào revision mà `_launch_impose_job`
    đang dùng cho toàn bộ job N-Up (`capture_source_fingerprint` +
    `assert_source_fingerprint`), nên không phải cơ chế yếu hơn dựng riêng.

    Cố ý **không** đưa `manifest_id` vào khoá: hai lượt cùng đầu vào phải hit dù ID
    khác nhau. Cũng không đưa `request_revision` vì nó không đổi hình học.

    FIX (audit 2026-08-29 §NEST-AUD-06): khoá phải phủ `trim/pont/cut/cut_style`
    và phần `export_unique_sheets` của artifact options vì chúng đổi vật cản, nội dung
    nền hoặc cấu trúc trang. Riêng report được tách khỏi identity từ lô
    §REPORT-OVERLAY: writer nhận report canonical mới nhất sau khi đã xác thực bundle
    và placements cũ, kèm fingerprint artifact riêng.

    Trước lô §NEST-PREVIEW-1 điều này còn tiềm ẩn vì chưa ai tạo phiên từ preview. Từ khi
    preview tạo phiên và export tái dùng, nó thành lỗi thật.

    Cách sửa cố ý dùng `dataclasses.asdict` chứ **không** liệt kê tay từng field: thêm một
    field mới vào bất kỳ spec nào là tự động vào khoá. Liệt kê tay chính là cách sinh ra bug
    này ngay từ đầu.
    """

    parts = []
    for part in job.parts:
        parts.append(
            (
                str(part.part_id),
                int(part.page_index),
                None if part.quantity is None else int(part.quantity),
                None if part.back_page_index is None else int(part.back_page_index),
                _fingerprint_key(capture_source_fingerprint(part.source_path)),
                _detected_shape_key(part.detected_shape),
            )
        )
    margin = job.margin_mm or {}
    return (
        str(job.tool),
        str(job.layout_intent),
        float(job.sheet_width_mm),
        float(job.sheet_height_mm),
        tuple(parts),
        tuple(sorted((str(k), float(v)) for k, v in margin.items())),
        int(job.max_sheets),
        int(job.seed),
        str(job.profile),
        None if job.time_budget_ms is None else int(job.time_budget_ms),
        # NEST (audit 2026-08-29 §NEST-CENTER-1): align đổi pose authoritative sau
        # solve. Thiếu nó sẽ tái dùng phiên center cho top-left (hoặc ngược lại).
        str(getattr(job, "align", "center")),
        # PARITY (audit 2026-08-29 §MAP-NEST-04): free gang và Chia đều diện
        # tích không được dùng chung phiên; reorder zone tương đương vẫn phải hit.
        str(job.grouping_intent),
        tuple(sorted(_placement_zone_key(zone) for zone in job.placement_zones)),
        _gap_key(job.part_gap),
        _gap_key(job.sheet_edge_gap),
        None if job.obstacle_gap is None else _gap_key(job.obstacle_gap),
        tuple(
            tuple(sorted((str(k), repr(v)) for k, v in dict(obstacle).items()))
            for obstacle in (job.fixed_obstacles or ())
        ),
        str(job.duplex_mode),
        str(job.flip_edge),
        bool(job.duplex_registration),
        _render_spec_key(job),
    )


def _render_spec_key(job: Any) -> tuple[tuple[str, str], ...]:
    """Khoá cho toàn bộ spec gia công/render của job.

    FIX (audit 2026-08-29 §NEST-AUD-06). Xem docstring `job_identity_key` để biết vì sao.

    Dùng `dataclasses.asdict` + JSON sắp khoá để đệ quy vào dataclass lồng nhau
    (`pont.config`, `pont.config.guides`). `default=repr` để một giá trị lạ không
    làm vỡ khoá — thà miss cache còn hơn chia nhầm một phiên.
    """

    import dataclasses
    import json

    def _canonical(value: Any) -> str:
        payload = dataclasses.asdict(value) if dataclasses.is_dataclass(value) else value
        return json.dumps(
            payload, sort_keys=True, separators=(",", ":"), default=repr, ensure_ascii=False
        )

    values: list[tuple[str, str]] = []
    for name in ("trim", "pont", "cut", "cut_style"):
        values.append((name, _canonical(getattr(job, name))))

    artifact_options = getattr(job, "artifact_options")
    # PERF (audit 2026-09-02 §REPORT-OVERLAY): report là metadata đóng dấu SAU
    # khi writer đã materialize placements. Giữ riêng lựa chọn đổi cấu trúc output
    # (export_unique_sheets), bỏ report khỏi layout cache. Quantity N-Up vẫn nằm
    # trong `parts`; chỉ S&R cố ý bỏ trị số quantity vì luôn xếp một tờ đại diện.
    values.append(
        (
            "artifact_options",
            _canonical(
                {
                    "export_unique_sheets": getattr(
                        artifact_options, "export_unique_sheets", None
                    )
                }
            ),
        )
    )
    return tuple(values)


def session_capacity(session: Any) -> int:
    """Số mẫu xếp được của phiên — chính con số cột "Tem/tờ" cần."""

    stats = session.solved.manifest.get("stats") or {}
    return int(stats.get("placedCount") or 0)


def session_sheet_count(session: Any) -> int:
    stats = session.solved.manifest.get("stats") or {}
    return int(stats.get("sheetCount") or 0)


@dataclass(frozen=True, slots=True)
class PreviewSessionLookup:
    """Kết quả tra phiên. `reused` để test và log phân biệt hit với miss."""

    session: Any
    reused: bool


@dataclass(slots=True)
class _InFlightSolve:
    """Một lượt solve dùng chung; subscriber cuối rời mới hủy native."""

    completed: threading.Event
    shared_cancel_event: threading.Event
    subscribers: set[object]
    callbacks: dict[object, Callable[[Mapping[str, Any]], None]]
    progress: dict[str, Any] | None = None
    session: Any | None = None
    error: BaseException | None = None


@dataclass(slots=True)
class _InFlightReferenceBatch:
    """Chốt handoff trong lúc preview S&R đang công bố nhiều manifest."""

    key: tuple
    job_count: int
    completed: threading.Event
    publishers: int = 0
    error: BaseException | None = None
    references: tuple[dict[str, Any], ...] | None = None
    restore_completed: threading.Event | None = None
    restore_started: bool = False
    restored_sessions: dict[tuple, Any] | None = None
    # PERF (audit 2026-09-02 §PERF-NEST-10): giữ các phiên nóng trong LRU khỏi bị
    # eviction suốt publication, nhưng không chép session/pin vào state tạm. Nhờ đó
    # state chỉ giữ identity key; lease vẫn thuộc entry nóng như trước.
    protected_hot_keys: tuple[tuple, ...] = ()


@dataclass(frozen=True, slots=True)
class _DetachedPreviewSource:
    """Binding tối thiểu của source đã được kho manifest xác minh đầy đủ."""

    locator_id: str
    content_hash: str
    snapshot_path: Any


@dataclass(frozen=True, slots=True)
class _RehydratedPreviewSession:
    """Phiên chỉ sống trong một batch preview, không sở hữu pin/lease token."""

    solved: Any
    source_pins: tuple[_DetachedPreviewSource, ...]
    authoritative_manifest_id: str
    authoritative_layout_fingerprint: str

    @property
    def manifest_id(self) -> str:
        return str(self.solved.manifest.get("manifestId"))

    @property
    def layout_fingerprint(self) -> str:
        return str(self.solved.production_request.layout_fingerprint)


class NestingPreviewWaitTimeout(TimeoutError):
    """Hết thời gian chờ một lượt preview đang chạy."""


def _cancel_requested(value: Any) -> bool:
    if value is None:
        return False
    if callable(value) and not hasattr(value, "is_set"):
        return bool(value())
    checker = getattr(value, "is_set", None)
    return bool(checker()) if callable(checker) else bool(value)


class NestingPreviewSessionStore:
    """Kho phiên nesting theo LRU, có trần theo RAM và tự thu hồi pin khi loại.

    An toàn theo thread: preview tới từ event loop FastAPI còn export chạy trong
    executor, hai bên có thể tra cùng lúc.
    """

    def __init__(
        self,
        *,
        capacity: int | None = None,
        solver: Callable[..., Any] | None = None,
        pin_discarder: Callable[[Any], None] | None = None,
        reference_loader: Callable[[Sequence[Mapping[str, Any]]], Any] | None = None,
    ) -> None:
        self._capacity = int(capacity) if capacity is not None else _default_capacity()
        if self._capacity < 1:
            raise ValueError("capacity phải ≥ 1.")
        self._solver = solver
        self._pin_discarder = pin_discarder
        self._reference_loader = reference_loader
        self._lock = threading.RLock()
        self._entries: OrderedDict[tuple, Any] = OrderedDict()
        # PERF (audit 2026-09-02 §PERF-NEST-05): ngoài hai chuỗi identity, reference
        # được giữ thêm proof nhỏ chỉ gồm scalar. Manifest/source thật vẫn ở kho đĩa,
        # không lách trần RAM session; reference cũ hai field vẫn hợp lệ nguyên trạng.
        self._reference_batches: OrderedDict[
            tuple, tuple[dict[str, Any], ...]
        ] = OrderedDict()
        # PERF (audit 2026-09-02 §PERF-NEST-05): proof quality gate là metadata nhỏ
        # gắn với đúng session key; không giữ geometry/source pin thêm một lần.
        self._quality_gate_proofs: OrderedDict[tuple, dict[str, Any]] = OrderedDict()
        # PERF (audit 2026-09-01 §PERF-NEST-01): callback publication S&R chạy
        # ngoài global lock. Key được bảo vệ tạm thời để wave sau không làm LRU thu
        # hồi source pin trước khi manifest của wave hiện tại đã commit xong.
        self._protected_keys: dict[tuple, int] = {}
        self._reference_batch_inflight: dict[tuple, _InFlightReferenceBatch] = {}
        self._inflight: dict[tuple, _InFlightSolve] = {}
        self._subscriber_inflight: dict[str, tuple[_InFlightSolve, object]] = {}

    @property
    def capacity(self) -> int:
        return self._capacity

    def __len__(self) -> int:
        with self._lock:
            return len(self._entries)

    def _solve(self, job, **kwargs):
        if self._solver is not None:
            return self._solver(job, **kwargs)
        from app.core.nesting_production_pipeline import solve_production_nesting_job

        return solve_production_nesting_job(job, **kwargs)

    def _discard(self, session: Any) -> None:
        """Thu hồi snapshot của phiên bị loại. Lỗi dọn không được che lỗi gốc."""

        discarder = self._pin_discarder
        if discarder is None:
            from app.core.nesting_source_pin import discard_source_pin

            discarder = discard_source_pin
        for pin in getattr(session, "source_pins", ()) or ():
            try:
                discarder(pin)
            except Exception:  # pragma: no cover - dọn dẹp là best-effort
                logger.debug("Không thu hồi được pin phiên preview.", exc_info=True)

    def _evict_to_capacity(self) -> None:
        while len(self._entries) > self._capacity:
            evict_key = next(
                (
                    key
                    for key in self._entries
                    if self._protected_keys.get(key, 0) <= 0
                ),
                None,
            )
            if evict_key is None:
                # Chỉ vượt cap trong cửa sổ publication batch. Mỗi callback xong sẽ
                # gọi lại hàm này; không tăng capacity nóng lâu dài của kho phiên.
                return
            evicted = self._entries.pop(evict_key)
            self._quality_gate_proofs.pop(evict_key, None)
            self._discard(evicted)

    def peek(self, job) -> Any | None:
        """Tra phiên đã có, KHÔNG solve. Dùng cho đường chỉ muốn số sẵn có."""

        key = job_identity_key(job)
        with self._lock:
            session = self._entries.get(key)
            if session is not None:
                self._entries.move_to_end(key)
            return session

    @staticmethod
    def _reference_batch_key(jobs: Any) -> tuple:
        return tuple(job_identity_key(job) for job in jobs)

    @staticmethod
    def _session_matches_reference(
        session: Any, reference: Mapping[str, Any]
    ) -> bool:
        """Chỉ coi session nóng là hit khi khớp exact hai identity bền."""

        try:
            manifest_id = getattr(session, "manifest_id")
            layout_fingerprint = getattr(session, "layout_fingerprint")
        except Exception:
            return False
        return (
            isinstance(manifest_id, str)
            and isinstance(layout_fingerprint, str)
            and manifest_id == reference.get("manifestId")
            and layout_fingerprint == reference.get("layoutFingerprint")
        )

    @staticmethod
    def _detach_reference_batch(
        jobs: tuple[Any, ...], references: Any
    ) -> tuple[dict[str, Any], ...]:
        references_tuple = tuple(references)
        if not jobs or len(jobs) != len(references_tuple):
            raise ValueError("Batch reference phải khớp đủ từng job S&R.")
        detached: list[dict[str, Any]] = []
        for reference in references_tuple:
            if not isinstance(reference, Mapping):
                raise ValueError("Reference S&R phải là object.")
            manifest_id = reference.get("manifestId")
            layout_fingerprint = reference.get("layoutFingerprint")
            if not isinstance(manifest_id, str) or not isinstance(
                layout_fingerprint, str
            ):
                raise ValueError("Reference S&R thiếu identity hợp lệ.")
            detached_reference: dict[str, Any] = {
                "manifestId": manifest_id,
                "layoutFingerprint": layout_fingerprint,
            }
            parsed_proof = parse_quality_gate_decision_proof(
                reference.get(QUALITY_GATE_PROOF_FIELD)
            )
            if parsed_proof is not None:
                # Parse + dựng dict mới: caller không thể sửa nested proof sau khi store.
                # Proof méo bị bỏ; export sẽ coi là thiếu và đo lại, không làm hỏng ref cũ.
                detached_reference[QUALITY_GATE_PROOF_FIELD] = parsed_proof.to_dict()
            detached.append(detached_reference)
        return tuple(detached)

    @staticmethod
    def _copy_reference(reference: Mapping[str, Any]) -> dict[str, Any]:
        copied = dict(reference)
        proof = copied.get(QUALITY_GATE_PROOF_FIELD)
        if isinstance(proof, Mapping):
            # Schema proof chỉ có scalar; một dict mới đủ tách quyền sở hữu mutation.
            copied[QUALITY_GATE_PROOF_FIELD] = dict(proof)
        return copied

    def _remember_reference_batch_locked(
        self, key: tuple, references: tuple[dict[str, Any], ...]
    ) -> None:
        self._reference_batches[key] = references
        self._reference_batches.move_to_end(key)
        # Số publication metadata dùng cùng policy RAM với số phiên nóng; mỗi entry
        # chỉ gồm chuỗi, không giữ source pin hoặc geometry.
        while len(self._reference_batches) > self._capacity:
            self._reference_batches.popitem(last=False)

    def remember_reference_batch(
        self, jobs: Any, references: Any
    ) -> None:
        """Giữ batch identity nhẹ cho publication S&R đã spill xuống kho đĩa."""

        jobs_tuple = tuple(jobs)
        detached = self._detach_reference_batch(jobs_tuple, references)
        key = self._reference_batch_key(jobs_tuple)
        with self._lock:
            self._remember_reference_batch_locked(key, detached)

    def peek_reference_batch(self, jobs: Any) -> list[dict[str, Any]] | None:
        """Tra batch đã commit mà không cần giữ các session thành viên trong RAM."""

        key = self._reference_batch_key(tuple(jobs))
        with self._lock:
            references = self._reference_batches.get(key)
            if references is None:
                return None
            self._reference_batches.move_to_end(key)
            return [self._copy_reference(reference) for reference in references]

    def remember_quality_gate_proof(self, job: Any, proof: Any) -> bool:
        """Lưu proof đã parse; proof méo không bao giờ được cache/công bố."""

        parsed = parse_quality_gate_decision_proof(proof)
        if parsed is None:
            return False
        key = job_identity_key(job)
        with self._lock:
            self._quality_gate_proofs[key] = parsed.to_dict()
            self._quality_gate_proofs.move_to_end(key)
            while len(self._quality_gate_proofs) > self._capacity:
                self._quality_gate_proofs.popitem(last=False)
        return True

    def peek_quality_gate_proof(self, job: Any) -> dict[str, Any] | None:
        """Tra proof server đã tạo cho đúng identity; trả bản sao tách quyền sở hữu."""

        key = job_identity_key(job)
        with self._lock:
            proof = self._quality_gate_proofs.get(key)
            if proof is None:
                return None
            self._quality_gate_proofs.move_to_end(key)
            return dict(proof)

    def begin_reference_batch(self, jobs: Any) -> _InFlightReferenceBatch:
        """Đăng ký publication và khôi phục phiên spill cho đúng một wave S&R.

        PERF (audit 2026-09-02 §PERF-NEST-10): batch 13 mẫu trên máy 32 GB có
        capacity nóng 7, nên lượt lặp trước đây solve lại sáu mẫu đã bị LRU loại dù
        manifest bền còn nguyên. Owner nạp ``load_many`` một lần ngoài global lock;
        các publisher trùng identity dùng chung Event. Phiên khôi phục chỉ sống trong
        state của wave, không vào ``_entries`` và không giữ lease token.
        """

        jobs_tuple = tuple(jobs)
        if not jobs_tuple:
            raise ValueError("Batch reference phải có ít nhất một job S&R.")
        key = self._reference_batch_key(jobs_tuple)
        with self._lock:
            state = self._reference_batch_inflight.get(key)
            if state is None:
                state = _InFlightReferenceBatch(
                    key=key,
                    job_count=len(jobs_tuple),
                    completed=threading.Event(),
                    restore_completed=threading.Event(),
                )
                self._reference_batch_inflight[key] = state
            state.publishers += 1
            restore_owner = not state.restore_started
            if restore_owner:
                state.restore_started = True
                references = self._reference_batches.get(key)
                if references is not None:
                    self._reference_batches.move_to_end(key)
                    restore_references = tuple(
                        self._copy_reference(reference) for reference in references
                    )
                    if len(restore_references) != len(jobs_tuple):
                        # Cache metadata bị cắt/méo không được làm rò latch hoặc
                        # khiến zip thiếu phần tử. Bỏ cache và quay về đường solve;
                        # lần finish kế tiếp sẽ ghi lại batch canonical mới.
                        self._reference_batches.pop(key, None)
                        restore_references = None
                        restore_jobs = ()
                        restore_references_subset = ()
                        stale_hot_to_discard = ()
                        state.restore_started = True
                        # Nhảy qua snapshot hot phía dưới bằng nhánh else chung.
                        # `continue` không dùng được trong vùng khởi tạo state.
                    else:
                        # Snapshot hot hits dưới cùng lock với LRU. Chỉ các mẫu chưa có
                        # session nóng (hoặc session có identity lệch) mới đi qua
                        # load_many(); không bỏ qua chốt identity nếu memory cache bị
                        # hỏng/tamper.
                        hot_keys: list[tuple] = []
                        missing_jobs: list[Any] = []
                        missing_references: list[dict[str, Any]] = []
                        stale_hot_sessions: list[Any] = []
                        for job, job_key, reference in zip(
                            jobs_tuple, key, restore_references, strict=True
                        ):
                            hot = self._entries.get(job_key)
                            if hot is not None and self._session_matches_reference(
                                hot, reference
                            ):
                                hot_keys.append(job_key)
                                self._entries.move_to_end(job_key)
                                continue
                            if hot is not None:
                                # Identity lệch không được dùng làm preview. Loại khỏi
                                # LRU rồi nạp lại durable reference; nếu durable record
                                # cũng hỏng thì toàn batch rơi về solve như đường cũ.
                                self._entries.pop(job_key, None)
                                self._quality_gate_proofs.pop(job_key, None)
                                stale_hot_sessions.append(hot)
                            missing_jobs.append(job)
                            missing_references.append(reference)
                        # Một key chỉ tăng protection một lần dù input bất thường có
                        # duplicate job identity.
                        protected = tuple(dict.fromkeys(hot_keys))
                        for hot_key in protected:
                            self._protected_keys[hot_key] = (
                                self._protected_keys.get(hot_key, 0) + 1
                            )
                        state.protected_hot_keys = protected
                        restore_jobs = tuple(missing_jobs)
                        restore_references_subset = tuple(missing_references)
                        stale_hot_to_discard = tuple(stale_hot_sessions)
                else:
                    restore_references = None
                    restore_jobs = ()
                    restore_references_subset = ()
                    stale_hot_to_discard = ()
            else:
                restore_references = None
                restore_jobs = ()
                restore_references_subset = ()
                stale_hot_to_discard = ()

        if restore_owner:
            restored: dict[tuple, Any] | None = None
            for stale_hot in stale_hot_to_discard:
                # Không gọi dọn resource trong global lock; source final của phiên
                # đã commit nên discard vẫn idempotent/no-op như eviction thường.
                self._discard(stale_hot)
            if restore_references is not None:
                try:
                    restored = {}
                    if restore_references_subset:
                        loader = self._reference_loader or load_referenced_manifests
                        stored_batch = loader(restore_references_subset)
                        if stored_batch is None:
                            restored = None
                        else:
                            restored = self._rehydrate_reference_sessions(
                                restore_jobs,
                                restore_references_subset,
                                stored_batch,
                            )
                except Exception:
                    # Reference chỉ là đường tăng tốc. Tamper/stale/lease hết hạn phải
                    # rơi về solve, tuyệt đối không dùng geometry RAM thiếu xác minh.
                    logger.info(
                        "Không khôi phục được batch preview S&R; sẽ solve lại.",
                        exc_info=True,
                    )
                    restored = None
            with self._lock:
                if self._reference_batch_inflight.get(key) is state:
                    state.restored_sessions = restored
                    if restore_references is not None and restored is None:
                        self._reference_batches.pop(key, None)
                if state.restore_completed is not None:
                    state.restore_completed.set()
        elif state.restore_completed is not None:
            # Không giữ global lock trong lúc owner xác minh hash/lease trên đĩa.
            state.restore_completed.wait()
        return state

    @staticmethod
    def _rehydrate_reference_sessions(
        jobs: tuple[Any, ...],
        references: tuple[dict[str, Any], ...],
        stored_batch: Any,
    ) -> dict[tuple, Any]:
        """Dựng session preview tạm từ record đã full-validate của manifest store."""

        # PARITY (audit 2026-09-02 §PERF-NEST-10): production request và placement
        # manifest có hai canonicalizer khác nhau theo hợp đồng. Request adapter
        # lượng tử số thực về 6 chữ số để hash input; manifest phải giữ nguyên
        # pose f64 native để preview rehydrate không dịch hình (và không đổi quyết
        # rời rạc ở sát biên). Trước đây dùng adapter cho cả hai khiến session nóng
        # và session rehydrate lệch tới ~5e-7 mm trên cùng manifest.
        from app.core.nesting_manifest_store import (
            canonical_json_bytes as canonical_manifest_json_bytes,
        )
        from app.core.nesting_production_adapter import (
            canonical_json_bytes as canonical_production_json_bytes,
        )
        from app.core.nesting_production_orchestrator import SolvedProductionNesting

        stored_values = tuple(stored_batch)
        if len(stored_values) != len(jobs) or len(references) != len(jobs):
            raise ValueError("Batch manifest khôi phục không khớp đủ job S&R.")

        sessions: dict[tuple, Any] = {}
        for job, reference, stored in zip(
            jobs, references, stored_values, strict=True
        ):
            manifest_id = str(reference["manifestId"])
            layout_fingerprint = str(reference["layoutFingerprint"])
            production = getattr(stored, "production_request")
            manifest = getattr(stored, "manifest")
            if (
                str(getattr(stored, "manifest_id", "")) != manifest_id
                or str(getattr(stored, "layout_fingerprint", ""))
                != layout_fingerprint
                or str(getattr(production, "layout_fingerprint", ""))
                != layout_fingerprint
                or not isinstance(manifest, Mapping)
                or str(manifest.get("manifestId")) != manifest_id
            ):
                raise ValueError("Identity manifest khôi phục không khớp reference.")

            resolved_sources = getattr(stored, "resolved_sources", None)
            if not isinstance(resolved_sources, Mapping) or not resolved_sources:
                raise ValueError("Manifest khôi phục thiếu source đã resolve.")
            bindings: list[_DetachedPreviewSource] = []
            for locator_id, resolved in resolved_sources.items():
                content_hash = getattr(resolved, "content_hash", None)
                source_path = getattr(resolved, "path", None)
                if (
                    not isinstance(locator_id, str)
                    or not isinstance(content_hash, str)
                    or source_path is None
                ):
                    raise ValueError("Source binding khôi phục không hợp lệ.")
                bindings.append(
                    _DetachedPreviewSource(
                        locator_id=locator_id,
                        content_hash=content_hash,
                        snapshot_path=source_path,
                    )
                )

            production_bytes = canonical_production_json_bytes(
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
            binding_tuple = tuple(bindings)
            solved = SolvedProductionNesting(
                production_request_canonical_bytes=production_bytes,
                manifest_canonical_bytes=canonical_manifest_json_bytes(dict(manifest)),
                source_pins=binding_tuple,
            )
            sessions[job_identity_key(job)] = _RehydratedPreviewSession(
                solved=solved,
                source_pins=binding_tuple,
                authoritative_manifest_id=manifest_id,
                authoritative_layout_fingerprint=layout_fingerprint,
            )
        return sessions

    def _restored_session_locked(self, key: tuple) -> Any | None:
        """Tra session tạm của một batch đang sống; session nóng luôn được ưu tiên."""

        for state in self._reference_batch_inflight.values():
            restored = state.restored_sessions
            if restored is not None:
                session = restored.get(key)
                if session is not None:
                    return session
        return None

    def finish_reference_batch(
        self,
        jobs: Any,
        state: _InFlightReferenceBatch,
        *,
        references: Any = None,
        error: BaseException | None = None,
    ) -> None:
        """Kết thúc một publisher; thành công thắng lỗi của preview trùng identity."""

        jobs_tuple = tuple(jobs)
        if len(jobs_tuple) != state.job_count:
            raise ValueError("Batch kết thúc phải khớp số job lúc đăng ký.")
        detached = (
            self._detach_reference_batch(jobs_tuple, references)
            if references is not None
            else None
        )

        with self._lock:
            # PERF (audit 2026-09-01 §PERF-NEST-01): dùng identity bất biến lúc begin.
            # Không stat lại source ở nhánh finish; file đổi/xóa giữa wave vẫn phải đánh
            # thức waiter cũ thay vì làm rơi latch vì job_identity_key đổi hoặc phát lỗi.
            key = state.key
            current = self._reference_batch_inflight.get(key)
            if current is not state:
                return
            state.publishers = max(0, state.publishers - 1)
            if detached is not None:
                # PERF (audit 2026-09-01 §PERF-NEST-01): cache, kết quả dành cho
                # waiter và trạng thái completed phải đổi nguyên tử. Waiter đã bắt
                # latch không phụ thuộc metadata còn sống trong LRU sau khi được đánh thức.
                self._remember_reference_batch_locked(key, detached)
                state.references = detached
                state.error = None
                state.completed.set()
            if state.publishers == 0 and state.references is not None:
                # Publisher thành công đầu tiên có thể xong khi publisher trùng identity
                # khác còn chạy. Giữ latch trong map tới publisher cuối để late handoff
                # không rơi qua khe cache LRU; trước khi pop đưa reference về MRU lần cuối.
                self._remember_reference_batch_locked(key, state.references)
                self._reference_batch_inflight.pop(key, None)
                state.restored_sessions = None
                self._release_reference_hot_protection_locked(state)
            elif state.publishers == 0:
                state.error = error or RuntimeError(
                    "Publication preview S&R kết thúc không có reference."
                )
                state.completed.set()
                self._reference_batch_inflight.pop(key, None)
                state.restored_sessions = None
                self._release_reference_hot_protection_locked(state)

    def _release_reference_hot_protection_locked(
        self, state: _InFlightReferenceBatch
    ) -> None:
        """Nhả protection hot-session sau publisher cuối, rồi ép LRU về trần."""

        protected = state.protected_hot_keys
        if not protected:
            return
        state.protected_hot_keys = ()
        for key in protected:
            remaining = self._protected_keys.get(key, 0) - 1
            if remaining > 0:
                self._protected_keys[key] = remaining
            else:
                self._protected_keys.pop(key, None)
        self._evict_to_capacity()

    def peek_reference_batch_or_wait(
        self,
        jobs: Any,
        *,
        timeout: float | None = None,
        cancel_check: Any = None,
    ) -> list[dict[str, Any]] | None:
        """Tra batch; nếu preview đang công bố thì chờ chốt thay vì gom session racy."""

        jobs_tuple = tuple(jobs)
        key = self._reference_batch_key(jobs_tuple)
        with self._lock:
            # Cache và latch phải được tra trong cùng critical section: publisher không
            # thể chen giữa hai lần tra rồi vừa pop latch vừa làm handoff báo cache miss.
            existing = self._reference_batches.get(key)
            if existing is not None:
                self._reference_batches.move_to_end(key)
                return [self._copy_reference(reference) for reference in existing]
            state = self._reference_batch_inflight.get(key)
        if state is None:
            return None
        # PERF (audit 2026-09-02 §PERF-NEST-03): export nay nhận job_id trước khi
        # handoff chạy nền, nên lệnh hủy phải cắt được waiter batch vô hạn. Chờ theo
        # nhịp ngắn; không hủy publisher preview vì nó có vòng đời/subscriber riêng.
        deadline = (
            None
            if timeout is None
            else time.monotonic() + max(0.0, float(timeout))
        )
        while not state.completed.is_set():
            if _cancel_requested(cancel_check):
                raise InterruptedError("Đã hủy lượt chờ publication preview S&R.")
            remaining = None if deadline is None else deadline - time.monotonic()
            if remaining is not None and remaining <= 0:
                raise NestingPreviewWaitTimeout(
                    "Hết thời gian chờ publication preview S&R."
                )
            state.completed.wait(
                0.1 if remaining is None else min(0.1, remaining)
            )
        with self._lock:
            if state.error is not None or state.references is None:
                return None
            return [self._copy_reference(reference) for reference in state.references]

    def _register_subscriber_locked(
        self,
        inflight: _InFlightSolve,
        *,
        subscriber_id: str | None,
        progress_callback: Callable[[Mapping[str, Any]], None] | None,
    ) -> object:
        token = object()
        if subscriber_id:
            previous = self._subscriber_inflight.pop(str(subscriber_id), None)
            if previous is not None:
                previous_inflight, previous_token = previous
                previous_inflight.subscribers.discard(previous_token)
                previous_inflight.callbacks.pop(previous_token, None)
                if (
                    previous_inflight is not inflight
                    and not previous_inflight.subscribers
                    and not previous_inflight.completed.is_set()
                ):
                    previous_inflight.shared_cancel_event.set()
            self._subscriber_inflight[str(subscriber_id)] = (inflight, token)
        inflight.subscribers.add(token)
        if progress_callback is not None:
            inflight.callbacks[token] = progress_callback
        return token

    def _detach_subscriber_locked(
        self,
        inflight: _InFlightSolve,
        token: object,
        subscriber_id: str | None,
    ) -> None:
        inflight.subscribers.discard(token)
        inflight.callbacks.pop(token, None)
        if subscriber_id:
            current = self._subscriber_inflight.get(str(subscriber_id))
            if current == (inflight, token):
                self._subscriber_inflight.pop(str(subscriber_id), None)
        if not inflight.subscribers and not inflight.completed.is_set():
            inflight.shared_cancel_event.set()

    def _publish_progress(
        self, inflight: _InFlightSolve, progress: Mapping[str, Any]
    ) -> None:
        snapshot = dict(progress)
        with self._lock:
            if inflight.completed.is_set() or inflight.shared_cancel_event.is_set():
                return
            inflight.progress = snapshot
            callbacks = list(inflight.callbacks.values())
        for callback in callbacks:
            try:
                callback(dict(snapshot))
            except Exception:
                logger.debug("Callback progress preview nesting bị lỗi.", exc_info=True)

    def _start_cancel_watcher(
        self,
        inflight: _InFlightSolve,
        token: object,
        subscriber_id: str | None,
        cancel_check: Any,
    ) -> None:
        """Nối Event riêng của subscriber vào chốt hủy dùng chung."""

        if cancel_check is None:
            return

        def watch() -> None:
            while not inflight.completed.wait(0.1):
                if not _cancel_requested(cancel_check):
                    continue
                with self._lock:
                    self._detach_subscriber_locked(
                        inflight, token, subscriber_id
                    )
                return

        threading.Thread(
            target=watch,
            name="prynx-preview-subscriber-cancel",
            daemon=True,
        ).start()

    @staticmethod
    def _wait_for_completion(
        inflight: _InFlightSolve,
        *,
        token: object | None = None,
        cancel_check: Any = None,
        deadline: float | None = None,
    ) -> None:
        """Chờ theo nhịp hữu hạn để luôn có cơ hội kiểm tra hủy/timeout."""

        while True:
            if _cancel_requested(cancel_check):
                raise InterruptedError("Đã hủy lượt chờ preview nesting.")
            if token is not None and token not in inflight.subscribers:
                raise InterruptedError("Subscriber preview nesting đã bị hủy.")
            remaining = None if deadline is None else deadline - time.monotonic()
            if remaining is not None and remaining <= 0:
                raise NestingPreviewWaitTimeout("Hết thời gian chờ preview nesting.")
            wait_seconds = 0.1 if remaining is None else min(0.1, remaining)
            if inflight.completed.wait(wait_seconds):
                return

    def cancel_subscriber(self, subscriber_id: str) -> bool:
        """Hủy một người chờ hoặc toàn bộ subscriber con của batch S&R.

        Chỉ subscriber cuối của từng identity solve mới phát tín hiệu xuống native.
        """

        with self._lock:
            subscriber_key = str(subscriber_id)
            child_prefix = subscriber_key + _BATCH_SUBSCRIBER_SEPARATOR
            matched = [
                key
                for key in self._subscriber_inflight
                if key == subscriber_key or key.startswith(child_prefix)
            ]
            for key in matched:
                inflight, token = self._subscriber_inflight.pop(key)
                inflight.subscribers.discard(token)
                inflight.callbacks.pop(token, None)
                if not inflight.subscribers and not inflight.completed.is_set():
                    inflight.shared_cancel_event.set()
            return bool(matched)

    def peek_or_wait(
        self,
        job,
        *,
        timeout: float = 60.0,
        cancel_check: Any = None,
        subscriber_id: str | None = None,
    ) -> Any | None:
        """Tra phiên; nếu đúng khoá đang solve thì chờ owner, không solve thêm.

        PERF/FIX (audit 2026-08-29 §NEST-SINGLEFLIGHT): người dùng có thể bấm
        ``Bình`` trước khi preview kết thúc. Handoff cũ chỉ ``peek()`` nên thấy miss và
        spawn process con solve trùng. Chờ Event hiện hữu là đường singleflight đúng;
        không giữ global lock trong lúc chờ và job khoá khác vẫn chạy độc lập.
        """

        key = job_identity_key(job)
        with self._lock:
            session = self._entries.get(key)
            if session is not None:
                self._entries.move_to_end(key)
                return session
            inflight = self._inflight.get(key)
        if inflight is None:
            return None

        deadline = time.monotonic() + max(0.0, float(timeout))
        # Lượt đã latch cancel không nhận subscriber mới. Chờ nó dọn xong rồi trả
        # cache miss để export fail-soft sang đường solve riêng.
        if inflight.shared_cancel_event.is_set():
            self._wait_for_completion(
                inflight, cancel_check=cancel_check, deadline=deadline
            )
            return self.peek(job)

        with self._lock:
            token = self._register_subscriber_locked(
                inflight, subscriber_id=subscriber_id, progress_callback=None
            )
        try:
            self._wait_for_completion(
                inflight,
                token=token,
                cancel_check=cancel_check,
                deadline=deadline,
            )
            if inflight.error is not None:
                raise inflight.error
            if inflight.session is None:  # pragma: no cover - hàng rào bất biến
                raise RuntimeError("Lượt solve nesting kết thúc mà không có phiên.")
            return inflight.session
        finally:
            with self._lock:
                self._detach_subscriber_locked(
                    inflight, token, subscriber_id
                )

    def get_or_solve(
        self,
        job,
        *,
        subscriber_id: str | None = None,
        cancel_event: Any = None,
        progress_callback: Callable[[Mapping[str, Any]], None] | None = None,
        session_callback: Callable[[Any], None] | None = None,
        **kwargs,
    ) -> PreviewSessionLookup:
        """Tra/solve rồi dùng session trong một cửa sổ được bảo vệ khỏi LRU.

        ``session_callback`` dành cho publication batch: callback chạy ngoài lock,
        nhưng key không thể bị eviction cho tới khi callback hoàn tất. Điều này giữ
        singleflight và cap RAM thường, đồng thời đóng race solve → commit ở S&R.
        """

        if session_callback is not None and not callable(session_callback):
            raise TypeError("session_callback phải callable hoặc None.")
        if session_callback is None:
            return self._get_or_solve(
                job,
                subscriber_id=subscriber_id,
                cancel_event=cancel_event,
                progress_callback=progress_callback,
                **kwargs,
            )

        key = job_identity_key(job)
        with self._lock:
            self._protected_keys[key] = self._protected_keys.get(key, 0) + 1
        try:
            lookup = self._get_or_solve(
                job,
                subscriber_id=subscriber_id,
                cancel_event=cancel_event,
                progress_callback=progress_callback,
                **kwargs,
            )
            session_callback(lookup.session)
            return lookup
        finally:
            with self._lock:
                remaining = self._protected_keys.get(key, 0) - 1
                if remaining > 0:
                    self._protected_keys[key] = remaining
                else:
                    self._protected_keys.pop(key, None)
                self._evict_to_capacity()

    def _get_or_solve(
        self,
        job,
        *,
        subscriber_id: str | None = None,
        cancel_event: Any = None,
        progress_callback: Callable[[Mapping[str, Any]], None] | None = None,
        **kwargs,
    ) -> PreviewSessionLookup:
        """Trả phiên cho job; mỗi khoá chỉ có một owner được solve.

        Solve và chờ đều **ngoài** vùng khóa: một lượt nesting mất cỡ vài giây,
        giữ khóa suốt thời gian đó sẽ chặn cả những job có khoá khác.
        """

        key = job_identity_key(job)
        if _cancel_requested(cancel_event):
            raise InterruptedError("Đã hủy preview nesting trước khi bắt đầu.")

        # Nếu lượt cũ đã mất subscriber cuối và latch cancel, caller mới không được
        # nhập vào Event đã set vĩnh viễn. Chờ nó dọn rồi thử lại thành owner mới.
        while True:
            with self._lock:
                existing = self._entries.get(key)
                if existing is not None:
                    if _cancel_requested(cancel_event):
                        raise InterruptedError("Đã hủy preview nesting.")
                    self._entries.move_to_end(key)
                    return PreviewSessionLookup(session=existing, reused=True)
                restored = self._restored_session_locked(key)
                if restored is not None:
                    if _cancel_requested(cancel_event):
                        raise InterruptedError("Đã hủy preview nesting.")
                    return PreviewSessionLookup(session=restored, reused=True)
                inflight = self._inflight.get(key)
                if inflight is not None and inflight.shared_cancel_event.is_set():
                    cancelled_inflight = inflight
                else:
                    cancelled_inflight = None
                    is_owner = inflight is None
                    if inflight is None:
                        # PERF/FIX (audit 2026-08-29 §NEST-SINGLEFLIGHT): công bố
                        # owner trước khi solve để preview trùng chỉ chờ.
                        inflight = _InFlightSolve(
                            completed=threading.Event(),
                            shared_cancel_event=threading.Event(),
                            subscribers=set(),
                            callbacks={},
                        )
                        self._inflight[key] = inflight
                    token = self._register_subscriber_locked(
                        inflight,
                        subscriber_id=subscriber_id,
                        progress_callback=progress_callback,
                    )
                    initial_progress = (
                        dict(inflight.progress) if inflight.progress is not None else None
                    )
                    break
            self._wait_for_completion(
                cancelled_inflight, cancel_check=cancel_event
            )

        if initial_progress is not None and progress_callback is not None:
            try:
                progress_callback(initial_progress)
            except Exception:
                logger.debug("Callback progress preview nesting bị lỗi.", exc_info=True)
        self._start_cancel_watcher(
            inflight, token, subscriber_id, cancel_event
        )
        if _cancel_requested(cancel_event):
            with self._lock:
                self._detach_subscriber_locked(inflight, token, subscriber_id)
            if not is_owner:
                raise InterruptedError("Đã hủy preview nesting.")

        if not is_owner:
            try:
                # Không giữ `_lock` trong lúc chờ; job khoá khác vẫn chạy song song.
                self._wait_for_completion(
                    inflight, token=token, cancel_check=cancel_event
                )
                if inflight.error is not None:
                    raise inflight.error
                if inflight.session is None:  # pragma: no cover - hàng rào bất biến
                    raise RuntimeError("Lượt solve nesting kết thúc mà không có phiên.")
                return PreviewSessionLookup(session=inflight.session, reused=True)
            finally:
                with self._lock:
                    self._detach_subscriber_locked(inflight, token, subscriber_id)

        try:
            session = self._solve(
                job,
                cancel_event=inflight.shared_cancel_event,
                progress_callback=lambda value: self._publish_progress(inflight, value),
                **kwargs,
            )
            caller_cancelled = False
            with self._lock:
                # Publication fence đọc trực tiếp Event của caller để đóng cửa sổ
                # rất hẹp trước khi watcher kịp tách token.
                if _cancel_requested(cancel_event):
                    self._detach_subscriber_locked(
                        inflight, token, subscriber_id
                    )
                caller_cancelled = token not in inflight.subscribers
                if inflight.shared_cancel_event.is_set() or not inflight.subscribers:
                    inflight.error = InterruptedError("Đã hủy preview nesting.")
                else:
                    self._entries[key] = session
                    self._entries.move_to_end(key)
                    self._evict_to_capacity()
                    inflight.session = session
            if inflight.session is None:
                self._discard(session)
                raise inflight.error or InterruptedError("Đã hủy preview nesting.")
            if caller_cancelled or _cancel_requested(cancel_event):
                # Solver có thể tiếp tục vì subscriber khác còn sống; caller đã hủy
                # không được nhận kết quả dù session vẫn được cache cho subscriber kia.
                raise InterruptedError("Subscriber preview nesting đã bị hủy.")
            return PreviewSessionLookup(session=session, reused=False)
        except BaseException as exc:
            # Mọi waiter phải nhận cùng lỗi; lượt sau được quyền thử solve lại.
            with self._lock:
                if inflight.session is None and inflight.error is None:
                    inflight.error = exc
            raise
        finally:
            # Dọn cả nhánh thành công lẫn lỗi. Event giữ riêng trong `inflight`, nên
            # waiter đã lấy tham chiếu vẫn được đánh thức sau khi map bỏ khoá này.
            with self._lock:
                if self._inflight.get(key) is inflight:
                    self._inflight.pop(key, None)
                inflight.completed.set()
                self._detach_subscriber_locked(inflight, token, subscriber_id)

    def invalidate(self, job) -> bool:
        """Bỏ phiên của một job. Trả True nếu có phiên bị bỏ."""

        key = job_identity_key(job)
        with self._lock:
            session = self._entries.pop(key, None)
            self._quality_gate_proofs.pop(key, None)
            stale_batches = [
                batch_key
                for batch_key in self._reference_batches
                if key in batch_key
            ]
            for batch_key in stale_batches:
                self._reference_batches.pop(batch_key, None)
        if session is None:
            return False
        self._discard(session)
        return True

    def clear(self) -> None:
        with self._lock:
            entries = list(self._entries.values())
            self._entries.clear()
            self._protected_keys.clear()
            self._quality_gate_proofs.clear()
            self._reference_batches.clear()
            for inflight in self._inflight.values():
                inflight.shared_cancel_event.set()
            for batch in self._reference_batch_inflight.values():
                batch.error = InterruptedError("Kho preview S&R đã được dọn.")
                batch.completed.set()
                batch.restored_sessions = None
                if batch.restore_completed is not None:
                    batch.restore_completed.set()
            self._reference_batch_inflight.clear()
            self._subscriber_inflight.clear()
        for session in entries:
            self._discard(session)


#: Khoá trong `settings` mang tham chiếu phiên qua ranh giới process. Tiền tố `_`
#: theo đúng quy ước sẵn có của route cho field nội bộ (xem `_diagnosticTraceId`).
SESSION_REFERENCE_SETTING = "_nestingPreviewSession"


def commit_and_reference(session: Any, *, store=None) -> dict[str, str]:
    """Công bố manifest của phiên rồi trả **tham chiếu** để process khác nạp lại.

    NEST (audit 2026-08-28 §A4b-6). Session nằm trong RAM process API, còn engine
    chạy trong `multiprocessing.Process` riêng — RAM không đi qua được. Thay vì cố
    truyền session, ta công bố manifest xuống kho trên đĩa rồi chuyển **hai chuỗi
    identity layout**. Envelope Execute bổ sung `reportHash` ở tầng worker; hàm
    storage này cố ý không sở hữu metadata report.

    Trả `manifestId` + `layoutFingerprint`: kho cố tình đòi **cả hai** để không bao
    giờ lookup bằng ID mơ hồ (`NestingManifestStore.load`). Caller production phải
    gắn thêm `reportHash` mới nhất trước khi bàn giao sang process con.
    """

    if isinstance(session, _RehydratedPreviewSession):
        # PERF (audit 2026-09-02 §PERF-NEST-10): record đã được load_many xác minh
        # trong đúng wave này. Persist lại vừa tốn I/O vừa đòi lease token mà session
        # tạm cố ý không sở hữu. Identity lệch phải fail-closed, không tự chữa mơ hồ.
        if (
            session.manifest_id != session.authoritative_manifest_id
            or session.layout_fingerprint
            != session.authoritative_layout_fingerprint
        ):
            raise ValueError("Identity session khôi phục không còn khớp reference.")
        return {
            "manifestId": session.authoritative_manifest_id,
            "layoutFingerprint": session.authoritative_layout_fingerprint,
        }

    from app.core.nesting_production_pipeline import commit_production_nesting_session

    stored = commit_production_nesting_session(session, store=store)
    return {
        "manifestId": stored.manifest_id,
        "layoutFingerprint": stored.layout_fingerprint,
    }


def load_referenced_manifest(reference: Mapping[str, Any], *, store=None):
    """Nạp manifest đã công bố từ tham chiếu. Trả None nếu không dùng được.

    Fail-**soft** có chủ đích: tham chiếu chỉ là đường tăng tốc. Manifest bị dọn,
    lease hết hạn hay fingerprint lệch thì caller phải solve lại chứ không được làm
    hỏng lượt bình của người dùng.
    """

    if not isinstance(reference, Mapping):
        return None
    manifest_id = reference.get("manifestId")
    layout_fingerprint = reference.get("layoutFingerprint")
    if not isinstance(manifest_id, str) or not isinstance(layout_fingerprint, str):
        return None
    if store is None:
        from app.core.nesting_manifest_store import NestingManifestStore

        store = NestingManifestStore()
    try:
        return store.load(
            manifest_id=manifest_id, layout_fingerprint=layout_fingerprint
        )
    except Exception:
        logger.info(
            "Không nạp lại được manifest phiên preview (%s); sẽ solve lại.",
            manifest_id,
            exc_info=True,
        )
        return None


def load_referenced_manifests(
    references: Sequence[Mapping[str, Any]],
    *,
    store=None,
):
    """Nạp batch S&R theo input order; locator mới O(1), legacy scan tối đa một lượt."""

    try:
        values = tuple(references)
    except TypeError:
        return None
    if not values:
        return ()
    for reference in values:
        if not isinstance(reference, Mapping):
            return None
        if not isinstance(reference.get("manifestId"), str) or not isinstance(
            reference.get("layoutFingerprint"), str
        ):
            return None
    if store is None:
        from app.core.nesting_manifest_store import NestingManifestStore

        store = NestingManifestStore()
    try:
        return store.load_many(values)
    except Exception:
        logger.info(
            "Không nạp lại được batch %s manifest preview; sẽ fail-closed tại handoff.",
            len(values),
            exc_info=True,
        )
        return None


#: Kho dùng chung của process. Preview và export phải tra CÙNG kho, nếu không thì
#: export vẫn solve lại và bất biến preview ≡ output lại vỡ.
_STORE: NestingPreviewSessionStore | None = None
_STORE_LOCK = threading.Lock()


def get_preview_session_store() -> NestingPreviewSessionStore:
    global _STORE
    with _STORE_LOCK:
        if _STORE is None:
            _STORE = NestingPreviewSessionStore()
        return _STORE


def reset_preview_session_store() -> None:
    """Chỉ dùng cho test: bỏ kho dùng chung và thu hồi mọi pin đang giữ."""

    global _STORE
    with _STORE_LOCK:
        store = _STORE
        _STORE = None
    if store is not None:
        store.clear()
