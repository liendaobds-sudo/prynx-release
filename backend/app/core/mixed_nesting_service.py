"""Cầu nối sidecar ⇄ engine lồng ghép tự do (mixed nesting) — phase P5.

Nguồn: ``docs/KE_HOACH_MIXED_TRUE_SHAPE_NESTING_DOC_LAP_2026-08-26.md`` §6.2, §6.3, §16.2.

Bốn ràng buộc mà module này thực thi
------------------------------------

1. **Fail-closed khi thiếu native.** Không có ``pdfcompare_native.MixedNestingRun`` thì
   raise :class:`EngineUnavailableError` để route trả ``503 ENGINE_UNAVAILABLE``.
   **Tuyệt đối không fallback** sang solver bình bài cũ hay bản Python — §20 ghi rõ đó là
   NO-GO, vì fallback im lặng sẽ cho ra layout của một engine khác mà người dùng không biết.

2. **Bắt được wheel cũ.** Native có class nhưng ``protocolVersion`` lệch thì cũng coi là
   không dùng được. Wheel stale nguy hiểm hơn wheel thiếu: nó chạy với hợp đồng khác.

3. **Không giữ GIL.** ``MixedNestingRun.solve()`` phía Rust đã nhả GIL, nhưng lời gọi vẫn
   chặn thread Python gọi nó. Vì vậy route **phải** đẩy qua threadpool/heavy scheduler;
   hàm ở đây là API đồng bộ, cố ý không tự tạo thread để nơi gọi kiểm soát điều phối.

4. **Không chạm PDFium.** Engine lồng ghép làm việc trên polygon mm thuần, không mở PDF,
   nên **không cần** ``pdfium_guard()``. Điều này là chủ đích: nếu sau này pipeline nhập
   PDF (P12) cần PDFium thì phần đó nằm ở worker riêng, không nằm ở đây.
"""

from __future__ import annotations

import json
import math
import threading
from dataclasses import dataclass
from typing import Any, Final

# Hợp đồng phiên bản mà sidecar này biết cách đọc. Lệch là từ chối chạy.
MIXED_NESTING_PROTOCOL_VERSION: Final[int] = 1

# Tên loại việc trong `heavy_job_scheduler`. Thuộc nhóm whole-machine (§14).
MIXED_NESTING_KIND: Final[str] = "mixed-nesting"

# Override vận hành cho số worker (§14). Người vận hành biết máy mình.
WORKER_COUNT_ENV: Final[str] = "PRYNX_MIXED_NEST_WORKERS"

# ── Mã lỗi từ Rust ⇄ HTTP status ─────────────────────────────────────────────
# Phải khớp `native/src/mixed_nesting_py.rs::codes`. Có test parity ở
# `backend/tests/test_mixed_nesting_native.py`.
ERROR_CODE_TO_STATUS: Final[dict[str, int]] = {
    "MIXED_NESTING_BAD_JSON": 422,
    "MIXED_NESTING_INVALID_REQUEST": 422,
    "MIXED_NESTING_INVALID_GEOMETRY": 422,
    "MIXED_NESTING_CANCELLED": 409,
    "MIXED_NESTING_ENGINE_ERROR": 500,
}

ENGINE_UNAVAILABLE_CODE: Final[str] = "ENGINE_UNAVAILABLE"


class MixedNestingError(Exception):
    """Lỗi có mã ổn định, đủ thông tin để route map sang HTTP."""

    def __init__(self, code: str, message: str, status: int) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status

    def to_payload(self) -> dict[str, Any]:
        """Thân phản hồi lỗi. Không chứa toạ độ contour của khách hàng."""
        return {"code": self.code, "message": self.message}


class EngineUnavailableError(MixedNestingError):
    """Native thiếu hoặc wheel cũ. Luôn là 503 — không bao giờ tự xử lý bằng cách khác."""

    def __init__(self, message: str) -> None:
        super().__init__(ENGINE_UNAVAILABLE_CODE, message, 503)


@dataclass(frozen=True)
class EngineCapabilities:
    """Năng lực mà bản native đang cài công bố."""

    protocol_version: int
    engine_version: str
    reflection: str
    default_rotation: str
    continuous_translation: bool
    profiles: tuple[str, ...]


