"""Fast, disposable viewer previews rendered by Ghostscript.

The native PDFium renderer remains the source of the final, sharp viewer image.
This module only creates a small JPEG sidecar so image-heavy imposed PDFs do not
leave the main canvas and thumbnail rail blank while PDFium decodes full-size
CMYK images.
"""
from __future__ import annotations

import hashlib
import logging
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path

from app.config import settings
from app.utils.subprocess_utils import run_hidden


logger = logging.getLogger(__name__)

PREVIEW_VERSION = "gs-viewer-v4-32q92"
MAIN_DPI = 96
MAIN_QUALITY = 92
THUMB_DPI = 32
THUMB_QUALITY = 92
MAX_THUMB_PAGES = 5000

_CACHE_ROOT = Path(tempfile.gettempdir()) / "prynx_viewer_preview_v1"
_CACHE_ROOT.mkdir(parents=True, exist_ok=True)
_KEY_RE = re.compile(r"^[0-9a-f]{32}$")
_locks_guard = threading.Lock()
_locks: dict[str, threading.Lock] = {}
_prune_guard = threading.Lock()
_writes_since_prune = 0

# GS preview chạy below-normal priority để nhường CPU cho renderer PDFium chính
# (tránh giật main view khi cuộn thumbnail). Đã thử bỏ (đặt 0) nhưng đo thực tế
# cho thấy KHÔNG nhanh hơn — nút thắt ~7s/block là thời gian GS parse+decode file
# lớn, không phải bị nhường CPU. Giữ below-normal vì vô hại về tốc độ mà tránh
# giật main view. run_hidden vẫn thêm CREATE_NO_WINDOW → release không nháy console.
_BELOW_NORMAL_PRIORITY_CLASS = 0x00004000 if os.name == "nt" else 0


class ViewerPreviewError(RuntimeError):
    """A recoverable preview failure; the frontend must fall back to PDFium."""


@dataclass(frozen=True)
class PreviewResult:
    path: Path
    cache_key: str
    cache_hit: bool
    render_ms: int


@dataclass(frozen=True)
class ThumbnailBatchResult:
    cache_key: str
    pages: int
    start_page: int
    end_page: int
    cache_hit: bool
    render_ms: int


def file_cache_key(pdf_path: str) -> str:
    """Return a cheap revision key without hashing a potentially huge PDF."""
    resolved = os.path.normcase(os.path.abspath(pdf_path))
    stat = os.stat(resolved)
    raw = f"{PREVIEW_VERSION}\0{resolved}\0{stat.st_size}\0{stat.st_mtime_ns}"
    return hashlib.sha256(raw.encode("utf-8", errors="surrogatepass")).hexdigest()[:32]


def _cache_dir(cache_key: str) -> Path:
    if not _KEY_RE.fullmatch(cache_key):
        raise ViewerPreviewError("Invalid viewer preview cache key")
    return _CACHE_ROOT / cache_key


def _lock_for(name: str) -> threading.Lock:
    with _locks_guard:
        lock = _locks.get(name)
        if lock is None:
            lock = threading.Lock()
            _locks[name] = lock
        return lock


def _drop_locks_for(cache_key: str) -> None:
    """Xoá các lock của một cache_key khi thư mục cache bị prune.

    `_locks` tạo 1 Lock mỗi (main|thumbs):{cache_key}:... và GIỮ MÃI → dict tăng
    đơn điệu theo file×page×dpi đã xem. Prune đĩa không đụng dict này. Khi cache
    dir của cache_key bị xoá thì mọi lock mang key đó cũng vô dụng → dọn luôn.
    """
    needle = f":{cache_key}:"
    with _locks_guard:
        for name in [n for n in _locks if needle in n]:
            _locks.pop(name, None)


def _ghostscript_path() -> str:
    path = str(getattr(settings, "GHOSTSCRIPT_PATH", "") or "")
    if not path or not os.path.isfile(path):
        raise ViewerPreviewError("Ghostscript is not available")
    return path


