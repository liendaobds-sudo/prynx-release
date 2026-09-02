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
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Iterator, Literal, Sequence

from app.config import settings


ArtifactKind = Literal["imposition", "vdp", "edit", "nesting_source"]

# LIFECYCLE (audit 2026-08-25 §REV.11): lease ban đầu đủ cho khoảng từ lúc
# backend công bố output tới lúc frontend commit vào workspace. Sau claim, owner
# được gia hạn lăn bằng heartbeat; tuyệt đối không chặn theo tổng tuổi của tab.
ARTIFACT_INITIAL_LEASE_SECONDS = 2 * 3600
# Heartbeat frontend hiện là 60 giây. Chừa 15 phút để một lượt timer bị throttle,
# máy vừa sleep/resume hoặc backend restart ngắn không làm tab còn mở mất guard.
# Đây vẫn là rolling TTL; tab sống lâu không bị hard-cap tổng tuổi.
ARTIFACT_OWNER_LEASE_SECONDS = 15 * 60
# NEST (audit 2026-08-28 §4B2): source final dùng TTL lăn theo lần
# preview/export/load; 26 giờ vượt cửa sổ cleanup 24 giờ nhưng không giữ vô hạn.
NESTING_SOURCE_FINAL_IDLE_SECONDS = 26 * 3600


_LEASE_MARKER_PREFIX = ".artifact_lease_"
_NESTING_SOURCE_MARKER_PREFIX = ".artifact_lease_nesting_source_"
_LEASE_TOKEN_PATTERN = re.compile(r"^[0-9a-f]{64}$")
_IMPOSITION_PATTERN = re.compile(
    r"^(?:nup|sticker)_[0-9a-f]{8}\.pdf$", re.IGNORECASE
)
_VDP_PATTERN = re.compile(r"^vdp_[0-9a-f]{32}\.pdf$", re.IGNORECASE)
_EDIT_PATTERN = re.compile(r"^.+_[^/\\]+_[0-9a-f]{6}\.pdf$", re.IGNORECASE)
_NESTING_SOURCE_PATTERN = re.compile(
    r"^nesting_source_[0-9a-f]{32}\.pdf$", re.IGNORECASE)
_LEASE_LOCK = threading.RLock()


@dataclass(frozen=True)
class NestingSourceLeaseResolution:
    """Receipt server-only của đúng một locator source đã resolve.

    Receipt không được serialize vào manifest. Nó giữ token/identity marker để
    bước gia hạn sau khi verify nội dung có thể đọc đúng một marker O(1), thay vì
    quét lại toàn bộ thư mục lease.
    """

    token: str
    locator_id: str
    artifact_path: Path
    created_at: float
    phase: Literal["provisional", "final"]


def _path_key(path: str | os.PathLike[str]) -> str:
    """Chuẩn hóa path để so sánh ổn định trên Windows."""
    return os.path.normcase(os.path.abspath(os.fspath(path)))


def _results_root() -> Path:
    return Path(os.path.abspath(os.fspath(settings.RESULTS_DIR)))



def _uploads_root() -> Path:
    return Path(os.path.abspath(os.fspath(settings.UPLOAD_DIR)))


def _artifact_root(kind: str) -> Path:
    return _uploads_root() if kind == "nesting_source" else _results_root()
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


def _valid_locator_id(locator_id: object) -> bool:
    if not isinstance(locator_id, str) or len(locator_id) != 36:
        return False
    try:
        # Locator đi vào manifest/hash nên phải canonical chữ thường tuyệt đối.
        return str(uuid.UUID(locator_id)) == locator_id
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


def _nesting_source_marker_path(locator_id: str) -> Path | None:
    """Marker authoritative của source mới, deterministic theo locator UUID."""

    if not _valid_locator_id(locator_id):
        return None
    return _results_root() / (
        f"{_NESTING_SOURCE_MARKER_PREFIX}{uuid.UUID(locator_id).hex}.json"
    )


