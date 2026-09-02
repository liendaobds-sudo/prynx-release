"""Render MỘT tờ bình bằng chính writer sản xuất của N-Up.

PREVIEW (audit 2026-08-28 §SHEET.PLAN.1). Vùng xem chính của Bình cắt xén hiển thị
tờ bình thật thay vì một bản mô phỏng. Cách duy nhất để preview không bao giờ lệch
file xuất là **không có renderer thứ hai**: preview gọi đúng ``process_chunk`` mà
đường xuất đang gọi, chỉ khác dải tờ là ``[N, N+1)`` thay vì cả tài liệu.

## Bất biến

1. **Solve một lần.** ``nup_sheet_plan`` gọi pha solve đúng một lần rồi giữ kế hoạch;
   mọi tờ render từ kế hoạch đó. Solve lại cho từng tờ là mở đường cho hai tờ thuộc
   hai lời giải khác nhau.
2. **Không nhân bản hợp đồng args.** Tuple 58 phần tử của ``process_chunk`` chỉ được
   dựng ở một chỗ: closure ``build_chunk_args`` trong ``_run_nup_engine_impl``.
3. **``total_sheets`` là số tờ THẬT của cả job**, không phải 1. Nó tham gia đặt tên
   OCG duy nhất; hạ xuống 1 là đổi nội dung trang.
4. **Không chiếm suất heavy job.** Đường này chạy nội tuyến trong tiến trình gọi.
   Caller phải tự giới hạn đồng thời; tuyệt đối không spawn process cho mỗi lần
   người dùng đổi thông số.
5. **Mặc định chỉ là nội dung raw của một tờ.** Các bước ở tầng tài liệu — gộp
   chunk, watermark, report, ``_sanitize_portable_pdf`` — vẫn thuộc
   ``finalize_nup_output``. Preview không mang chúng; riêng export S&R fallback
   lưới được opt-in đóng snapshot report canonical lên Front sau khi writer xong.
"""

from __future__ import annotations

import contextlib
import logging
import os
import shutil
import tempfile
from dataclasses import dataclass
from typing import Any, Callable, Dict, Iterator, Mapping


logger = logging.getLogger(__name__)


class NupSheetRenderError(ValueError):
    """Kế hoạch hoặc chỉ số tờ không dùng được để render."""


@dataclass(frozen=True, slots=True)
class NupSheetReportSnapshot:
    """Report đã dựng trong pha solve, đủ để hoàn thiện một tờ độc lập.

    Map dùng tuple thay vì ``dict`` để render plan thật sự bất biến. Style được
    chuẩn hoá một lần từ cùng ``reportDisplay`` mà đường export toàn tài liệu dùng;
    renderer không tự dựng lại nội dung report.
    """

    enabled: bool = False
    reports_by_sheet: tuple[tuple[int, str], ...] = ()
    position: str = "top"
    offset_x_mm: float = 5.0
    offset_y_mm: float = 5.0
    font_size: float = 8.0
    centered: bool = True

    @classmethod
    def from_engine_state(
        cls,
        reports_by_sheet: Mapping[int, str],
        display: Mapping[str, Any] | None,
    ) -> "NupSheetReportSnapshot":
        """Chụp metadata canonical; report tắt không đọc các field style ẩn."""

        config = display if isinstance(display, Mapping) else {}
        enabled = bool(config.get("enabled"))
        if not enabled:
            return cls()
        reports = tuple(
            sorted(
                (int(sheet_index), str(text))
                for sheet_index, text in reports_by_sheet.items()
                if text
            )
        )
        return cls(
            enabled=True,
            reports_by_sheet=reports,
            position=str(config.get("position", "top") or "top"),
            offset_x_mm=float(config.get("offsetX", 5.0)),
            offset_y_mm=float(config.get("offsetY", 5.0)),
            font_size=float(config.get("fontSize", 8.0)),
            centered=bool(config.get("centered", True)),
        )

    def text_for_sheet(self, sheet_index: int) -> str | None:
        """Nội dung của đúng chỉ số tờ toàn cục, không remap sang trang CUT."""

        for candidate, text in self.reports_by_sheet:
            if candidate == sheet_index:
                return text
        return None


