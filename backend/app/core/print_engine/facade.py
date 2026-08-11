"""PrintEngineFacade — cửa duy nhất để lớp Python gọi PrynX Print Engine (PPE).

PPE là engine prepress clean-room viết bằng Rust (`print_engine/`), nối vào Python
qua `pdfcompare_native.ppe_separations`. Facade này KHÔNG chứa logic prepread: nó
chỉ dịch contract và quyết định *có được phép tin kết quả hay không*.

# Vì sao cần một facade thay vì gọi native trực tiếp

Ba việc phải làm giống nhau ở mọi caller (`separations.py`, `softproof.py`,
`preflight_rules/ink.py`). Rải ra từng nơi thì chắc chắn có nơi làm thiếu, và
nơi làm thiếu sẽ là nơi báo "đạt ngưỡng mực" trên dữ liệu không đủ tin:

1. **Dịch plate sang contract sẵn có** — `alpha_data` = zlib + base64 của mảng
   `u8`, `255 = 100% mực`. Đây đúng contract `SeparationEngine._create_colored_plate`
   đang trả cho frontend, nên đổi engine không phải đổi API hay code frontend.
2. **Cấp `fallback_font`** — thiếu nó, trang chữ dùng font không nhúng báo
   **0% mực**, tức báo *thiếu* mực. Đó là chiều sai làm hỏng lô in: file quá
   ngưỡng bị coi là đạt.
3. **Map hai trục hỏng sang `accuracy`** — xem bên dưới.

# Hai trục hỏng, và vì sao không gộp

`RenderWarnings` của PPE tách theo *hệ quả với lượng mực* (xem
`print_engine/src/error.rs`):

* `ink_unsound` — có nội dung đáng lẽ phải lên mực mà chưa lên, hoặc lên sai
  lượng (object bị bỏ, transparency chưa dựng, màu phải xấp xỉ, `/OC` có thể
  đang ẩn nội dung). Đỉnh TAC đo được **không** dùng để chốt kẽm ⇒ facade coi
  như PPE thất bại để caller dừng an toàn hoặc chọn chế độ xấp xỉ công khai.
* `geometry_approximate` — nội dung *đã* lên mực nhưng hình khác bản gốc (font
  thay thế). Đỉnh mực vùng đặc vẫn đúng; chỉ **diện tích phủ** là ước lượng ⇒
  dùng được cho TAC, nhưng hạ nhãn `accuracy`.

Gộp hai trục thành một cờ nghe an toàn hơn nhưng lại phá chính mục tiêu: gần như
mọi file xưởng thật đều có một nhãn chữ font không nhúng, nên cờ gộp sẽ bật trên
gần hết file và PPE không bao giờ được dùng — trong khi đỉnh mực của nó đúng.

# Ranh giới

Facade là **READ/raster only**. Không ghi PDF ở đây; mọi đường ghi vẫn là pikepdf.
"""

from __future__ import annotations

import base64
import logging
import os
import tempfile
import threading
import zlib
from pathlib import Path
from typing import Any, Callable, TypeVar

logger = logging.getLogger(__name__)

# Nhãn `accuracy` trả về. Giữ nguyên chuỗi mà `separations.py` đang dùng để
# frontend không phải biết PPE tồn tại.
ACCURACY_RIP = "rip_separations"
ACCURACY_RIP_APPROX_GEOMETRY = "rip_separations_approx_geometry"

_OUTPUT_PREVIEW_FILTERS = {
    "all",
    "device-cmyk",
    "device-rgb",
    "device-gray",
    "spot",
    "text",
    "images",
    "line-art",
    "smooth-shades",
}


class PpeUnavailable(RuntimeError):
    """Native chưa build, hoặc build cũ chưa có PPE."""


class PpeRequestSuperseded(RuntimeError):
    """Request session đã bị generation mới hơn thay thế hoặc owner đóng."""


class PpeResultUntrusted(RuntimeError):
    """PPE chạy xong nhưng lượng mực không đủ tin để dùng.

    Không phải lỗi kỹ thuật — engine đã trung thực khai báo giới hạn của chính nó
    (thiếu shading, transparency chưa dựng, `/OC`…). Caller phải dừng an toàn
    hoặc chọn chế độ xấp xỉ công khai thay vì hạ ngưỡng.
    """

    def __init__(self, reason: str, detail: dict[str, Any] | None = None):
        super().__init__(reason)
        self.reason = reason
        self.detail = detail or {}


def _native_softproof_preview_kwargs(
    *,
    output_preview_filter: str = "all",
    simulate_paper_color: bool = False,
    simulate_black_ink: bool = False,
    page_background_rgb: tuple[int, int, int] | list[int] | None = None,
) -> dict[str, Any]:
    """Validate contract mới và chỉ gửi keyword khi caller thật sự dùng nó.

    Mặc định rỗng giữ compatibility với extension cũ trong vòng dev. Khi UI bật
    một lựa chọn mới, build cũ phải fail-loud thay vì trả trang không đổi.
    """
    normalized_filter = (output_preview_filter or "all").strip().lower()
    if normalized_filter not in _OUTPUT_PREVIEW_FILTERS:
        raise ValueError(
            f"output_preview_filter không hợp lệ: {normalized_filter}"
        )
    normalized_background: tuple[int, int, int] | None = None
    if page_background_rgb is not None:
        if (
            not isinstance(page_background_rgb, (tuple, list))
            or len(page_background_rgb) != 3
            or any(
                isinstance(channel, bool)
                or not isinstance(channel, int)
                or not 0 <= channel <= 255
                for channel in page_background_rgb
            )
        ):
            raise ValueError("page_background_rgb phải gồm ba số nguyên 0..255")
        normalized_background = tuple(page_background_rgb)

    if (
        normalized_filter == "all"
        and not simulate_paper_color
        and not simulate_black_ink
        and normalized_background is None
    ):
        return {}

    native_caps = capabilities()
    supported_filters = set(native_caps.get("output_preview_filters") or [])
    if normalized_filter not in supported_filters:
        raise PpeUnavailable(
            f"pdfcompare_native chưa hỗ trợ Show={normalized_filter}"
        )
    required = (
        (simulate_paper_color, "softproof_paper_color", "Paper Color"),
        (simulate_black_ink, "softproof_black_ink", "Black Ink"),
        (normalized_background is not None, "softproof_page_background", "Background Color"),
    )
    for enabled, capability, label in required:
        if enabled and not native_caps.get(capability):
            raise PpeUnavailable(f"pdfcompare_native chưa hỗ trợ {label}")

    return {
        "output_preview_filter": normalized_filter,
        "simulate_paper_color": bool(simulate_paper_color),
        "simulate_black_ink": bool(simulate_black_ink),
        "page_background_rgb": normalized_background,
    }


