"""Vòng đời session trên đĩa cho công cụ Tách tem từ ảnh.

Ảnh và mask full-resolution không được giữ trong store RAM sau khi analyze. Store chỉ
giữ metadata nhẹ; artifact nằm dưới RESULTS_DIR và được dọn theo TTL hoặc khi đóng tab.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import json
import logging
from pathlib import Path
import shutil
import threading
import time
from typing import TYPE_CHECKING
import uuid

import cv2
import numpy as np
from PIL import Image

from app.config import settings
from app.workers.sticker_sheet_engine import (
    StickerSheetAnalysis,
    StickerSheetError,
    reprocess_sticker_sheet,
)

if TYPE_CHECKING:
    from app.workers.sticker_source_inspector import StickerSourceInspection


logger = logging.getLogger(__name__)

SESSION_TTL_SECONDS = 30 * 60.0
PREVIEW_MAX_EDGE_PX = 2000
SESSION_ROOT = Path(settings.RESULTS_DIR) / "sticker_sheet_sessions"
_PUBLIC_ASSET_FILENAMES = {
    "preview": "preview.png",
    "labels": "preview_labels.png",
    "uncertainty": "preview_uncertainty.png",
}


@dataclass
class StickerSheetPageState:
    """Trạng thái và artifact độc lập của một trang nguồn trong cùng tài liệu."""

    page_number: int
    directory: Path
    analysis_source_path: Path | None
    original_width_px: int | None
    original_height_px: int | None
    analysis_width_px: int | None
    analysis_height_px: int | None
    preview_width_px: int
    preview_height_px: int
    dpi: tuple[float, float] | None
    stage: str
    boundary_source: str
    strategy_confidence: float
    needs_review: bool
    manifest: dict[str, object]
    # PERF (audit 2026-08-10 §CUTLINE.EXPORT1): chỉ giữ Bézier preview mới nhất
    # của trang trong RAM. Khóa đầy đủ revision/edit/tuning ngăn export dùng nhầm.
    cutline_export_cache: dict[str, object] | None = field(default=None, repr=False)
    # UIUX (audit 2026-09-06 §CUSTOM.5): nhận diện lại giữ bản đã duyệt cho tới
    # khi artifact mới công bố thành công; token chặn worker bị hủy ghi đè lượt mới.
    detection_previous_manifest: dict[str, object] | None = field(default=None, repr=False)
    detection_token: str | None = field(default=None, repr=False)
    operation_lock: threading.RLock = field(default_factory=threading.RLock, repr=False)


@dataclass
class StickerSheetSession:
    session_id: str
    directory: Path
    source_path: Path
    analysis_source_path: Path | None
    original_name: str
    original_width_px: int | None
    original_height_px: int | None
    analysis_width_px: int | None
    analysis_height_px: int | None
    preview_width_px: int
    preview_height_px: int
    dpi: tuple[float, float] | None
    stage: str
    source_kind: str
    boundary_source: str
    strategy_confidence: float
    needs_review: bool
    page_count: int
    manifest: dict[str, object]
    last_access: float
    legacy_active_page: int = 1
    pages: dict[int, StickerSheetPageState] = field(default_factory=dict)
    operation_lock: threading.RLock = field(default_factory=threading.RLock, repr=False)


_SESSIONS: dict[str, StickerSheetSession] = {}
_STORE_LOCK = threading.RLock()


class StickerSheetSessionConflict(RuntimeError):
    """Session đổi trạng thái/revision trong lúc người dùng đang tinh chỉnh."""


def _page_directory(session_directory: Path, page_number: int) -> Path:
    """Trang 1 giữ layout cũ; trang sau tách thư mục để không ghi đè artifact."""
    if page_number == 1:
        return session_directory
    return session_directory / "pages" / f"{page_number:04d}"


def _get_page_state(
    session: StickerSheetSession,
    page_number: int,
) -> StickerSheetPageState | None:
    if page_number < 1 or page_number > session.page_count:
        return None
    return session.pages.get(page_number)


def _resolved_page_number(
    session: StickerSheetSession,
    page_number: int | None,
) -> int:
    return session.legacy_active_page if page_number is None else page_number


def _sync_legacy_active_page(
    session: StickerSheetSession,
    page: StickerSheetPageState,
) -> None:
    """Phản chiếu trang vừa thao tác cho route/export cũ trong lô chuyển tiếp."""
    session.legacy_active_page = page.page_number
    session.analysis_source_path = page.analysis_source_path
    session.original_width_px = page.original_width_px
    session.original_height_px = page.original_height_px
    session.analysis_width_px = page.analysis_width_px
    session.analysis_height_px = page.analysis_height_px
    session.preview_width_px = page.preview_width_px
    session.preview_height_px = page.preview_height_px
    session.dpi = page.dpi
    session.stage = page.stage
    session.boundary_source = page.boundary_source
    session.strategy_confidence = page.strategy_confidence
    session.needs_review = page.needs_review
    session.manifest = page.manifest


def _validate_refinement_arrays(analysis: StickerSheetAnalysis) -> bool:
    """Chỉ công bố refinement khi đủ dữ liệu 8-bit cùng kích thước ảnh phân tích."""
    if analysis.raw_alpha is None or analysis.shadow_exclusion is None:
        return False
    expected_shape = (analysis.height, analysis.width)
    return (
        analysis.raw_alpha.shape == expected_shape
        and analysis.shadow_exclusion.shape == expected_shape
        and analysis.raw_alpha.dtype == np.uint8
        and analysis.shadow_exclusion.dtype == np.uint8
    )


def _resolved_root() -> Path:
    root = SESSION_ROOT.resolve()
    root.mkdir(parents=True, exist_ok=True)
    return root


def _safe_session_dir(session_id: str) -> Path:
    root = _resolved_root()
    target = (root / session_id).resolve()
    try:
        target.relative_to(root)
    except ValueError as exc:
        raise ValueError("Session tách tem không hợp lệ.") from exc
    return target


def _read_manifest(path: Path) -> dict[str, object] | None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def _optional_int(value: object) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return parsed if parsed >= 0 else None


def _manifest_dpi(manifest: dict[str, object]) -> tuple[float, float] | None:
    value = manifest.get("dpi")
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        return None
    try:
        dpi = (float(value[0]), float(value[1]))
    except (TypeError, ValueError, OverflowError):
        return None
    return dpi if dpi[0] > 0 and dpi[1] > 0 else None


def _float_or_default(value: object, default: float = 0.0) -> float:
    if isinstance(value, bool):
        return default
    try:
        return float(value)
    except (TypeError, ValueError, OverflowError):
        return default


def _restore_session_from_disk(session_id: str) -> StickerSheetSession | None:
    """Khôi phục metadata nhẹ khi worker reload nhưng artifact phiên vẫn còn trên đĩa."""
    try:
        directory = _safe_session_dir(session_id)
    except ValueError:
        return None
    root_manifest_path = directory / "manifest.json"
    root_manifest = _read_manifest(root_manifest_path)
    if root_manifest is None or root_manifest.get("session_id") != session_id:
        return None

    source_paths = sorted(path for path in directory.glob("source.*") if path.is_file())
    if not source_paths:
        return None
    page_count = _optional_int(root_manifest.get("page_count"))
    if page_count is None or page_count < 1 or page_count > 10_000:
        return None

    stable_stages = {"inspected", "mask-review", "mask-ready"}
    pages: dict[int, StickerSheetPageState] = {}
    manifest_mtimes: list[float] = []
    for page_number in range(1, page_count + 1):
        page_directory = _page_directory(directory, page_number)
        page_manifest_path = page_directory / "manifest.json"
        page_manifest = root_manifest if page_number == 1 else _read_manifest(page_manifest_path)
        if page_manifest is None:
            return None
        try:
            manifest_mtimes.append(page_manifest_path.stat().st_mtime)
        except OSError:
            return None
        stage = str(page_manifest.get("stage", ""))
        if stage not in stable_stages:
            return None
        analysis_source = page_directory / "analysis_source.png"
        pages[page_number] = StickerSheetPageState(
            page_number=page_number,
            directory=page_directory,
            analysis_source_path=(analysis_source if analysis_source.is_file() else None),
            original_width_px=_optional_int(page_manifest.get("original_width_px")),
            original_height_px=_optional_int(page_manifest.get("original_height_px")),
            analysis_width_px=_optional_int(page_manifest.get("analysis_width_px")),
            analysis_height_px=_optional_int(page_manifest.get("analysis_height_px")),
            preview_width_px=_optional_int(page_manifest.get("preview_width_px")) or 0,
            preview_height_px=_optional_int(page_manifest.get("preview_height_px")) or 0,
            dpi=_manifest_dpi(page_manifest),
            stage=stage,
            boundary_source=str(page_manifest.get("boundary_source", "ai")),
            strategy_confidence=_float_or_default(page_manifest.get("strategy_confidence")),
            needs_review=bool(page_manifest.get("needs_review", True)),
            manifest=page_manifest,
        )

    if time.time() - max(manifest_mtimes) > SESSION_TTL_SECONDS:
        _remove_directory(directory)
        return None

    first_page = pages[1]
    restored = StickerSheetSession(
        session_id=session_id,
        directory=directory,
        source_path=source_paths[0],
        analysis_source_path=first_page.analysis_source_path,
        original_name=Path(str(root_manifest.get("original_name", "source"))).name,
        original_width_px=first_page.original_width_px,
        original_height_px=first_page.original_height_px,
        analysis_width_px=first_page.analysis_width_px,
        analysis_height_px=first_page.analysis_height_px,
        preview_width_px=first_page.preview_width_px,
        preview_height_px=first_page.preview_height_px,
        dpi=first_page.dpi,
        stage=first_page.stage,
        source_kind=str(root_manifest.get("source_kind", "raster")),
        boundary_source=first_page.boundary_source,
        strategy_confidence=first_page.strategy_confidence,
        needs_review=first_page.needs_review,
        page_count=page_count,
        manifest=first_page.manifest,
        last_access=time.monotonic(),
        pages=pages,
    )
    with _STORE_LOCK:
        current = _SESSIONS.get(session_id)
        if current is not None:
            return current
        # SESSION (feedback 2026-08-10 §AI.RELOAD1): uvicorn --reload thay worker
        # không được làm mất phiên khi manifest và toàn bộ artifact vẫn hợp lệ trên đĩa.
        _SESSIONS[session_id] = restored
    logger.info("Khôi phục phiên tách tem %s sau khi backend reload", session_id)
    return restored


def _remove_directory(directory: Path) -> None:
    root = _resolved_root()
    target = directory.resolve()
    try:
        target.relative_to(root)
    except ValueError:
        logger.error("Từ chối dọn session nằm ngoài RESULTS_DIR: %s", target)
        return
    if target.exists():
        shutil.rmtree(target)


def _encode_label_rgb(labels: np.ndarray) -> Image.Image:
    ids = labels.astype(np.uint32)
    encoded = np.zeros((*labels.shape, 3), dtype=np.uint8)
    encoded[:, :, 0] = ids & 0xFF
    encoded[:, :, 1] = (ids >> 8) & 0xFF
    encoded[:, :, 2] = (ids >> 16) & 0xFF
    return Image.fromarray(encoded, "RGB")


def _preview_size(width: int, height: int) -> tuple[int, int]:
    longest = max(width, height)
    if longest <= PREVIEW_MAX_EDGE_PX:
        return width, height
    scale = PREVIEW_MAX_EDGE_PX / float(longest)
    return max(1, round(width * scale)), max(1, round(height * scale))


def _write_json_atomic(path: Path, payload: dict[str, object]) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    temporary.replace(path)


def _save_session_png(image: Image.Image, path: Path) -> None:
    """Ghi PNG tạm ưu tiên latency; cleanup 26 giờ nên không cần optimize đắt."""
    image.save(path, format="PNG", compress_level=1)


def create_session(
    *,
    source_path: str | Path,
    original_name: str,
    original_size: tuple[int, int],
    analysis: StickerSheetAnalysis,
    dpi: tuple[float, float] | None,
) -> StickerSheetSession:
    """Materialize analysis thành artifact session rồi mới công bố vào store."""
    sweep_expired()
    session_id = uuid.uuid4().hex
    directory = _safe_session_dir(session_id)
    directory.mkdir(parents=True, exist_ok=False)
    source = Path(source_path)
    safe_extension = source.suffix.lower() if source.suffix else ".img"
    session_source = directory / f"source{safe_extension}"

    try:
        # SESSION (audit 2026-08-08 §UNIFIED.8): không giữ mtime cũ của file khách;
        # cleanup RESULTS_DIR dùng mtime và có thể xóa nguồn session vừa tạo.
        shutil.copyfile(source, session_source)
        np.save(directory / "labels.npy", analysis.labels, allow_pickle=False)
        _save_session_png(Image.fromarray(analysis.rgba, "RGBA"), directory / "rgba.png")
        _save_session_png(Image.fromarray(analysis.alpha, "L"), directory / "alpha.png")
        _save_session_png(
            Image.fromarray(analysis.uncertainty, "L"),
            directory / "uncertainty.png",
        )

        preview_size = _preview_size(analysis.width, analysis.height)
        preview_rgba = Image.fromarray(analysis.rgba, "RGBA")
        preview_uncertainty = Image.fromarray(analysis.uncertainty, "L")
        preview_labels = analysis.labels
        if preview_size != (analysis.width, analysis.height):
            preview_rgba = preview_rgba.resize(preview_size, Image.Resampling.LANCZOS)
            preview_uncertainty = preview_uncertainty.resize(
                preview_size,
                Image.Resampling.NEAREST,
            )
            preview_labels = cv2.resize(
                preview_labels,
                preview_size,
                interpolation=cv2.INTER_NEAREST,
            )
        if preview_size == (analysis.width, analysis.height):
            # PERF (audit 2026-08-10 §AI-SPEED.4): cùng pixel thì copy file đã
            # encode, không nén lại RGBA/uncertainty lần thứ hai.
            shutil.copyfile(directory / "rgba.png", directory / "preview.png")
            shutil.copyfile(
                directory / "uncertainty.png",
                directory / "preview_uncertainty.png",
            )
        else:
            _save_session_png(preview_rgba, directory / "preview.png")
            _save_session_png(
                preview_uncertainty,
                directory / "preview_uncertainty.png",
            )
        _save_session_png(
            _encode_label_rgb(preview_labels),
            directory / "preview_labels.png",
        )

        manifest: dict[str, object] = {
            "session_id": session_id,
            "stage": "mask-ready",
            "source_kind": "raster",
            "boundary_source": "ai",
            "strategy_confidence": 0.8,
            "needs_review": True,
            "page_count": 1,
            "original_name": Path(original_name).name,
            "original_width_px": int(original_size[0]),
            "original_height_px": int(original_size[1]),
            "analysis_width_px": analysis.width,
            "analysis_height_px": analysis.height,
            "preview_width_px": preview_size[0],
            "preview_height_px": preview_size[1],
            "dpi": list(dpi) if dpi else None,
            "model": analysis.model,
            "model_seconds": round(analysis.model_seconds, 6),
            "postprocess_seconds": round(analysis.postprocess_seconds, 6),
            "mask_revision": 1,
            # Endpoint /analyze cũ trả thẳng mask-ready, không có bước review.
            "refinement_available": False,
            "alpha_threshold": int(analysis.alpha_threshold),
            "shadow_cleanup": analysis.shadow_cleanup,
            "warnings": list(analysis.warnings),
            "instances": [
                {
                    "id": instance.id,
                    "x": instance.x,
                    "y": instance.y,
                    "width": instance.width,
                    "height": instance.height,
                    "area_px": instance.area_px,
                    "confidence": instance.confidence,
                    "uncertain_ratio": instance.uncertain_ratio,
                }
                for instance in analysis.instances
            ],
        }
        _write_json_atomic(directory / "manifest.json", manifest)
        session = StickerSheetSession(
            session_id=session_id,
            directory=directory,
            source_path=session_source,
            analysis_source_path=session_source,
            original_name=Path(original_name).name,
            original_width_px=int(original_size[0]),
            original_height_px=int(original_size[1]),
            analysis_width_px=analysis.width,
            analysis_height_px=analysis.height,
            preview_width_px=preview_size[0],
            preview_height_px=preview_size[1],
            dpi=dpi,
            stage="mask-ready",
            source_kind="raster",
            boundary_source="ai",
            strategy_confidence=0.8,
            needs_review=True,
            page_count=1,
            manifest=manifest,
            last_access=time.monotonic(),
        )
        session.pages[1] = StickerSheetPageState(
            page_number=1,
            directory=directory,
            analysis_source_path=session_source,
            original_width_px=int(original_size[0]),
            original_height_px=int(original_size[1]),
            analysis_width_px=analysis.width,
            analysis_height_px=analysis.height,
            preview_width_px=preview_size[0],
            preview_height_px=preview_size[1],
            dpi=dpi,
            stage="mask-ready",
            boundary_source="ai",
            strategy_confidence=0.8,
            needs_review=True,
            manifest=manifest,
        )
        with _STORE_LOCK:
            _SESSIONS[session_id] = session
        return session
    except BaseException:
        _remove_directory(directory)
        raise


def create_source_session(
    *,
    source_path: str | Path,
    original_name: str,
    inspection: "StickerSourceInspection",
) -> StickerSheetSession:
    """Lưu nguồn + preview inspect; chưa tạo mask và chưa được phép export."""
    sweep_expired()
    session_id = uuid.uuid4().hex
    directory = _safe_session_dir(session_id)
    directory.mkdir(parents=True, exist_ok=False)
    source = Path(source_path)
    safe_extension = source.suffix.lower() if source.suffix else ".bin"
    session_source = directory / f"source{safe_extension}"

    try:
        shutil.copyfile(source, session_source)
        preview = inspection.preview.convert("RGBA")
        preview.save(directory / "preview.png", format="PNG", optimize=True)
        manifest: dict[str, object] = {
            "session_id": session_id,
            "stage": "inspected",
            "original_name": Path(original_name).name,
            **inspection.to_manifest(),
        }
        _write_json_atomic(directory / "manifest.json", manifest)
        session = StickerSheetSession(
            session_id=session_id,
            directory=directory,
            source_path=session_source,
            analysis_source_path=None,
            original_name=Path(original_name).name,
            original_width_px=inspection.source_width_px,
            original_height_px=inspection.source_height_px,
            analysis_width_px=None,
            analysis_height_px=None,
            preview_width_px=preview.width,
            preview_height_px=preview.height,
            dpi=inspection.dpi,
            stage="inspected",
            source_kind=inspection.source_kind,
            boundary_source=inspection.boundary_source,
            strategy_confidence=inspection.strategy_confidence,
            needs_review=inspection.needs_review,
            page_count=inspection.page_count,
            manifest=manifest,
            last_access=time.monotonic(),
        )
        # UIUX (audit 2026-08-09 §MP.2-3): một tài liệu dùng chung file nguồn/TTL,
        # nhưng stage, manifest và artifact phải độc lập theo trang. Trang 1 giữ layout
        # cũ để các consumer một trang chưa nâng hợp đồng vẫn chạy trong lô chuyển tiếp.
        page_manifests = {
            int(item.get("page_number", index + 1)): item
            for index, item in enumerate(inspection.to_manifest().get("pages", []))
            if isinstance(item, dict)
        }
        for page_number in range(1, inspection.page_count + 1):
            page_directory = _page_directory(directory, page_number)
            if page_number != 1:
                page_directory.mkdir(parents=True, exist_ok=False)
            page_metadata = page_manifests.get(page_number, {})
            page_manifest = {
                **manifest,
                "stage": "inspected",
                "source_page": page_number,
                "page": page_metadata,
            }
            if page_number != 1:
                _write_json_atomic(page_directory / "manifest.json", page_manifest)
            session.pages[page_number] = StickerSheetPageState(
                page_number=page_number,
                directory=page_directory,
                analysis_source_path=None,
                original_width_px=(inspection.source_width_px if page_number == 1 else None),
                original_height_px=(inspection.source_height_px if page_number == 1 else None),
                analysis_width_px=None,
                analysis_height_px=None,
                preview_width_px=(preview.width if page_number == 1 else 0),
                preview_height_px=(preview.height if page_number == 1 else 0),
                dpi=(inspection.dpi if page_number == 1 else None),
                stage="inspected",
                boundary_source=inspection.boundary_source,
                strategy_confidence=inspection.strategy_confidence,
                needs_review=inspection.needs_review,
                manifest=page_manifest,
            )
        with _STORE_LOCK:
            _SESSIONS[session_id] = session
        return session
    except BaseException:
        _remove_directory(directory)
        raise


def begin_source_detection(
    session_id: str,
    page_number: int = 1,
    *,
    base_revision: int | None = None,
) -> StickerSheetSession | None:
    """Giữ quyền nhận diện độc quyền theo trang, không khóa oan trang khác."""
    session = get_session(session_id)
    if session is None:
        return None
    page = _get_page_state(session, page_number)
    if page is None:
        return None
    with page.operation_lock:
        with _STORE_LOCK:
            current = _SESSIONS.get(session_id)
            current_page = current.pages.get(page_number) if current is session else None
            if current_page is not page:
                return None
            if base_revision is not None:
                if (
                    page.stage not in {"mask-review", "mask-ready"}
                    or int(page.manifest.get("mask_revision", 0)) != int(base_revision)
                ):
                    raise StickerSheetSessionConflict(
                        "Vùng tem đã thay đổi. Hãy chọn lại trên bản xem trước mới nhất."
                    )
            elif page.stage != "inspected":
                return None
            page.detection_previous_manifest = dict(page.manifest)
            page.detection_token = uuid.uuid4().hex
            page.stage = "detecting"
            page.manifest = {**page.manifest, "stage": "detecting"}
            session.last_access = time.monotonic()
            _sync_legacy_active_page(session, page)
            return session


def abort_source_detection(
    session_id: str,
    page_number: int = 1,
    *,
    detection_token: str | None = None,
) -> bool:
    """Trả session về trạng thái chờ sau một lần nhận diện lỗi/hủy."""
    with _STORE_LOCK:
        session = _SESSIONS.get(session_id)
    if session is None:
        return False
    page = _get_page_state(session, page_number)
    if page is None:
        return False
    with page.operation_lock:
        with _STORE_LOCK:
            current = _SESSIONS.get(session_id)
            current_page = current.pages.get(page_number) if current is session else None
            if (
                current_page is not page
                or page.stage not in ("detecting", "promoting")
                or (detection_token is not None and page.detection_token != detection_token)
            ):
                return False
            page.manifest = page.detection_previous_manifest or {
                **page.manifest, "stage": "inspected",
            }
            page.stage = str(page.manifest.get("stage", "inspected"))
            page.detection_previous_manifest = None
            page.detection_token = None
            session.last_access = time.monotonic()
            _sync_legacy_active_page(session, page)
            return True


def promote_source_session(
    session_id: str,
    *,
    analysis: StickerSheetAnalysis,
    analysis_source: Image.Image,
    boundary_source: str,
    strategy_confidence: float,
    needs_review: bool,
    dpi: tuple[float, float] | None,
    source_page: int,
    vector_geometry_ref: dict[str, object] | None = None,
    warnings: list[str] | None = None,
    edge_background_rgb: tuple[int, int, int] | None = None,
    edge_background_tolerance: int = 0,
    detection_token: str | None = None,
) -> StickerSheetSession | None:
    """Nâng session inspect thành mask-review nhưng vẫn giữ nguyên file nguồn gốc."""
    session = get_session(session_id)
    if session is None:
        return None
    page = _get_page_state(session, source_page)
    if page is None:
        return None
    with page.operation_lock:
        with _STORE_LOCK:
            current = _SESSIONS.get(session_id)
            current_page = current.pages.get(source_page) if current is session else None
            if (
                current_page is not page
                or page.stage not in ("inspected", "detecting")
                or (detection_token is not None and page.detection_token != detection_token)
            ):
                return None
            previous_stage = page.stage
            previous_manifest = dict(page.manifest)
            previous_revision = int(previous_manifest.get("mask_revision", 0))
            page.stage = "promoting"
            _sync_legacy_active_page(session, page)

        directory = page.directory
        staging = directory / f".promote-{uuid.uuid4().hex}"
        backup = directory / f".promote-backup-{uuid.uuid4().hex}"
        published_artifacts: list[str] = []
        source_preview = directory / "source_preview.png"
        analysis_source_path = directory / "analysis_source.png"
        refinement_available = (
            boundary_source == "ai" and _validate_refinement_arrays(analysis)
        )
        final_artifacts = [
            "analysis_source.png",
            "labels.npy",
            "rgba.png",
            "alpha.png",
            "uncertainty.png",
            "preview.png",
            "preview_uncertainty.png",
            "preview_labels.png",
        ]
        if refinement_available:
            final_artifacts.extend((
                "raw_alpha.png",
                "shadow_exclusion.png",
                "reference_labels.npy",
            ))
        try:
            staging.mkdir(parents=False, exist_ok=False)
            normalized_source = analysis_source.convert("RGBA")
            _save_session_png(normalized_source, staging / "analysis_source.png")
            np.save(staging / "labels.npy", analysis.labels, allow_pickle=False)
            _save_session_png(Image.fromarray(analysis.rgba, "RGBA"), staging / "rgba.png")
            _save_session_png(Image.fromarray(analysis.alpha, "L"), staging / "alpha.png")
            _save_session_png(
                Image.fromarray(analysis.uncertainty, "L"),
                staging / "uncertainty.png",
            )
            if refinement_available:
                _save_session_png(
                    Image.fromarray(analysis.raw_alpha, "L"),
                    staging / "raw_alpha.png",
                )
                _save_session_png(
                    Image.fromarray(analysis.shadow_exclusion, "L"),
                    staging / "shadow_exclusion.png",
                )
                np.save(
                    staging / "reference_labels.npy",
                    analysis.labels,
                    allow_pickle=False,
                )

            preview_size = _preview_size(analysis.width, analysis.height)
            preview_rgba = Image.fromarray(analysis.rgba, "RGBA")
            preview_uncertainty = Image.fromarray(analysis.uncertainty, "L")
            preview_labels = analysis.labels
            if preview_size != (analysis.width, analysis.height):
                preview_rgba = preview_rgba.resize(preview_size, Image.Resampling.LANCZOS)
                preview_uncertainty = preview_uncertainty.resize(
                    preview_size,
                    Image.Resampling.NEAREST,
                )
                preview_labels = cv2.resize(
                    preview_labels,
                    preview_size,
                    interpolation=cv2.INTER_NEAREST,
                )
            if preview_size == (analysis.width, analysis.height):
                shutil.copyfile(staging / "rgba.png", staging / "preview.png")
                shutil.copyfile(
                    staging / "uncertainty.png",
                    staging / "preview_uncertainty.png",
                )
            else:
                _save_session_png(preview_rgba, staging / "preview.png")
                _save_session_png(
                    preview_uncertainty,
                    staging / "preview_uncertainty.png",
                )
            _save_session_png(
                _encode_label_rgb(preview_labels),
                staging / "preview_labels.png",
            )

            source_warnings = list(previous_manifest.get(
                "source_warnings", previous_manifest.get("warnings", []),
            ))
            merged_warnings = list(dict.fromkeys([
                *source_warnings,
                *analysis.warnings,
                *(warnings or []),
            ]))
            manifest = {
                **page.manifest,
                "stage": "mask-review",
                "mask_confirmed": False,
                "boundary_source": boundary_source,
                "strategy_confidence": round(float(strategy_confidence), 4),
                "needs_review": bool(needs_review),
                "source_page": int(source_page),
                "original_width_px": normalized_source.width,
                "original_height_px": normalized_source.height,
                "analysis_width_px": analysis.width,
                "analysis_height_px": analysis.height,
                "preview_width_px": preview_size[0],
                "preview_height_px": preview_size[1],
                "dpi": list(dpi) if dpi else None,
                "model": analysis.model,
                "model_seconds": round(analysis.model_seconds, 6),
                "postprocess_seconds": round(analysis.postprocess_seconds, 6),
                "mask_revision": previous_revision + 1,
                "refinement_available": refinement_available,
                "alpha_threshold": int(analysis.alpha_threshold),
                "shadow_cleanup": analysis.shadow_cleanup,
                "warnings": merged_warnings,
                "source_warnings": source_warnings,
                # QUALITY (audit 2026-08-21 §CANONICAL.2): màu nền là metadata
                # của chính silhouette đã duyệt. Giữ qua session để execute dùng
                # lại artifact không phải hút màu từ halo JPEG ở mép tem.
                "edge_background_rgb": (
                    list(edge_background_rgb)
                    if edge_background_rgb is not None
                    else None
                ),
                "edge_background_tolerance": max(
                    0,
                    min(255, int(edge_background_tolerance)),
                ),
                "instances": [
                    {
                        "id": instance.id,
                        "x": instance.x,
                        "y": instance.y,
                        "width": instance.width,
                        "height": instance.height,
                        "area_px": instance.area_px,
                        "confidence": instance.confidence,
                        "uncertain_ratio": instance.uncertain_ratio,
                    }
                    for instance in analysis.instances
                ],
                "vector_geometry_ref": vector_geometry_ref,
            }
            _write_json_atomic(staging / "manifest.json", manifest)

            with _STORE_LOCK:
                current = _SESSIONS.get(session_id)
                current_page = current.pages.get(source_page) if current is session else None
                if (
                    current_page is not page
                    or page.stage != "promoting"
                    or (detection_token is not None and page.detection_token != detection_token)
                ):
                    return None
                if not source_preview.exists() and (directory / "preview.png").exists():
                    shutil.copyfile(directory / "preview.png", source_preview)
                # UIUX (audit 2026-09-06 §CUSTOM.5): staging hoàn chỉnh mới được
                # thay artifact. Nếu ổ đĩa lỗi giữa chừng, phục hồi cả mask cũ.
                backup.mkdir(parents=False, exist_ok=False)
                for filename in [*final_artifacts, "manifest.json"]:
                    original = directory / filename
                    if original.is_file():
                        shutil.copyfile(original, backup / filename)
                for filename in [*final_artifacts, "manifest.json"]:
                    (staging / filename).replace(directory / filename)
                    published_artifacts.append(filename)
                page.analysis_source_path = analysis_source_path
                page.original_width_px = normalized_source.width
                page.original_height_px = normalized_source.height
                page.analysis_width_px = analysis.width
                page.analysis_height_px = analysis.height
                page.preview_width_px = preview_size[0]
                page.preview_height_px = preview_size[1]
                page.dpi = dpi
                page.stage = "mask-review"
                page.boundary_source = boundary_source
                page.strategy_confidence = float(strategy_confidence)
                page.needs_review = bool(needs_review)
                page.manifest = manifest
                page.cutline_export_cache = None
                page.detection_previous_manifest = None
                page.detection_token = None
                session.last_access = time.monotonic()
                _sync_legacy_active_page(session, page)
            return session
        except BaseException:
            logger.exception("Không nâng được session nguồn tem %s", session_id)
            try:
                for filename in published_artifacts:
                    saved = backup / filename
                    if saved.is_file():
                        shutil.copyfile(saved, directory / filename)
                    else:
                        (directory / filename).unlink(missing_ok=True)
                if (backup / "manifest.json").is_file():
                    shutil.copyfile(backup / "manifest.json", directory / "manifest.json")
            except OSError:
                logger.exception("Không khôi phục trọn vẹn artifact session %s", session_id)
            with _STORE_LOCK:
                current = _SESSIONS.get(session_id)
                current_page = current.pages.get(source_page) if current is session else None
                if current_page is page and page.stage == "promoting":
                    page.stage = previous_stage
                    page.manifest = previous_manifest
                    _sync_legacy_active_page(session, page)
            raise
        finally:
            shutil.rmtree(staging, ignore_errors=True)
            shutil.rmtree(backup, ignore_errors=True)


def refine_source_session(
    session_id: str,
    *,
    alpha_threshold: int,
    shadow_cleanup: str,
    base_revision: int,
    page_number: int | None = None,
) -> StickerSheetSession | None:
    """Tái dựng preview từ Alpha đã cache và công bố đồng bộ một revision mới."""
    session = get_session(session_id)
    if session is None:
        return None
    page_number = _resolved_page_number(session, page_number)
    page = _get_page_state(session, page_number)
    if page is None:
        return None

    with page.operation_lock:
        with _STORE_LOCK:
            current = _SESSIONS.get(session_id)
            current_page = current.pages.get(page_number) if current is session else None
            if current_page is not page:
                return None
            if page.stage != "mask-review":
                raise StickerSheetSessionConflict(
                    "Chỉ có thể tinh chỉnh trước khi xác nhận vùng tem."
                )
            current_revision = int(page.manifest.get("mask_revision", 1))
            if current_revision != int(base_revision):
                raise StickerSheetSessionConflict(
                    "Bản xem trước đã thay đổi. Hãy thử lại trên kết quả mới nhất."
                )
            if (
                page.boundary_source != "ai"
                or not bool(page.manifest.get("refinement_available"))
            ):
                raise StickerSheetSessionConflict(
                    "Nguồn tem này không có dữ liệu AI để tinh chỉnh."
                )
            previous_manifest = dict(page.manifest)
            page.stage = "refining"
            session.last_access = time.monotonic()
            _sync_legacy_active_page(session, page)

        directory = page.directory
        staging = directory / f".refine-{uuid.uuid4().hex}"
        backup = directory / f".refine-backup-{uuid.uuid4().hex}"
        final_artifacts = (
            "labels.npy",
            "rgba.png",
            "alpha.png",
            "uncertainty.png",
            "preview.png",
            "preview_uncertainty.png",
            "preview_labels.png",
        )
        try:
            required_paths = {
                "source": directory / "analysis_source.png",
                "raw_alpha": directory / "raw_alpha.png",
                "shadow_exclusion": directory / "shadow_exclusion.png",
                "reference_labels": directory / "reference_labels.npy",
            }
            if any(not path.is_file() for path in required_paths.values()):
                raise StickerSheetSessionConflict(
                    "Dữ liệu xem trước AI không còn đầy đủ. Hãy nhận diện lại ảnh."
                )

            with Image.open(required_paths["source"]) as opened:
                opened.load()
                analysis_source = opened.convert("RGB")
            with Image.open(required_paths["raw_alpha"]) as opened:
                raw_alpha = np.asarray(opened.convert("L"), dtype=np.uint8).copy()
            with Image.open(required_paths["shadow_exclusion"]) as opened:
                shadow_exclusion = np.asarray(
                    opened.convert("L"),
                    dtype=np.uint8,
                ).copy()
            reference_labels = np.load(
                required_paths["reference_labels"],
                allow_pickle=False,
            )
            expected_shape = (analysis_source.height, analysis_source.width)
            if (
                raw_alpha.shape != expected_shape
                or shadow_exclusion.shape != expected_shape
                or reference_labels.shape != expected_shape
            ):
                raise StickerSheetSessionConflict(
                    "Dữ liệu xem trước AI không khớp ảnh nguồn. Hãy nhận diện lại ảnh."
                )

            model = str(previous_manifest.get("model", "birefnet-lite"))
            analysis = reprocess_sticker_sheet(
                analysis_source,
                raw_alpha=raw_alpha,
                shadow_exclusion=shadow_exclusion,
                model=model,  # type: ignore[arg-type]
                alpha_threshold=int(alpha_threshold),
                shadow_cleanup=shadow_cleanup,  # type: ignore[arg-type]
                reference_labels=reference_labels,
            )

            staging.mkdir(parents=False, exist_ok=False)
            np.save(staging / "labels.npy", analysis.labels, allow_pickle=False)
            _save_session_png(
                Image.fromarray(analysis.rgba, "RGBA"),
                staging / "rgba.png",
            )
            _save_session_png(
                Image.fromarray(analysis.alpha, "L"),
                staging / "alpha.png",
            )
            _save_session_png(
                Image.fromarray(analysis.uncertainty, "L"),
                staging / "uncertainty.png",
            )

            preview_size = _preview_size(analysis.width, analysis.height)
            preview_rgba = Image.fromarray(analysis.rgba, "RGBA")
            preview_uncertainty = Image.fromarray(analysis.uncertainty, "L")
            preview_labels = analysis.labels
            if preview_size != (analysis.width, analysis.height):
                preview_rgba = preview_rgba.resize(
                    preview_size,
                    Image.Resampling.LANCZOS,
                )
                preview_uncertainty = preview_uncertainty.resize(
                    preview_size,
                    Image.Resampling.NEAREST,
                )
                preview_labels = cv2.resize(
                    preview_labels,
                    preview_size,
                    interpolation=cv2.INTER_NEAREST,
                )
            if preview_size == (analysis.width, analysis.height):
                shutil.copyfile(staging / "rgba.png", staging / "preview.png")
                shutil.copyfile(
                    staging / "uncertainty.png",
                    staging / "preview_uncertainty.png",
                )
            else:
                _save_session_png(preview_rgba, staging / "preview.png")
                _save_session_png(
                    preview_uncertainty,
                    staging / "preview_uncertainty.png",
                )
            _save_session_png(
                _encode_label_rgb(preview_labels),
                staging / "preview_labels.png",
            )

            next_revision = current_revision + 1
            merged_warnings = list(dict.fromkeys([
                *list(previous_manifest.get("warnings", [])),
                *analysis.warnings,
            ]))
            manifest = {
                **previous_manifest,
                "stage": "mask-review",
                "mask_confirmed": False,
                "mask_revision": next_revision,
                "alpha_threshold": int(alpha_threshold),
                "shadow_cleanup": shadow_cleanup,
                "postprocess_seconds": round(analysis.postprocess_seconds, 6),
                "refine_seconds": round(analysis.postprocess_seconds, 6),
                "preview_width_px": preview_size[0],
                "preview_height_px": preview_size[1],
                "warnings": merged_warnings,
                "instances": [
                    {
                        "id": instance.id,
                        "x": instance.x,
                        "y": instance.y,
                        "width": instance.width,
                        "height": instance.height,
                        "area_px": instance.area_px,
                        "confidence": instance.confidence,
                        "uncertain_ratio": instance.uncertain_ratio,
                    }
                    for instance in analysis.instances
                ],
            }

            backup.mkdir(parents=False, exist_ok=False)
            for filename in final_artifacts:
                artifact = directory / filename
                if not artifact.is_file():
                    raise StickerSheetSessionConflict(
                        "Artifact xem trước không còn đầy đủ. Hãy nhận diện lại ảnh."
                    )
                shutil.copyfile(artifact, backup / filename)
            for filename in final_artifacts:
                (staging / filename).replace(directory / filename)
            _write_json_atomic(directory / "manifest.json", manifest)

            with _STORE_LOCK:
                current = _SESSIONS.get(session_id)
                current_page = current.pages.get(page_number) if current is session else None
                if current_page is not page or page.stage != "refining":
                    raise StickerSheetSessionConflict(
                        "Phiên nguồn tem đã thay đổi trong lúc tinh chỉnh."
                    )
                page.preview_width_px = preview_size[0]
                page.preview_height_px = preview_size[1]
                page.stage = "mask-review"
                page.needs_review = True
                page.manifest = manifest
                session.last_access = time.monotonic()
                _sync_legacy_active_page(session, page)
                return session
        except BaseException as exc:
            if not isinstance(
                exc,
                (StickerSheetError, StickerSheetSessionConflict),
            ):
                logger.exception("Không tinh chỉnh được session nguồn tem %s", session_id)
            try:
                if backup.is_dir():
                    for filename in final_artifacts:
                        saved = backup / filename
                        if saved.is_file():
                            shutil.copyfile(saved, directory / filename)
                _write_json_atomic(directory / "manifest.json", previous_manifest)
            except OSError:
                logger.exception(
                    "Không khôi phục trọn vẹn artifact refinement session %s",
                    session_id,
                )
            with _STORE_LOCK:
                current = _SESSIONS.get(session_id)
                current_page = current.pages.get(page_number) if current is session else None
                if current_page is page and page.stage == "refining":
                    page.stage = "mask-review"
                    page.manifest = previous_manifest
                    _sync_legacy_active_page(session, page)
            raise
        finally:
            shutil.rmtree(staging, ignore_errors=True)
            shutil.rmtree(backup, ignore_errors=True)


def confirm_source_session(
    session_id: str,
    page_number: int | None = None,
) -> StickerSheetSession | None:
    """Chốt mask review; chỉ sau bước này export mới được mở khóa."""
    session = get_session(session_id)
    if session is None:
        return None
    page_number = _resolved_page_number(session, page_number)
    page = _get_page_state(session, page_number)
    if page is None:
        return None
    with page.operation_lock:
        with _STORE_LOCK:
            current = _SESSIONS.get(session_id)
            current_page = current.pages.get(page_number) if current is session else None
            if current_page is not page or page.stage not in ("mask-review", "mask-ready"):
                return None
            if page.stage == "mask-ready":
                return session
            manifest = {
                **page.manifest,
                "stage": "mask-ready",
                "mask_confirmed": True,
            }
            _write_json_atomic(page.directory / "manifest.json", manifest)
            page.stage = "mask-ready"
            page.manifest = manifest
            session.last_access = time.monotonic()
            _sync_legacy_active_page(session, page)
            return session


def get_session(session_id: str) -> StickerSheetSession | None:
    if len(session_id) != 32 or any(ch not in "0123456789abcdef" for ch in session_id):
        return None
    sweep_expired()
    with _STORE_LOCK:
        session = _SESSIONS.get(session_id)
    if session is None:
        session = _restore_session_from_disk(session_id)
        if session is None:
            return None
    with _STORE_LOCK:
        current = _SESSIONS.get(session_id)
        if current is not session:
            return current
        session.last_access = time.monotonic()
        return session


def get_page_state(
    session_id: str,
    page_number: int = 1,
) -> StickerSheetPageState | None:
    """Trả snapshot nhẹ của trang; caller phải dùng operation_lock khi đọc artifact."""
    session = get_session(session_id)
    if session is None:
        return None
    return _get_page_state(session, page_number)


def get_asset(
    session_id: str,
    asset: str,
    page_number: int | None = None,
) -> Path | None:
    filename = _PUBLIC_ASSET_FILENAMES.get(asset)
    if filename is None:
        return None
    session = get_session(session_id)
    if session is None:
        return None
    page = _get_page_state(session, _resolved_page_number(session, page_number))
    if page is None:
        return None
    path = page.directory / filename
    return path if path.is_file() else None


def read_versioned_asset(
    session_id: str,
    asset: str,
    revision: int,
    page_number: int | None = None,
) -> bytes | None:
    """Đọc trọn artifact dưới khóa và từ chối URL thuộc revision đã cũ."""
    filename = _PUBLIC_ASSET_FILENAMES.get(asset)
    if filename is None:
        return None
    session = get_session(session_id)
    if session is None:
        return None
    page_number = _resolved_page_number(session, page_number)
    page = _get_page_state(session, page_number)
    if page is None:
        return None
    with page.operation_lock:
        with _STORE_LOCK:
            current = _SESSIONS.get(session_id)
            current_page = current.pages.get(page_number) if current is session else None
            if current_page is not page:
                return None
            current_revision = int(page.manifest.get("mask_revision", 0))
            if current_revision != int(revision):
                raise StickerSheetSessionConflict(
                    "Bản xem trước này đã được thay bằng revision mới hơn."
                )
        path = page.directory / filename
        return path.read_bytes() if path.is_file() else None


def close_session(session_id: str) -> bool:
    session = get_session(session_id)
    if session is None:
        return False
    with session.operation_lock:
        with _STORE_LOCK:
            if _SESSIONS.get(session_id) is not session:
                return False
            _SESSIONS.pop(session_id, None)
        _remove_directory(session.directory)
        return True


def sweep_expired(now: float | None = None) -> int:
    current_time = time.monotonic() if now is None else now
    with _STORE_LOCK:
        candidates = [
            (session_id, session)
            for session_id, session in _SESSIONS.items()
            if current_time - session.last_access > SESSION_TTL_SECONDS
        ]
    removed = 0
    for session_id, session in candidates:
        with session.operation_lock:
            with _STORE_LOCK:
                current = _SESSIONS.get(session_id)
                if (
                    current is not session
                    or current_time - current.last_access <= SESSION_TTL_SECONDS
                ):
                    continue
                _SESSIONS.pop(session_id, None)
            _remove_directory(session.directory)
            removed += 1
    return removed