# Cache kết quả nạp native. ``None`` = chưa thử; tuple = đã thử xong.
_LOAD_LOCK = threading.Lock()
_LOADED: tuple[Any, EngineCapabilities] | None = None
_LOAD_ERROR: str | None = None


def _probe_native() -> tuple[Any, EngineCapabilities]:
    """Nạp và kiểm bản native. Raise :class:`EngineUnavailableError` nếu không dùng được."""
    try:
        import pdfcompare_native as native  # noqa: PLC0415 — nạp muộn là chủ đích
    except ImportError as exc:  # pragma: no cover - phụ thuộc môi trường
        raise EngineUnavailableError(
            "Chưa cài phần lõi tính toán (pdfcompare_native). Hãy chạy lại bước cài đặt."
        ) from exc

    run_class = getattr(native, "MixedNestingRun", None)
    if run_class is None:
        # Wheel cũ: có native nhưng chưa có engine lồng ghép.
        raise EngineUnavailableError(
            "Phần lõi tính toán đang dùng là bản cũ, chưa có engine lồng ghép tự do. "
            "Hãy cập nhật phần mềm."
        )

    capabilities_fn = getattr(run_class, "capabilities", None)
    if capabilities_fn is None:
        raise EngineUnavailableError(
            "Phần lõi tính toán không công bố được năng lực — bản cài không đồng bộ."
        )
    try:
        raw = json.loads(capabilities_fn())
        capabilities = EngineCapabilities(
            protocol_version=int(raw["protocolVersion"]),
            engine_version=str(raw["engineVersion"]),
            reflection=str(raw["reflection"]),
            default_rotation=str(raw["defaultRotation"]),
            continuous_translation=bool(raw["continuousTranslation"]),
            profiles=tuple(str(item) for item in raw["profiles"]),
        )
    except (ValueError, KeyError, TypeError) as exc:
        raise EngineUnavailableError(
            "Phần lõi tính toán trả về năng lực không đọc được — bản cài không đồng bộ."
        ) from exc

    if capabilities.protocol_version != MIXED_NESTING_PROTOCOL_VERSION:
        # Wheel stale nguy hiểm hơn wheel thiếu: nó CHẠY được nhưng theo hợp đồng khác.
        raise EngineUnavailableError(
            "Phần lõi tính toán dùng phiên bản giao thức "
            f"{capabilities.protocol_version}, sidecar cần {MIXED_NESTING_PROTOCOL_VERSION}. "
            "Hãy cập nhật phần mềm."
        )
    if capabilities.reflection != "forbidden":
        # Bất biến của cả dự án: bình mặt trước không lật khuôn.
        raise EngineUnavailableError(
            "Phần lõi tính toán cho phép lật khuôn — bản cài không đúng hợp đồng."
        )
    return run_class, capabilities


def load_engine() -> tuple[Any, EngineCapabilities]:
    """Trả ``(MixedNestingRun, capabilities)``, cache lại kết quả kiểm.

    Kết quả **thất bại cũng được cache**: nếu wheel thiếu thì mọi request sau đó cũng
    thiếu, không cần dò lại từng lần và làm chậm đường lỗi.
    """
    global _LOADED, _LOAD_ERROR  # noqa: PLW0603 — cache cấp module là chủ đích
    if _LOADED is not None:
        return _LOADED
    with _LOAD_LOCK:
        if _LOADED is not None:
            return _LOADED
        if _LOAD_ERROR is not None:
            raise EngineUnavailableError(_LOAD_ERROR)
        try:
            _LOADED = _probe_native()
        except EngineUnavailableError as exc:
            _LOAD_ERROR = exc.message
            raise
        return _LOADED


def reset_engine_cache() -> None:
    """Xoá cache nạp native. Chỉ dùng cho test; không gọi trong đường sản xuất."""
    global _LOADED, _LOAD_ERROR  # noqa: PLW0603
    with _LOAD_LOCK:
        _LOADED = None
        _LOAD_ERROR = None


def engine_capabilities() -> EngineCapabilities:
    """Năng lực engine, dùng cho endpoint ``GET /api/mixed-nesting/capabilities``."""
    return load_engine()[1]


