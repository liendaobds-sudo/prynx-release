"""Bằng chứng server-owned nối inspect PDF với lần xuất máy bế kế tiếp.

Proof chỉ là một handle opaque kích thước cố định. ``CutModel`` và binding nguồn
nằm hoàn toàn trong RAM của đúng thế hệ sidecar; process restart tự làm mọi proof
cũ mất hiệu lực, kể cả supervisor dùng lại sidecar token. Mỗi handle chỉ được lấy
ra một lần bằng thao tác nguyên tử trước khi băm lại source.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import hmac
import math
import os
import secrets
import threading
import time
from typing import Mapping, Optional

from app.core.system_memory import read_memory_status_mb
from app.workers.cut_export.cut_model import CutModel
from app.workers.cut_export.pdf_source import _hash_open_stream, _stat_revision


PROOF_TTL_SECONDS = 300
_PROOF_CLOCK_SKEW_SECONDS = 5
_PROOF_VERSION = "v2"
_PROOF_PURPOSE = b"prynx-cut-inspect-proof:v2:"
_HANDLE_ID_HEX_LENGTH = 32
_HANDLE_SIGNATURE_HEX_LENGTH = 64
_MIB = 1024 * 1024
_ESTIMATED_MODEL_BASE_BYTES = 4 * 1024
_ESTIMATED_PATH_BYTES = 512
_ESTIMATED_POINT_BYTES = 128
_ESTIMATED_MARK_BYTES = 256
CUT_INSPECT_PROOF_MAX_LENGTH = (
    len(_PROOF_VERSION)
    + 1
    + _HANDLE_ID_HEX_LENGTH
    + 1
    + _HANDLE_SIGNATURE_HEX_LENGTH
)

# PERF/SEC (audit 2026-09-02 §PERF-NEST-07): secret này thuộc MỘT thế hệ
# process, không dùng sidecar token vốn được supervisor giữ qua lần restart.
_PROCESS_GENERATION_SECRET = secrets.token_bytes(32)


@dataclass
class _StoredProof:
    canonical_path: str
    sha256: str
    size_bytes: int
    page_idx: int
    force_layer: Optional[str]
    model: CutModel
    issued_at: int
    expires_at: int
    batch_id: str
    estimated_bytes: int


@dataclass(frozen=True)
class _ProofTombstone:
    code: str
    retain_until: int


_ACTIVE_PROOFS: dict[str, _StoredProof] = {}
_PROOF_TOMBSTONES: dict[str, _ProofTombstone] = {}
_PROOF_STORE_LOCK = threading.Lock()


class CutInspectProofError(ValueError):
    """Lỗi proof có mã ổn định để API/frontend phân loại mà không parse text."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def _canonical_path(path: str) -> str:
    return os.path.normcase(os.path.normpath(os.path.realpath(os.path.abspath(path))))


def _normalise_layer(value: Optional[str]) -> Optional[str]:
    return value if isinstance(value, str) and value else None


def _source_names(pont_config: Optional[dict]) -> dict[str, str]:
    config = pont_config or {}
    return {
        "group": config.get("groupName") or config.get("group_name") or "",
        "item": config.get("itemName") or config.get("item_name") or "",
        "layer": config.get("layerName") or config.get("layer_name") or "",
        "layerInfo": config.get("layerInfoName") or config.get("layer_info_name") or "",
    }


def _validate_fingerprint(fingerprint: Mapping[str, object]) -> tuple[str, int]:
    digest = fingerprint.get("sha256")
    byte_size = fingerprint.get("size_bytes")
    if (
        fingerprint.get("algorithm") != "sha256"
        or not isinstance(digest, str)
        or len(digest) != 64
        or any(char not in "0123456789abcdefABCDEF" for char in digest)
        or isinstance(byte_size, bool)
        or not isinstance(byte_size, int)
        or byte_size < 0
    ):
        raise CutInspectProofError("bad-fingerprint")
    return digest.lower(), byte_size


def _signature(handle_id: str) -> str:
    return hmac.new(
        _PROCESS_GENERATION_SECRET,
        _PROOF_PURPOSE + handle_id.encode("ascii"),
        hashlib.sha256,
    ).hexdigest()