def _valid_image(path: Path) -> bool:
    try:
        return path.is_file() and path.stat().st_size > 0
    except OSError:
        return False


def _run_ghostscript(cmd: list[str], timeout: int) -> None:
    kwargs: dict = {
        "stdout": subprocess.PIPE,
        "stderr": subprocess.PIPE,
        "timeout": timeout,
    }
    if _BELOW_NORMAL_PRIORITY_CLASS:
        kwargs["creationflags"] = _BELOW_NORMAL_PRIORITY_CLASS
    try:
        result = run_hidden(cmd, **kwargs)
    except (OSError, subprocess.SubprocessError) as exc:
        raise ViewerPreviewError(f"Ghostscript preview failed: {exc}") from exc
    if result.returncode != 0:
        detail = (result.stderr or b"").decode("utf-8", errors="replace").strip()
        if len(detail) > 600:
            detail = detail[-600:]
        raise ViewerPreviewError(
            f"Ghostscript preview exited with code {result.returncode}"
            + (f": {detail}" if detail else "")
        )


def render_page_preview(pdf_path: str, page: int, dpi: int = MAIN_DPI) -> PreviewResult:
    """Render/cache one page for the main canvas's transient preview layer."""
    page = int(page)
    dpi = max(48, min(144, int(dpi)))
    if page < 1:
        raise ViewerPreviewError("Page must be 1 or greater")

    cache_key = file_cache_key(pdf_path)
    cache_dir = _cache_dir(cache_key)
    output = cache_dir / f"main_p{page:06d}_d{dpi:03d}.jpg"
    if _valid_image(output):
        return PreviewResult(output, cache_key, True, 0)

    lock = _lock_for(f"main:{cache_key}:{page}:{dpi}")
    with lock:
        if _valid_image(output):
            return PreviewResult(output, cache_key, True, 0)
        cache_dir.mkdir(parents=True, exist_ok=True)
        fd, tmp_name = tempfile.mkstemp(prefix="main_", suffix=".jpg", dir=cache_dir)
        os.close(fd)
        tmp_path = Path(tmp_name)
        try:
            started = time.perf_counter()
            cmd = [
                _ghostscript_path(),
                "-dSAFER", "-dBATCH", "-dNOPAUSE", "-dQUIET",
                "-dAutoRotatePages=/None", "-dUseCropBox",
                "-dTextAlphaBits=4", "-dGraphicsAlphaBits=4",
                "-sDEVICE=jpeg", f"-r{dpi}", f"-dJPEGQ={MAIN_QUALITY}",
                f"-dFirstPage={page}", f"-dLastPage={page}",
                f"-sOutputFile={tmp_path}", pdf_path,
            ]
            _run_ghostscript(cmd, timeout=180)
            if not _valid_image(tmp_path):
                raise ViewerPreviewError("Ghostscript did not create a page preview")
            os.replace(tmp_path, output)
            render_ms = round((time.perf_counter() - started) * 1000)
            _note_cache_write()
            return PreviewResult(output, cache_key, False, render_ms)
        finally:
            try:
                tmp_path.unlink(missing_ok=True)
            except OSError:
                pass