@dataclass(frozen=True, slots=True)
class NupSheetRenderPlan:
    """Một lượt solve đã chốt của job N-Up. Mọi tờ phải render TỪ ĐÂY.

    ``build_chunk_args`` là closure của pha solve, nên **không** đi qua biên tiến
    trình được. Đường preview cố tình chạy nội tuyến; muốn đẩy sang process khác thì
    phải persist kế hoạch trước, không được pickle closure.
    """

    build_chunk_args: Callable[[int, int, int], tuple]
    total_sheets: int
    chunk_size: int
    layout_type: str
    page_count: int
    capacity: int
    #: Tờ → trang nguồn. Chỉ Bình trang (``repeat``) mới có ánh xạ 1:1 này.
    sheet_mapping: tuple[int, ...]
    #: Snapshot report chỉ được dùng khi caller export opt-in; preview mặc định raw.
    report_snapshot: NupSheetReportSnapshot = NupSheetReportSnapshot()

    def source_page_for_sheet(self, sheet_index: int) -> int | None:
        """Trang nguồn của một tờ, hoặc ``None`` khi tờ gom nhiều mẫu.

        Ba cách dàn (``sequential``/``cut_stacks``/``ratio_stack``) và
        ``mixed_guillotine`` xếp nhiều trang lên cùng một tờ, nên câu hỏi "tờ này
        thuộc trang nào" không có câu trả lời đơn trị — trả ``None`` thay vì đoán.
        """
        if 0 <= sheet_index < len(self.sheet_mapping):
            return int(self.sheet_mapping[sheet_index])
        return None


def _validate_sheet_index(plan: NupSheetRenderPlan, sheet_index: int) -> int:
    if not isinstance(plan, NupSheetRenderPlan):
        raise NupSheetRenderError("plan phải là NupSheetRenderPlan.")
    try:
        index = int(sheet_index)
    except (TypeError, ValueError) as exc:
        raise NupSheetRenderError("sheet_index phải là số nguyên.") from exc
    if not 0 <= index < int(plan.total_sheets):
        raise NupSheetRenderError(
            f"Tờ {index} nằm ngoài khoảng 0..{int(plan.total_sheets) - 1}."
        )
    return index


@contextlib.contextmanager
def nup_sheet_plan(
    source_path: str,
    settings: Dict[str, Any],
    *,
    job_id: str | None = None,
) -> Iterator[NupSheetRenderPlan]:
    """Solve một lần và giữ kế hoạch render trong suốt block.

    File đã chuẩn hoá hệ trang sống đến hết block: ``build_chunk_args`` giữ đường dẫn
    đó trong closure, nên xoá sớm là làm kế hoạch trỏ vào file không còn tồn tại.
    Chuẩn hoá đi qua đúng ``canonical_page_space`` mà export dùng — thiếu bước này thì
    trang ``/Rotate=90`` cho preview và export hai hệ quy chiếu khác nhau.
    """
    from app.schemas.pont import normalize_pont_settings
    from app.workers import nup_engine

    normalized, _ = nup_engine._normalize_page_sheet_settings(settings)
    normalized = normalize_pont_settings(normalized)

    with nup_engine.canonical_page_space(source_path, job_id) as canonical_path:
        # ``output_path`` chỉ dùng để kiểm dung lượng ổ trong pha solve; pha này
        # không ghi gì vào đó.
        probe_output = os.path.join(
            tempfile.gettempdir(), f"nup_sheet_plan_{os.getpid()}.pdf"
        )
        plan = nup_engine._run_nup_engine_impl(
            canonical_path,
            probe_output,
            normalized,
            job_id=job_id,
            _sheet_plan_only=True,
        )
        if not isinstance(plan, NupSheetRenderPlan):
            raise NupSheetRenderError(
                "Pha solve không trả về NupSheetRenderPlan; hợp đồng đã bị đổi."
            )
        yield plan