def _nesting_source_marker_for_read(
    token: str,
    locator_id: str,
) -> Path | None:
    """Ưu tiên marker locator mới; fallback marker token v1 để tương thích."""

    marker = _nesting_source_marker_path(locator_id)
    if marker is None:
        return None
    try:
        if os.path.lexists(marker):
            return marker
    except OSError:
        # Path deterministic có lỗi phải fail-closed, không rơi về marker legacy.
        return marker
    return _marker_path(token)


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
    if kind == "nesting_source":
        return len(pure.parts) == 1 and bool(
            _NESTING_SOURCE_PATTERN.fullmatch(pure.name)
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

    root = _artifact_root(kind)
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
    root = _artifact_root(kind)
    candidate = Path(os.fspath(artifact_path))
    if not candidate.is_absolute():
        candidate = root / candidate
    candidate = Path(os.path.abspath(os.fspath(candidate)))
    try:
        relative_os = os.path.relpath(candidate, root)
    except ValueError as exc:
        raise ValueError("Artifact nằm ngoài root lease") from exc
    if relative_os == os.pardir or relative_os.startswith(os.pardir + os.sep):
        raise ValueError("Artifact nằm ngoài root lease")
    relative = PurePosixPath(*Path(relative_os).parts).as_posix()
    validated = _artifact_from_relative(kind, relative)
    if validated is None or _path_key(validated) != _path_key(candidate):
        raise ValueError("Artifact không thuộc allowlist lease")
    return relative, validated


def _is_lease_candidate_path(artifact_path: str | os.PathLike[str]) -> bool:
    """Fast-path: chỉ artifact thuộc allowlist mới cần quét marker."""

    candidate = Path(os.path.abspath(os.fspath(artifact_path)))
    for kind in ("imposition", "vdp", "edit", "nesting_source"):
        root = _artifact_root(kind)
        try:
            relative_os = os.path.relpath(candidate, root)
        except ValueError:
            continue
        if relative_os == os.pardir or relative_os.startswith(os.pardir + os.sep):
            continue
        relative = PurePosixPath(*Path(relative_os).parts).as_posix()
        if _relative_matches_kind(kind, relative):
            return True
    return False


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


def _write_marker_no_replace(marker: Path, payload: dict[str, object]) -> None:
    """Công bố marker locator bằng hard-link no-replace xuyên process."""

    marker.parent.mkdir(parents=True, exist_ok=True)
    temporary = marker.with_name(
        f"{marker.name}.{os.getpid()}.{threading.get_ident()}."
        f"{secrets.token_hex(4)}.tmp"
    )
    try:
        with open(temporary, "x", encoding="utf-8") as stream:
            json.dump(payload, stream, ensure_ascii=False, separators=(",", ":"))
            stream.flush()
            os.fsync(stream.fileno())
        try:
            os.link(temporary, marker, follow_symlinks=False)
        except FileExistsError as exc:
            raise ValueError("locator source nesting đã có lease khác") from exc
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
        or not _LEASE_TOKEN_PATTERN.fullmatch(token)
        or kind not in {"imposition", "vdp", "edit", "nesting_source"}
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

    phase = payload.get("phase")
    locator_id = payload.get("locator_id")
    if kind == "nesting_source":
        if (
            fid is not None
            or claimed
            or normalized_owners
            or phase not in {"provisional", "final"}
            or not _valid_locator_id(locator_id)
        ):
            return None
        assert isinstance(locator_id, str)
        if relative != f"nesting_source_{uuid.UUID(locator_id).hex}.pdf":
            return None
        if marker not in {
            _nesting_source_marker_path(locator_id),
            _marker_path(token),
        }:
            return None
    else:
        if phase is not None or locator_id is not None or marker != _marker_path(token):
            return None

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
    if kind == "nesting_source":
        normalized["phase"] = phase
        normalized["locator_id"] = locator_id
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
    locator_id: str | None = None,
    initial_ttl_seconds: float = ARTIFACT_INITIAL_LEASE_SECONDS,
) -> str:
    """Tạo marker v1 atomic; source nesting bắt đầu ở phase provisional."""
    if kind not in {"imposition", "vdp", "edit", "nesting_source"}:
        raise ValueError("Loại artifact lease không hợp lệ")
    if kind == "nesting_source":
        if fid is not None or not _valid_locator_id(locator_id):
            raise ValueError("locator source nesting không hợp lệ")
    elif locator_id is not None:
        raise ValueError("locator_id chỉ dành cho source nesting")
    elif not _valid_fid(fid):
        raise ValueError("fid artifact lease không hợp lệ")
    if not _valid_ttl(initial_ttl_seconds):
        raise ValueError("TTL artifact lease phải lớn hơn 0")

    with _LEASE_LOCK:
        # Validate lại trong lock để cleanup cùng process không thể xóa xen giữa
        # bước kiểm tra artifact và publication marker.
        relative, _artifact = _normalize_artifact(kind, artifact_path)
        token = secrets.token_hex(32)
        marker = (
            _nesting_source_marker_path(locator_id)
            if kind == "nesting_source" and isinstance(locator_id, str)
            else _marker_path(token)
        )
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
        if kind == "nesting_source":
            payload["phase"] = "provisional"
            payload["locator_id"] = locator_id
            # PERF/SEC (audit 2026-09-01 §PERF-NEST-02): marker authoritative
            # deterministic theo locator và publish no-replace xuyên process.
            # Receipt đọc O(1), không quét thư mục nhưng duplicate không thể thắng.
            _write_marker_no_replace(marker, payload)
        else:
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
        if payload.get("kind") == "nesting_source":
            return False
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
        if payload.get("kind") == "nesting_source":
            return False, None, None
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
        if payload.get("kind") == "nesting_source":
            return False
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