def prepare_thumbnail_batch(
    pdf_path: str,
    page_count: int,
    start_page: int = 1,
    batch_size: int = 8,
) -> ThumbnailBatchResult:
    """Render one lazy thumbnail block in a single Ghostscript process."""
    page_count = int(page_count)
    if page_count < 1 or page_count > MAX_THUMB_PAGES:
        raise ViewerPreviewError(f"Page count must be between 1 and {MAX_THUMB_PAGES}")
    start_page = max(1, min(int(start_page), page_count))
    batch_size = max(1, min(32, int(batch_size)))
    end_page = min(page_count, start_page + batch_size - 1)

    cache_key = file_cache_key(pdf_path)
    cache_dir = _cache_dir(cache_key)

    def final_path(page: int) -> Path:
        return cache_dir / f"thumb_p{page:06d}_d{THUMB_DPI:03d}_q{THUMB_QUALITY:03d}.jpg"

    if all(_valid_image(final_path(page)) for page in range(start_page, end_page + 1)):
        return ThumbnailBatchResult(cache_key, page_count, start_page, end_page, True, 0)

    lock = _lock_for(f"thumbs:{cache_key}:{start_page}:{end_page}")
    with lock:
        if all(_valid_image(final_path(page)) for page in range(start_page, end_page + 1)):
            return ThumbnailBatchResult(cache_key, page_count, start_page, end_page, True, 0)

        cache_dir.mkdir(parents=True, exist_ok=True)
        stage_dir = Path(tempfile.mkdtemp(prefix="thumbs_", dir=cache_dir))
        try:
            pattern = stage_dir / "thumb_%06d.jpg"
            started = time.perf_counter()
            cmd = [
                _ghostscript_path(),
                "-dSAFER", "-dBATCH", "-dNOPAUSE", "-dQUIET",
                "-dAutoRotatePages=/None", "-dUseCropBox",
                "-dTextAlphaBits=4", "-dGraphicsAlphaBits=4",
                "-sDEVICE=jpeg", f"-r{THUMB_DPI}", f"-dJPEGQ={THUMB_QUALITY}",
                f"-dFirstPage={start_page}", f"-dLastPage={end_page}",
                f"-sOutputFile={pattern}", pdf_path,
            ]
            expected = end_page - start_page + 1
            timeout = min(300, max(120, expected * 8))
            _run_ghostscript(cmd, timeout=timeout)

            rendered = sorted(stage_dir.glob("thumb_*.jpg"))
            if len(rendered) != expected or any(not _valid_image(path) for path in rendered):
                raise ViewerPreviewError(
                    f"Ghostscript created {len(rendered)} of {expected} thumbnails"
                )
            for page, staged in enumerate(rendered, start=start_page):
                os.replace(staged, final_path(page))
            render_ms = round((time.perf_counter() - started) * 1000)
            _note_cache_write()
            return ThumbnailBatchResult(
                cache_key, page_count, start_page, end_page, False, render_ms
            )
        finally:
            shutil.rmtree(stage_dir, ignore_errors=True)

def thumbnail_path(cache_key: str, page: int) -> Path:
    page = int(page)
    if page < 1 or page > MAX_THUMB_PAGES:
        raise ViewerPreviewError("Invalid thumbnail page")
    path = _cache_dir(cache_key) / f"thumb_p{page:06d}_d{THUMB_DPI:03d}_q{THUMB_QUALITY:03d}.jpg"
    if not _valid_image(path):
        raise ViewerPreviewError("Thumbnail is not cached")
    return path


def _note_cache_write() -> None:
    """Occasionally prune stale sidecars without adding work to every request."""
    global _writes_since_prune
    with _prune_guard:
        _writes_since_prune += 1
        if _writes_since_prune < 32:
            return
        _writes_since_prune = 0
    _prune_cache_best_effort()


def _prune_cache_best_effort(max_bytes: int = 512 * 1024 * 1024, max_age_days: int = 7) -> None:
    try:
        now = time.time()
        entries: list[tuple[float, int, Path]] = []
        total = 0
        for child in _CACHE_ROOT.iterdir():
            if not child.is_dir() or not _KEY_RE.fullmatch(child.name):
                continue
            files = [path for path in child.rglob("*") if path.is_file()]
            size = sum(path.stat().st_size for path in files)
            newest = max((path.stat().st_mtime for path in files), default=child.stat().st_mtime)
            if now - newest > max_age_days * 86400:
                shutil.rmtree(child, ignore_errors=True)
                _drop_locks_for(child.name)
                continue
            total += size
            entries.append((newest, size, child))
        if total > max_bytes:
            for _mtime, size, child in sorted(entries):
                shutil.rmtree(child, ignore_errors=True)
                _drop_locks_for(child.name)
                total -= size
                if total <= max_bytes:
                    break
    except OSError:
        logger.debug("Could not prune viewer preview cache", exc_info=True)
