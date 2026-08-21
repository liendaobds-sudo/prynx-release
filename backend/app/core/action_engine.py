"""
Action Engine — Tự động sửa lỗi PDF (giống Action Lists của Enfocus PitStop).

Sử dụng:
  - pikepdf + LittleCMS: chuyển màu, sửa object và cấu trúc PDF
  - PrynX Print Engine: flatten transparency và outline chữ có hậu kiểm

Actions:
  CONVERT_TO_CMYK       — Chuyển toàn bộ hệ màu sang CMYK + gắn ICC Profile
  FLATTEN_TRANSPARENCY  — Flatten tất cả transparency groups
  FIX_METADATA          — Xóa metadata nhạy cảm, cập nhật Producer
  EMBED_FONTS           — Nhúng toàn bộ font chưa embedded
  DOWNSCALE_IMAGES      — Giảm ảnh > 600 DPI xuống 300 DPI
"""
import asyncio
import logging
import os
import re
import shutil
import threading
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

import pikepdf

from app.config import settings
from app.core.engine_support import (
    InternalEngineUnsupported,
    unsupported_message,
)

logger = logging.getLogger(__name__)

_CANCEL_EVENT_PARAM = "_prynx_cancel_event"


def _remove_file_quietly(path: str) -> None:
    """Dọn file riêng của tác vụ; lỗi dọn không được che lỗi nghiệp vụ gốc."""
    try:
        if os.path.isfile(path):
            os.remove(path)
    except OSError:
        pass


def _validate_staged_pdf(
    input_path: str,
    staged_path: str,
    cancel_event: threading.Event,
) -> None:
    """Chỉ cho publish PDF đọc được, đủ trang và chưa bị yêu cầu hủy."""
    if cancel_event.is_set():
        raise InterruptedError("Tác vụ PDF đã bị hủy trước bước hậu kiểm.")
    if not os.path.isfile(staged_path) or os.path.getsize(staged_path) == 0:
        raise ValueError("Handler không tạo được file PDF kết quả hợp lệ.")
    with pikepdf.open(input_path) as source_pdf, pikepdf.open(staged_path) as staged_pdf:
        if len(staged_pdf.pages) != len(source_pdf.pages):
            raise ValueError(
                "Số trang của file kết quả không khớp file nguồn "
                f"({len(staged_pdf.pages)} != {len(source_pdf.pages)})."
            )
    if cancel_event.is_set():
        raise InterruptedError("Tác vụ PDF đã bị hủy sau bước hậu kiểm.")


@dataclass
class ActionLogEntry:
    """Log entry for a single action step."""
    action_id: str
    status: str           # "success" | "failed" | "skipped"
    message: str
    duration_ms: int = 0
    # Engine đã THỰC SỰ chạy: "ppe" | "pikepdf" | "channel_remover".
    # Cần để API báo đúng đường xử lý đã được dùng cho file kết quả.
    engine: str | None = None
    # Dữ liệu báo cáo bổ sung (vd report gỡ kênh: max/avg ΔE, OOG, warnings).
    # Để None với các action không sinh report. Task 11.2 sẽ surface lên FixResponse.
    report: dict | None = None


@dataclass
class ActionResult:
    """Result of executing one or more actions."""
    success: bool
    output_path: str | None = None
    log: list[ActionLogEntry] = field(default_factory=list)
    error: str | None = None


