"""Capability hoàn tất tác vụ đã nhận hợp lệ; không phải license hay quyền Pro.

SEC (audit 2026-09-09 §LICUX.JOB): token chỉ tồn tại ở client và registry của
đúng phiên sidecar. Hết hạn license không làm mất kết quả đang làm, nhưng không
được dùng receipt này để gửi việc mới, truy cập việc khác hay đổi tham số.
"""

from __future__ import annotations

import hashlib
import hmac
import re
import secrets
import threading
import time
from dataclasses import dataclass
from typing import Callable


JOB_ACCESS_HEADER = "X-PrynX-Job-Access"
# Đây là hạn capability bảo mật, không phải giới hạn worker/RAM hoặc tuổi job.
# Không gia hạn khi poll; cleanup artifact hiện hành vẫn là nguồn chân lý riêng.
JOB_ACCESS_MAX_SECONDS = 24 * 60 * 60
_TOKEN_PATTERN = re.compile(r"[0-9a-f]{64}\Z")
_ID_PATTERN = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z")
_wall_seconds = time.time
_monotonic_seconds = time.monotonic
_lock = threading.RLock()


@dataclass(frozen=True)
class JobAccessReceipt:
    token: str
    expires_at: int
    paths: tuple[str, ...]


@dataclass(frozen=True)
class _JobAccessGrant:
    family: str
    job_id: str
    source_ids: tuple[str, ...]
    owner_hash: str
    session_hash: str
    issued_at: float
    expires_at: float
    monotonic_deadline: float


_grants: dict[str, _JobAccessGrant] = {}


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def _expired(grant: _JobAccessGrant, wall: float, mono: float) -> bool:
    return wall < grant.issued_at or wall >= grant.expires_at or mono >= grant.monotonic_deadline


def issue_job_access(
    *,
    family: str,
    job_id: str,
    license_info: dict,
    session_token: str | None,
    source_ids: tuple[str, ...] = (),
) -> JobAccessReceipt | None:
    """Chỉ route submit gọi sau khi enqueue thành công và license đã được kiểm."""
    family_patterns = {
        "compare": _ID_PATTERN,
        "nup": re.compile(r"[0-9a-f]{8}\Z"),
        "vdp": re.compile(r"[0-9a-f]{32}\Z"),
    }
    pattern = family_patterns.get(family)
    if pattern is None or not pattern.fullmatch(job_id):
        raise ValueError("Phạm vi tác vụ chưa hỗ trợ receipt hoàn tất.")
    if family == "compare" and (len(source_ids) != 2 or any(not _ID_PATTERN.fullmatch(value) for value in source_ids)):
        raise ValueError("Receipt Compare phải gắn đúng hai ID file nguồn.")
    if family != "compare" and source_ids:
        raise ValueError("Receipt tác vụ này không cấp quyền đọc file nguồn riêng.")
    license_key = license_info.get("license_key")
    hwid = license_info.get("hwid")
    if (
        license_info.get("verified") is not True
        or not isinstance(license_key, str) or not license_key
        or not isinstance(hwid, str) or not hwid
        or not session_token
    ):
        # Dev chưa xác minh không cần receipt; tuyệt đối không sinh quyền từ
        # DEV_MODE, field body hay context chỉ tự nhận gói Pro.
        return None
    wall, mono = _wall_seconds(), _monotonic_seconds()
    grant = _JobAccessGrant(
        family=family, job_id=job_id, source_ids=source_ids,
        owner_hash=_digest(f"{license_key}:{hwid}"), session_hash=_digest(session_token),
        issued_at=wall, expires_at=wall + JOB_ACCESS_MAX_SECONDS,
        monotonic_deadline=mono + JOB_ACCESS_MAX_SECONDS,
    )
    receipt = JobAccessReceipt(secrets.token_hex(32), int(grant.expires_at), _exact_paths(grant))
    with _lock:
        for key, previous in list(_grants.items()):
            if _expired(previous, wall, mono):
                _grants.pop(key, None)
        _grants[_digest(receipt.token)] = grant
    return receipt


def invalidate_job_access_owner(owner_hash: str) -> None:
    """Thu hồi mọi receipt của owner khi sidecar đã quan sát quyết định từ chối."""
    with _lock:
        for key, grant in list(_grants.items()):
            if hmac.compare_digest(grant.owner_hash, owner_hash):
                _grants.pop(key, None)


def _route_allowed(grant: _JobAccessGrant, method: str, path: str) -> bool:
    if f"{method} {path}" in _exact_paths(grant):
        return True
    if grant.family != "compare":
        return False
    job_path = f"/api/jobs/{grant.job_id}"
    return method == "GET" and re.fullmatch(re.escape(job_path) + r"/page/[1-9][0-9]*", path) is not None


def _exact_paths(grant: _JobAccessGrant) -> tuple[str, ...]:
    """Gợi ý đường dẫn đã neo cho client; backend vẫn kiểm method/scope độc lập."""
    if grant.family == "compare":
        job_path = f"/api/jobs/{grant.job_id}"
        return (
            f"GET {job_path}", f"GET {job_path}/results", f"POST {job_path}/cancel",
            *(f"GET /api/files/{file_id}/serve" for file_id in grant.source_ids),
        )
    if grant.family == "nup":
        return (
            f"GET /api/imposition/nup-status/{grant.job_id}",
            f"GET /api/imposition/nup-download/{grant.job_id}",
            f"POST /api/imposition/nup-cancel/{grant.job_id}",
        )
    if grant.family == "vdp":
        return (
            f"GET /api/vdp/status/{grant.job_id}", f"GET /api/vdp/download/{grant.job_id}",
            f"POST /api/vdp/vdp-cancel/{grant.job_id}", f"POST /api/vdp/cancel/{grant.job_id}",
        )
    return ()


def resolve_job_access(
    *,
    token: str,
    method: str,
    path: str,
    session_token: str | None,
    owner_is_revoked: Callable[[str], bool],
) -> dict:
    """Không chấp nhận query/encoded alias, grant khác phiên hoặc route ngoài job."""
    if not _TOKEN_PATTERN.fullmatch(token) or not session_token:
        raise PermissionError("Receipt hoàn tất tác vụ không hợp lệ.")
    key = _digest(token)
    with _lock:
        grant = _grants.get(key)
        if grant is None:
            raise PermissionError("Receipt hoàn tất tác vụ không còn hiệu lực.")
        if _expired(grant, _wall_seconds(), _monotonic_seconds()):
            _grants.pop(key, None)
            raise PermissionError("Receipt hoàn tất tác vụ đã hết hạn.")
        if not hmac.compare_digest(grant.session_hash, _digest(session_token)):
            raise PermissionError("Receipt thuộc phiên sidecar khác.")
        if owner_is_revoked(grant.owner_hash):
            invalidate_job_access_owner(grant.owner_hash)
            raise PermissionError("Bản quyền đã bị từ chối; receipt tác vụ đã thu hồi.")
        if not _route_allowed(grant, method, path):
            raise PermissionError("Receipt không cấp quyền cho thao tác hoặc tác vụ này.")
        # Không trả verified=True/plan/features/key: không biến capability đọc
        # kết quả thành một context license có thể dùng cho công cụ khác.
        return {"job_access": grant}


def is_job_access_for(context: dict, family: str, job_id: str) -> bool:
    grant = context.get("job_access")
    return isinstance(grant, _JobAccessGrant) and grant.family == family and grant.job_id == job_id