def _native_separations_preview_kwargs(
    *, output_preview_filter: str = "all"
) -> dict[str, Any]:
    """Chỉ mở contract Show cho separations khi native khai đúng capability.

    `all` cố ý không gửi keyword mới để mọi consumer mặc định vẫn chạy byte-for-
    byte trên extension cũ. Filter khác `all` không được fallback âm thầm sang
    một bản kẽm chưa lọc.
    """
    normalized_filter = (output_preview_filter or "all").strip().lower()
    if normalized_filter not in _OUTPUT_PREVIEW_FILTERS:
        raise ValueError(
            f"output_preview_filter không hợp lệ: {normalized_filter}"
        )
    if normalized_filter == "all":
        return {}

    native_caps = capabilities()
    supported_filters = set(native_caps.get("output_preview_filters") or [])
    if (
        not native_caps.get("separations_output_preview_filter")
        or normalized_filter not in supported_filters
    ):
        raise PpeUnavailable(
            "pdfcompare_native chưa hỗ trợ lọc kẽm theo "
            f"Show={normalized_filter}"
        )
    return {"output_preview_filter": normalized_filter}


def _native():
    try:
        import pdfcompare_native  # type: ignore
    except ImportError as e:  # pragma: no cover - phụ thuộc build
        raise PpeUnavailable(f"pdfcompare_native chưa cài: {e}") from e
    if not hasattr(pdfcompare_native, "ppe_separations"):
        raise PpeUnavailable(
            "pdfcompare_native thiếu ppe_separations — cần rebuild: "
            "maturin develop --release --manifest-path native/Cargo.toml"
        )
    return pdfcompare_native


def is_available() -> bool:
    """`True` khi native có PPE. Dùng để quyết định thứ tự engine, không throw."""
    try:
        _native()
        return True
    except PpeUnavailable:
        return False


def capabilities() -> dict[str, Any]:
    """Capability matrix lấy TỪ Rust, không hardcode ở Python.

    Nguồn duy nhất là code thật: khi một tính năng xong, cờ đổi cùng lúc với code
    nên không thể quên cập nhật ở lớp Python.
    """
    return dict(_native().ppe_capabilities())


def _fallback_font_path() -> str | None:
    """Font TrueType thay cho font PDF không nhúng.

    Rust không tự tìm font: layout assets do lớp đóng gói quyết định (dev chạy từ
    repo, bản phát hành nằm trong sidecar), nên chỉ Python biết font ở đâu.

    Trả `None` khi không có font — khi đó chữ không nhúng font sẽ không được vẽ và
    PPE bật `ink_unsound`, nên kết quả bị loại chứ không lặng lẽ báo thiếu mực.
    """
    here = Path(__file__).resolve()
    for base in (here.parents[2] / "assets" / "fonts", Path.cwd() / "app" / "assets" / "fonts"):
        cand = base / "DejaVuSans.ttf"
        if cand.is_file():
            return str(cand)
    return None


def _auto_memory_budget_mb(
    total_ram_mb: float | None,
    available_ram_mb: float | None,
    concurrency: int = 1,
) -> int:
    """Chọn ngân sách PPE theo tier RAM, không hard-cap máy mạnh.

    Ngân sách chỉ là chốt chống cấp phát quá mức, không được cấp phát trước.
    Máy >=16 GB lấy theo RAM *đang khả dụng* và không có ceiling nhân tạo.

    `concurrency` là số việc nặng được phép chạy cùng lúc. Ngân sách là trần cho
    **một** lần render, nên phải chia: PERF (audit 2026-07-27 §A.5) — trước đây mỗi
    lần render tự lấy 75% RAM còn trống, N việc song song cùng cam kết N lần lượng
    đó và trần mất tác dụng đúng lúc máy đang căng nhất. Sàn của từng tier vẫn được
    giữ để máy nhiều slot không tụt xuống mức không render nổi trang nào.
    """
    slots = max(1, int(concurrency))
    if total_ram_mb is None or total_ram_mb <= 0:
        return 512
    available = available_ram_mb if available_ram_mb and available_ram_mb > 0 else None
    if total_ram_mb < 8 * 1024:
        if available is None:
            return 384
        # PERF (audit 2026-08-10 §PPE.SCOPE.8): máy low-tier còn sạch cần đủ
        # ngân sách cho Export CMYK 300 DPI; khi RAM trống giảm, 25%/slot co
        # budget xuống trước khi hệ thống phải swap.
        return max(256, min(640, int(available * 0.25 / slots)))
    if total_ram_mb < 16 * 1024:
        if available is None:
            return 1024
        return max(512, min(1024, int(available * 0.50 / slots)))
    # PERF (audit 2026-07-27 §4.4): >=16 GB không bị trần 512 MiB. Dùng phần
    # RAM khả dụng để vẫn tự hạ khi hệ thống đang chịu áp lực bộ nhớ.
    basis = available if available is not None else total_ram_mb
    ratio = 0.75 if available is not None else 0.50
    return max(512, int(basis * ratio / slots))


def _memory_budget_mb() -> int:
    """Ngân sách mỗi lần render: env/config ghi đè, còn lại tự chọn theo RAM."""
    from app.config import settings
    from app.core.system_memory import read_memory_status_mb

    override = getattr(settings, "PRYNX_PPE_MEMORY_BUDGET_MB", None)
    if override is not None:
        value = int(override)
        if value <= 0:
            raise ValueError("PRYNX_PPE_MEMORY_BUDGET_MB must be greater than zero")
        return value
    from app.core.heavy_job_scheduler import max_active_heavy_jobs

    total_mb, available_mb = read_memory_status_mb()
    value = _auto_memory_budget_mb(total_mb, available_mb, max_active_heavy_jobs())
    if value <= 0:  # chốt phòng vệ cho mọi thay đổi chính sách về sau
        raise ValueError("PRYNX_PPE_MEMORY_BUDGET_MB must be greater than zero")
    return value


