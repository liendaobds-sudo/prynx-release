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
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any, Callable, Final, Iterator

# Hợp đồng phiên bản mà sidecar này biết cách đọc. Lệch là từ chối chạy.
MIXED_NESTING_PROTOCOL_VERSION: Final[int] = 2
MIXED_NESTING_MANIFEST_SCHEMA_VERSION: Final[int] = 1
MIXED_NESTING_PRODUCTION_SCHEMA_VERSION: Final[int] = 3

# Đúng 16 version tham gia `layoutFingerprint` production. Native có thể công bố thêm
# field tương thích về sau, nhưng thiếu bất kỳ field nào dưới đây thì đường Tem/CNC phải
# fail-closed thay vì dùng wheel cũ trả manifest không đủ provenance.
PRODUCTION_ALGORITHM_VERSION_KEYS: Final[frozenset[str]] = frozenset(
    {
        "protocolVersion",
        "engineVersion",
        "validatorVersion",
        "toleranceVersion",
        "canonicalizationVersion",
        "productionSchemaVersion",
        "normalizeRuleVersion",
        "referencePointRuleVersion",
        "kernelVersion",
        "nfpRuleVersion",
        "scoreVersion",
        "solverVersion",
        "multiStartVersion",
        "baselineVersion",
        "candidateRuleVersion",
        "refineRuleVersion",
    }
)

# Capability tối thiểu của protocol v2. Cho phép native bổ sung capability mới mà
# không làm sidecar cũ từ chối một wheel vẫn tương thích ngược.
MIXED_NESTING_REQUIRED_PROFILES: Final[frozenset[str]] = frozenset(
    {"fast", "balanced", "tight"}
)
MIXED_NESTING_REQUIRED_LAYOUT_INTENTS: Final[frozenset[str]] = frozenset(
    {"quantity_fulfillment", "autofill_single_sheet"}
)
# Extension production S&R được feature-negotiate qua capabilities; hai intent cũ vẫn
# là tập tối thiểu để các đường generic báo engine sẵn sàng.
_AUTOFILL_LAYOUT_INTENTS: Final[frozenset[str]] = frozenset(
    {"autofill_single_sheet", "step_repeat_single_sheet"}
)

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
PRODUCTION_MANIFEST_MISMATCH_CODE: Final[str] = "MIXED_NESTING_MANIFEST_MISMATCH"

