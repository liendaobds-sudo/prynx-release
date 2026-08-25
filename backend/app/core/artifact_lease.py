"""Lease bền trên đĩa cho Working artifact đang được tab desktop sở hữu.

Marker chỉ lưu đường dẫn tương đối đã qua allowlist. Client chỉ nhận token bí mật,
không được gửi path ngược lại khi claim/renew/release. Mọi lần gia hạn là rolling:
tuổi của tab không bị giới hạn cứng khi heartbeat vẫn còn sống.
"""

from __future__ import annotations

import json
import math
import os
import re
import secrets
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path, PurePosixPath
from typing import Iterator, Literal

from app.config import settings


ArtifactKind = Literal["imposition", "vdp", "edit"]

# LIFECYCLE (audit 2026-08-25 §REV.11): lease ban đầu đủ cho khoảng từ lúc
# backend công bố output tới lúc frontend commit vào workspace. Sau claim, owner
# được gia hạn lăn bằng heartbeat; tuyệt đối không chặn theo tổng tuổi của tab.
ARTIFACT_INITIAL_LEASE_SECONDS = 2 * 3600
# Heartbeat frontend hiện là 60 giây. Chừa 15 phút để một lượt timer bị throttle,
# máy vừa sleep/resume hoặc backend restart ngắn không làm tab còn mở mất guard.
# Đây vẫn là rolling TTL; tab sống lâu không bị hard-cap tổng tuổi.
ARTIFACT_OWNER_LEASE_SECONDS = 15 * 60

_LEASE_MARKER_PREFIX = ".artifact_lease_"
_LEASE_TOKEN_PATTERN = re.compile(r"^[0-9a-f]{64}$")
_IMPOSITION_PATTERN = re.compile(
    r"^(?:nup|sticker)_[0-9a-f]{8}\.pdf$", re.IGNORECASE
)
_VDP_PATTERN = re.compile(r"^vdp_[0-9a-f]{32}\.pdf$", re.IGNORECASE)
_EDIT_PATTERN = re.compile(r"^.+_[^/\\]+_[0-9a-f]{6}\.pdf$", re.IGNORECASE)
_LEASE_LOCK = threading.RLock()


def _path_key(path: str | os.PathLike[str]) -> str:
    """Chuẩn hóa path để so sánh ổn định trên Windows."""
    return os.path.normcase(os.path.abspath(os.fspath(path)))


def _results_root() -> Path:
    return Path(os.path.abspath(os.fspath(settings.RESULTS_DIR)))


def _valid_owner_id(owner_id: object) -> bool:
    return bool(
        isinstance(owner_id, str)
        and owner_id
        and owner_id == owner_id.strip()
        and len(owner_id) <= 128
        and not any(ord(char) < 32 for char in owner_id)
    )


def _valid_fid(fid: object) -> bool:
    if fid is None:
        return True
    if not isinstance(fid, str) or len(fid) != 36:
        return False
    try:
        return str(uuid.UUID(fid)) == fid.lower()
    except (ValueError, AttributeError):
        return False


def _valid_timestamp(value: object) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(float(value))
    )


def _valid_ttl(value: float) -> bool:
    return _valid_timestamp(value) and float(value) > 0


def _marker_path(token: str) -> Path | None:
    if not isinstance(token, str) or not _LEASE_TOKEN_PATTERN.fullmatch(token):
        return None
    return _results_root() / f"{_LEASE_MARKER_PREFIX}{token}.json"


def _relative_matches_kind(kind: str, relative_path: str) -> bool:
    if "\\" in relative_path or "\x00" in relative_path:
        return False
    pure = PurePosixPath(relative_path)
    if pure.is_absolute() or any(part in {"", ".", ".."} for part in pure.parts):
        return False
    if pure.as_posix() != relative_path:
        return False
    if kind == "imposition":
        return len(pure.parts) == 1 and bool(_IMPOSITION_PATTERN.fullmatch(pure.name))
    if kind == "vdp":
        return len(pure.parts) == 1 and bool(_VDP_PATTERN.fullmatch(pure.name))
    if kind == "edit":
        return (
            len(pure.parts) == 2
            and pure.parts[0] == "edit_output"
            and bool(_EDIT_PATTERN.fullmatch(pure.name))
        )
    return False