def _translate_engine_error(exc: BaseException) -> MixedNestingError:
    """Đổi lỗi từ Rust thành lỗi có mã và HTTP status.

    Rust đặt mã ở **đầu** thông báo, ngăn bởi ``": "``. Mã lạ được quy về 500 thay vì
    đoán, vì đoán sai sẽ trả 422 cho một lỗi engine và người dùng đi sửa dữ liệu vô ích.
    """
    text = str(exc)
    code, _, remainder = text.partition(":")
    code = code.strip()
    if code in ERROR_CODE_TO_STATUS:
        message = remainder.strip() or code
        return MixedNestingError(code, message, ERROR_CODE_TO_STATUS[code])
    return MixedNestingError(
        "MIXED_NESTING_ENGINE_ERROR",
        "Engine lồng ghép gặp lỗi không xác định.",
        500,
    )


class MixedNestingRunHandle:
    """Một vòng chạy: bọc đối tượng Rust và thêm lớp an toàn cho sidecar.

    Đối tượng Rust chia sẻ cờ hủy và bộ đếm tiến độ qua ``Arc``, nên :meth:`cancel` và
    :meth:`progress` gọi được từ **thread khác** trong lúc :meth:`solve` đang chạy. Đó
    là điều làm endpoint Status và Cancel vẫn phản hồi khi solver chiếm hết CPU.
    """

    __slots__ = ("_run", "_capabilities")

    def __init__(self) -> None:
        run_class, capabilities = load_engine()
        self._run = run_class()
        self._capabilities = capabilities

    @property
    def capabilities(self) -> EngineCapabilities:
        return self._capabilities

    def solve(self, request: dict[str, Any]) -> dict[str, Any]:
        """Chạy lồng ghép, trả placement manifest dạng dict.

        **Chặn thread gọi.** Nơi gọi phải đẩy qua threadpool hoặc heavy scheduler —
        hàm này cố ý không tự tạo thread để việc điều phối nằm ở một chỗ duy nhất.
        """
        try:
            payload = json.dumps(request, allow_nan=False)
        except ValueError as exc:
            # `allow_nan=False` chặn NaN/Infinity ngay ở biên Python: JSON không có hai
            # giá trị đó, và để chúng đi tiếp sẽ thành lỗi mơ hồ ở tầng dưới.
            raise MixedNestingError(
                "MIXED_NESTING_BAD_JSON",
                "Dữ liệu lệnh chứa giá trị không hữu hạn.",
                422,
            ) from exc
        try:
            encoded = self._run.solve(payload)
        except MixedNestingError:
            raise
        except BaseException as exc:  # noqa: BLE001 - phải quy MỌI lỗi Rust về mã ổn định
            raise _translate_engine_error(exc) from exc
        try:
            return json.loads(encoded)
        except ValueError as exc:
            raise MixedNestingError(
                "MIXED_NESTING_ENGINE_ERROR",
                "Kết quả từ engine không đọc được.",
                500,
            ) from exc

    def progress(self) -> dict[str, Any]:
        """Ảnh chụp tiến độ. Rẻ, không chặn, gọi được từ thread khác."""
        try:
            return json.loads(self._run.progress())
        except BaseException as exc:  # noqa: BLE001
            raise _translate_engine_error(exc) from exc

    def cancel(self) -> None:
        """Yêu cầu hủy. Idempotent — gọi nhiều lần hoặc sau khi xong đều vô hại."""
        self._run.cancel()

    @property
    def cancelled(self) -> bool:
        return bool(self._run.is_cancelled())


def create_run() -> MixedNestingRunHandle:
    """Tạo một vòng chạy mới. Raise :class:`EngineUnavailableError` nếu native không dùng được."""
    return MixedNestingRunHandle()