# ── Available Actions Registry ──
AVAILABLE_ACTIONS = {
    "CONVERT_TO_CMYK": {
        "title": "Chuyển đổi sang CMYK",
        "description": "Chuyển toàn bộ Object RGB sang hệ màu CMYK với ICC Profile chuẩn in offset.",
        "engine": "pikepdf",
    },
    "FLATTEN_TRANSPARENCY": {
        "title": "Flatten Transparency",
        "description": "Xóa bỏ mọi hiệu ứng trong suốt (bóng đổ, blend mode) để máy CTP không bị lỗi.",
        "engine": "ppe",
    },
    "OUTLINE_FONTS": {
        "title": "Khóa Font (Outline Text)",
        "description": "Chuyển toàn bộ chữ thành vector, hậu kiểm từng trang và dừng nếu không thể bảo toàn bản in.",
        "engine": "pikepdf",
    },
    # `engine` ở registry là đường dự kiến; engine thật của mỗi lần chạy nằm
    # trong `ActionLogEntry.engine`.
    "EMBED_FONTS": {
        "title": "Nhúng Font (Embed)",
        "description": "Kiểm tra font đã nhúng; dừng an toàn nếu file còn font thiếu.",
        "engine": "pikepdf",
    },
    "DOWNSCALE_IMAGES": {
        "title": "Giảm độ phân giải ảnh",
        "description": "Downscale ảnh > 600 DPI xuống 300 DPI để giảm dung lượng file.",
        "engine": "pikepdf",
    },
    "FIX_METADATA": {
        "title": "Sửa Metadata",
        "description": "Xóa metadata nhạy cảm (Author, Creator, Subject) và cập nhật Producer.",
        "engine": "pikepdf",
    },
    "FIX_HAIRLINES": {
        "title": "Sửa nét mảnh (Hairlines)",
        "description": "Tăng độ dày các nét < 0.25pt để không bị mất khi in offset.",
        "engine": "pikepdf",
    },
    # Đường pikepdf chèn ExtGState vào đúng object đen để bật overprint thật sự;
    # chỉ ghi `/OPM` mà thiếu `/OP`/`/op` vẫn khiến object đen knockout.
    "SET_BLACK_OVERPRINT": {
        "title": "Overprint Text Đen",
        "description": "Đặt overprint cho text và nét đen (K>95%), tránh lỗi knockout khi in offset.",
        "engine": "pikepdf",
    },
    "REMOVE_CHANNELS": {
        "title": "Gỡ kênh màu (Channel Remover)",
        "description": (
            "Gỡ một hoặc nhiều kênh process (C/M/Y/K) để in bằng ít mực hơn. "
            "Chế độ 'reseparate' bù màu qua FOGRA39 để giữ màu gần nhất; "
            "cảnh báo và báo cáo ΔE cho vùng ngoài gamut."
        ),
        "engine": "channel_remover",
        "parameters": {
            "kept_channels": {
                "type": "array",
                "description": "Danh sách kênh GIỮ lại (1..3 phần tử), tập con của C/M/Y/K.",
                "default": ["C", "M", "Y"],
            },
            "mode": {
                "type": "string",
                "enum": ["direct", "reseparate"],
                "description": "'direct' xóa thẳng kênh; 'reseparate' bù màu qua FOGRA39.",
                "default": "reseparate",
            },
            "tac_limit": {
                "type": "number",
                "description": "Tổng phủ mực tối đa (%) cho màu kết quả.",
                "default": 360.0,
            },
            "gamut_threshold": {
                "type": "number",
                "description": "Ngưỡng ΔE phân loại màu Out-Of-Gamut.",
                "default": 5.0,
            },
            "spot_handling": {
                "type": "string",
                "enum": ["skip", "convert"],
                "description": "'skip' giữ nguyên màu pha; 'convert' chuyển sang CMYK trước khi gỡ.",
                "default": "skip",
            },
            "process_hidden_layers": {
                "type": "boolean",
                "description": "Có áp gỡ kênh cho nội dung layer ẩn (OCG) hay không.",
                "default": False,
            },
            "grid_step": {
                "type": "number",
                "description": "Bước lưới (%) khi liệt kê tổ hợp CMYK kênh-giữ cho LUT.",
                "default": 5.0,
            },
        },
    },
}