def _format_handle(handle_id: str) -> str:
    return f"{_PROOF_VERSION}.{handle_id}.{_signature(handle_id)}"


def _estimate_cut_model_bytes(model: CutModel) -> int:
    """Ước lượng bảo thủ phần RAM Python giữ sống cùng một ``CutModel``.

    Tọa độ hiện là ``tuple[float, float]`` nằm trong list nên không thể dùng kích
    thước payload số học 16 byte/điểm. Hệ số dưới đây tính cả tuple, hai float,
    con trỏ list và overhead dataclass; đây là admission estimate, không phải số
    đo heap tuyệt đối.
    """
    estimated = _ESTIMATED_MODEL_BASE_BYTES
    for path in model.paths:
        estimated += _ESTIMATED_PATH_BYTES
        estimated += len(path.points) * _ESTIMATED_POINT_BYTES
        if path.tool_tag:
            estimated += len(path.tool_tag.encode("utf-8", errors="replace"))
    estimated += len(model.marks) * _ESTIMATED_MARK_BYTES
    for key, value in model.source_names.items():
        estimated += 128
        estimated += len(str(key).encode("utf-8", errors="replace"))
        estimated += len(str(value).encode("utf-8", errors="replace"))
    return max(_ESTIMATED_MODEL_BASE_BYTES, estimated)


def _positive_memory_mb(value: object) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 and math.isfinite(parsed) else None


def _proof_store_budget_bytes(
    total_ram_mb: float | None,
    available_ram_mb: float | None,
) -> int:
    """Ngân sách model proof theo RAM, không hard-cap máy >=16 GB.

    PERF (audit 2026-09-02 §PERF-NEST-07): đây là cache giữ qua request nên hai
    tier máy yếu có ceiling chống swap. Máy mạnh lấy 5% RAM *đang khả dụng*;
    ngân sách tăng theo máy và chỉ co lại khi hệ thống thật sự chịu áp lực RAM.
    """
    total = _positive_memory_mb(total_ram_mb)
    available = _positive_memory_mb(available_ram_mb)
    if total is None:
        return 64 * _MIB

    basis = available if available is not None else total
    if total < 8 * 1024:
        budget_mb = max(32.0, min(96.0, basis * 0.02))
    elif total < 16 * 1024:
        budget_mb = max(96.0, min(256.0, basis * 0.03))
    else:
        # Máy mạnh không có ceiling cố định: 64 GB/40 GB trống được admission
        # gấp đôi 32 GB/20 GB trống, nhưng cache vẫn không thể ăn vô hạn 5 phút.
        budget_mb = max(256.0, basis * 0.05)
    return max(_MIB, int(budget_mb * _MIB))


def _current_proof_store_budget_bytes() -> int:
    total_ram_mb, available_ram_mb = read_memory_status_mb()
    return _proof_store_budget_bytes(total_ram_mb, available_ram_mb)


def _proof_binding(stored: _StoredProof) -> tuple[str, str, int, int, Optional[str]]:
    return (
        stored.canonical_path,
        stored.sha256,
        stored.size_bytes,
        stored.page_idx,
        stored.force_layer,
    )


def _eviction_ids_for_budget_locked(
    *,
    excluded_ids: set[str],
    incoming_bytes: int,
    budget_bytes: int,
) -> set[str]:
    """Chọn nguyên batch cũ nhất để batch mới luôn được giữ trọn vẹn."""
    remaining = {
        handle_id: stored
        for handle_id, stored in _ACTIVE_PROOFS.items()
        if handle_id not in excluded_ids
    }
    projected_bytes = incoming_bytes + sum(
        stored.estimated_bytes for stored in remaining.values()
    )
    evicted_ids: set[str] = set()
    while projected_bytes > budget_bytes and remaining:
        _oldest_id, oldest = min(
            remaining.items(),
            key=lambda item: (item[1].issued_at, item[1].batch_id, item[0]),
        )
        batch_ids = [
            handle_id
            for handle_id, stored in remaining.items()
            if stored.batch_id == oldest.batch_id
        ]
        for handle_id in batch_ids:
            projected_bytes -= remaining.pop(handle_id).estimated_bytes
            evicted_ids.add(handle_id)
    if projected_bytes > budget_bytes:
        raise CutInspectProofError("capacity")
    return evicted_ids