# PlacementManifestV1 production có đúng tập field top-level này. Các struct Rust lồng
# nhau tiếp tục được khóa bằng serde `deny_unknown_fields`; chốt Python bắt field lạ ở
# biên trước khi chuyển sang native để lỗi luôn quy về cùng mã production.
_PRODUCTION_MANIFEST_FIELDS: Final[frozenset[str]] = frozenset(
    {
        "schemaVersion",
        "manifestId",
        "protocolVersion",
        "engineVersion",
        "jobId",
        "requestRevision",
        "inputHash",
        "layoutFingerprint",
        "layoutIntent",
        "seed",
        "status",
        "provenance",
        "search",
        "placements",
        "unplaced",
        "stats",
        "validation",
    }
)


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
    layout_intents: tuple[str, ...]
    #: Optional để wheel lab cũ vẫn được chẩn đoán; đường production bắt buộc có.
    native_build_identity: str | None = None
    #: Vắng mặt chỉ được dùng cho AppTool lab cũ. Production gọi
    #: :meth:`require_production_versions` và từ chối wheel thiếu field này.
    manifest_schema_version: int | None = None
    algorithm_versions: tuple[tuple[str, int | str], ...] = ()
    #: Version của cầu điều khiển runtime (worker grant/cache budget). ``None`` giữ
    #: tương thích wheel lab/fake handle cũ; job production mới chỉ truyền grant khi
    #: native công bố đúng version này.
    runtime_control_version: int | None = None
    #: Ba cờ năng lực runtime NF-3 mà native công bố ở ``capabilities()``. ``None`` = wheel
    #: cũ không công bố — KHÔNG được suy diễn thành ``False`` nghiệp vụ (đó chỉ là thiếu
    #: khai báo, không phải "engine chạy tuần tự"). Native hiện tại công bố cả ba là
    #: ``True``: trial portfolio chạy song song theo wave, NFP cold-miss dựng song song,
    #: và cache NFP bị chặn theo byte budget. Ghi lại để log/telemetry Python nói đúng
    #: sự thật thay vì im lặng coi như không có.
    portfolio_parallel_enabled: bool | None = None
    nfp_cold_miss_parallel_enabled: bool | None = None
    nfp_cache_byte_budget_enforced: bool | None = None

    def algorithm_version_map(self) -> dict[str, int | str]:
        return dict(self.algorithm_versions)

    def require_production_versions(self) -> dict[str, int | str]:
        """Trả version map đã kiểm hoặc raise 503 khi wheel chưa đủ contract production."""

        if not _canonical_build_identity(self.native_build_identity):
            raise EngineUnavailableError(
                "Phần lõi tính toán thiếu danh tính native build production. "
                "Hãy cập nhật phần mềm."
            )
        if self.manifest_schema_version != MIXED_NESTING_MANIFEST_SCHEMA_VERSION:
            raise EngineUnavailableError(
                "Phần lõi tính toán chưa hỗ trợ đúng placement manifest production. "
                "Hãy cập nhật phần mềm."
            )
        versions = self.algorithm_version_map()
        missing = PRODUCTION_ALGORITHM_VERSION_KEYS.difference(versions)
        if missing:
            raise EngineUnavailableError(
                "Phần lõi tính toán thiếu provenance thuật toán production. "
                "Hãy cập nhật phần mềm."
            )
        if (
            versions["protocolVersion"] != self.protocol_version
            or versions["engineVersion"] != self.engine_version
            or versions["productionSchemaVersion"]
            != MIXED_NESTING_PRODUCTION_SCHEMA_VERSION
        ):
            raise EngineUnavailableError(
                "Phần lõi tính toán công bố version production không nhất quán."
            )
        return versions


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
        if not isinstance(raw, dict):
            raise TypeError("capability phải là JSON object")
        raw_protocol_version = raw["protocolVersion"]
        if isinstance(raw_protocol_version, bool) or not isinstance(
            raw_protocol_version, int
        ):
            raise TypeError("protocolVersion phải là số nguyên")
    except (ValueError, KeyError, TypeError) as exc:
        raise EngineUnavailableError(
            "Phần lõi tính toán trả về năng lực không đọc được — bản cài không đồng bộ."
        ) from exc

    if raw_protocol_version != MIXED_NESTING_PROTOCOL_VERSION:
        # Đọc version trước field v2 để wheel v1 thiếu layoutIntents vẫn được chẩn
        # đoán đúng là stale protocol, thay vì lỗi capability chung.
        raise EngineUnavailableError(
            "Phần lõi tính toán dùng phiên bản giao thức "
            f"{raw_protocol_version}, sidecar cần {MIXED_NESTING_PROTOCOL_VERSION}. "
            "Hãy cập nhật phần mềm."
        )

    try:
        engine_version = raw["engineVersion"]
        reflection = raw["reflection"]
        default_rotation = raw["defaultRotation"]
        continuous_translation = raw["continuousTranslation"]
        profiles = raw["profiles"]
        layout_intents = raw["layoutIntents"]
        native_build_identity = raw.get("nativeBuildIdentity")
        manifest_schema_version = raw.get("manifestSchemaVersion")
        algorithm_versions_raw = raw.get("algorithmVersions")
        runtime_control_version = raw.get("runtimeControlVersion")
        portfolio_parallel_enabled = raw.get("portfolioParallelEnabled")
        nfp_cold_miss_parallel_enabled = raw.get("nfpColdMissParallelEnabled")
        nfp_cache_byte_budget_enforced = raw.get("nfpCacheByteBudgetEnforced")
        if not isinstance(engine_version, str) or not engine_version.strip():
            raise TypeError("engineVersion phải là chuỗi không rỗng")
        if not isinstance(reflection, str) or not isinstance(default_rotation, str):
            raise TypeError("capability góc/lật phải là chuỗi")
        if not isinstance(profiles, list) or not all(
            isinstance(item, str) and item for item in profiles
        ):
            raise TypeError("profiles phải là mảng chuỗi")
        if not isinstance(layout_intents, list) or not all(
            isinstance(item, str) and item for item in layout_intents
        ):
            raise TypeError("layoutIntents phải là mảng chuỗi")
        if native_build_identity is not None and not isinstance(
            native_build_identity, str
        ):
            raise TypeError("nativeBuildIdentity phải là chuỗi khi có mặt")
        if manifest_schema_version is not None and (
            isinstance(manifest_schema_version, bool)
            or not isinstance(manifest_schema_version, int)
        ):
            raise TypeError("manifestSchemaVersion phải là số nguyên")
        if algorithm_versions_raw is None:
            algorithm_versions: tuple[tuple[str, int | str], ...] = ()
        else:
            if not isinstance(algorithm_versions_raw, dict):
                raise TypeError("algorithmVersions phải là object")
            for key, value in algorithm_versions_raw.items():
                if not isinstance(key, str) or not key:
                    raise TypeError("algorithmVersions có key không hợp lệ")
                if isinstance(value, bool) or not isinstance(value, (int, str)):
                    raise TypeError("algorithmVersions có value không hợp lệ")
                if isinstance(value, str) and not value:
                    raise TypeError("algorithmVersions có chuỗi rỗng")
            algorithm_versions = tuple(sorted(algorithm_versions_raw.items()))
        if runtime_control_version is not None and (
            isinstance(runtime_control_version, bool)
            or not isinstance(runtime_control_version, int)
            or runtime_control_version <= 0
        ):
            raise TypeError("runtimeControlVersion phải là số nguyên dương")
        # Ba cờ NF-3 chỉ mang tính khai báo: chấp nhận vắng mặt (wheel cũ) nhưng khi có
        # mặt PHẢI là bool thật, không nhận số/chuỗi "true". Không ép giá trị true ở đây —
        # ghi đúng cái native nói để log phản ánh trung thực, kể cả khi một wheel tương lai
        # tắt cờ.
        for _flag_name, _flag_value in (
            ("portfolioParallelEnabled", portfolio_parallel_enabled),
            ("nfpColdMissParallelEnabled", nfp_cold_miss_parallel_enabled),
            ("nfpCacheByteBudgetEnforced", nfp_cache_byte_budget_enforced),
        ):
            if _flag_value is not None and not isinstance(_flag_value, bool):
                raise TypeError(f"{_flag_name} phải là bool khi có mặt")
        capabilities = EngineCapabilities(
            protocol_version=raw_protocol_version,
            engine_version=engine_version,
            reflection=reflection,
            default_rotation=default_rotation,
            continuous_translation=continuous_translation,
            profiles=tuple(profiles),
            layout_intents=tuple(layout_intents),
            native_build_identity=native_build_identity,
            manifest_schema_version=manifest_schema_version,
            algorithm_versions=algorithm_versions,
            runtime_control_version=runtime_control_version,
            portfolio_parallel_enabled=portfolio_parallel_enabled,
            nfp_cold_miss_parallel_enabled=nfp_cold_miss_parallel_enabled,
            nfp_cache_byte_budget_enforced=nfp_cache_byte_budget_enforced,
        )
    except (ValueError, KeyError, TypeError) as exc:
        raise EngineUnavailableError(
            "Phần lõi tính toán trả về năng lực không đọc được — bản cài không đồng bộ."
        ) from exc

    if capabilities.reflection != "forbidden":
        # Bất biến của cả dự án: bình mặt trước không lật khuôn.
        raise EngineUnavailableError(
            "Phần lõi tính toán cho phép lật khuôn — bản cài không đúng hợp đồng."
        )
    if capabilities.default_rotation != "free":
        raise EngineUnavailableError(
            "Phần lõi tính toán không hỗ trợ miền góc tự do mặc định — "
            "bản cài không đúng hợp đồng."
        )
    if capabilities.continuous_translation is not True:
        raise EngineUnavailableError(
            "Phần lõi tính toán không hỗ trợ dịch chuyển liên tục — "
            "bản cài không đúng hợp đồng."
        )
    if not MIXED_NESTING_REQUIRED_PROFILES.issubset(capabilities.profiles):
        raise EngineUnavailableError(
            "Phần lõi tính toán không hỗ trợ đủ hồ sơ tối ưu — "
            "bản cài không đúng hợp đồng."
        )
    if not MIXED_NESTING_REQUIRED_LAYOUT_INTENTS.issubset(
        capabilities.layout_intents
    ):
        raise EngineUnavailableError(
            "Phần lõi tính toán không hỗ trợ đủ ý định bình số lượng/tự lấp đầy — "
            "bản cài không đúng hợp đồng."
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

    @staticmethod
    def _encode_request(request: dict[str, Any]) -> str:
        try:
            return json.dumps(request, allow_nan=False)
        except ValueError as exc:
            # `allow_nan=False` chặn NaN/Infinity ngay ở biên Python: JSON không có hai
            # giá trị đó, và để chúng đi tiếp sẽ thành lỗi mơ hồ ở tầng dưới.
            raise MixedNestingError(
                "MIXED_NESTING_BAD_JSON",
                "Dữ liệu lệnh chứa giá trị không hữu hạn.",
                422,
            ) from exc

    @staticmethod
    def _decode_manifest(encoded: str) -> dict[str, Any]:
        try:
            return json.loads(encoded)
        except ValueError as exc:
            raise MixedNestingError(
                "MIXED_NESTING_ENGINE_ERROR",
                "Kết quả từ engine không đọc được.",
                500,
            ) from exc

    def _solve_native(
        self,
        request: dict[str, Any],
        *,
        worker_grant: int | None = None,
        nfp_cache_max_bytes_per_trial: int | None = None,
    ) -> dict[str, Any]:
        payload = self._encode_request(request)
        try:
            if worker_grant is None:
                encoded = self._run.solve(payload)
            else:
                encoded = self._run.solve(
                    payload,
                    int(worker_grant),
                    nfp_cache_max_bytes_per_trial,
                )
        except MixedNestingError:
            raise
        except BaseException as exc:  # noqa: BLE001 - phải quy MỌI lỗi Rust về mã ổn định
            raise _translate_engine_error(exc) from exc
        return self._decode_manifest(encoded)

    def solve(self, request: dict[str, Any]) -> dict[str, Any]:
        """Chạy lồng ghép, trả placement manifest dạng dict.

        **Chặn thread gọi.** Nơi gọi phải đẩy qua threadpool hoặc heavy scheduler —
        hàm này cố ý không tự tạo thread để việc điều phối nằm ở một chỗ duy nhất.
        Đường gọi cũ giữ đúng một đối số để wheel/fake handle cũ không vỡ.
        """
        return self._solve_native(request)

    def solve_with_hardware(
        self,
        request: dict[str, Any],
        *,
        worker_grant: int,
        nfp_cache_max_bytes_per_trial: int,
    ) -> dict[str, Any]:
        """Truyền grant runtime đã admission vào native mà không đổi request canonical.

        Grant chỉ là lịch chạy theo phần cứng, tuyệt đối không được nhét vào request JSON
        vì như vậy cùng bài in sẽ có identity/fingerprint khác nhau giữa hai máy. Native
        cũ thiếu runtime-control bị từ chối rõ; fake handle cũ được tương thích ở tầng
        registry bằng feature detection, không hạ âm thầm production xuống đường cũ.
        """
        if self._capabilities.runtime_control_version != 1:
            raise EngineUnavailableError(
                "Phần lõi tính toán chưa nhận được worker grant/cache budget. "
                "Hãy cập nhật phần mềm."
            )
        if worker_grant <= 0 or nfp_cache_max_bytes_per_trial <= 0:
            raise ValueError("worker grant và cache budget phải là số dương")
        return self._solve_native(
            request,
            worker_grant=worker_grant,
            nfp_cache_max_bytes_per_trial=nfp_cache_max_bytes_per_trial,
        )

    def solve_production(self, request: dict[str, Any]) -> dict[str, Any]:
        """Solve production rồi kiểm manifest echo đúng identity/provenance.

        Đường lab giữ :meth:`solve` để tương thích payload cũ. Tem bế/CNC bắt buộc dùng
        hàm này; wheel cũ hoặc manifest lệch identity đều fail-closed.
        """

        self._capabilities.require_production_versions()
        manifest = self.solve(request)
        validate_production_manifest(manifest, request, self._capabilities)
        return manifest

    def solve_production_with_hardware(
        self,
        request: dict[str, Any],
        *,
        worker_grant: int,
        nfp_cache_max_bytes_per_trial: int,
    ) -> dict[str, Any]:
        """Biến thể production cho orchestrator truyền grant ở lô kế tiếp."""
        self._capabilities.require_production_versions()
        manifest = self.solve_with_hardware(
            request,
            worker_grant=worker_grant,
            nfp_cache_max_bytes_per_trial=nfp_cache_max_bytes_per_trial,
        )
        validate_production_manifest(manifest, request, self._capabilities)
        return manifest

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


def _manifest_mismatch() -> MixedNestingError:
    return MixedNestingError(
        PRODUCTION_MANIFEST_MISMATCH_CODE,
        "Placement manifest không khớp lệnh production đã ghim; engine từ chối công bố.",
        500,
    )


def _canonical_build_identity(value: Any) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and value == value.lower()
        and all(character in "0123456789abcdef" for character in value)
    )