# ═════════════════════════════════════════════════════════════════════════════
#  Admission: ngân sách worker và RAM — phase P6b
#
#  Kế hoạch §14. Ba điều bắt buộc, và mỗi điều đều có test riêng:
#
#  1. **`plan_worker_count` là nguồn chân lý duy nhất cho số worker.** Module này KHÔNG
#     chép lại bảng cap theo RAM. Máy `≥16 GB` không bị hạ; chỉ tier `<8 GB`/`<16 GB` mới
#     giảm — đúng rule #1 của AGENTS.md.
#  2. **Ước lượng RAM đi theo trạng thái tìm kiếm, KHÔNG theo "số góc".** Free-angle là
#     miền liên tục nên "số rotation" không tồn tại; ước lượng dựa vào số orientation
#     proposal đang giữ, beam, refinement state, NFP/IFP cache, spatial index và
#     thumbnail. Hệ quả kiểm được: hai request giống nhau nhưng khác `rotationConstraint`
#     (`free` / `discrete` bốn góc / `fixed`) phải cho **cùng một** ước lượng.
#  3. **Vượt ngân sách thì fail SỚM, có hướng dẫn**, thay vì để engine chạy tới OOM.
# ═════════════════════════════════════════════════════════════════════════════

#: Phiên bản của MÔ HÌNH ước lượng. Tăng khi đổi hệ số, để benchmark cũ không bị so lệch.
ADMISSION_MODEL_VERSION: Final[int] = 1


@dataclass(frozen=True)
class SearchEffort:
    """Ngân sách tìm kiếm của một profile.

    Bản sao **có test parity** của ``imposition_core/src/mixed_nesting/control.rs``
    (``SearchEffort::for_profile``). Sidecar cần các con số này TRƯỚC khi gọi engine để
    ước lượng RAM, mà không thể hỏi engine nếu engine chưa chắc nạp được. Chống drift bằng
    ``test_mixed_nesting_admission.py``: test đọc trực tiếp file Rust và so từng số.
    """

    trial_count: int
    orientation_proposals_per_part: int
    beam_width: int
    refinement_rounds: int
    multi_start_restarts: int
    evaluation_budget: int


SEARCH_EFFORT_BY_PROFILE: Final[dict[str, SearchEffort]] = {
    # `evaluation_budget` đã hiệu chỉnh bằng đo ngày 2026-08-26 (xem docstring
    # `SearchEffort::for_profile` phía Rust): ≈9.700 lượt/giây ⇒ 3 / 10 / 31 giây.
    "fast": SearchEffort(4, 12, 4, 2, 1, 30_000),
    "balanced": SearchEffort(12, 32, 8, 6, 3, 100_000),
    "tight": SearchEffort(32, 96, 16, 18, 8, 300_000),
}

# ── Hệ số của mô hình ước lượng (MB / byte) ─────────────────────────────────
#
# Các số dưới đây là cận trên thô, chọn để KHÔNG đánh giá thấp. Chúng chỉ dùng cho
# admission (đặt chỗ RAM), không dùng làm cap hiệu năng, nên sai lệch lên phía an toàn
# chỉ khiến máy yếu xếp hàng chứ không làm chậm máy mạnh.

#: Một đỉnh polygon: 2×f64 toạ độ + chi phí Vec/phân rã lồi/chỉ mục cạnh.
_BYTES_PER_VERTEX: Final[int] = 48

#: Contour nguồn được giữ nhiều bản: gốc, đã canonicalize, và các mảnh lồi.
_GEOMETRY_COPIES: Final[int] = 3

#: Một placement trong spatial index: pose + bbox + id + liên kết ô lưới.
_BYTES_PER_PLACEMENT: Final[int] = 256

#: Thumbnail xem trước của mỗi part (§14: source thumbnail tính vào admission).
_THUMBNAIL_MB_PER_PART: Final[float] = 0.75

#: Trần LRU theo byte của NFP/IFP cache. §14 cấm cache vô hạn theo từng giá trị `f64`.
NFP_CACHE_MAX_MB: Final[float] = 192.0

#: Chi phí nền của một vòng chạy: JSON request/response, manifest, validator.
_BASE_OVERHEAD_MB: Final[float] = 64.0

#: Số pose sống mà một vòng refine giữ đồng thời (rounds chạy NỐI TIẾP nên KHÔNG nhân
#: theo `refinement_rounds`; chỉ nhân theo số pose giữ song song trong một vòng).
_REFINEMENT_LIVE_POSES: Final[int] = 3

_MB: Final[float] = 1024.0 * 1024.0