def _prune_store_locked(now: int) -> None:
    """Nhả model hết hạn nhưng giữ tombstone nhỏ để trả mã lỗi ổn định."""
    for handle_id, tombstone in list(_PROOF_TOMBSTONES.items()):
        if tombstone.retain_until < now:
            _PROOF_TOMBSTONES.pop(handle_id, None)

    expired_ids = [
        handle_id
        for handle_id, stored in _ACTIVE_PROOFS.items()
        if stored.expires_at < now
        or stored.issued_at > now + _PROOF_CLOCK_SKEW_SECONDS
    ]
    for handle_id in expired_ids:
        _ACTIVE_PROOFS.pop(handle_id, None)
        _PROOF_TOMBSTONES[handle_id] = _ProofTombstone(
            code="expired",
            retain_until=now + PROOF_TTL_SECONDS,
        )


def issue_cut_inspect_proofs(
    *,
    path: str,
    fingerprint: Mapping[str, object],
    force_layer: Optional[str],
    models: Mapping[int, CutModel],
) -> dict[int, str]:
    """Cấp nguyên tử một bộ proof cho các model cùng revision vừa inspect."""
    digest, byte_size = _validate_fingerprint(fingerprint)
    canonical_path = _canonical_path(path)
    normalised_layer = _normalise_layer(force_layer)
    issued_at = int(time.time())
    expires_at = issued_at + PROOF_TTL_SECONDS

    ordered_models: list[tuple[int, CutModel, int]] = []
    for raw_page_idx, model in sorted(models.items()):
        if isinstance(raw_page_idx, bool) or not isinstance(raw_page_idx, int):
            raise CutInspectProofError("bad-model-set")
        if model.is_empty or model.sheet_w_mm <= 0 or model.sheet_h_mm <= 0:
            raise CutInspectProofError("bad-model-set")
        ordered_models.append(
            (raw_page_idx, model, _estimate_cut_model_bytes(model))
        )

    if not ordered_models:
        return {}

    incoming_bytes = sum(item[2] for item in ordered_models)
    budget_bytes = _current_proof_store_budget_bytes()
    # Một batch Send All phải nguyên vẹn. Không âm thầm bỏ vài trang để vừa RAM.
    if incoming_bytes > budget_bytes:
        raise CutInspectProofError("capacity")

    handles: dict[int, str] = {}
    batch_id = secrets.token_hex(16)
    with _PROOF_STORE_LOCK:
        _prune_store_locked(issued_at)

        new_bindings = {
            (canonical_path, digest, byte_size, page_idx, normalised_layer)
            for page_idx, _model, _estimated_bytes in ordered_models
        }
        superseded_ids = {
            handle_id
            for handle_id, stored in _ACTIVE_PROOFS.items()
            if _proof_binding(stored) in new_bindings
        }
        evicted_ids = _eviction_ids_for_budget_locked(
            excluded_ids=superseded_ids,
            incoming_bytes=incoming_bytes,
            budget_bytes=budget_bytes,
        )

        pending: list[tuple[str, int, _StoredProof]] = []
        reserved_ids: set[str] = set()
        for page_idx, model, estimated_bytes in ordered_models:
            while True:
                handle_id = secrets.token_hex(16)
                if (
                    handle_id not in _ACTIVE_PROOFS
                    and handle_id not in _PROOF_TOMBSTONES
                    and handle_id not in reserved_ids
                ):
                    break
            reserved_ids.add(handle_id)
            pending.append(
                (
                    handle_id,
                    page_idx,
                    _StoredProof(
                        canonical_path=canonical_path,
                        sha256=digest,
                        size_bytes=byte_size,
                        page_idx=page_idx,
                        force_layer=normalised_layer,
                        model=model,
                        issued_at=issued_at,
                        expires_at=expires_at,
                        batch_id=batch_id,
                        estimated_bytes=estimated_bytes,
                    ),
                )
            )

        # Latest-per-binding chặn refresh preview giữ nhiều bản model giống nhau.
        # Handle bị thay/evict trở thành unknown-proof; không tạo tombstone mới để
        # chính thao tác refresh không biến thành một cache phụ không có admission.
        for handle_id in superseded_ids | evicted_ids:
            _ACTIVE_PROOFS.pop(handle_id, None)
        for handle_id, page_idx, stored in pending:
            _ACTIVE_PROOFS[handle_id] = stored
            handles[page_idx] = _format_handle(handle_id)
    return handles