def _validate_manifest_with_native(
    request: dict[str, Any], manifest: dict[str, Any]
) -> None:
    """Chạy lại final validator Rust trên layout đã có, tuyệt đối không solve lại."""

    try:
        request_payload = json.dumps(request, allow_nan=False)
        manifest_payload = json.dumps(manifest, allow_nan=False)
        run_class, _capabilities = load_engine()
        validate_fn = getattr(run_class, "validate_manifest", None)
        if not callable(validate_fn):
            raise RuntimeError("native chưa có re-validator placement manifest")
        validate_fn(request_payload, manifest_payload)
    except BaseException as exc:  # noqa: BLE001 - mọi lỗi native phải fail-closed cùng mã
        raise _manifest_mismatch() from exc


def validate_production_manifest(
    manifest: dict[str, Any],
    request: dict[str, Any],
    capabilities: EngineCapabilities,
) -> None:
    """Kiểm postcondition production, không sửa/điền thiếu dữ liệu từ engine."""

    versions = capabilities.require_production_versions()
    if (
        not isinstance(manifest, dict)
        or set(manifest) != _PRODUCTION_MANIFEST_FIELDS
        or not isinstance(request, dict)
    ):
        raise _manifest_mismatch()

    contract = request.get("productionContract")
    job_id = request.get("jobId")
    if not isinstance(contract, dict) or not isinstance(job_id, str) or not job_id:
        raise _manifest_mismatch()

    validation = manifest.get("validation")
    provenance = manifest.get("provenance")
    if not isinstance(validation, dict) or not isinstance(provenance, dict):
        raise _manifest_mismatch()

    expected_identity = {
        "schemaVersion": capabilities.manifest_schema_version,
        "manifestId": job_id,
        "protocolVersion": capabilities.protocol_version,
        "engineVersion": capabilities.engine_version,
        "jobId": job_id,
        "requestRevision": contract.get("requestRevision"),
        "inputHash": contract.get("inputHash"),
        "layoutFingerprint": contract.get("layoutFingerprint"),
        "layoutIntent": request.get("layoutIntent", "quantity_fulfillment"),
        "seed": request.get("seed"),
        "status": "completed",
    }
    if any(manifest.get(key) != value for key, value in expected_identity.items()):
        raise _manifest_mismatch()
    if validation.get("valid") is not True:
        raise _manifest_mismatch()
    if (
        not _canonical_build_identity(provenance.get("nativeBuildIdentity"))
        or provenance.get("nativeBuildIdentity")
        != capabilities.native_build_identity
    ):
        raise _manifest_mismatch()

    effective_versions: dict[str, Any] = {
        "protocolVersion": manifest.get("protocolVersion"),
        "engineVersion": manifest.get("engineVersion"),
        "validatorVersion": validation.get("validatorVersion"),
        "toleranceVersion": provenance.get("toleranceVersion"),
        "canonicalizationVersion": provenance.get("canonicalizationVersion"),
        "productionSchemaVersion": provenance.get("productionSchemaVersion"),
        "normalizeRuleVersion": provenance.get("normalizeRuleVersion"),
        "referencePointRuleVersion": provenance.get("referencePointRuleVersion"),
        "kernelVersion": provenance.get("kernelVersion"),
        "nfpRuleVersion": provenance.get("nfpRuleVersion"),
        "scoreVersion": provenance.get("scoreVersion"),
        "solverVersion": provenance.get("solverVersion"),
        "multiStartVersion": provenance.get("multiStartVersion"),
        "baselineVersion": provenance.get("baselineVersion"),
        "candidateRuleVersion": provenance.get("candidateRuleVersion"),
        "refineRuleVersion": provenance.get("refineRuleVersion"),
    }
    if any(
        effective_versions.get(key) != versions.get(key)
        for key in PRODUCTION_ALGORITHM_VERSION_KEYS
    ):
        raise _manifest_mismatch()

    _validate_manifest_with_native(request, manifest)

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
ADMISSION_MODEL_VERSION: Final[int] = 4