@dataclass(frozen=True)
class WorkloadShape:
    """Hình dạng khối việc, suy ra từ request.

    Cố ý **không có** trường nào đếm góc. Thêm một trường như vậy là mở lại đúng lỗi mà
    §14 cấm: free-angle không có số góc hữu hạn để đếm.
    """

    part_count: int
    instance_count: int
    #: Tổng đỉnh contour NGUỒN (outer + holes) của mọi part, KHÔNG nhân theo quantity.
    source_vertex_count: int
    max_sheets: int

    @property
    def avg_vertices_per_part(self) -> float:
        if self.part_count <= 0:
            return 0.0
        return self.source_vertex_count / self.part_count


@dataclass(frozen=True)
class HardwarePlan:
    """Kết quả admission: đủ để gọi ``run_scheduled_in_threadpool`` và để ghi log."""

    workers: int
    per_worker_mb: float
    shared_mb: float
    estimated_peak_mb: float
    effort: SearchEffort
    reason: str


def normalize_profile(raw: Any) -> str:
    """Tên profile hợp lệ, mặc định ``balanced``. Không đoán tên lạ thành profile khác."""
    if isinstance(raw, str):
        name = raw.strip().lower()
        if name in SEARCH_EFFORT_BY_PROFILE:
            return name
    return "balanced"


def _count_ring_vertices(ring: Any) -> int:
    if not isinstance(ring, list):
        return 0
    return sum(1 for point in ring if isinstance(point, (list, tuple)) and len(point) >= 2)


def describe_workload(request: dict[str, Any]) -> WorkloadShape:
    """Đọc hình dạng khối việc từ request.

    Chịu được dữ liệu thiếu/sai kiểu vì admission chạy **trước** validator của engine:
    nhiệm vụ ở đây là ước lượng, không phải bắt lỗi. Request xấu vẫn bị engine từ chối
    bằng mã lỗi riêng.
    """
    parts = request.get("parts")
    if not isinstance(parts, list):
        parts = []

    part_count = 0
    instance_count = 0
    vertex_count = 0
    for part in parts:
        if not isinstance(part, dict):
            continue
        part_count += 1
        raw_quantity = part.get("quantity", 0)
        quantity = raw_quantity if isinstance(raw_quantity, int) and raw_quantity > 0 else 0
        instance_count += quantity
        vertex_count += _count_ring_vertices(part.get("outer"))
        holes = part.get("holes")
        if isinstance(holes, list):
            for hole in holes:
                vertex_count += _count_ring_vertices(hole)

    sheet = request.get("sheet")
    raw_max_sheets = sheet.get("maxSheets") if isinstance(sheet, dict) else None
    max_sheets = raw_max_sheets if isinstance(raw_max_sheets, int) and raw_max_sheets > 0 else 1

    return WorkloadShape(
        part_count=part_count,
        instance_count=instance_count,
        source_vertex_count=vertex_count,
        max_sheets=max_sheets,
    )


def estimate_per_worker_mb(shape: WorkloadShape, effort: SearchEffort) -> float:
    """RAM của MỘT worker: orientation proposal + beam + refinement state.

    Ba khoản này là phần duy nhất nhân theo số worker; hình học nguồn, NFP cache và
    spatial index dùng chung nên nằm ở :func:`estimate_shared_mb`.
    """
    avg_vertices = shape.avg_vertices_per_part

    # Pha coarse: mỗi worker giữ tối đa `orientation_proposals_per_part` pose ứng viên
    # cho MỘT part đang xét (proposal là pose, không phải bản sao cả tờ).
    proposal_mb = effort.orientation_proposals_per_part * avg_vertices * _BYTES_PER_VERTEX / _MB

    # Beam: giữ top-K layout dở dang, mỗi layout mang placement của các instance đã đặt.
    beam_mb = effort.beam_width * shape.instance_count * _BYTES_PER_PLACEMENT / _MB

    # Refinement liên tục `(theta, tx, ty)`: các vòng chạy NỐI TIẾP, nên chỉ tính số pose
    # sống trong một vòng, nhân với beam.
    refinement_mb = (
        effort.beam_width
        * _REFINEMENT_LIVE_POSES
        * avg_vertices
        * _BYTES_PER_VERTEX
        / _MB
    )

    return proposal_mb + beam_mb + refinement_mb