def issue_cut_inspect_proof(
    *,
    path: str,
    fingerprint: Mapping[str, object],
    page_idx: int,
    force_layer: Optional[str],
    model: CutModel,
) -> str:
    """Wrapper tương thích để cấp proof cho một trang."""
    return issue_cut_inspect_proofs(
        path=path,
        fingerprint=fingerprint,
        force_layer=force_layer,
        models={page_idx: model},
    )[page_idx]


def _decode_handle(proof: str) -> str:
    if not isinstance(proof, str) or not proof:
        raise CutInspectProofError("malformed")
    try:
        version, handle_id, provided_signature = proof.split(".", 2)
    except ValueError as exc:
        raise CutInspectProofError("malformed") from exc
    if (
        version != _PROOF_VERSION
        or len(proof) != CUT_INSPECT_PROOF_MAX_LENGTH
        or len(handle_id) != _HANDLE_ID_HEX_LENGTH
        or any(char not in "0123456789abcdef" for char in handle_id)
        or len(provided_signature) != _HANDLE_SIGNATURE_HEX_LENGTH
    ):
        raise CutInspectProofError("malformed")
    if not hmac.compare_digest(provided_signature, _signature(handle_id)):
        raise CutInspectProofError("bad-signature")
    return handle_id


def _take_stored_proof(
    handle_id: str,
    *,
    path: str,
    page_idx: int,
    force_layer: Optional[str],
) -> _StoredProof:
    """Lấy proof đúng một lần; loser đồng thời bị chặn trước bước băm source."""
    now = int(time.time())
    canonical_path = _canonical_path(path)
    normalised_layer = _normalise_layer(force_layer)
    with _PROOF_STORE_LOCK:
        _prune_store_locked(now)
        tombstone = _PROOF_TOMBSTONES.get(handle_id)
        if tombstone is not None:
            raise CutInspectProofError(tombstone.code)
        stored = _ACTIVE_PROOFS.get(handle_id)
        if stored is None:
            raise CutInspectProofError("unknown-proof")
        if (
            stored.canonical_path != canonical_path
            or stored.page_idx != page_idx
            or stored.force_layer != normalised_layer
        ):
            raise CutInspectProofError("binding-mismatch")

        # Chuyển trạng thái active → replay ngay trong cùng critical section.
        # Từ đây chỉ đúng một caller có thể chạm source/model của proof này.
        _ACTIVE_PROOFS.pop(handle_id, None)
        _PROOF_TOMBSTONES[handle_id] = _ProofTombstone(
            code="replay",
            retain_until=stored.expires_at + _PROOF_CLOCK_SKEW_SECONDS,
        )
        return stored


def _verify_current_source(path: str, expected_digest: str, expected_size: int) -> None:
    try:
        with open(path, "rb") as source:
            before = os.fstat(source.fileno())
            digest, byte_size = _hash_open_stream(source)
            after = os.fstat(source.fileno())
            path_after = os.stat(path)
    except OSError as exc:
        raise CutInspectProofError("source-stale") from exc
    if (
        _stat_revision(before) != _stat_revision(after)
        or _stat_revision(before) != _stat_revision(path_after)
        or byte_size != int(before.st_size)
        or byte_size != expected_size
        or not hmac.compare_digest(digest, expected_digest)
    ):
        raise CutInspectProofError("source-stale")


def verify_cut_inspect_proof(
    proof: str,
    *,
    path: str,
    page_idx: int,
    force_layer: Optional[str],
    pont_config: Optional[dict],
) -> CutModel:
    """Lấy model server-owned một lần rồi xác nhận source vẫn đúng revision."""
    handle_id = _decode_handle(proof)
    stored = _take_stored_proof(
        handle_id,
        path=path,
        page_idx=page_idx,
        force_layer=force_layer,
    )
    _verify_current_source(path, stored.sha256, stored.size_bytes)
    stored.model.source_names = _source_names(pont_config)
    return stored.model