# Mirror trần protocol `MAX_INSTANCES_TOTAL` của Rust. Core không import schema để
# tránh đảo tầng; test admission khóa parity ba chiều Rust ↔ schema ↔ service.
AUTOFILL_INSTANCE_ADMISSION_CAP: Final[int] = 100_000


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

#: Ngân sách byte của HashMap NFP/IFP trong một baseline/trial. Native bỏ insert khi
#: vượt trần; đây không phải LRU và §14 cấm cache vô hạn theo từng giá trị ``f64``.
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

    #: Grant tối đa theo CPU/RAM. Giữ tên ``workers`` để không phá consumer cũ.
    workers: int
    #: Số worker compute NFP có thể hoạt động đồng thời theo grant hiện tại.
    active_workers: int
    #: Số trial portfolio chạy song song tối đa của lượt solve (NF-3 đã bật). Bằng
    #: ``min(worker_grant, trial_count)`` — đúng mức đồng thời mà engine dispatch theo
    #: wave. KHÔNG còn là "số quan sát cho tương lai": trial nay chạy song song thật.
    portfolio_trial_capacity: int
    per_worker_mb: float
    shared_mb: float
    estimated_peak_mb: float
    nfp_cache_max_bytes_per_trial: int
    effort: SearchEffort
    reason: str

    @property
    def worker_grant(self) -> int:
        """Tên tường minh dùng ở cầu native; alias ``workers`` giữ tương thích."""
        return self.workers


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