def _matches_nesting_source_binding(
    payload: dict[str, object],
    artifact: Path,
    *,
    expected_locator_id: str,
    expected_artifact_path: str | os.PathLike[str],
) -> bool:
    """Bind token server với đúng locator/path source mà caller đang giữ."""

    if not _valid_locator_id(expected_locator_id):
        return False
    try:
        _relative, expected = _normalize_artifact(
            "nesting_source", expected_artifact_path
        )
    except (OSError, TypeError, ValueError):
        return False
    return (
        payload.get("kind") == "nesting_source"
        and payload.get("locator_id") == expected_locator_id
        and _path_key(artifact) == _path_key(expected)
    )


def promote_artifact_lease(
    token: str,
    *,
    expected_locator_id: str,
    expected_artifact_path: str | os.PathLike[str],
    final_ttl_seconds: float = NESTING_SOURCE_FINAL_IDLE_SECONDS,
) -> bool:
    """Chuyển source provisional thành final; gọi lại final là idempotent/renew."""

    marker = _nesting_source_marker_for_read(token, expected_locator_id)
    if marker is None or not _valid_ttl(final_ttl_seconds):
        return False
    with _LEASE_LOCK:
        now = time.time()
        parsed = _read_marker(marker)
        if parsed is None:
            return False
        payload, artifact = parsed
        if (
            payload.get("token") != token
            or not _matches_nesting_source_binding(
                payload,
                artifact,
                expected_locator_id=expected_locator_id,
                expected_artifact_path=expected_artifact_path,
            )
        ):
            return False
        if float(payload["initial_expires_at"]) <= now:
            _unlink_marker(marker)
            return False
        payload["phase"] = "final"
        payload["initial_expires_at"] = now + float(final_ttl_seconds)
        _write_marker_atomic(marker, payload)
        return True