def _auto_session_cache_budget_mb(
    total_ram_mb: float | None,
    available_ram_mb: float | None,
) -> int:
    """Ngân sách cache sống lâu của một document session.

    Khác `_auto_memory_budget_mb`, đây là RAM được giữ qua nhiều request. Hai tier
    máy thấp có ceiling phòng swap; máy >=16 GB co giãn theo RAM đang trống và
    không có hard-cap cố định. Lô 2C sẽ chia tổng này giữa các lease/session sống.
    """
    if total_ram_mb is None or total_ram_mb <= 0:
        return 128
    available = available_ram_mb if available_ram_mb and available_ram_mb > 0 else None
    if total_ram_mb < 8 * 1024:
        basis = available if available is not None else total_ram_mb
        return max(32, min(96, int(basis * 0.08)))
    if total_ram_mb < 16 * 1024:
        basis = available if available is not None else total_ram_mb
        return max(96, min(256, int(basis * 0.12)))
    basis = available if available is not None else total_ram_mb
    return max(256, int(basis * 0.125))


def _session_cache_budget_mb() -> int:
    """Ngân sách resource cache cho một session theo RAM khả dụng."""
    from app.core.system_memory import read_memory_status_mb

    total_mb, available_mb = read_memory_status_mb()
    return _auto_session_cache_budget_mb(total_mb, available_mb)


_NativeResult = TypeVar("_NativeResult")
_STRUCTURAL_OPEN_MARKERS = (
    "invalid file trailer",
    "invalid xref",
    "xref",
    "trailer",
    "không mở được pdf",
)
_SESSION_INVALIDATION_MARKERS = (
    "rendersession đã bị vô hiệu hóa",
    "không mở lại được pdf",
    "thay đổi trong lúc làm mới rendersession",
)


def _call_native_with_pdf_recovery(
    pdf_path: str,
    call: Callable[[str], _NativeResult],
) -> tuple[_NativeResult, bool]:
    """Retry a structural-open failure through a temporary qpdf rewrite.

    `lopdf` intentionally rejects some malformed xref/trailer structures that
    qpdf hoặc các parser dung sai cao hơn có thể phục hồi. Nhánh thử lại được giới hạn:

    * only a native *open/structure* error is eligible;
    * the source must be an existing regular file;
    * the original is never overwritten;
    * the normalized file lives only for the duration of the native call.

    A render/page/memory error is not retried because rewriting cannot fix it and
    would hide the real failure behind a second parser.
    """
    try:
        return call(pdf_path), False
    except RuntimeError as original:
        message = str(original).lower()
        source = Path(pdf_path)
        if not source.is_file() or not any(marker in message for marker in _STRUCTURAL_OPEN_MARKERS):
            raise

        try:
            import pikepdf
        except ImportError as recovery_error:
            logger.warning("PPE PDF recovery unavailable: pikepdf is not installed")
            raise original from recovery_error

        with tempfile.TemporaryDirectory(prefix="prynx-ppe-recovery-") as tmp:
            normalized = Path(tmp) / "normalized.pdf"
            try:
                with pikepdf.open(
                    source,
                    attempt_recovery=True,
                    suppress_warnings=True,
                ) as pdf:
                    pdf.save(normalized)
            except (pikepdf.PdfError, OSError, ValueError) as recovery_error:
                logger.warning(
                    "PPE PDF structure recovery failed for %s: %s",
                    source,
                    recovery_error,
                )
                raise original from recovery_error

            logger.warning(
                "PPE normalized malformed PDF structure in a temporary file: %s",
                source,
            )
            # Lỗi của lần render thứ hai phải nổi nguyên trạng. Chỉ lỗi *rewrite*
            # mới được nối về lỗi parser ban đầu.
            return call(str(normalized)), True


