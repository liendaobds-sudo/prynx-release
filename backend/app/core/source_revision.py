"""Fingerprint nhẹ để chặn job đọc nhầm revision của file nguồn theo đường dẫn."""

from __future__ import annotations

import os
from dataclasses import dataclass


SOURCE_REVISION_CHANGED_MESSAGE = (
    "File nguồn đã thay đổi trong khi tác vụ đang chờ hoặc đang xử lý. "
    "Kết quả chưa được công bố; hãy chạy lại trên file hiện tại."
)


class SourceRevisionChangedError(RuntimeError):
    """File tại đường dẫn đã không còn đúng revision lúc nhận request."""


@dataclass(frozen=True, slots=True)
class SourceFingerprint:
    normalized_path: str
    size: int
    mtime_ns: int
    device: int | None
    inode: int | None


def _normalized_source_path(path: str | os.PathLike[str]) -> str:
    """Chuẩn hóa alias đường dẫn nhưng không đọc/hash toàn bộ file."""
    return os.path.normcase(
        os.path.normpath(os.path.realpath(os.path.abspath(os.fspath(path))))
    )


def _optional_stat_identity(stat_result: os.stat_result, name: str) -> int | None:
    value = getattr(stat_result, name, None)
    return int(value) if value is not None else None


def _fingerprint_from_stat(
    path: str | os.PathLike[str],
    stat_result: os.stat_result,
) -> SourceFingerprint:
    return SourceFingerprint(
        normalized_path=_normalized_source_path(path),
        size=int(stat_result.st_size),
        mtime_ns=int(stat_result.st_mtime_ns),
        device=_optional_stat_identity(stat_result, "st_dev"),
        inode=_optional_stat_identity(stat_result, "st_ino"),
    )


def capture_source_fingerprint(path: str | os.PathLike[str]) -> SourceFingerprint:
    """Chụp identity/metadata nguồn bằng một lần ``stat`` nhẹ."""
    normalized_path = _normalized_source_path(path)
    return _fingerprint_from_stat(normalized_path, os.stat(normalized_path))


def assert_source_fingerprint_stat(
    expected: SourceFingerprint,
    path: str | os.PathLike[str],
    stat_result: os.stat_result,
) -> None:
    """So revision với đúng file descriptor caller vừa mở."""

    if not isinstance(expected, SourceFingerprint):
        raise TypeError("expected phải là SourceFingerprint.")
    if _fingerprint_from_stat(path, stat_result) != expected:
        raise SourceRevisionChangedError(SOURCE_REVISION_CHANGED_MESSAGE)


def assert_source_fingerprint(expected: SourceFingerprint) -> None:
    """Fail-closed nếu đường dẫn không còn trỏ tới đúng revision đã chụp."""
    try:
        current = capture_source_fingerprint(expected.normalized_path)
    except OSError as exc:
        raise SourceRevisionChangedError(SOURCE_REVISION_CHANGED_MESSAGE) from exc
    if current != expected:
        raise SourceRevisionChangedError(SOURCE_REVISION_CHANGED_MESSAGE)