def resolve_nesting_source_leases(
    locator_ids: Sequence[str],
    *,
    require_final: bool = True,
) -> dict[str, NestingSourceLeaseResolution] | None:
    """Resolve locator mới O(1); marker v1 lịch sử fallback đúng một lượt quét.

    Marker deterministic là authority duy nhất cho locator mới. Marker token v1
    chỉ được xét khi locator chưa có authority mới; mọi marker v1 sống cùng
    locator đều được đếm trước khi lọc phase nên duplicate legacy vẫn fail-closed.
    Gia hạn luôn diễn ra sau khi caller verify nội dung.
    """

    try:
        requested = tuple(locator_ids)
    except TypeError:
        return None
    if (
        not isinstance(require_final, bool)
        or any(not _valid_locator_id(locator_id) for locator_id in requested)
        or len(set(requested)) != len(requested)
    ):
        return None
    if not requested:
        return {}
    with _LEASE_LOCK:
        root = _results_root()
        if not root.is_dir():
            return None
        now = time.time()
        matches: dict[str, list[tuple[dict[str, object], Path]]] = {
            locator_id: [] for locator_id in requested
        }
        legacy_requested: set[str] = set()
        for locator_id in requested:
            marker = _nesting_source_marker_path(locator_id)
            assert marker is not None
            try:
                marker_exists = os.path.lexists(marker)
            except OSError:
                return None
            if not marker_exists:
                legacy_requested.add(locator_id)
                continue
            parsed = _read_marker(marker)
            if parsed is None:
                return None
            payload, artifact = parsed
            if (
                payload.get("kind") != "nesting_source"
                or payload.get("locator_id") != locator_id
            ):
                return None
            if float(payload["initial_expires_at"]) <= now:
                _unlink_marker(marker)
                continue
            matches[locator_id].append((payload, artifact))

        if legacy_requested:
            try:
                markers = list(root.glob(f"{_LEASE_MARKER_PREFIX}*.json"))
            except OSError:
                return None
            for marker in markers:
                if marker.name.startswith(_NESTING_SOURCE_MARKER_PREFIX):
                    continue
                parsed = _read_marker(marker)
                if parsed is None:
                    continue
                payload, artifact = parsed
                locator_id = payload.get("locator_id")
                if (
                    payload.get("kind") != "nesting_source"
                    or locator_id not in legacy_requested
                ):
                    continue
                assert isinstance(locator_id, str)
                if float(payload["initial_expires_at"]) <= now:
                    _unlink_marker(marker)
                    continue
                matches[locator_id].append((payload, artifact))

        resolved: dict[str, NestingSourceLeaseResolution] = {}
        for locator_id in requested:
            locator_matches = matches[locator_id]
            if len(locator_matches) != 1:
                return None
            payload, artifact = locator_matches[0]
            phase = payload.get("phase")
            if phase not in {"provisional", "final"}:
                return None
            if require_final and phase != "final":
                return None
            token = payload.get("token")
            created_at = payload.get("created_at")
            if not isinstance(token, str) or not isinstance(created_at, float):
                return None
            resolved[locator_id] = NestingSourceLeaseResolution(
                token=token,
                locator_id=locator_id,
                artifact_path=artifact,
                created_at=created_at,
                phase=phase,
            )
        return resolved


def resolve_nesting_source_lease(
    locator_id: str,
    *,
    require_final: bool = True,
) -> NestingSourceLeaseResolution | None:
    """Giữ helper một locator trên nền batch resolver fail-closed."""

    resolved = resolve_nesting_source_leases(
        (locator_id,),
        require_final=require_final,
    )
    return None if resolved is None else resolved.get(locator_id)


def resolve_nesting_source_lease_token(
    token: str,
    *,
    expected_locator_id: str,
    expected_artifact_path: str | os.PathLike[str],
    require_final: bool,
) -> NestingSourceLeaseResolution | None:
    """Resolve marker source vừa tạo bằng token server-only, O(1)."""

    marker = _nesting_source_marker_for_read(token, expected_locator_id)
    if marker is None or not isinstance(require_final, bool):
        return None
    with _LEASE_LOCK:
        now = time.time()
        parsed = _read_marker(marker)
        if parsed is None:
            return None
        payload, artifact = parsed
        if (
            payload.get("token") != token
            or not _matches_nesting_source_binding(
                payload,
                artifact,
                expected_locator_id=expected_locator_id,
                expected_artifact_path=expected_artifact_path,
            )
        ):
            return None
        if float(payload["initial_expires_at"]) <= now:
            _unlink_marker(marker)
            return None
        phase = payload.get("phase")
        if phase not in {"provisional", "final"}:
            return None
        if require_final and phase != "final":
            return None
        created_at = payload.get("created_at")
        if not isinstance(created_at, float):
            return None
        return NestingSourceLeaseResolution(
            token=token,
            locator_id=expected_locator_id,
            artifact_path=artifact,
            created_at=created_at,
            phase=phase,
        )