class PpeSoftproofSession:
    """Owner Python của một `PpeRenderSession` native.

    API stateless vẫn được giữ làm compatibility lane cho build cũ và PDF phải
    qpdf-recovery. Wrapper tự loại response cũ cả trước lẫn sau lời gọi native;
    vì vậy cancel của coroutine không thể làm bitmap lỗi thời lọt lên cache.
    """

    def __init__(
        self,
        *,
        pdf_path: str,
        owner_id: str,
        cmyk_profile_id: str,
        render_intent: int,
        native_session: Any | None,
        open_info: dict[str, Any],
        fallback_reason: str | None = None,
    ) -> None:
        self.pdf_path = str(pdf_path)
        self._document_path_key = os.path.normcase(
            os.path.realpath(os.fspath(pdf_path))
        )
        self.owner_id = owner_id
        self.cmyk_profile_id = cmyk_profile_id
        self.render_intent = int(render_intent)
        self._native_session = native_session
        self._open_info = dict(open_info)
        self._fallback_reason = fallback_reason
        self._state_lock = threading.Lock()
        self._closed = False
        self._last_accepted_generation = 0
        self._latest_request_generation = 0

    @property
    def uses_native_session(self) -> bool:
        return self._native_session is not None

    @property
    def open_info(self) -> dict[str, Any]:
        return dict(self._open_info)

    def _check_owner_locked(self, owner_id: str) -> None:
        if owner_id != self.owner_id:
            raise ValueError("owner_id không sở hữu PPE RenderSession này")

    def _check_request_locked(
        self,
        pdf_path: str,
        cmyk_profile_id: str,
        render_intent: int,
    ) -> None:
        requested_path = os.path.normcase(os.path.realpath(os.fspath(pdf_path)))
        requested_profile = (cmyk_profile_id or "fogra39").strip().lower()
        if requested_path != self._document_path_key:
            raise ValueError("PPE RenderSession không thuộc tài liệu request này")
        if requested_profile != self.cmyk_profile_id:
            raise ValueError("PPE RenderSession không thuộc profile màu request này")
        if int(render_intent) != self.render_intent:
            raise ValueError("PPE RenderSession không thuộc rendering intent request này")

    def render(
        self,
        *,
        owner_id: str,
        request_generation: int,
        pdf_path: str,
        cmyk_profile_id: str,
        render_intent: int,
        page_num: int,
        dpi: int = 150,
        simulate_overprint: bool = True,
        output_preview_filter: str = "all",
        simulate_paper_color: bool = False,
        simulate_black_ink: bool = False,
        page_background_rgb: tuple[int, int, int] | list[int] | None = None,
        clip: tuple[int, int, int, int] | None = None,
    ) -> dict[str, Any]:
        generation = int(request_generation)
        if generation <= 0:
            raise ValueError("request_generation PPE phải lớn hơn 0")
        with self._state_lock:
            self._check_owner_locked(owner_id)
            self._check_request_locked(pdf_path, cmyk_profile_id, render_intent)
            if self._closed:
                raise PpeRequestSuperseded("PPE RenderSession đã đóng")
            if (
                self._last_accepted_generation > 0
                and generation <= self._last_accepted_generation
            ):
                raise PpeRequestSuperseded(
                    f"generation {generation} không mới hơn "
                    f"{self._last_accepted_generation}"
                )
            self._last_accepted_generation = generation
            self._latest_request_generation = max(
                self._latest_request_generation, generation
            )
            native_session = self._native_session

        if native_session is None:
            raw = softproof(
                pdf_path,
                page_num,
                dpi=dpi,
                cmyk_profile_id=cmyk_profile_id,
                render_intent=render_intent,
                simulate_overprint=simulate_overprint,
                output_preview_filter=output_preview_filter,
                simulate_paper_color=simulate_paper_color,
                simulate_black_ink=simulate_black_ink,
                page_background_rgb=page_background_rgb,
                clip=clip,
            )
            raw["session_mode"] = "stateless_fallback"
            if self._fallback_reason:
                raw["session_fallback_reason"] = self._fallback_reason
            raw.setdefault("document_identity", None)
            raw["request_generation"] = generation
            raw.setdefault("session_generation", None)
            raw.setdefault("resource_cache_hit", False)
            raw.setdefault("cache", {})
            raw.setdefault(
                "timings_ms",
                {
                    "open": None,
                    "parse": None,
                    "resource": None,
                    "raster": None,
                    "color": None,
                    "encode": 0.0,
                },
            )
            raw["session_open"] = dict(self._open_info)
        else:
            kwargs: dict[str, Any] = {
                "page": page_num,
                "dpi": float(dpi),
                "page_box": "crop",
                "fallback_font": _fallback_font_path(),
                "simulate_overprint": simulate_overprint,
                "memory_budget_mb": _memory_budget_mb(),
            }
            kwargs.update(
                _native_softproof_preview_kwargs(
                    output_preview_filter=output_preview_filter,
                    simulate_paper_color=simulate_paper_color,
                    simulate_black_ink=simulate_black_ink,
                    page_background_rgb=page_background_rgb,
                )
            )
            if clip is not None:
                if len(clip) != 4 or any(
                    isinstance(value, bool) or not isinstance(value, int)
                    for value in clip
                ):
                    raise ValueError("clip PPE phải gồm bốn số nguyên x/y/width/height")
                x, y, width, height = clip
                if x < 0 or y < 0 or width <= 0 or height <= 0:
                    raise ValueError(
                        "clip PPE phải có x/y không âm và width/height dương"
                    )
                kwargs.update(
                    clip_x=x,
                    clip_y=y,
                    clip_width=width,
                    clip_height=height,
                )
            try:
                raw = dict(
                    native_session.render_softproof(
                        owner_id,
                        generation,
                        **kwargs,
                    )
                )
            except RuntimeError as exc:
                with self._state_lock:
                    superseded = (
                        self._closed
                        or generation != self._latest_request_generation
                        or self._native_session is not native_session
                    )
                if superseded:
                    raise PpeRequestSuperseded(
                        f"bỏ render generation {generation} vì session đã đổi/đóng"
                    ) from exc
                if "PPE_STALE_REQUEST" in str(exc):
                    raise PpeRequestSuperseded(str(exc)) from exc
                lowered = str(exc).lower()
                if any(marker in lowered for marker in _SESSION_INVALIDATION_MARKERS):
                    # File có thể đang ở giữa một lần save-over. Session core đã
                    # fail-closed; request sau đi stateless/recovery thay vì làm tab
                    # hỏng vĩnh viễn đến khi người dùng mở lại tài liệu.
                    with self._state_lock:
                        if (
                            not self._closed
                            and generation == self._latest_request_generation
                            and self._native_session is native_session
                        ):
                            self._native_session = None
                            self._fallback_reason = (
                                "session bị vô hiệu hóa khi file thay đổi; "
                                "chuyển tạm sang stateless"
                            )
                raise
            raw["pdf_recovered"] = False
            raw["session_mode"] = "native"
            raw["session_open"] = dict(self._open_info)

        with self._state_lock:
            if self._closed or generation != self._latest_request_generation:
                raise PpeRequestSuperseded(
                    f"bỏ response generation {generation} vì owner đã chuyển request"
                )
        return raw

    def ensure_current(self, owner_id: str, request_generation: int) -> None:
        """Hậu kiểm rẻ sau encode/trước cache response."""
        generation = int(request_generation)
        with self._state_lock:
            self._check_owner_locked(owner_id)
            if self._closed or generation != self._latest_request_generation:
                raise PpeRequestSuperseded(
                    f"response generation {generation} đã bị thay thế trước khi trả"
                )

    def info(self, owner_id: str) -> dict[str, Any]:
        with self._state_lock:
            self._check_owner_locked(owner_id)
            if self._closed:
                return {**self._open_info, "valid": False}
            native_session = self._native_session
        if native_session is None:
            return {
                **self._open_info,
                "valid": True,
                "session_mode": "stateless_fallback",
            }
        return dict(native_session.info(owner_id))

    def cancel(self, owner_id: str, request_generation: int) -> bool:
        generation = int(request_generation)
        with self._state_lock:
            self._check_owner_locked(owner_id)
            if self._closed:
                return False
            cancelled_through = generation + 1
            changed = cancelled_through > self._latest_request_generation
            self._latest_request_generation = max(
                self._latest_request_generation, cancelled_through
            )
            native_session = self._native_session
        if native_session is not None:
            native_session.cancel(owner_id, generation)
        return changed

    def close(self, owner_id: str) -> bool:
        with self._state_lock:
            self._check_owner_locked(owner_id)
            if self._closed:
                return False
            self._closed = True
            self._latest_request_generation += 1
            native_session = self._native_session
        if native_session is not None:
            native_session.close(owner_id)
        return True

    def __enter__(self) -> "PpeSoftproofSession":
        return self

    def __exit__(self, _exc_type, _exc, _traceback) -> None:
        self.close(self.owner_id)


