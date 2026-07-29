"""Tải và kiểm tra model AI theo cách atomic, dùng chung cho các worker."""

from __future__ import annotations

import hashlib
import logging
import os
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

import httpx

logger = logging.getLogger(__name__)


def sha256_file(path: str | os.PathLike[str]) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _is_valid(path: Path, expected_sha256: str) -> bool:
    return path.is_file() and sha256_file(path) == expected_sha256.lower()


@contextmanager
def _interprocess_lock(lock_path: Path) -> Iterator[None]:
    """Khoá một byte để hai sidecar không cùng ghi model."""
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with open(lock_path, "a+b") as lock_file:
        if lock_file.tell() == 0:
            lock_file.write(b"0")
            lock_file.flush()
        lock_file.seek(0)
        if os.name == "nt":
            import msvcrt

            msvcrt.locking(lock_file.fileno(), msvcrt.LK_LOCK, 1)
            try:
                yield
            finally:
                lock_file.seek(0)
                msvcrt.locking(lock_file.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


def ensure_model(
    *,
    filename: str,
    url: str,
    expected_sha256: str,
    cache_dir: str,
    bundled_dir: str | None = None,
) -> str:
    """Trả đường dẫn model hợp lệ; tải vào `.part` rồi đổi tên atomic nếu thiếu."""
    if bundled_dir:
        bundled = Path(bundled_dir) / filename
        if _is_valid(bundled, expected_sha256):
            return str(bundled)
        if bundled.exists():
            logger.error("Model bundle sai SHA-256: %s", bundled)

    target = Path(cache_dir) / filename
    target.parent.mkdir(parents=True, exist_ok=True)
    if _is_valid(target, expected_sha256):
        return str(target)

    with _interprocess_lock(target.with_suffix(target.suffix + ".lock")):
        if _is_valid(target, expected_sha256):
            return str(target)
        if target.exists():
            logger.warning("Xoá model cache không hợp lệ trước khi tải lại: %s", target)
            target.unlink()

        part = target.with_name(f"{target.name}.{os.getpid()}.part")
        try:
            digest = hashlib.sha256()
            with httpx.stream("GET", url, follow_redirects=True, timeout=60.0) as response:
                response.raise_for_status()
                with open(part, "wb") as output:
                    for chunk in response.iter_bytes(chunk_size=1024 * 1024):
                        output.write(chunk)
                        digest.update(chunk)
                    output.flush()
                    os.fsync(output.fileno())
            actual = digest.hexdigest()
            if actual != expected_sha256.lower():
                raise RuntimeError(
                    f"Model {filename} sai SHA-256: nhận {actual}, cần {expected_sha256.lower()}"
                )
            os.replace(part, target)
            return str(target)
        finally:
            try:
                part.unlink()
            except FileNotFoundError:
                pass