def _artifact_from_relative(
    kind: str,
    relative_path: object,
    *,
    require_file: bool = True,
) -> Path | None:
    if not isinstance(relative_path, str) or not _relative_matches_kind(kind, relative_path):
        return None

    root = _results_root()
    pure = PurePosixPath(relative_path)
    current = root
    for part in pure.parts:
        current = current / part
        # Không cho marker hợp lệ trỏ qua symlink, kể cả symlink ở thư mục cha.
        try:
            if current.is_symlink():
                return None
        except OSError:
            return None

    if require_file:
        try:
            if not current.is_file():
                return None
        except OSError:
            return None
    return current


def _normalize_artifact(kind: str, artifact_path: str | os.PathLike[str]) -> tuple[str, Path]:
    root = _results_root()
    candidate = Path(os.fspath(artifact_path))
    if not candidate.is_absolute():
        candidate = root / candidate
    candidate = Path(os.path.abspath(os.fspath(candidate)))
    try:
        relative_os = os.path.relpath(candidate, root)
    except ValueError as exc:
        raise ValueError("Artifact nằm ngoài RESULTS_DIR") from exc
    if relative_os == os.pardir or relative_os.startswith(os.pardir + os.sep):
        raise ValueError("Artifact nằm ngoài RESULTS_DIR")
    relative = PurePosixPath(*Path(relative_os).parts).as_posix()
    validated = _artifact_from_relative(kind, relative)
    if validated is None or _path_key(validated) != _path_key(candidate):
        raise ValueError("Artifact không thuộc allowlist lease")
    return relative, validated


def _is_lease_candidate_path(artifact_path: str | os.PathLike[str]) -> bool:
    """Fast-path: chỉ artifact thuộc ba allowlist mới cần quét marker."""
    root = _results_root()
    candidate = Path(os.path.abspath(os.fspath(artifact_path)))
    try:
        relative_os = os.path.relpath(candidate, root)
    except ValueError:
        return False
    if relative_os == os.pardir or relative_os.startswith(os.pardir + os.sep):
        return False
    relative = PurePosixPath(*Path(relative_os).parts).as_posix()
    return any(
        _relative_matches_kind(kind, relative)
        for kind in ("imposition", "vdp", "edit")
    )


def _write_marker_atomic(marker: Path, payload: dict[str, object]) -> None:
    marker.parent.mkdir(parents=True, exist_ok=True)
    temporary = marker.with_name(
        f"{marker.name}.{os.getpid()}.{threading.get_ident()}.{secrets.token_hex(4)}.tmp"
    )
    try:
        with open(temporary, "x", encoding="utf-8") as stream:
            json.dump(payload, stream, ensure_ascii=False, separators=(",", ":"))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, marker)
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass


def _read_marker(marker: Path) -> tuple[dict[str, object], Path] | None:
    try:
        if marker.is_symlink() or not marker.is_file():
            return None
        payload = json.loads(marker.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return None
    if not isinstance(payload, dict) or payload.get("v") != 1:
        return None

    token = payload.get("token")
    kind = payload.get("kind")
    relative = payload.get("artifact")
    created_at = payload.get("created_at")
    initial_expires_at = payload.get("initial_expires_at")
    claimed = payload.get("claimed")
    owners = payload.get("owners")
    fid = payload.get("fid")
    if (
        not isinstance(token, str)
        or marker != _marker_path(token)
        or kind not in {"imposition", "vdp", "edit"}
        or not _valid_timestamp(created_at)
        or not _valid_timestamp(initial_expires_at)
        or not isinstance(claimed, bool)
        or not isinstance(owners, dict)
        or not _valid_fid(fid)
    ):
        return None

    normalized_owners: dict[str, float] = {}
    for owner_id, expires_at in owners.items():
        if not _valid_owner_id(owner_id) or not _valid_timestamp(expires_at):
            return None
        normalized_owners[owner_id] = float(expires_at)

    artifact = _artifact_from_relative(kind, relative)
    if artifact is None:
        return None
    normalized: dict[str, object] = {
        "v": 1,
        "token": token,
        "kind": kind,
        "artifact": relative,
        "created_at": float(created_at),
        "initial_expires_at": float(initial_expires_at),
        "claimed": claimed,
        "owners": normalized_owners,
    }
    if fid is not None:
        normalized["fid"] = fid
    return normalized, artifact


def _prune_owners(payload: dict[str, object], now: float) -> bool:
    owners = payload["owners"]
    assert isinstance(owners, dict)
    live = {
        owner_id: float(expires_at)
        for owner_id, expires_at in owners.items()
        if float(expires_at) > now
    }
    changed = live != owners
    payload["owners"] = live
    return changed


def _payload_is_protected(payload: dict[str, object], now: float) -> bool:
    owners = payload["owners"]
    assert isinstance(owners, dict)
    if owners:
        return True
    return not bool(payload["claimed"]) and float(payload["initial_expires_at"]) > now


def _unlink_marker(marker: Path) -> None:
    try:
        marker.unlink(missing_ok=True)
    except OSError:
        pass


def _protected_path_keys_locked(now: float) -> set[str]:
    root = _results_root()
    if not root.is_dir():
        return set()
    try:
        markers = list(root.glob(f"{_LEASE_MARKER_PREFIX}*.json"))
    except OSError:
        return set()

    protected: set[str] = set()
    for marker in markers:
        parsed = _read_marker(marker)
        if parsed is None:
            continue
        payload, artifact = parsed
        changed = _prune_owners(payload, now)
        if not _payload_is_protected(payload, now):
            _unlink_marker(marker)
            continue
        if changed:
            _write_marker_atomic(marker, payload)
        protected.add(_path_key(marker))
        protected.add(_path_key(artifact))
    return protected


def create_artifact_lease(
    kind: ArtifactKind,
    artifact_path: str | os.PathLike[str],
    *,
    fid: str | None = None,
    initial_ttl_seconds: float = ARTIFACT_INITIAL_LEASE_SECONDS,
) -> str:
    """Tạo marker v1 atomic cho artifact vừa được backend công bố."""
    if kind not in {"imposition", "vdp", "edit"}:
        raise ValueError("Loại artifact lease không hợp lệ")
    if not _valid_fid(fid):
        raise ValueError("fid artifact lease không hợp lệ")
    if not _valid_ttl(initial_ttl_seconds):
        raise ValueError("TTL artifact lease phải lớn hơn 0")

    with _LEASE_LOCK:
        # Validate lại trong lock để cleanup cùng process không thể xóa xen giữa
        # bước kiểm tra artifact và publication marker.
        relative, _artifact = _normalize_artifact(kind, artifact_path)
        token = secrets.token_hex(32)
        marker = _marker_path(token)
        if marker is None:
            raise RuntimeError("Không tạo được token artifact lease")
        now = time.time()
        payload: dict[str, object] = {
            "v": 1,
            "token": token,
            "kind": kind,
            "artifact": relative,
            "created_at": now,
            "initial_expires_at": now + float(initial_ttl_seconds),
            "claimed": False,
            "owners": {},
        }
        if fid is not None:
            payload["fid"] = fid
        _write_marker_atomic(marker, payload)
        return token


def claim_artifact_lease(
    token: str,
    owner_id: str,
    *,
    owner_ttl_seconds: float = ARTIFACT_OWNER_LEASE_SECONDS,
) -> bool:
    """Claim owner mới; token đã claim chỉ nhận thêm owner khi còn owner sống."""
    marker = _marker_path(token)
    if marker is None or not _valid_owner_id(owner_id) or not _valid_ttl(owner_ttl_seconds):
        return False
    with _LEASE_LOCK:
        now = time.time()
        parsed = _read_marker(marker)
        if parsed is None:
            return False
        payload, _artifact = parsed
        owners_before_prune = payload["owners"]
        assert isinstance(owners_before_prune, dict)
        owner_was_known = owner_id in owners_before_prune
        _prune_owners(payload, now)
        owners = payload["owners"]
        assert isinstance(owners, dict)
        # LIFECYCLE (audit 2026-08-25 §REV.11): sau Windows sleep, timer WebView
        # có thể trễ quá TTL dù cả app/sidecar cùng bị suspend. Nếu marker chưa bị
        # cleanup, đúng owner cũ được reclaim; owner lạ vẫn không chiếm token chết.
        if bool(payload["claimed"]) and not owner_was_known and not owners:
            # Owner lạ không được làm mất cơ hội reclaim của owner cũ sau sleep.
            # Cleanup nền là nơi duy nhất thu hồi marker đã thật sự hết hạn.
            return False
        if not bool(payload["claimed"]) and float(payload["initial_expires_at"]) <= now:
            _unlink_marker(marker)
            return False
        payload["claimed"] = True
        owners[owner_id] = now + float(owner_ttl_seconds)
        _write_marker_atomic(marker, payload)
        return True


def renew_artifact_lease_with_metadata(
    token: str,
    owner_id: str,
    *,
    owner_ttl_seconds: float = ARTIFACT_OWNER_LEASE_SECONDS,
) -> tuple[bool, str | None, str | None]:
    """Gia hạn rolling và trả fid/path Edit trong cùng critical section.

    Metadata chỉ được trả khi marker Edit hợp lệ và owner hiện tại gia hạn thành
    công; caller dùng cặp fid/path để không kéo TTL nhầm bản ghi DB khác artifact.
    """
    marker = _marker_path(token)
    if marker is None or not _valid_owner_id(owner_id) or not _valid_ttl(owner_ttl_seconds):
        return False, None, None
    with _LEASE_LOCK:
        now = time.time()
        parsed = _read_marker(marker)
        if parsed is None:
            return False, None, None
        payload, artifact = parsed
        owners_before_prune = payload["owners"]
        assert isinstance(owners_before_prune, dict)
        owner_was_known = owner_id in owners_before_prune
        _prune_owners(payload, now)
        owners = payload["owners"]
        assert isinstance(owners, dict)
        if not bool(payload["claimed"]) or not owner_was_known:
            return False, None, None
        owners[owner_id] = now + float(owner_ttl_seconds)
        _write_marker_atomic(marker, payload)
        fid = payload.get("fid") if payload.get("kind") == "edit" else None
        artifact_path = (
            os.path.abspath(os.fspath(artifact))
            if payload.get("kind") == "edit"
            else None
        )
        return True, fid if isinstance(fid, str) else None, artifact_path


def renew_artifact_lease_with_fid(
    token: str,
    owner_id: str,
    *,
    owner_ttl_seconds: float = ARTIFACT_OWNER_LEASE_SECONDS,
) -> tuple[bool, str | None]:
    """Giữ contract cũ cho caller chỉ cần fid Edit."""
    renewed, fid, _artifact_path = renew_artifact_lease_with_metadata(
        token,
        owner_id,
        owner_ttl_seconds=owner_ttl_seconds,
    )
    return renewed, fid


def renew_artifact_lease(
    token: str,
    owner_id: str,
    *,
    owner_ttl_seconds: float = ARTIFACT_OWNER_LEASE_SECONDS,
) -> bool:
    """Gia hạn rolling, giữ contract bool cho caller không cần metadata Edit."""
    renewed, _fid, _artifact_path = renew_artifact_lease_with_metadata(
        token,
        owner_id,
        owner_ttl_seconds=owner_ttl_seconds,
    )
    return renewed


def release_artifact_lease(token: str, owner_id: str) -> bool:
    """Release idempotent; owner cuối rời đi làm marker ngừng bảo vệ artifact."""
    marker = _marker_path(token)
    if marker is None or not _valid_owner_id(owner_id):
        return False
    with _LEASE_LOCK:
        now = time.time()
        parsed = _read_marker(marker)
        if parsed is None:
            # Token đúng định dạng nhưng marker đã được release/sweep: vẫn thành công.
            return True
        payload, _artifact = parsed
        owners_before_prune = payload["owners"]
        assert isinstance(owners_before_prune, dict)
        if bool(payload["claimed"]) and owner_id not in owners_before_prune:
            # Release idempotent của owner lạ/stale không được thu hồi owner khác.
            return True
        _prune_owners(payload, now)
        owners = payload["owners"]
        assert isinstance(owners, dict)
        owners.pop(owner_id, None)
        if bool(payload["claimed"]) and owners:
            _write_marker_atomic(marker, payload)
        else:
            # Release trước claim cũng thu hồi initial lease (ca commit thất bại).
            _unlink_marker(marker)
        return True


def collect_artifact_lease_protected_path_keys(now: float | None = None) -> set[str]:
    """Đọc marker sau restart và trả path đang được initial/owner sống bảo vệ."""
    observed_at = time.time() if now is None else float(now)
    with _LEASE_LOCK:
        return _protected_path_keys_locked(observed_at)


def is_artifact_path_protected(
    artifact_path: str | os.PathLike[str],
    *,
    now: float | None = None,
) -> bool:
    if not _is_lease_candidate_path(artifact_path):
        return False
    key = _path_key(artifact_path)
    observed_at = time.time() if now is None else float(now)
    with _LEASE_LOCK:
        return key in _protected_path_keys_locked(observed_at)


@contextmanager
def artifact_delete_guard(
    artifact_path: str | os.PathLike[str],
) -> Iterator[bool]:
    """Giữ lock qua lần recheck sát `unlink` để claim không chen vào cùng process."""
    if not _is_lease_candidate_path(artifact_path):
        yield True
        return
    key = _path_key(artifact_path)
    with _LEASE_LOCK:
        yield key not in _protected_path_keys_locked(time.time())