def open_softproof_session(
    pdf_path: str,
    *,
    owner_id: str,
    cmyk_profile_id: str = "fogra39",
    render_intent: int = 1,
    resource_cache_budget_mb: int | None = None,
) -> PpeSoftproofSession:
    """Mở document/profile một lần; build cũ tự đi compatibility lane stateless."""
    owner = str(owner_id).strip()
    if not owner:
        raise ValueError("owner_id PPE không được rỗng")
    profile_id = (cmyk_profile_id or "fogra39").strip().lower()
    from app.core.icc_profiles import resolve_cmyk_profile_path, resolve_srgb_profile_path

    cmyk_profile = resolve_cmyk_profile_path(profile_id)
    if not cmyk_profile:
        raise RuntimeError(f"không tìm được profile CMYK '{profile_id}'")
    native = _native()
    cache_budget = (
        _session_cache_budget_mb()
        if resource_cache_budget_mb is None
        else int(resource_cache_budget_mb)
    )
    if cache_budget < 0:
        raise ValueError("resource_cache_budget_mb must be non-negative")

    if not hasattr(native, "PpeRenderSession"):
        return PpeSoftproofSession(
            pdf_path=pdf_path,
            owner_id=owner,
            cmyk_profile_id=profile_id,
            render_intent=render_intent,
            native_session=None,
            open_info={
                "engine": "ppe",
                "valid": True,
                "session_available": False,
                "open_timings_ms": {},
            },
            fallback_reason="native build chưa có PpeRenderSession",
        )

    try:
        native_session = native.PpeRenderSession(
            pdf_path,
            owner,
            cmyk_profile,
            rgb_profile=resolve_srgb_profile_path(),
            render_intent=int(render_intent),
            resource_cache_budget_mb=cache_budget,
        )
    except RuntimeError as exc:
        message = str(exc).lower()
        source = Path(pdf_path)
        if source.is_file() and any(
            marker in message for marker in _STRUCTURAL_OPEN_MARKERS
        ):
            # Session không được giữ đường dẫn temp đã bị xóa. PDF lỗi cấu trúc
            # tiếp tục đi wrapper stateless, nơi qpdf temp sống đúng trọn một call.
            return PpeSoftproofSession(
                pdf_path=pdf_path,
                owner_id=owner,
                cmyk_profile_id=profile_id,
                render_intent=render_intent,
                native_session=None,
                open_info={
                    "engine": "ppe",
                    "valid": True,
                    "session_available": False,
                    "open_timings_ms": {},
                },
                fallback_reason="PDF cần qpdf recovery theo từng render",
            )
        raise

    open_info = dict(native_session.info(owner))
    open_info["session_available"] = True
    return PpeSoftproofSession(
        pdf_path=pdf_path,
        owner_id=owner,
        cmyk_profile_id=profile_id,
        render_intent=render_intent,
        native_session=native_session,
        open_info=open_info,
    )


# Màu hiển thị của kẽm process. Đọc từ `SeparationEngine` lúc chạy (xem
# `_plate_color`) chứ không copy hằng số sang đây: hai bảng màu song song sẽ lệch
# nhau khi một bên đổi, và preview đổi màu theo engine là bug người dùng thấy ngay.
def _plate_color(
    name: str,
    is_spot: bool,
    spot_rgb: list[int] | None = None,
) -> list[int]:
    """Màu hiển thị của kẽm. Dùng chung bảng với `SeparationEngine` để preview
    không đổi màu khi đổi engine.

    `PLATE_COLORS` là thuộc tính *instance*, nên phải dựng engine để đọc — không
    có bản class-level nào để tham chiếu.
    """
    from app.core.separations import _lookup_spot_rgb

    if is_spot and spot_rgb is not None:
        return spot_rgb
    if not is_spot:
        table = _process_plate_colors()
        if name in table:
            return table[name]
    return _lookup_spot_rgb(name)


_PROCESS_COLORS_CACHE: dict[str, list[int]] | None = None


def _process_plate_colors() -> dict[str, list[int]]:
    """Bảng màu 4 kẽm process, đọc một lần rồi giữ lại.

    Dựng `SeparationEngine()` mỗi plate sẽ gọi `mkdir` thư mục kết quả 4–5 lần cho
    mỗi trang — công vô ích trên đường chạy nóng.
    """
    global _PROCESS_COLORS_CACHE
    if _PROCESS_COLORS_CACHE is None:
        from app.core.separations import SeparationEngine

        _PROCESS_COLORS_CACHE = dict(SeparationEngine().PLATE_COLORS)
    return _PROCESS_COLORS_CACHE


