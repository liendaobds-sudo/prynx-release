"""Vòng đời session trên đĩa cho công cụ Tách tem từ ảnh.

Ảnh và mask full-resolution không được giữ trong store RAM sau khi analyze. Store chỉ
giữ metadata nhẹ; artifact nằm dưới RESULTS_DIR và được dọn theo TTL hoặc khi đóng tab.
"""

from __future__ import annotations

from dataclasses import dataclass
import json
import logging
from pathlib import Path
import shutil
import threading
import time
import uuid

import cv2
import numpy as np
from PIL import Image

from app.config import settings
from app.workers.sticker_sheet_engine import StickerSheetAnalysis


logger = logging.getLogger(__name__)

SESSION_TTL_SECONDS = 30 * 60.0
PREVIEW_MAX_EDGE_PX = 2000
SESSION_ROOT = Path(settings.RESULTS_DIR) / "sticker_sheet_sessions"


@dataclass
class StickerSheetSession:
    session_id: str
    directory: Path
    source_path: Path
    original_name: str
    original_width_px: int
    original_height_px: int
    analysis_width_px: int
    analysis_height_px: int
    preview_width_px: int
    preview_height_px: int
    dpi: tuple[float, float] | None
    manifest: dict[str, object]
    last_access: float


_SESSIONS: dict[str, StickerSheetSession] = {}
_STORE_LOCK = threading.RLock()


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
        shutil.copy2(source, session_source)
        np.save(directory / "labels.npy", analysis.labels, allow_pickle=False)
        Image.fromarray(analysis.rgba, "RGBA").save(directory / "rgba.png", format="PNG")
        Image.fromarray(analysis.alpha, "L").save(directory / "alpha.png", format="PNG")
        Image.fromarray(analysis.uncertainty, "L").save(
            directory / "uncertainty.png",
            format="PNG",
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
        preview_rgba.save(directory / "preview.png", format="PNG", optimize=True)
        preview_uncertainty.save(
            directory / "preview_uncertainty.png",
            format="PNG",
            optimize=True,
        )
        _encode_label_rgb(preview_labels).save(
            directory / "preview_labels.png",
            format="PNG",
            optimize=True,
        )

        manifest: dict[str, object] = {
            "session_id": session_id,
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
            original_name=Path(original_name).name,
            original_width_px=int(original_size[0]),
            original_height_px=int(original_size[1]),
            analysis_width_px=analysis.width,
            analysis_height_px=analysis.height,
            preview_width_px=preview_size[0],
            preview_height_px=preview_size[1],
            dpi=dpi,
            manifest=manifest,
            last_access=time.monotonic(),
        )
        with _STORE_LOCK:
            _SESSIONS[session_id] = session
        return session
    except BaseException:
        _remove_directory(directory)
        raise


def get_session(session_id: str) -> StickerSheetSession | None:
    if len(session_id) != 32 or any(ch not in "0123456789abcdef" for ch in session_id):
        return None
    sweep_expired()
    with _STORE_LOCK:
        session = _SESSIONS.get(session_id)
        if session is not None:
            session.last_access = time.monotonic()
        return session


def get_asset(session_id: str, asset: str) -> Path | None:
    filenames = {
        "preview": "preview.png",
        "labels": "preview_labels.png",
        "uncertainty": "preview_uncertainty.png",
    }
    filename = filenames.get(asset)
    if filename is None:
        return None
    session = get_session(session_id)
    if session is None:
        return None
    path = session.directory / filename
    return path if path.is_file() else None


def close_session(session_id: str) -> bool:
    with _STORE_LOCK:
        session = _SESSIONS.pop(session_id, None)
    if session is None:
        return False
    _remove_directory(session.directory)
    return True


def sweep_expired(now: float | None = None) -> int:
    current = time.monotonic() if now is None else now
    with _STORE_LOCK:
        expired = [
            session_id
            for session_id, session in _SESSIONS.items()
            if current - session.last_access > SESSION_TTL_SECONDS
        ]
        sessions = [_SESSIONS.pop(session_id) for session_id in expired]
    for session in sessions:
        _remove_directory(session.directory)
    return len(sessions)