def refresh_resolved_nesting_source_lease(
    resolution: NestingSourceLeaseResolution,
    *,
    require_final: bool,
) -> NestingSourceLeaseResolution | None:
    """Đọc lại đúng marker receipt O(1), không gia hạn và không đổi phase."""

    if not isinstance(resolution, NestingSourceLeaseResolution) or not isinstance(
        require_final, bool
    ):
        return None
    refreshed = resolve_nesting_source_lease_token(
        resolution.token,
        expected_locator_id=resolution.locator_id,
        expected_artifact_path=resolution.artifact_path,
        require_final=require_final,
    )
    if refreshed is None or refreshed.created_at != resolution.created_at:
        return None
    return refreshed


def renew_resolved_nesting_source_lease(
    resolution: NestingSourceLeaseResolution,
    *,
    final_ttl_seconds: float = NESTING_SOURCE_FINAL_IDLE_SECONDS,
) -> bool:
    """Gia hạn final receipt sau verify bằng đúng marker token, O(1)."""

    if not isinstance(resolution, NestingSourceLeaseResolution) or not _valid_ttl(
        final_ttl_seconds
    ):
        return False
    marker = _nesting_source_marker_for_read(
        resolution.token,
        resolution.locator_id,
    )
    if marker is None:
        return False
    with _LEASE_LOCK:
        now = time.time()
        parsed = _read_marker(marker)
        if parsed is None:
            return False
        payload, artifact = parsed
        if (
            resolution.phase != "final"
            or payload.get("phase") != "final"
            or payload.get("token") != resolution.token
            or payload.get("created_at") != resolution.created_at
            or not _matches_nesting_source_binding(
                payload,
                artifact,
                expected_locator_id=resolution.locator_id,
                expected_artifact_path=resolution.artifact_path,
            )
        ):
            return False
        if float(payload["initial_expires_at"]) <= now:
            _unlink_marker(marker)
            return False
        payload["initial_expires_at"] = now + float(final_ttl_seconds)
        _write_marker_atomic(marker, payload)
        return True


def resolve_artifact_lease_locator(
    kind: ArtifactKind,
    locator_id: str,
    *,
    require_final: bool = True,
    renew: bool = False,
    final_ttl_seconds: float = NESTING_SOURCE_FINAL_IDLE_SECONDS,
) -> Path | None:
    """Giữ API locator cũ; renew dùng receipt để không quét lần hai."""

    if kind != "nesting_source" or not isinstance(renew, bool):
        return None
    resolution = resolve_nesting_source_lease(
        locator_id,
        require_final=require_final,
    )
    if resolution is None:
        return None
    if renew and not renew_resolved_nesting_source_lease(
        resolution,
        final_ttl_seconds=final_ttl_seconds,
    ):
        return None
    return resolution.artifact_path


def discard_artifact_lease(
    token: str,
    *,
    expected_locator_id: str,
    expected_artifact_path: str | os.PathLike[str],
) -> bool:
    """Thu hồi marker source bằng token server; không nhận path từ client."""

    marker = _nesting_source_marker_for_read(token, expected_locator_id)
    if marker is None:
        return False
    with _LEASE_LOCK:
        parsed = _read_marker(marker)
        if parsed is None:
            return False
        payload, artifact = parsed
        if (
            payload.get("token") != token
            or not _matches_nesting_source_binding(
                payload,
                artifact,
                expected_locator_id=expected_locator_id,
                expected_artifact_path=expected_artifact_path,
            )
            or payload.get("phase") != "provisional"
        ):
            return False
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