def separations(
    pdf_path: str,
    page_num: int,
    dpi: int = 100,
    *,
    ink_accurate: bool = False,
    cmyk_profile_id: str | None = "fogra39",
    render_intent: int = 1,
    allow_geometry_approximation: bool = True,
    output_preview_filter: str = "all",
) -> dict[str, Any]:
    """Tách kẽm một trang bằng PPE, trả contract giống `SeparationEngine`.

    `ink_accurate=True` → chế độ đo mực cho TAC: **tắt khử răng cưa** để cạnh nhị
    phân và vùng đặc đọc đúng 100% mực mỗi kênh.

    # Vì sao chế độ đo mực VẪN nạp profile ICC

    Bất biến prepress ở đây hẹp hơn "TAC thì đừng dùng ICC", và trộn hai điều đó
    là nguồn của cả một lớp sai:

    * `DeviceCMYK` / `DeviceGray` / `Separation` / `DeviceN` — dữ liệu **đã là
      mực**. Không bao giờ đi qua ICC. Round-trip nén vùng đặc 400% xuống ~292%
      và biến một file vượt giới hạn mực thành "đạt". Việc này do chính engine
      bảo đảm, không phụ thuộc caller (`print_engine/tests/render_icc.rs` có test
      khoá: bật và tắt ICC cho kết quả **giống từng byte** trên DeviceCMYK).
    * `DeviceRGB` / `Lab` / `ICCBased` — **chưa** phải mực. Không có profile thì
      lượng mực chỉ là một công thức UCR tuỳ tiện, nên engine trung thực bật
      `ink_unsound` và trang bị loại.

    Trước đây facade bỏ ICC cho *toàn bộ* chế độ đo mực. Hệ quả đo được: 4/18
    fixture (mọi trang có ảnh RGB) bị loại khỏi kết quả tin cậy, dù §16.3 đã
    chứng minh PPE khớp renderer tham chiếu dưới 1 điểm TAC trên chính nội dung RGB khi cùng
    profile. Nạp profile ở đây **mở rộng** vùng PPE đo được mà không nới bất biến
    nào — phần đã là mực vẫn không bị chạm tới.

    `allow_geometry_approximation=False` → loại cả trang có font thay thế. Dùng
    khi cần con số diện tích phủ chính xác (ví dụ báo giá mực), không cần cho TAC.

    Raises:
        PpeUnavailable: native chưa có PPE.
        PpeResultUntrusted: lượng mực không đủ tin (caller phải dừng hoặc hạ nhãn).
    """
    native = _native()
    # CORRECTNESS (audit 2026-08-10 §PPE.REAUDIT.4): bitmap và plate phải
    # render cùng một filter nguồn. Default rỗng giữ nguyên ABI native cũ.
    preview_kwargs = _native_separations_preview_kwargs(
        output_preview_filter=output_preview_filter
    )

    cmyk_profile = None
    rgb_profile = None
    if cmyk_profile_id:
        # Nạp cho CẢ hai chế độ. Xem docstring: profile chỉ áp cho nội dung chưa
        # phải mực; `ink_accurate` điều khiển khử răng cưa, không điều khiển ICC.
        from app.core.icc_profiles import resolve_cmyk_profile_path, resolve_srgb_profile_path

        cmyk_profile = resolve_cmyk_profile_path(cmyk_profile_id)
        rgb_profile = resolve_srgb_profile_path()

    def _render(candidate_path: str):
        return native.ppe_separations(
            candidate_path,
            page=page_num,
            dpi=float(dpi),
            ink_accurate=ink_accurate,
            page_box="crop",
            cmyk_profile=cmyk_profile,
            rgb_profile=rgb_profile,
            render_intent=int(render_intent),
            fallback_font=_fallback_font_path(),
            memory_budget_mb=_memory_budget_mb(),
            **preview_kwargs,
        )

    raw_native, pdf_recovered = _call_native_with_pdf_recovery(pdf_path, _render)
    raw = dict(raw_native)
    raw["pdf_recovered"] = pdf_recovered

    # ── Cổng tin cậy ────────────────────────────────────────────────────────
    # Đặt TRƯỚC khi dựng plate: dựng xong rồi mới loại là tốn công vô ích, và
    # nguy hiểm hơn — dễ có nhánh trả plate ra ngoài mà bỏ qua cổng này.
    if raw.get("ink_unsound"):
        raise PpeResultUntrusted(
            _explain_unsound(raw),
            {
                "dropped_objects": raw.get("dropped_objects"),
                "unsupported_transparency": raw.get("unsupported_transparency"),
                "hidden_content_risk": raw.get("hidden_content_risk"),
                "approximated_colorspaces": raw.get("approximated_colorspaces"),
                "skipped_ops": raw.get("skipped_ops"),
            },
        )

    geometry_approx = bool(raw.get("geometry_approximate"))
    if geometry_approx and not allow_geometry_approximation:
        raise PpeResultUntrusted(
            "font không nhúng đã phải thay thế nên diện tích phủ chỉ là xấp xỉ",
            {"substituted_fonts": raw.get("substituted_fonts")},
        )

    # PREFLIGHT (audit 2026-08-10 §OP.2/4/5): đường xem Output Preview cần
    # inventory tài liệu, metadata trang và alternate color thật. Việc đo TAC
    # (`ink_accurate=True`) chạy lần lượt nhiều trang và không tiêu thụ các field
    # này, nên không quét toàn tài liệu lặp O(n²) ở đường đó.
    inventory: dict[str, Any] | None = None
    inventory_error: str | None = None
    page_inventory: dict[str, Any] = {}
    colorants_by_name: dict[str, dict[str, Any]] = {}
    spot_display: dict[str, dict[str, Any]] = {}
    if not ink_accurate:
        try:
            from app.core.ink_manager import analyze_ink_inventory, colorant_rgb_map

            inventory = analyze_ink_inventory(pdf_path)
            page_inventory = next(
                (
                    item for item in inventory.get("pages", [])
                    if int(item.get("page", 0)) == page_num
                ),
                {},
            )
            colorants_by_name = {
                item["name"]: item
                for item in inventory.get("document_colorants", [])
                if item.get("name")
            }
            spot_display = colorant_rgb_map(
                list(colorants_by_name.values()),
                cmyk_profile_id or "fogra39",
                rendering_intent=render_intent,
            )
        except Exception as exc:  # noqa: BLE001
            # Không làm mất bản kẽm nếu một PDF lạ khiến lớp metadata thất bại.
            # Contract nói rõ inventory không xác định; UI không được tự điền
            # false/DeviceCMYK rồi tạo cảm giác đã phân tích thành công.
            inventory_error = str(exc)
            logger.warning("Không đọc được inventory mực của Output Preview: %s", exc)

    plates: list[dict[str, Any]] = []
    for p in raw.get("plates", []):
        ink: bytes = p["ink"]
        is_spot = bool(p.get("is_spot"))
        alternate = colorants_by_name.get(p["name"], {})
        display = spot_display.get(p["name"], {}) if is_spot else {}
        # zlib level 1: khớp đúng lựa chọn của `_create_colored_plate` — nén nhanh
        # quan trọng hơn nén nhỏ vì payload này đi thẳng ra frontend mỗi lần xem.
        plates.append({
            "name": p["name"],
            "color": _plate_color(p["name"], is_spot, display.get("rgb")),
            "alpha_data": base64.b64encode(zlib.compress(ink, level=1)).decode("utf-8"),
            "is_spot": is_spot,
            # COLOR (audit 2026-08-10 §OP.1): giữ toàn bộ tint transform đã được
            # PPE lấy mẫu, không rút còn màu ở tint 100%. Composite subset cần
            # đúng cả vùng spot 10–90%, đặc biệt với FunctionType 2 N != 1.
            "alternate_cmyk_lut": p.get("alternate_cmyk_lut"),
            "coverage_pct": round(float(p.get("coverage_pct") or 0.0), 4),
            "alternate_space": alternate.get("alternate_space"),
            "alternate_cmyk": alternate.get("alternate_cmyk"),
            "color_source": (
                display.get("source")
                if is_spot and display
                else "name_fallback" if is_spot else "process_preview"
            ),
        })

    page_plate_by_name = {plate["name"]: plate for plate in plates}
    document_spots = [
        item for item in (inventory or {}).get("document_colorants", [])
        if item.get("is_spot")
    ]
    spot_names = (
        [item["name"] for item in document_spots]
        if document_spots
        else [p["name"] for p in plates if p["is_spot"]]
    )
    spot_inks: list[dict[str, Any]] = []
    for colorant in document_spots:
        name = colorant["name"]
        plate = page_plate_by_name.get(name)
        display = spot_display.get(name, {})
        spot_inks.append({
            "name": name,
            "rgb": display.get("rgb") or _plate_color(name, True),
            "coverage_pct": plate.get("coverage_pct", 0.0) if plate else 0.0,
            "is_pantone": "pantone" in name.lower(),
            "present_on_page": plate is not None,
            "pages": list(colorant.get("pages") or []),
            "alternate_space": colorant.get("alternate_space"),
            "alternate_cmyk": colorant.get("alternate_cmyk"),
            "color_source": display.get("source") or "name_fallback",
        })
    result: dict[str, Any] = {
        "width": raw["width"],
        "height": raw["height"],
        "plates": plates,
        "max_tac_pct": raw.get("max_tac_pct"),
        "has_spot_colors": bool(spot_names),
        "detected_spots": spot_names,
        "spot_inks": spot_inks,
        "document_colorants": list((inventory or {}).get("document_colorants", [])),
        "page_colorants": list(page_inventory.get("colorants") or []),
        "page_spot_colorants": list(page_inventory.get("spot_colorants") or []),
        "page_has_transparency": page_inventory.get("page_has_transparency"),
        "blending_color_space": page_inventory.get("blending_color_space"),
        "inventory_source": (inventory or {}).get("metadata_source"),
        "inventory_error": inventory_error,
        "engine": "ppe",
        "accuracy": ACCURACY_RIP_APPROX_GEOMETRY if geometry_approx else ACCURACY_RIP,
        "quality_note": _quality_note(
            raw,
            geometry_approx,
            ink_accurate,
            pdf_recovered,
        ),
        # Vết chẩn đoán: giữ để UI giải thích được vì sao accuracy bị hạ.
        "ppe_pdf_recovered": pdf_recovered,
        "ppe_substituted_fonts": list(raw.get("substituted_fonts") or []),
        "ppe_colorspaces_used": list(raw.get("colorspaces_used") or []),
        "ppe_skipped_ops": list(raw.get("skipped_ops") or []),
    }
    return result