class ActionEngine:
    """
    Executes auto-fix actions on PDF files.
    
    Usage:
        engine = ActionEngine()
        result = await engine.execute("input.pdf", "CONVERT_TO_CMYK")
        result = await engine.execute_batch("input.pdf", [
            {"id": "CONVERT_TO_CMYK"},
            {"id": "FLATTEN_TRANSPARENCY"},
        ])
    """

    def __init__(self):
        self.icc_dir = settings.ICC_PROFILE_DIR
        self.default_profile = settings.DEFAULT_CMYK_PROFILE
        self.output_dir = Path(settings.RESULTS_DIR) / "preflight_output"
        self.output_dir.mkdir(parents=True, exist_ok=True)
        # Buffer chứa report bổ sung của handler gần nhất (vd REMOVE_CHANNELS).
        self._last_report: dict | None = None
        # Engine THỰC TẾ đã chạy của handler gần nhất. Khác `AVAILABLE_ACTIONS
        # [id]["engine"]` — đó chỉ là engine dự kiến.
        self._last_engine: str | None = None

    async def execute(
        self, pdf_path: str, action_id: str, params: dict | None = None, original_name: str | None = None
    ) -> ActionResult:
        """Execute a single action on a PDF."""
        if action_id not in AVAILABLE_ACTIONS:
            return ActionResult(
                success=False,
                error=f"Action '{action_id}' không tồn tại.",
            )

        stem = Path(original_name).stem if original_name else Path(pdf_path).stem
        output_name = f"{stem}_{action_id}_{uuid.uuid4().hex[:6]}.pdf"
        output_path = str(self.output_dir / output_name)
        staged_path = str(
            self.output_dir
            / f".{Path(output_name).stem}.{uuid.uuid4().hex}.pending.pdf"
        )
        cancel_event = threading.Event()
        params = dict(params or {})
        # PERF/CORRECTNESS (audit 2026-08-10 §PPE.REAUDIT.3): cầu nối từ
        # cancellation của coroutine xuống worker sync. Tên reserved luôn ghi
        # đè input ngoài để caller không thể tráo token của tác vụ.
        params[_CANCEL_EVENT_PARAM] = cancel_event

        start = datetime.now()
        try:
            handler = getattr(self, f"_action_{action_id.lower()}", None)
            logger.debug(f"action_id={action_id}, handler={handler}, handler_name=_action_{action_id.lower()}")
            if handler is None:
                return ActionResult(success=False, error=f"Handler cho '{action_id}' chưa được triển khai.")

            # Reset report buffer; handlers sinh report (vd REMOVE_CHANNELS) sẽ
            # gán self._last_report để execute đính vào ActionLogEntry.report.
            self._last_report = None
            self._last_engine = None

            async def run_handler_and_publish() -> bool:
                logger.debug("Calling handler for %s...", action_id)
                handler_success = await handler(pdf_path, staged_path, params)
                if not handler_success:
                    return False
                await asyncio.to_thread(
                    _validate_staged_pdf,
                    pdf_path,
                    staged_path,
                    cancel_event,
                )
                if cancel_event.is_set():
                    raise InterruptedError("Tác vụ PDF đã bị hủy trước khi publish.")
                # Staging nằm cùng thư mục nên os.replace là atomic trên cùng
                # volume: API không bao giờ nhìn thấy PDF mới ghi được một phần.
                os.replace(staged_path, output_path)
                return True

            worker_task = asyncio.create_task(run_handler_and_publish())
            try:
                # shield giữ worker sống đủ lâu để nó nhận token và tự đóng tài
                # nguyên; hủy Future của to_thread không dừng được thread thật.
                success = await asyncio.shield(worker_task)
            except asyncio.CancelledError:
                cancel_event.set()
                try:
                    await asyncio.shield(worker_task)
                except BaseException:  # worker có thể kết thúc bằng InterruptedError
                    pass
                _remove_file_quietly(staged_path)
                _remove_file_quietly(output_path)
                raise
            logger.debug(f"Handler returned: {success}")

            duration = int((datetime.now() - start).total_seconds() * 1000)

            base_msg = (
                f"{AVAILABLE_ACTIONS[action_id]['title']} "
                f"{'thành công' if success else 'thất bại'}."
            )
            report = self._last_report
            if report:
                if report.get("max_delta_e") is not None:
                    base_msg += (
                        f" ΔE max={report.get('max_delta_e', 0):.2f}, "
                        f"avg={report.get('avg_delta_e', 0):.2f}, "
                        f"OOG={report.get('out_of_gamut_count', 0)}."
                    )
                for warn in report.get("warnings", []):
                    base_msg += f" ⚠ {warn}"

            log_entry = ActionLogEntry(
                action_id=action_id,
                status="success" if success else "failed",
                message=base_msg,
                duration_ms=duration,
                report=report,
                # Handler nào không tự khai thì lấy engine dự kiến trong registry.
                engine=self._last_engine or AVAILABLE_ACTIONS[action_id].get("engine"),
            )

            return ActionResult(
                success=success,
                output_path=output_path if success else None,
                log=[log_entry],
            )

        except InternalEngineUnsupported as exc:
            # GS-SUNSET (audit 2026-08-08 §GS.2): đây là REFUSED có chủ đích,
            # không phải lỗi hệ thống. Xoá mọi output dở để API không bao giờ
            # giao nhầm file của lần thử native vừa thất bại.
            _remove_file_quietly(output_path)
            duration = int((datetime.now() - start).total_seconds() * 1000)
            message = str(exc)
            logger.info("Action %s dừng an toàn: %s", action_id, message)
            return ActionResult(
                success=False,
                error=message,
                log=[ActionLogEntry(
                    action_id=action_id, status="refused",
                    message=message, duration_ms=duration, engine="none",
                )],
            )

        except Exception as e:
            _remove_file_quietly(output_path)
            import traceback
            tb = traceback.format_exc()
            duration = int((datetime.now() - start).total_seconds() * 1000)
            logger.error(f"Action {action_id} failed: {tb}")
            return ActionResult(
                success=False,
                error=repr(e),
                log=[ActionLogEntry(
                    action_id=action_id, status="failed",
                    message=repr(e), duration_ms=duration,
                )],
            )
        finally:
            _remove_file_quietly(staged_path)

    async def execute_batch(
        self, pdf_path: str, actions: list[dict], original_name: str | None = None
    ) -> ActionResult:
        """
        Execute a chain of actions sequentially (pipeline).
        Each action's output becomes the next action's input.
        """
        all_logs: list[ActionLogEntry] = []
        current_input = pdf_path
        final_output = None

        try:
            for action_spec in actions:
                action_id = action_spec.get("id", "")
                params = action_spec.get("params", {})

                result = await self.execute(
                    current_input,
                    action_id,
                    params,
                    original_name=original_name if current_input == pdf_path else None,
                )
                all_logs.extend(result.log)

                if not result.success:
                    # Pipeline không trả file từng chặng; giữ nó lại khi bước
                    # sau fail/cancel chỉ tạo orphan trong results.
                    if final_output and final_output != pdf_path:
                        _remove_file_quietly(final_output)
                    return ActionResult(
                        success=False,
                        output_path=None,
                        log=all_logs,
                        error=f"Pipeline dừng tại '{action_id}': {result.error}",
                    )

                # Clean up intermediate files (keep only final output)
                if final_output and final_output != pdf_path:
                    _remove_file_quietly(final_output)

                final_output = result.output_path
                current_input = result.output_path
        except asyncio.CancelledError:
            if final_output and final_output != pdf_path:
                _remove_file_quietly(final_output)
            raise

        return ActionResult(
            success=True,
            output_path=final_output,
            log=all_logs,
        )

    def _refuse_unsupported(
        self,
        action_id: str,
        details: str = "",
        *,
        public_details: list[str] | None = None,
    ) -> None:
        """Dừng tác vụ khi engine nội bộ không bảo toàn chắc chắn được file."""
        # GS-SUNSET (audit 2026-08-08 §GS.2): từ chối ngay tại điểm quyết định,
        # không dựng lệnh hoặc làm tiền xử lý cho đường engine đã bị loại bỏ.
        self._last_engine = "none"
        if details:
            logger.info("%s: engine nội bộ từ chối (%s)", action_id, details)
        message = unsupported_message(AVAILABLE_ACTIONS[action_id]["title"])
        if public_details:
            # COLOR (audit 2026-08-20 §COLOR.04): chỉ surface blocker nghiệp vụ
            # do core trả về; giới hạn ba mục để log kỹ thuật/path không lọt vào
            # phản hồi và thông báo vẫn đủ ngắn để UI hiển thị.
            blockers = [
                re.sub(
                    r"(?i)(?:[a-z]:[\\/]|\\\\)[^;\r\n]*",
                    "[đường dẫn đã ẩn]",
                    item.strip().replace("\r", " ").replace("\n", " "),
                )[:240]
                for item in public_details
                if isinstance(item, str) and item.strip()
            ][:3]
            if blockers:
                message += " Giới hạn phát hiện: " + "; ".join(blockers) + "."
        raise InternalEngineUnsupported(message)

    # ────────────────────────────────────────────────────────
    #  ACTION HANDLERS
    # ────────────────────────────────────────────────────────

    async def _action_convert_to_cmyk(
        self, input_path: str, output_path: str, params: dict
    ) -> bool:
        """Chuyển object RGB sang CMYK bằng pikepdf + LittleCMS.

        Đường object-level giữ nguyên Separation/DeviceN, vì vậy kênh bế và màu
        pha không bị đổi thành process. Nếu gặp cấu trúc chưa hỗ trợ, tác vụ dừng
        an toàn thay vì dựng lại cả tài liệu bằng một engine khác.
        """
        profile_name = params.get("icc_profile", self.default_profile)
        icc_path = os.path.join(self.icc_dir, profile_name)
        cancel_event = params.get(_CANCEL_EVENT_PARAM)

        if not os.path.exists(icc_path):
            raise FileNotFoundError(f"ICC Profile không tìm thấy: {icc_path}")

        try:
            from app.core import icc_profiles, pdf_actions_native

            srgb = icc_profiles.resolve_srgb_profile_path()
            native = None
            if srgb:
                native = await asyncio.to_thread(
                    pdf_actions_native.convert_to_cmyk,
                    input_path,
                    output_path,
                    icc_path,
                    srgb,
                    cancel_check=cancel_event.is_set if cancel_event else None,
                    rendering_intent=params.get("rendering_intent", "relative"),
                    preserve_black=params.get("preserve_black", True),
                    black_point_compensation=params.get("black_point_compensation", True),
                    brightness_lstar=params.get("brightness_lstar", 0),
                    contrast_percent=params.get("contrast_percent", 0),
                    vibrance_percent=params.get("vibrance_percent", 0),
                    adjustment_stage=params.get("adjustment_stage", "pre_icc"),
                )
        except Exception as exc:  # noqa: BLE001
            if cancel_event is not None and cancel_event.is_set():
                raise InterruptedError("Tác vụ chuyển CMYK đã bị hủy.") from exc
            logger.warning("CONVERT_TO_CMYK: engine nội bộ lỗi: %s", exc)
            native = None

        if native is not None and native.get("supported"):
            self._last_engine = "pikepdf"
            report_warnings = list(native.get("warnings", []))
            report_warnings.append(
                "Chuyển ở mức object: màu Spot/Separation được GIỮ NGUYÊN "
                "(kênh bế, Pantone không bị đổi thành process)."
            )
            self._last_report = {
                "color_ops_converted": native.get("ops", 0),
                "images_converted": native.get("images", 0),
                "images_flattened": native.get("flattened_images", 0),
                "color_adjustments": native.get("adjustments", {}),
                "warnings": report_warnings,
            }
            return True

        native_blockers = (native or {}).get("blockers", [])
        if not isinstance(native_blockers, list):
            native_blockers = []
        blockers = [
            item.strip()
            for item in native_blockers
            if isinstance(item, str) and item.strip()
        ][:3]
        self._refuse_unsupported(
            "CONVERT_TO_CMYK",
            "; ".join(blockers),
            public_details=blockers,
        )

    async def _action_flatten_transparency(
        self, input_path: str, output_path: str, params: dict
    ) -> bool:
        """Flatten transparency bằng PPE, có cảnh báo về layer và màu pha."""
        warnings: list[str] = []
        cancel_event = params.get(_CANCEL_EVENT_PARAM)
        try:
            has_ocg, has_spot = await asyncio.to_thread(
                self._detect_ocg_and_spot, input_path
            )
            if cancel_event is not None and cancel_event.is_set():
                raise InterruptedError("Tác vụ flatten đã bị hủy.")
            if has_ocg:
                warnings.append(
                    "File có Layer (OCG). Flatten sẽ raster hóa trang có trong suốt, "
                    "GỘP/MẤT layer — không thể tách lại. Cân nhắc giữ bản gốc."
                )
            if has_spot:
                warnings.append(
                    "File có màu Spot/Separation (Pantone/dieline). Nếu Spot nằm trên "
                    "trang có transparency, tác vụ sẽ từ chối vì chưa có oracle tint "
                    "an toàn; giữ bản gốc hoặc chuyển Spot riêng trước khi flatten."
                )
        except Exception as e:
            logger.debug("detect OCG/spot trước flatten thất bại: %s", e)

        # File không có trong suốt thì PPE chỉ sao chép cấu trúc. File có trong
        # suốt được raster hoá và báo rõ phần layer/màu pha có thể bị hợp nhất.
        try:
            from app.core import pdf_actions_native

            native = await asyncio.to_thread(
                pdf_actions_native.flatten_transparency,
                input_path,
                output_path,
                float(params.get("dpi", 300)),
                cancel_check=cancel_event.is_set if cancel_event else None,
            )
        except Exception as exc:  # noqa: BLE001
            if cancel_event is not None and cancel_event.is_set():
                raise InterruptedError("Tác vụ flatten đã bị hủy.") from exc
            logger.warning("FLATTEN_TRANSPARENCY: PPE lỗi: %s", exc)
            native = None

        if native is not None and native.get("supported"):
            self._last_engine = "ppe"
            self._last_report = {
                "pages_rasterized": native.get("flattened", 0),
                "warnings": warnings + list(native.get("warnings", [])),
                # COLOR (audit 2026-08-20 §COLOR.26): giữ provenance để log/API
                # không chỉ nói "đã flatten" mà còn cho biết OI/CMM nào đã tạo
                # số CMYK và liệu tài liệu mixed có phần chưa quản lý profile.
                "output_intent_profile": native.get("output_intent_profile"),
                "rendering_intent": native.get("rendering_intent"),
                "black_point_compensation": native.get("black_point_compensation"),
                "profile_mixed_unmanaged": bool(native.get("profile_mixed_unmanaged")),
            }
            return True

        native_blockers = (native or {}).get("blockers", [])
        if not isinstance(native_blockers, list):
            native_blockers = []
        public_details = [
            item.strip()
            for item in native_blockers
            if isinstance(item, str) and item.strip()
        ][:3]
        native_warnings = (native or {}).get("warnings", [])
        if not isinstance(native_warnings, list):
            native_warnings = []
        details = "; ".join(public_details or native_warnings)
        # COLOR (audit 2026-08-20 §COLOR.22): lỗi hậu kiểm transparency là
        # giới hạn nghiệp vụ, không phải stacktrace. Surface mã đã lọc để UI
        # biết vì sao không có artifact thay vì chỉ nhận thông báo chung chung.
        self._refuse_unsupported(
            "FLATTEN_TRANSPARENCY",
            details,
            public_details=public_details,
        )

    @staticmethod
    def _detect_ocg_and_spot(pdf_path: str) -> tuple[bool, bool]:
        """Dò nhanh (cấu trúc, không render) file có OCG (layer) và/hoặc màu Spot.

        - OCG: ``/Root/OCProperties`` tồn tại.
        - Spot: bất kỳ ColorSpace ``/Separation`` hoặc ``/DeviceN`` nào trong
          resource của trang (đệ quy Form XObject qua resource_walker).
        """
        has_ocg = False
        has_spot = False
        try:
            with pikepdf.open(pdf_path) as pdf:
                try:
                    root = pdf.Root
                    if root.get("/OCProperties") is not None:
                        has_ocg = True
                except Exception:
                    pass

                from app.core.preflight_rules.resource_walker import iter_resource_dicts

                for page in pdf.pages:
                    if has_spot:
                        break
                    try:
                        for res in iter_resource_dicts(page, pdf):
                            cs_dict = res.get("/ColorSpace")
                            if cs_dict is None:
                                continue
                            if hasattr(cs_dict, "resolve"):
                                cs_dict = cs_dict.resolve()
                            if not isinstance(cs_dict, pikepdf.Dictionary):
                                continue
                            for _n, cs in cs_dict.items():
                                s = str(cs)
                                if "Separation" in s or "DeviceN" in s:
                                    has_spot = True
                                    break
                            if has_spot:
                                break
                    except Exception:
                        continue
        except Exception:
            pass
        return has_ocg, has_spot

    async def _action_embed_fonts(
        self, input_path: str, output_path: str, params: dict
    ) -> bool:
        """Xác nhận font đã đủ và giữ nguyên file ở mức object.

        Phần lớn file thực tế đã nhúng hết font (hoặc chỉ dùng base-14, thứ theo
        §9.6.2.2 không cần nhúng). Với những file đó, chỉ cần kiểm tra bằng
        pikepdf rồi sao chép nguyên vẹn.

        Khi có font **thiếu thật**, đường native cố tình KHÔNG tự nhúng thay:
        muốn nhúng một font không nằm trong file thì phải mượn font hệ thống
        rồi dựng lại ``/Widths``/``/Encoding``; sai một bảng width là chữ chạy
        — tràn khung, lệch ngắt dòng — và lỗi đó chỉ lộ ra lúc in. Vì vậy file
        thiếu font phải dừng an toàn để người dùng cung cấp bản đã nhúng font.
        """
        _ = params
        try:
            from app.core import pdf_actions_native

            info = await asyncio.to_thread(
                pdf_actions_native.analyze_font_embedding, input_path
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("EMBED_FONTS: không phân tích được font: %s", exc)
            info = None

        # `readable=False` nghĩa là KHÔNG ĐỌC ĐƯỢC file, không phải
        # "không thiếu font" — coi hai thứ đó như nhau là bỏ qua bước nhúng trên
        # đúng file đang hỏng.
        if info is not None and info.get("readable", True) and not info.get("missing"):
            shutil.copyfile(input_path, output_path)
            self._last_engine = "pikepdf"
            warnings = list(info.get("warnings", []))
            n_emb = len(info.get("embedded", []))
            n_b14 = len(info.get("base14", []))
            self._last_report = {
                "fonts_embedded": n_emb,
                "fonts_base14": n_b14,
                "warnings": warnings,
            }
            logger.info(
                "EMBED_FONTS: %d font đã nhúng, %d base-14 — giữ nguyên file.",
                n_emb, n_b14,
            )
            return True

        missing = ", ".join((info or {}).get("missing", [])[:5])
        self._refuse_unsupported("EMBED_FONTS", missing)

    async def _action_outline_fonts(
        self, input_path: str, output_path: str, params: dict
    ) -> bool:
        """Chuyển chữ thành path bằng fontTools và hậu kiểm hình in.

        Engine chỉ nhận font có dữ liệu glyph nhúng và cấu trúc chữ đã hỗ trợ.
        Annotation/AcroForm được PPE bake vào content stream bên trong pipeline;
        mọi ca không chứng minh được tính tương đương đều dừng an toàn.
        """
        cancel_event = params.get(_CANCEL_EVENT_PARAM)
        try:
            from app.core import outline_text

            native = await asyncio.to_thread(
                outline_text.outline_fonts,
                input_path,
                output_path,
                cancel_check=cancel_event.is_set if cancel_event else None,
            )
        except Exception as exc:  # noqa: BLE001
            if cancel_event is not None and cancel_event.is_set():
                raise InterruptedError("Tác vụ outline chữ đã bị hủy.") from exc
            logger.warning("OUTLINE_FONTS: engine nội bộ lỗi: %s", exc)
            native = None

        if native is not None and native.get("supported"):
            self._last_engine = "pikepdf"
            self._last_report = {
                "glyphs_outlined": native.get("glyphs", 0),
                "warnings": list(native.get("warnings", [])),
            }
            return True

        details = "; ".join((native or {}).get("warnings", []))
        self._refuse_unsupported("OUTLINE_FONTS", details)

    async def _action_downscale_images(
        self, input_path: str, output_path: str, params: dict
    ) -> bool:
        """Hạ ảnh vượt ngưỡng DPI ở mức image object bằng pikepdf.

        Đường pikepdf chỉ sửa đúng những image XObject vượt ngưỡng và giữ nguyên
        phần còn lại của file. Nếu file chỉ có ảnh vượt ngưỡng thuộc codec hoặc
        colorspace chưa hỗ trợ, tác vụ dừng an toàn thay vì báo thành công giả.

        ``params``:
          * ``target_dpi`` (mặc định 300) — DPI đích sau khi hạ.
          * ``max_dpi``    (mặc định 600) — chỉ hạ ảnh vượt mức này. Trùng
            ``ImageRules.MAX_IMAGE_DPI`` để action và rule phát hiện dùng chung
            một thước đo.
        """
        target_dpi = params.get("target_dpi", 300)
        max_dpi = params.get("max_dpi", 600)

        try:
            from app.core import pdf_actions_native

            result = await asyncio.to_thread(
                pdf_actions_native.downscale_images,
                input_path,
                output_path,
                float(target_dpi),
                float(max_dpi),
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("DOWNSCALE_IMAGES: engine nội bộ lỗi: %s", exc)
            result = None

        skipped = (result or {}).get("skipped", {})
        blocked = sum(
            n for reason, n in skipped.items() if reason != "đã dưới ngưỡng"
        )
        if result is not None and (result.get("changed", 0) > 0 or blocked == 0):
            # Có sửa được, hoặc mọi ảnh vốn đã dưới ngưỡng — cả hai đều là kết
            # quả đúng. Ảnh không hỗ trợ còn lại được ghi rõ trong cảnh báo.
            self._last_engine = "pikepdf"
            warnings = list(result.get("warnings", []))
            if blocked:
                warnings.append(
                    "Bỏ qua "
                    + ", ".join(
                        f"{n} ảnh ({reason})"
                        for reason, n in skipped.items()
                        if reason != "đã dưới ngưỡng"
                    )
                    + "."
                )
            self._last_report = {
                "images_downscaled": result.get("changed", 0),
                "images_skipped": skipped,
                "details": result.get("details", []),
                "warnings": warnings,
            }
            return True

        details = ", ".join(f"{n} ảnh ({reason})" for reason, n in skipped.items())
        self._refuse_unsupported("DOWNSCALE_IMAGES", details)

    async def _action_fix_metadata(
        self, input_path: str, output_path: str, params: dict
    ) -> bool:
        """Clean sensitive metadata and update Producer using pikepdf."""
        try:
            with pikepdf.open(input_path) as pdf:
                # Clear sensitive metadata fields
                with pdf.open_metadata() as meta:
                    # Remove common sensitive fields
                    sensitive_keys = [
                        '{http://purl.org/dc/elements/1.1/}creator',
                        '{http://ns.adobe.com/xap/1.0/}CreatorTool',
                        '{http://ns.adobe.com/pdf/1.3/}Producer',
                    ]
                    for key in sensitive_keys:
                        try:
                            del meta[key]
                        except (KeyError, TypeError):
                            pass

                    # Set our own producer
                    meta['{http://ns.adobe.com/pdf/1.3/}Producer'] = 'PDF Inspector — PrintSolutions.vn'

                # Also update the Info dictionary
                if pdf.docinfo:
                    pdf.docinfo[pikepdf.Name.Author] = pikepdf.String("")
                    pdf.docinfo[pikepdf.Name.Creator] = pikepdf.String("PDF Inspector")
                    pdf.docinfo[pikepdf.Name.Producer] = pikepdf.String("PDF Inspector — PrintSolutions.vn")

                pdf.save(output_path)
                logger.info(f"FIX_METADATA: Cleaned metadata → {output_path}")
                return True

        except Exception as e:
            logger.error(f"FIX_METADATA failed: {e}")
            raise

    # ────────────────────────────────────────────────────────
    #  FIX HAIRLINES (pikepdf)
    # ────────────────────────────────────────────────────────

    async def _action_fix_hairlines(self, pdf_path: str, output_path: str, params: dict) -> bool:
        """Phát hiện & tăng độ dày các NÉT (stroke) mảnh hơn ngưỡng.

        An toàn màu / đường khuôn:
          - CHỈ xử lý path có nét (``color`` khác ``None``). Path chỉ-tô (fill) không
            mang khái niệm "độ dày nét" nên không phải hairline; bỏ qua chúng cũng
            đồng thời tránh lỗi ``len(None)`` khi ``finish(color=None)``.
          - Bao gồm cả nét ``width == 0`` (toán tử ``0 w`` — hairline kinh điển, mảnh
            nhất, dễ biến mất khi in offset nhất).
          - BỎ QUA path dùng màu Spot/Separation (vd đường bế CutContour/Dieline):
            vẽ đè bằng DeviceRGB/CMYK sẽ làm sai màu, sai khổ và mất kênh spot.
        """
        from app.workers.pdf_ops import new_shape
        from app.workers.pdf_content_parser import extract_vector_paths

        threshold = params.get("threshold_pt", 0.1)
        replace_with = params.get("replace_pt", 0.25)

        try:
            pdf = pikepdf.Pdf.open(pdf_path)
            total_fixed = 0

            for pike_page in pdf.pages:
                drawings = extract_vector_paths(pike_page, pdf)
                shape = new_shape(pdf, pike_page)
                fixed_on_page = 0

                for path in drawings:
                    color = path.get("color")
                    # Chỉ NÉT mới có độ dày để sửa; bỏ path chỉ-tô (color=None).
                    if color is None:
                        continue
                    # Giữ nguyên nét màu Spot/Separation (đường bế, vạch kỹ thuật).
                    if path.get("spot_name"):
                        continue
                    width = path.get("width", 0)
                    # Gồm cả width == 0 (hairline '0 w'); loại width > threshold.
                    if not (0 <= width <= threshold):
                        continue

                    fill = path.get("fill")
                    items = path.get("items", [])
                    closePath = path.get("closePath", False)

                    for item in items:
                        if item[0] == "l":      # line
                            shape.draw_line(item[1], item[2])
                        elif item[0] == "re":   # rect
                            shape.draw_rect(item[1])
                        elif item[0] == "c":    # curve (bezier)
                            shape.draw_bezier(item[1], item[2], item[3], item[4])

                    if items:
                        shape.finish(
                            color=color,
                            fill=fill,
                            width=replace_with,
                            closePath=closePath,
                        )
                        fixed_on_page += 1

                if fixed_on_page > 0:
                    shape.commit()
                    total_fixed += fixed_on_page

            pdf.save(output_path)
            pdf.close()

            logger.info(f"FIX_HAIRLINES: Fixed {total_fixed} hairlines (<= {threshold}pt -> {replace_with}pt)")
            return True

        except Exception as e:
            logger.error(f"FIX_HAIRLINES failed: {e}")
            raise

    # ────────────────────────────────────────────────────────
    #  SET BLACK OVERPRINT (pikepdf)
    # ────────────────────────────────────────────────────────

    async def _action_set_black_overprint(self, pdf_path: str, output_path: str, params: dict) -> bool:
        """Bật overprint THỰC SỰ cho text/nét đen (K>95%) bằng pikepdf.

        Chỉ ghi ``/OPM`` (mode) mà không ghi cờ ``/OP``/``/op`` true thì object
        đen vẫn knockout. Engine chèn ExtGState overprint vào đúng object đen
        (xem app.core.overprint_black).

        Tôn trọng tham số: ``overprint_black`` (công tắc), ``preserve_overprint``.
        (``trap_width``/``black_trap_width`` là trapping spread/choke ở mức RIP —
        ngoài phạm vi công cụ này; xem cảnh báo trên UI.)
        """
        from app.core.overprint_black import apply_black_overprint

        def _work():
            return apply_black_overprint(pdf_path, output_path, params or {})

        count = await asyncio.to_thread(_work)
        self._last_engine = "pikepdf"
        logger.info(f"SET_BLACK_OVERPRINT: bật overprint cho {count} thao tác vẽ object đen")
        return True

    # ────────────────────────────────────────────────────────
    #  REMOVE CHANNELS (channel_remover)
    # ────────────────────────────────────────────────────────

    async def _action_remove_channels(self, pdf_path: str, output_path: str, params: dict) -> bool:
        """Gỡ kênh process (C/M/Y/K) khỏi PDF, có bù màu re-separation.

        Theo mẫu ``_action_set_black_overprint``: hàm lõi đồng bộ
        ``remove_channels`` (app.core.channel_remover) được chạy qua
        ``asyncio.to_thread`` để không chặn event loop. ``output_path`` do
        ``execute`` dựng sẵn nằm dưới ``RESULTS_DIR/preflight_output`` (Req 9.1),
        nên file kết quả tải được qua Download_Endpoint và ``output_filename`` =
        ``Path(output_path).name`` (Req 9.2).

        Báo cáo (max/avg ΔE, OOG count, warnings) được đính vào
        ``self._last_report`` để ``execute`` gắn vào ``ActionLogEntry.report`` và
        tóm tắt vào message — không cần đổi ``FixResponse`` (task 11.2 surface sau).
        (Req 9.1, 9.2, 9.3)
        """
        from app.core.channel_remover import remove_channels

        def _work():
            return remove_channels(pdf_path, output_path, params or {})

        report = await asyncio.to_thread(_work)

        self._last_report = {
            "output_filename": report.output_filename,
            "max_delta_e": report.max_delta_e,
            "avg_delta_e": report.avg_delta_e,
            "out_of_gamut_count": report.out_of_gamut_count,
            "total_colors": report.total_colors,
            "warnings": list(report.warnings),
            "identical_to_original": report.identical_to_original,
        }

        logger.info(
            "REMOVE_CHANNELS: colors=%d oog=%d ΔEmax=%.2f ΔEavg=%.2f warnings=%d -> %s",
            report.total_colors, report.out_of_gamut_count,
            report.max_delta_e, report.avg_delta_e,
            len(report.warnings), output_path,
        )
        return True

    @staticmethod
    def get_available_actions() -> dict:
        """Return metadata for all available actions (for UI rendering)."""
        return AVAILABLE_ACTIONS