def _outer_area_mm2(ring: Any) -> float | None:
    """Diện tích tuyệt đối theo shoelace; dữ liệu xấu trả `None`, không ném lỗi.

    Admission không thay validator hình học. Hàm chỉ cần một cận RAM bảo thủ trước khi
    gọi engine; hole không bị trừ vì core MVP cũng coi outer là vật liệu đặc.
    """
    if not isinstance(ring, list) or len(ring) < 3:
        return None
    points: list[tuple[float, float]] = []
    for raw in ring:
        if not isinstance(raw, (list, tuple)) or len(raw) < 2:
            return None
        try:
            x = float(raw[0])
            y = float(raw[1])
        except (TypeError, ValueError):
            return None
        if not math.isfinite(x) or not math.isfinite(y):
            return None
        points.append((x, y))
    twice_area = 0.0
    for index, (x1, y1) in enumerate(points):
        x2, y2 = points[(index + 1) % len(points)]
        twice_area += x1 * y2 - x2 * y1
    area = abs(twice_area) / 2.0
    return area if math.isfinite(area) and area > 0.0 else None


def _autofill_instance_upper_bound(request: dict[str, Any], parts: list[Any]) -> int:
    """Cận trên số placement autofill trên một tờ để admission không thấy 0 con.

    Không trừ hole, gap hay khoảng trống giữa polygon: `ceil(usable/min_outer)` vì
    vậy chỉ có thể ước lượng cao hơn sức chứa thật. Clamp theo trần protocol để dữ
    liệu cực nhỏ không làm số học/RAM phình vô hạn.
    """
    sheet = request.get("sheet")
    if not isinstance(sheet, dict):
        return 1
    margin = sheet.get("marginMm")
    if not isinstance(margin, dict):
        margin = {}
    try:
        width = float(sheet.get("widthMm"))
        height = float(sheet.get("heightMm"))
        usable_width = width - float(margin.get("left", 0.0)) - float(
            margin.get("right", 0.0)
        )
        usable_height = height - float(margin.get("top", 0.0)) - float(
            margin.get("bottom", 0.0)
        )
    except (TypeError, ValueError):
        return 1
    if not math.isfinite(usable_width) or not math.isfinite(usable_height):
        return AUTOFILL_INSTANCE_ADMISSION_CAP
    if usable_width <= 0.0 or usable_height <= 0.0:
        return 1
    usable_area = usable_width * usable_height
    if not math.isfinite(usable_area):
        return AUTOFILL_INSTANCE_ADMISSION_CAP
    if usable_area <= 0.0:
        return 1

    areas = [
        area
        for part in parts
        if isinstance(part, dict)
        if (area := _outer_area_mm2(part.get("outer"))) is not None
    ]
    if not areas:
        return 1
    ratio = usable_area / min(areas)
    if not math.isfinite(ratio):
        return AUTOFILL_INSTANCE_ADMISSION_CAP
    return max(1, min(AUTOFILL_INSTANCE_ADMISSION_CAP, math.ceil(ratio)))


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
        if request.get("layoutIntent") not in _AUTOFILL_LAYOUT_INTENTS:
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
    if request.get("layoutIntent") in _AUTOFILL_LAYOUT_INTENTS:
        instance_count = _autofill_instance_upper_bound(request, parts)

    return WorkloadShape(
        part_count=part_count,
        instance_count=instance_count,
        source_vertex_count=vertex_count,
        max_sheets=max_sheets,
    )