def compose_separation_subset(
    *,
    width: int,
    height: int,
    plates: list[dict[str, Any]],
    enabled_names: list[str],
    cmyk_profile_id: str = "fogra39",
    render_intent: int = 1,
) -> dict[str, Any]:
    """Ghép tập kẽm đang bật qua ICC mà không raster lại PDF.

    Input dùng thẳng contract `separations()`: mỗi mặt phẳng là zlib + base64 với
    255 = 100% mực. Facade giải nén có giới hạn đúng số pixel rồi giao byte cho
    native; không dựng ảnh RGB màu cố định và không dùng CSS multiply.
    """
    native = _native()
    if not hasattr(native, "ppe_compose_separation_subset"):
        raise PpeUnavailable(
            "pdfcompare_native thiếu ppe_compose_separation_subset — cần rebuild: "
            "maturin develop --release --manifest-path native/Cargo.toml"
        )
    if isinstance(width, bool) or isinstance(height, bool):
        raise ValueError("width/height bản kẽm không hợp lệ")
    width = int(width)
    height = int(height)
    if width <= 0 or height <= 0:
        raise ValueError("width/height bản kẽm phải lớn hơn 0")
    pixel_count = width * height
    if not plates or len(plates) > 64:
        raise ValueError("plates phải có từ 1 đến 64 bản kẽm")
    memory_budget_mb = _memory_budget_mb()
    estimated_bytes = pixel_count * (len(plates) + 16 + 3)
    if estimated_bytes > memory_budget_mb * 1024 * 1024:
        raise ValueError(
            "ghép bản kẽm vượt ngân sách RAM theo cấu hình phần cứng hiện tại"
        )

    decoded: list[dict[str, Any]] = []
    for plate in plates:
        name = str(plate.get("name") or "")
        encoded = plate.get("alpha_data")
        if not name or not isinstance(encoded, str):
            raise ValueError("plate thiếu name/alpha_data hợp lệ")
        try:
            compressed = base64.b64decode(encoded, validate=True)
            inflater = zlib.decompressobj()
            ink = inflater.decompress(compressed, pixel_count + 1)
        except (ValueError, zlib.error) as exc:
            raise ValueError(f"alpha_data của bản kẽm '{name}' không hợp lệ") from exc
        if (
            len(ink) != pixel_count
            or not inflater.eof
            or inflater.unconsumed_tail
            or inflater.unused_data
        ):
            raise ValueError(
                f"alpha_data của bản kẽm '{name}' không khớp {width}×{height} pixel"
            )
        decoded.append({
            "name": name,
            "ink": ink,
            "is_spot": bool(plate.get("is_spot")),
            "alternate_cmyk_lut": plate.get("alternate_cmyk_lut"),
        })

    from app.core.icc_profiles import resolve_cmyk_profile_path, resolve_srgb_profile_path

    result = native.ppe_compose_separation_subset(
        width,
        height,
        decoded,
        list(dict.fromkeys(str(name) for name in enabled_names)),
        resolve_cmyk_profile_path(cmyk_profile_id),
        rgb_profile=resolve_srgb_profile_path(),
        render_intent=int(render_intent),
        memory_budget_mb=memory_budget_mb,
    )
    return dict(result)