def _remove_file_quietly(path: str) -> None:
    """Dọn file chưa publish; lỗi cleanup không được che lỗi kết xuất gốc."""

    try:
        os.remove(path)
    except FileNotFoundError:
        return
    except OSError:
        logger.warning("Không xoá được artifact tạm %s", path, exc_info=True)


def _stamp_report_on_front(
    plan: NupSheetRenderPlan,
    sheet_index: int,
    target: str,
) -> None:
    """Hoàn thiện report trên Front cục bộ; CUT (nếu có) luôn để sạch."""

    snapshot = plan.report_snapshot
    if not snapshot.enabled:
        return
    text = snapshot.text_for_sheet(sheet_index)
    if not text:
        return

    from app.workers import nup_report

    try:
        ok = nup_report.stamp_reports_on_pdf(
            target,
            target,
            {0: text},
            position=snapshot.position,
            offset_x_mm=snapshot.offset_x_mm,
            offset_y_mm=snapshot.offset_y_mm,
            font_size=snapshot.font_size,
            centered=snapshot.centered,
        )
    except Exception as exc:
        raise NupSheetRenderError(
            "Không ghi được report lên tờ lưới; artifact chưa được publish."
        ) from exc
    if not ok:
        raise NupSheetRenderError(
            "Không ghi được report lên tờ lưới; artifact chưa được publish."
        )


def render_nup_sheet(
    plan: NupSheetRenderPlan,
    sheet_index: int,
    output_path: str,
    *,
    include_report: bool = False,
) -> str:
    """Ghi đúng một tờ ra ``output_path``. Không solve, không gộp tài liệu.

    Mặc định trả nội dung raw để preview/parity không đổi. ``include_report`` chỉ
    dành cho artifact export đã chọn tờ đại diện; report được đóng lên trang Front
    cục bộ số 0, không bao giờ lên trang CUT cục bộ số 1.
    """
    from app.workers.nup_process_chunk import process_chunk

    index = _validate_sheet_index(plan, sheet_index)
    args = plan.build_chunk_args(index, index + 1, index)
    chunk_path = process_chunk(args)
    if not chunk_path or not os.path.exists(chunk_path):
        raise NupSheetRenderError(f"Writer không tạo được tờ {index}.")

    target = os.path.abspath(output_path)
    parent = os.path.dirname(target)
    staged_path: str | None = None
    try:
        if parent:
            os.makedirs(parent, exist_ok=True)

        # FIX (audit 2026-08-31 §S&R-REPORT-PUBLISH): luôn hoàn thiện trên file
        # cùng thư mục đích rồi mới replace nguyên tử. Copy khác ổ hoặc stamp lỗi
        # chỉ để lại file ẩn chưa publish, không bao giờ biến target thành PDF dở.
        fd, staged_path = tempfile.mkstemp(
            prefix=".nup_sheet_",
            suffix=".pdf",
            dir=parent or None,
        )
        os.close(fd)
        try:
            os.replace(chunk_path, staged_path)
        except OSError:
            shutil.copyfile(chunk_path, staged_path)

        if include_report:
            _stamp_report_on_front(plan, index, staged_path)
        os.replace(staged_path, target)
        staged_path = None
        return target
    except Exception:
        # Report là nội dung bắt buộc của export này: không giữ artifact cũ ở
        # chính output_path khiến caller tưởng job lỗi vẫn sinh tờ hợp lệ.
        if include_report:
            _remove_file_quietly(target)
        raise
    finally:
        if staged_path:
            _remove_file_quietly(staged_path)
        if os.path.exists(chunk_path):
            _remove_file_quietly(chunk_path)


__all__ = [
    "NupSheetRenderError",
    "NupSheetReportSnapshot",
    "NupSheetRenderPlan",
    "nup_sheet_plan",
    "render_nup_sheet",
]