def estimate_per_worker_mb(shape: WorkloadShape, effort: SearchEffort) -> float:
    """Cận RAM quy đổi cho MỘT worker compute NFP.

    Native hiện dựng NFP cold-miss song song ngay trong một baseline/trial. HashMap cache
    vẫn thuộc trial và có byte budget, nhưng các worker giữ kết quả build cục bộ tới
    publication barrier; admission vì vậy giữ cận bảo thủ theo toàn bộ compute grant.

    NF-3: portfolio trial nay chạy SONG SONG theo wave (mỗi trial một cache + evaluation
    atomic riêng). Cận này vẫn đúng và vẫn bảo thủ: số trial chạy đồng thời luôn
    ``≤ worker_grant``, mà reservation tính thẳng ``worker_grant × per_worker`` (đã gồm
    trọn một NFP cache mỗi worker), nên nó là cận TRÊN của đỉnh RAM song song, không phải
    cận của đường tuần tự cũ.
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

    return proposal_mb + beam_mb + refinement_mb + NFP_CACHE_MAX_MB


def estimate_shared_mb(shape: WorkloadShape, effort: SearchEffort) -> float:
    """RAM dùng chung: hình học nguồn, spatial index và thumbnail."""
    del effort  # Effort chỉ ảnh hưởng search state per-worker; giữ tham số tương thích.
    geometry_mb = shape.source_vertex_count * _GEOMETRY_COPIES * _BYTES_PER_VERTEX / _MB

    spatial_mb = shape.instance_count * shape.max_sheets * _BYTES_PER_PLACEMENT / _MB
    thumbnail_mb = shape.part_count * _THUMBNAIL_MB_PER_PART

    return geometry_mb + spatial_mb + thumbnail_mb


def plan_hardware(
    request: dict[str, Any],
    *,
    cpu_count: int | None = None,
    worker_grant_limit: int | None = None,
) -> HardwarePlan:
    """Ngân sách worker + RAM cho một job, TRƯỚC khi chạm engine.

    Số worker lấy từ ``system_memory.plan_worker_count`` — nguồn chân lý duy nhất. Ước
    lượng RAM **không** phụ thuộc ``rotationConstraint``: nó đi theo effort của profile và
    hình học, đúng như §14 yêu cầu. ``active_workers`` là compute concurrency NFP;
    ``portfolio_trial_capacity`` là số trial portfolio chạy song song (NF-3 đã bật) —
    cả hai đều được reservation tính theo cận trên ``worker_grant``.

    ``worker_grant_limit`` là phần ngân sách runtime do một batch cha đã chia. Nó được
    áp SAU planner/env để nhiều solve không tự nhận trọn ``cpu-1`` rồi oversubscribe;
    tổng grant của batch vẫn do chính ``plan_worker_count`` quyết định.
    """
    from app.core.system_memory import plan_worker_count  # noqa: PLC0415 — tránh vòng import

    if worker_grant_limit is not None and (
        isinstance(worker_grant_limit, bool)
        or not isinstance(worker_grant_limit, int)
        or worker_grant_limit <= 0
    ):
        raise ValueError("worker_grant_limit phải là số nguyên dương hoặc None")

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
    if worker_grant_limit is not None:
        # PERF (audit 2026-09-01 §SR13-WAVE): cap này là phần grant đã chia từ
        # ngân sách toàn máy, không phải hard-cap độc lập trên máy mạnh.
        workers = min(workers, worker_grant_limit)
        reason = f"{reason}; runtime_worker_grant_limit={worker_grant_limit}"

    # PERF (audit 2026-08-30 §NEST-NF-3): grant chạy thật ở cả hai tầng — cold-miss NFP
    # batch VÀ portfolio trial song song theo wave. `active_workers` là mức NFP đồng thời;
    # `portfolio_trial_capacity` là số trial chạy song song (≤ trial_count của profile).
    active_workers = workers
    portfolio_trial_capacity = min(workers, effort.trial_count)
    estimated_peak_mb = shared_mb + active_workers * per_worker_mb + _BASE_OVERHEAD_MB
    nfp_cache_max_bytes_per_trial = int(NFP_CACHE_MAX_MB * _MB)

    return HardwarePlan(
        workers=workers,
        active_workers=active_workers,
        portfolio_trial_capacity=portfolio_trial_capacity,
        per_worker_mb=per_worker_mb,
        shared_mb=shared_mb,
        estimated_peak_mb=estimated_peak_mb,
        nfp_cache_max_bytes_per_trial=nfp_cache_max_bytes_per_trial,
        effort=effort,
        reason=(
            f"{reason}; model=v{ADMISSION_MODEL_VERSION}, "
            f"parts={shape.part_count}, instances={shape.instance_count}, "
            f"vertices={shape.source_vertex_count}, "
            f"worker_grant={workers}, active_workers={active_workers}, "
            f"portfolio_trial_capacity={portfolio_trial_capacity}, "
            f"nfp_cache_mb_per_trial={NFP_CACHE_MAX_MB:.1f}, "
            f"per_worker_mb={per_worker_mb:.1f}, peak_mb={estimated_peak_mb:.1f}"
        ),
    )


@dataclass(frozen=True)
class BatchHardwarePlan:
    """Ngân sách toàn batch và cách chia grant xác định cho từng wave."""

    total_worker_grant: int
    max_parallel_jobs: int
    reason: str

    def grants_for_wave(self, active_jobs: int) -> tuple[int, ...]:
        """Chia hết tổng grant, chênh tối đa một worker và giữ thứ tự ổn định."""

        if (
            isinstance(active_jobs, bool)
            or not isinstance(active_jobs, int)
            or active_jobs <= 0
            or active_jobs > self.max_parallel_jobs
        ):
            raise ValueError("active_jobs không hợp lệ với kế hoạch batch")
        base, remainder = divmod(self.total_worker_grant, active_jobs)
        return tuple(
            base + (1 if index < remainder else 0)
            for index in range(active_jobs)
        )


@dataclass
class _BatchWorkerGrantWaiter:
    """Một yêu cầu grant nguyên tử đang chờ coordinator cấp CPU."""

    requested: int
    granted: bool = False
    bypasses: int = 0


@dataclass
class _BatchWorkerGrantState:
    """Trạng thái private của một batch S&R trong một process sidecar."""

    capacity: int
    held: int = 0
    closed: bool = False
    waiters: list[_BatchWorkerGrantWaiter] | None = None

    def __post_init__(self) -> None:
        if self.waiters is None:
            self.waiters = []


class BatchWorkerGrantRequest:
    """Vé một-lần giữ nguyên grant của lane cho tới khi solve kết thúc.

    Vé chỉ được claim bởi owner singleflight thật. Cache hit và follower giữ object
    nhưng không claim, vì vậy không chiếm CPU quota trong lúc chờ kết quả của owner.
    """

    __slots__ = (
        "_batch_id",
        "_claimed",
        "_claim_lock",
        "_coordinator",
        "worker_grant",
    )

    def __init__(
        self,
        coordinator: "SharedBatchWorkerGrantCoordinator",
        batch_id: object,
        worker_grant: int,
    ) -> None:
        self._coordinator = coordinator
        self._batch_id = batch_id
        self.worker_grant = worker_grant
        self._claim_lock = threading.Lock()
        self._claimed = False

    @contextmanager
    def claim(
        self,
        cancel_check: Callable[[], bool] | None = None,
    ) -> Iterator[int]:
        """Chờ quota, trả đúng grant đã lập kế hoạch và luôn nhả khi terminal."""

        with self._claim_lock:
            if self._claimed:
                raise RuntimeError("Vé worker grant chỉ được claim một lần.")
            self._claimed = True

        acquired = False
        try:
            self._coordinator._acquire(  # noqa: SLF001 - vé là facade của coordinator
                self._batch_id,
                self.worker_grant,
                cancel_check,
            )
            acquired = True
            yield self.worker_grant
        finally:
            if acquired:
                self._coordinator._release(  # noqa: SLF001 - cặp acquire/release nội bộ
                    self._batch_id,
                    self.worker_grant,
                )


class BatchWorkerGrantLease:
    """Đăng ký lifecycle của một batch với coordinator process-wide."""

    __slots__ = ("_batch_id", "_closed", "_coordinator", "total_worker_grant")

    def __init__(
        self,
        coordinator: "SharedBatchWorkerGrantCoordinator",
        batch_id: object,
        total_worker_grant: int,
    ) -> None:
        self._coordinator = coordinator
        self._batch_id = batch_id
        self.total_worker_grant = total_worker_grant
        self._closed = False

    def request(self, worker_grant: int) -> BatchWorkerGrantRequest:
        if self._closed:
            raise RuntimeError("Batch worker grant đã đóng.")
        return self._coordinator._new_request(  # noqa: SLF001 - lease là facade
            self._batch_id,
            worker_grant,
        )

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._coordinator._unregister(self._batch_id)  # noqa: SLF001


class SharedBatchWorkerGrantCoordinator:
    """Chia một ngân sách worker thật cho mọi batch S&R trong cùng process.

    PERF (audit 2026-09-02 §PERF-NEST-12): trước đây mỗi preview tự nhận trọn
    ``cpu-1``; hai preview trên máy 16 luồng vì vậy công bố 30 grant và làm deadline
    solver hết sớm. Coordinator không thêm hard-cap: capacity vẫn lấy từ planner
    RAM/CPU hiện hữu. Một batch đơn dùng trọn capacity; khi có nhiều batch, quota được
    cấp theo batch và luôn giữ nguyên grant 1/2 của từng lane đã lập kế hoạch.

    Không preempt native solve đang chạy. Batch tới sau nhận quota ngay ở lần release
    kế tiếp; cấp phát work-conserving nhưng ưu tiên batch đang dưới phần chia công bằng.
    Condition không bao giờ được giữ khi gọi store, callback hay native solver.
    """

    def __init__(self) -> None:
        self._condition = threading.Condition(threading.Lock())
        self._states: dict[object, _BatchWorkerGrantState] = {}
        self._order: list[object] = []
        self._cursor = 0
        self._held_total = 0

    @staticmethod
    def _positive_int(value: Any, *, name: str) -> int:
        if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
            raise ValueError(f"{name} phải là số nguyên dương")
        return value

    def register(self, total_worker_grant: int) -> BatchWorkerGrantLease:
        capacity = self._positive_int(
            total_worker_grant,
            name="total_worker_grant",
        )
        batch_id = object()
        with self._condition:
            self._states[batch_id] = _BatchWorkerGrantState(capacity=capacity)
            self._order.append(batch_id)
            self._dispatch_locked()
        return BatchWorkerGrantLease(self, batch_id, capacity)

    def _new_request(
        self,
        batch_id: object,
        worker_grant: int,
    ) -> BatchWorkerGrantRequest:
        requested = self._positive_int(worker_grant, name="worker_grant")
        with self._condition:
            state = self._states.get(batch_id)
            if state is None or state.closed:
                raise RuntimeError("Batch worker grant không còn hoạt động.")
            if requested > state.capacity:
                raise ValueError("worker_grant vượt tổng grant của batch")
        return BatchWorkerGrantRequest(self, batch_id, requested)

    def _effective_capacity_locked(self) -> int:
        capacities = [
            state.capacity
            for state in self._states.values()
            # Lease close khi còn active trở thành tombstone: capacity thấp của nó
            # vẫn phải có hiệu lực tới lần release cuối, nếu không batch mới có thể
            # làm tổng held vượt ngân sách đã bảo vệ solve đang chạy.
            if not state.closed or state.held > 0
        ]
        return min(capacities) if capacities else 0

    def _waiting_order_locked(self) -> list[object]:
        if not self._order:
            return []
        start = self._cursor % len(self._order)
        rotated = self._order[start:] + self._order[:start]
        return [
            batch_id
            for batch_id in rotated
            if (
                (state := self._states.get(batch_id)) is not None
                and not state.closed
                and bool(state.waiters)
            )
        ]

    def _advance_cursor_locked(self, batch_id: object) -> None:
        if not self._order:
            self._cursor = 0
            return
        try:
            index = self._order.index(batch_id)
        except ValueError:  # pragma: no cover - hàng rào trạng thái
            self._cursor %= len(self._order)
            return
        self._cursor = (index + 1) % len(self._order)

    def _dispatch_locked(self) -> None:
        """Cấp các waiter vừa capacity; gọi khi đăng ký/acquire/release/cancel."""

        while True:
            capacity = self._effective_capacity_locked()
            free = capacity - self._held_total
            if free <= 0:
                return
            waiting = self._waiting_order_locked()
            if not waiting:
                return

            base, remainder = divmod(capacity, len(waiting))
            targets = {
                batch_id: base + (1 if index < remainder else 0)
                for index, batch_id in enumerate(waiting)
            }

            selected: object | None = None
            blocked_by_weight = [
                self._states[batch_id].waiters[0]
                for batch_id in waiting
                if self._states[batch_id].waiters is not None
                and self._states[batch_id].waiters[0].requested > free
            ]
            for batch_id in waiting:
                state = self._states[batch_id]
                assert state.waiters is not None
                request = state.waiters[0]
                if (
                    request.requested <= free
                    and state.held + request.requested <= targets[batch_id]
                ):
                    selected = batch_id
                    break

            if selected is not None and blocked_by_weight:
                if any(waiter.bypasses >= 1 for waiter in blocked_by_weight):
                    return

            if selected is None:
                # Grant 2 không được bẻ thành 1. Cho grant nhỏ bypass đúng một lần;
                # từ lần kế giữ tối đa `requested-1` token rỗi để grant lớn tích đủ.
                # Đây là bounded bypass: hy sinh work-conserving trong cửa sổ ngắn
                # để chuỗi waiter 1 không làm waiter 2 đói vô hạn.
                if any(waiter.bypasses >= 1 for waiter in blocked_by_weight):
                    return
                selected = next(
                    (
                        batch_id
                        for batch_id in waiting
                        if self._states[batch_id].waiters is not None
                        and self._states[batch_id].waiters[0].requested <= free
                    ),
                    None,
                )
            if selected is None:
                return

            for waiter in blocked_by_weight:
                waiter.bypasses += 1

            state = self._states[selected]
            assert state.waiters is not None
            waiter = state.waiters.pop(0)
            state.held += waiter.requested
            self._held_total += waiter.requested
            waiter.granted = True
            self._advance_cursor_locked(selected)
            self._condition.notify_all()

    def _remove_waiter_locked(
        self,
        state: _BatchWorkerGrantState,
        waiter: _BatchWorkerGrantWaiter,
    ) -> None:
        assert state.waiters is not None
        try:
            state.waiters.remove(waiter)
        except ValueError:
            pass

    def _acquire(
        self,
        batch_id: object,
        requested: int,
        cancel_check: Callable[[], bool] | None,
    ) -> None:
        waiter = _BatchWorkerGrantWaiter(requested=requested)
        with self._condition:
            state = self._states.get(batch_id)
            if state is None or state.closed:
                raise InterruptedError("Batch nesting đã đóng trước khi nhận CPU grant.")
            assert state.waiters is not None
            state.waiters.append(waiter)
            try:
                self._dispatch_locked()
                while not waiter.granted:
                    if state.closed or (
                        cancel_check is not None and cancel_check()
                    ):
                        raise InterruptedError(
                            "Đã hủy nesting khi đang chờ CPU grant."
                        )
                    # Timeout ngắn để thấy Event cancel dù caller không notify Condition.
                    self._condition.wait(timeout=0.05)

                if cancel_check is not None and cancel_check():
                    raise InterruptedError(
                        "Đã hủy nesting ngay sau khi nhận CPU grant."
                    )
            except BaseException:
                # Cancel callback production chỉ là Event.is_set, nhưng facade nhận
                # callable tổng quát. Callable ném lỗi cũng phải thu hồi waiter/grant;
                # nếu không coordinator bị poison và tombstone không bao giờ đóng.
                if waiter.granted:
                    state.held -= requested
                    self._held_total -= requested
                    waiter.granted = False
                else:
                    self._remove_waiter_locked(state, waiter)
                self._dispatch_locked()
                self._condition.notify_all()
                raise

    def _release(self, batch_id: object, requested: int) -> None:
        with self._condition:
            state = self._states.get(batch_id)
            if state is None or state.held < requested:
                raise RuntimeError("CPU worker grant bị nhả sai lifecycle.")
            state.held -= requested
            self._held_total -= requested
            if state.closed and state.held == 0:
                self._remove_state_locked(batch_id)
            self._dispatch_locked()
            self._condition.notify_all()

    def _remove_state_locked(self, batch_id: object) -> None:
        self._states.pop(batch_id, None)
        try:
            index = self._order.index(batch_id)
        except ValueError:
            return
        self._order.pop(index)
        if self._order:
            if index < self._cursor:
                self._cursor -= 1
            self._cursor %= len(self._order)
        else:
            self._cursor = 0

    def _unregister(self, batch_id: object) -> None:
        with self._condition:
            state = self._states.get(batch_id)
            if state is None or state.closed:
                return
            state.closed = True
            assert state.waiters is not None
            state.waiters.clear()
            if state.held == 0:
                self._remove_state_locked(batch_id)
            self._dispatch_locked()
            self._condition.notify_all()

    def snapshot(self) -> dict[str, int]:
        """Telemetry/test hook nhỏ; không lộ batch identity ra API."""

        with self._condition:
            return {
                "capacity": self._effective_capacity_locked(),
                "held": self._held_total,
                "batches": sum(
                    1 for state in self._states.values() if not state.closed
                ),
                "waiters": sum(
                    len(state.waiters or ()) for state in self._states.values()
                ),
            }


_SHARED_BATCH_WORKER_GRANTS = SharedBatchWorkerGrantCoordinator()


def register_shared_batch_worker_grants(
    total_worker_grant: int,
) -> BatchWorkerGrantLease:
    """Đăng ký một batch S&R vào ngân sách CPU process-wide."""

    return _SHARED_BATCH_WORKER_GRANTS.register(total_worker_grant)


def plan_batch_hardware(
    job_count: int,
    *,
    cpu_count: int | None = None,
) -> BatchHardwarePlan:
    """Lập tổng grant cho nhiều solve độc lập, không nhân ``cpu-1`` theo số job.

    Ước lượng mỗi lane gồm ít nhất một cache NFP và overhead vòng chạy. Con số này chỉ
    có thể hạ concurrency trên máy ``<16 GB`` qua planner chung; máy ``≥16 GB`` vẫn giữ
    toàn bộ ``cpu-1`` theo rule dự án. Env operator cũng được đọc đúng một lần ở đây.
    """

    from app.core.system_memory import plan_worker_count  # noqa: PLC0415 — tránh vòng import

    if isinstance(job_count, bool) or not isinstance(job_count, int) or job_count <= 0:
        raise ValueError("job_count phải là số nguyên dương")

    scheduling_mb_per_lane = NFP_CACHE_MAX_MB + _BASE_OVERHEAD_MB
    total_worker_grant, reason = plan_worker_count(
        kind=f"{MIXED_NESTING_KIND}-batch",
        per_worker_mb=scheduling_mb_per_lane,
        cpu_count=cpu_count,
        env_override=WORKER_COUNT_ENV,
    )
    max_parallel_jobs = min(job_count, total_worker_grant)
    return BatchHardwarePlan(
        total_worker_grant=total_worker_grant,
        max_parallel_jobs=max_parallel_jobs,
        reason=(
            f"{reason}; jobs={job_count}, parallel={max_parallel_jobs}, "
            f"shared_worker_grant={total_worker_grant}, "
            f"scheduling_mb_per_lane={scheduling_mb_per_lane:.1f}"
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