def softproof(
    pdf_path: str,
    page_num: int,
    dpi: int = 150,
    *,
    cmyk_profile_id: str = "fogra39",
    render_intent: int = 1,
    simulate_overprint: bool = True,
    output_preview_filter: str = "all",
    simulate_paper_color: bool = False,
    simulate_black_ink: bool = False,
    page_background_rgb: tuple[int, int, int] | list[int] | None = None,
    clip: tuple[int, int, int, int] | None = None,
) -> dict[str, Any]:
    """Soft-proof một trang: render trong không gian mực rồi quy sang sRGB qua ICC.

    Trả `{"width", "height", "rgb", "degraded", "ink_unsound"}` với `rgb` là bytes
    dài `width * height * 3`. `clip=(x, y, width, height)` dùng hệ pixel của
    ảnh full-page sau `/Rotate`, gốc trên-trái; khi có clip, kích thước trả về
    đúng bằng `width × height` của vùng đó.

    # Vì sao đường này khác hẳn `separations`

    Soft-proof là câu hỏi **"in ra sẽ trông thế nào"**, không phải **"tốn bao nhiêu
    mực"**. Hai câu hỏi cần hai cấu hình đối nghịch:

    * khử răng cưa **bật** (xem) thay vì tắt (đo);
    * mực pha **quy về CMYK** (màn hình không có mực pha) thay vì giữ kẽm riêng.

    Vì vậy kết quả của hàm này tuyệt đối không được dùng để kết luận lượng mực, và
    đó là lý do nó là một hàm riêng chứ không phải một cờ của `separations`.

    Khác `separations`, ở đây **không** có cổng tin cậy chặn kết quả: một ảnh xem
    trước thiếu một object vẫn hữu ích, còn một con số TAC thiếu một object thì
    không. Cờ `ink_unsound` vẫn được trả về để lớp UI nói ra.

    Raises:
        PpeUnavailable: native chưa có PPE, hoặc build cũ chưa có `ppe_softproof`.
        RuntimeError: không tìm được profile CMYK (không có profile ⇒ không có
            soft-proof; đoán một công thức rồi gọi đó là soft-proof là hứa hão).
    """
    native = _native()
    if not hasattr(native, "ppe_softproof"):
        raise PpeUnavailable(
            "pdfcompare_native thiếu ppe_softproof — cần rebuild: "
            "maturin develop --release --manifest-path native/Cargo.toml"
        )

    from app.core.icc_profiles import resolve_cmyk_profile_path, resolve_srgb_profile_path

    cmyk_profile = resolve_cmyk_profile_path(cmyk_profile_id)
    if not cmyk_profile:
        raise RuntimeError(f"không tìm được profile CMYK '{cmyk_profile_id}'")

    normalized_clip: tuple[int, int, int, int] | None = None
    if clip is not None:
        native_caps = (
            dict(native.ppe_capabilities())
            if hasattr(native, "ppe_capabilities")
            else {}
        )
        if not native_caps.get("softproof_viewport_clip"):
            raise PpeUnavailable(
                "pdfcompare_native chưa hỗ trợ clip soft-proof — cần rebuild native"
            )
        if len(clip) != 4 or any(
            isinstance(value, bool) or not isinstance(value, int) for value in clip
        ):
            raise ValueError("clip PPE phải gồm bốn số nguyên x/y/width/height")
        x, y, width, height = clip
        if x < 0 or y < 0 or width <= 0 or height <= 0:
            raise ValueError("clip PPE phải có x/y không âm và width/height dương")
        normalized_clip = (x, y, width, height)
    preview_kwargs = _native_softproof_preview_kwargs(
        output_preview_filter=output_preview_filter,
        simulate_paper_color=simulate_paper_color,
        simulate_black_ink=simulate_black_ink,
        page_background_rgb=page_background_rgb,
    )

    def _render(candidate_path: str):
        kwargs: dict[str, Any] = {
            "page": page_num,
            "dpi": float(dpi),
            "cmyk_profile": cmyk_profile,
            "rgb_profile": resolve_srgb_profile_path(),
            "render_intent": int(render_intent),
            "page_box": "crop",
            "fallback_font": _fallback_font_path(),
            "simulate_overprint": simulate_overprint,
            "memory_budget_mb": _memory_budget_mb(),
        }
        kwargs.update(preview_kwargs)
        # PERF (audit 2026-08-08 §RENDER.3/5): không gửi bốn keyword None để
        # caller full-page vẫn tương thích với extension native cũ trong vòng dev.
        if normalized_clip is not None:
            x, y, width, height = normalized_clip
            kwargs.update(
                clip_x=x,
                clip_y=y,
                clip_width=width,
                clip_height=height,
            )
        return native.ppe_softproof(candidate_path, **kwargs)

    raw, pdf_recovered = _call_native_with_pdf_recovery(pdf_path, _render)
    result = dict(raw)
    result["pdf_recovered"] = pdf_recovered
    return result


def _explain_unsound(raw: dict[str, Any]) -> str:
    """Lý do người đọc hiểu được, thay vì một cờ boolean."""
    parts: list[str] = []
    if raw.get("dropped_objects"):
        parts.append(f"{raw['dropped_objects']} object chưa vẽ được")
    if raw.get("unsupported_transparency"):
        parts.append("transparency chưa đúng blending color space hoặc soft mask chưa hỗ trợ đủ")
    if raw.get("hidden_content_risk"):
        parts.append("có optional content (/OC) chưa xét trạng thái bật/tắt")
    approx = raw.get("approximated_colorspaces") or []
    if approx:
        parts.append("màu phải xấp xỉ: " + ", ".join(approx))
    return "PPE: lượng mực chưa đủ tin (" + "; ".join(parts) + ")" if parts else "PPE: lượng mực chưa đủ tin"


def _quality_note(
    raw: dict[str, Any],
    geometry_approx: bool,
    ink_accurate: bool,
    pdf_recovered: bool = False,
) -> str:
    mode = "đo lượng mực DeviceCMYK" if ink_accurate else "xem trước color-managed"
    note = f"PrynX Print Engine — kẽm process/spot trong không gian mực ({mode})."
    if pdf_recovered:
        note += (
            " Cấu trúc xref/trailer lỗi đã được qpdf phục hồi trong tệp tạm; "
            "file gốc không bị sửa."
        )
    if geometry_approx:
        fonts = ", ".join(raw.get("substituted_fonts") or []) or "không rõ"
        note += (
            f" Font không nhúng đã thay ({fonts}): đỉnh mực vẫn đúng, "
            "nhưng phần trăm diện tích phủ là xấp xỉ."
        )
    return note


# ── Export CMYK production (audit 2026-07-30 §IMG-04 lô 4) ────────────────────

def export_cmyk(
    pdf_path: str,
    page_num: int,
    dpi: int = 300,
    *,
    cmyk_profile_id: str = "fogra39",
    render_intent: int = 1,
    simulate_overprint: bool = True,
    page_box: str = "crop",
) -> dict[str, Any]:
    """Render một trang ra CMYK composite 4 kênh 8 bit (production export).

    Trả ``{"width", "height", "cmyk", "degraded", "ink_unsound"}`` với ``cmyk``
    là bytes dài ``width * height * 4`` (interleaved C-M-Y-K).

    Khác ``softproof`` ở chỗ KHÔNG quy sang RGB: giữ nguyên CMYK cho downstream
    (TIFF CMYK, RIP). Caller nhúng ICC profile (FOGRA39/SWOP) khi ghi file.

    Raises:
        PpeUnavailable: native chưa có ppe_export_cmyk.
        RuntimeError: thiếu CMYK profile.
    """
    native = _native()
    if not hasattr(native, "ppe_export_cmyk"):
        raise PpeUnavailable(
            "pdfcompare_native thiếu ppe_export_cmyk — cần rebuild: "
            "maturin develop --release --manifest-path native/Cargo.toml"
        )

    from app.core.icc_profiles import resolve_cmyk_profile_path

    cmyk_profile = resolve_cmyk_profile_path(cmyk_profile_id)
    if not cmyk_profile:
        raise RuntimeError(f"không tìm được profile CMYK '{cmyk_profile_id}'")

    def _render(candidate_path: str):
        return native.ppe_export_cmyk(
            candidate_path,
            page=page_num,
            dpi=float(dpi),
            cmyk_profile=cmyk_profile,
            render_intent=int(render_intent),
            page_box=page_box,
            fallback_font=_fallback_font_path(),
            simulate_overprint=simulate_overprint,
            memory_budget_mb=_memory_budget_mb(),
        )

    raw, pdf_recovered = _call_native_with_pdf_recovery(pdf_path, _render)
    result = dict(raw)
    result["pdf_recovered"] = pdf_recovered
    return result