def estimate_shared_mb(shape: WorkloadShape, effort: SearchEffort) -> float:
    """RAM dùng chung: hình học nguồn, NFP/IFP cache, spatial index, thumbnail."""
    geometry_mb = shape.source_vertex_count * _GEOMETRY_COPIES * _BYTES_PER_VERTEX / _MB

    # NFP/IFP: mỗi cặp (part, part) kể cả tự-cặp. Một NFP có bậc ~ tổng đỉnh hai bên.
    pair_count = shape.part_count * (shape.part_count + 1) / 2 if shape.part_count else 0.0
    nfp_raw_mb = pair_count * 2 * shape.avg_vertices_per_part * _BYTES_PER_VERTEX / _MB
    # LRU theo byte: cache KHÔNG được lớn vô hạn theo số cặp (§14).
    nfp_mb = min(nfp_raw_mb, NFP_CACHE_MAX_MB)

    spatial_mb = shape.instance_count * shape.max_sheets * _BYTES_PER_PLACEMENT / _MB
    thumbnail_mb = shape.part_count * _THUMBNAIL_MB_PER_PART

    return geometry_mb + nfp_mb + spatial_mb + thumbnail_mb


def plan_hardware(
    request: dict[str, Any],
    *,
    cpu_count: int | None = None,
) -> HardwarePlan:
    """Ngân sách worker + RAM cho một job, TRƯỚC khi chạm engine.

    Số worker lấy từ ``system_memory.plan_worker_count`` — nguồn chân lý duy nhất. Ước
    lượng RAM **không** phụ thuộc ``rotationConstraint``: nó đi theo effort của profile và
    hình học, đúng như §14 yêu cầu.
    """
    from app.core.system_memory import plan_worker_count  # noqa: PLC0415 — tránh vòng import

    shape = describe_workload(request)
    effort = SEARCH_EFFORT_BY_PROFILE[normalize_profile(request.get("profile"))]

    per_worker_mb = estimate_per_worker_mb(shape, effort)
    shared_mb = estimate_shared_mb(shape, effort)

    workers, reason = plan_worker_count(
        kind=MIXED_NESTING_KIND,
        per_worker_mb=per_worker_mb,
        cpu_count=cpu_count,
        env_override=WORKER_COUNT_ENV,
    )
    estimated_peak_mb = shared_mb + workers * per_worker_mb + _BASE_OVERHEAD_MB

    return HardwarePlan(
        workers=workers,
        per_worker_mb=per_worker_mb,
        shared_mb=shared_mb,
        estimated_peak_mb=estimated_peak_mb,
        effort=effort,
        reason=(
            f"{reason}; model=v{ADMISSION_MODEL_VERSION}, "
            f"parts={shape.part_count}, instances={shape.instance_count}, "
            f"vertices={shape.source_vertex_count}, "
            f"per_worker_mb={per_worker_mb:.1f}, peak_mb={estimated_peak_mb:.1f}"
        ),
    )


def memory_budget_mb() -> float | None:
    """Ngân sách RAM an toàn cho reservation. ``None`` = không đọc được RAM (fail-open)."""
    from app.core.system_memory import read_memory_status_mb  # noqa: PLC0415

    _total_mb, available_mb = read_memory_status_mb()
    if available_mb is None or not math.isfinite(available_mb):
        return None
    # Chừa 25% cho hệ điều hành, UI và sidecar; cùng tinh thần với các planner khác.
    return max(0.0, available_mb * 0.75)


def assert_fits_memory(plan: HardwarePlan, budget_mb: float | None = None) -> None:
    """Fail SỚM nếu job không vừa RAM ngay cả khi chạy một mình.

    §14: "Nếu ước lượng vượt ngân sách an toàn, fail sớm bằng lỗi có hướng dẫn thay vì để
    OOM." Không đọc được RAM thì **không** chặn — giữ hành vi fail-open như các planner
    khác, vì chốt whole-machine slot vẫn còn hiệu lực.
    """
    from app.core.heavy_job_scheduler import HeavyJobMemoryUnavailable  # noqa: PLC0415

    budget = memory_budget_mb() if budget_mb is None else budget_mb
    if budget is None:
        return
    if plan.estimated_peak_mb > budget:
        raise HeavyJobMemoryUnavailable(plan.estimated_peak_mb, budget)
