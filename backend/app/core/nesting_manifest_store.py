"""Kho lưu Placement Manifest production bất biến cho Bình Tem bế / Bình CNC.

Store này chỉ làm ba việc: canonical hóa đúng manifest cùng render bundle/reference,
công bố nguyên tử một lần, và đọc lại bằng cặp ``manifestId + layoutFingerprint``.
Nó không solve, không tự vá manifest, không giữ registry RAM và không xóa dữ liệu khi
``close()``; vì vậy preview và exporter có thể dùng lại đúng một kết quả sau restart.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import secrets
import stat
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final, Mapping, Sequence

from app.core.artifact_lease import (
    NestingSourceLeaseResolution,
    resolve_nesting_source_leases,
)

from app.core.mixed_nesting_artifacts import (
    assert_root_safe,
    resolve_root as resolve_artifact_root,
)

from app.core.mixed_nesting_service import (
    EngineCapabilities,
    EngineUnavailableError,
    MIXED_NESTING_MANIFEST_SCHEMA_VERSION,
    MIXED_NESTING_PRODUCTION_SCHEMA_VERSION,
    MixedNestingError,
    PRODUCTION_ALGORITHM_VERSION_KEYS,
    engine_capabilities,
    validate_production_manifest,
)
from app.core.nesting_production_adapter import (
    ProductionAdapterError,
    ProductionNestingRequest,
    validate_production_request_identity,
)
from app.core.nesting_source_pin import (
    NestingSourceStaleError,
    PinnedNestingSource,
    PinnedPageMetadata,
    ResolvedPinnedSource,
    VerifiedNestingSourceProof,
    discard_source_pin,
    promote_source_pin,
    reverify_source_pin,
    resolve_final_source,
    source_descriptor,
    verify_source_pin,
)

NESTING_MANIFEST_STORE_SCHEMA_VERSION: Final[int] = 1
MANIFEST_DIRECTORY_NAME: Final[str] = "manifests"

_MANIFEST_ID_PATTERN: Final[re.Pattern[str]] = re.compile(r"^[0-9a-f]{32}$")
_IDENTITY_SHA256_PATTERN: Final[re.Pattern[str]] = re.compile(
    r"^sha256:[0-9a-f]{64}$"
)
_CONTENT_SHA256_PATTERN: Final[re.Pattern[str]] = re.compile(r"^[0-9a-f]{64}$")
_WRITE_LOCK = threading.RLock()

_PLACEMENT_FIELDS: Final[frozenset[str]] = frozenset(
    {"instanceId", "partId", "sheetIndex", "pose", "sourceRevision"}
)
_POSE_FIELDS: Final[frozenset[str]] = frozenset(
    {"rotationDeg", "translateXmm", "translateYmm"}
)
_UNPLACED_FIELDS: Final[frozenset[str]] = frozenset(
    {"instanceId", "partId", "reason"}
)
_STATS_FIELDS: Final[frozenset[str]] = frozenset(
    {
        "sheetCount",
        "placedCount",
        "unplacedCount",
        "materialUtilization",
        "elapsedMs",
        "attempts",
        "orientationEvaluations",
        "poseRefinements",
        "terminationReason",
    }
)
_MANIFEST_FIELDS: Final[frozenset[str]] = frozenset(
    {
        "schemaVersion",
        "manifestId",
        "protocolVersion",
        "engineVersion",
        "jobId",
        "requestRevision",
        "inputHash",
        "layoutFingerprint",
        "layoutIntent",
        "seed",
        "status",
        "provenance",
        "search",
        "placements",
        "unplaced",
        "stats",
        "validation",
    }
)
_PRODUCTION_PAYLOAD_FIELDS: Final[frozenset[str]] = frozenset(
    {
        "engineRequest",
        "renderBundle",
        "renderBundleHash",
        "inputHash",
        "solverConfigHash",
        "geometryConstraintsHash",
        "layoutFingerprint",
        "algorithmVersions",
        "nativeBuildIdentity",
    }
)
_VALIDATION_FIELDS: Final[frozenset[str]] = frozenset(
    {"valid", "validatorVersion"}
)
_PROVENANCE_FIELDS: Final[frozenset[str]] = frozenset(
    {
        "nativeBuildIdentity",
        "productionSchemaVersion",
        "toleranceVersion",
        "canonicalizationVersion",
        "normalizeRuleVersion",
        "referencePointRuleVersion",
        "kernelVersion",
        "nfpRuleVersion",
        "scoreVersion",
        "solverVersion",
        "multiStartVersion",
        "baselineVersion",
        "candidateRuleVersion",
        "refineRuleVersion",
    }
)
_SEARCH_REQUIRED_FIELDS: Final[frozenset[str]] = frozenset(
    {"budget", "trialsRun", "trialsRejected", "selectedCandidate", "selectedScore"}
)
_SEARCH_OPTIONAL_FIELDS: Final[frozenset[str]] = frozenset({"baselineScore"})
_BUDGET_REQUIRED_FIELDS: Final[frozenset[str]] = frozenset(
    {
        "trialCount",
        "orientationProposalsPerPart",
        "beamWidth",
        "refinementRounds",
        "multiStartRestarts",
        "evaluationBudget",
    }
)
_BUDGET_OPTIONAL_FIELDS: Final[frozenset[str]] = frozenset({"timeBudgetMs"})
_SCORE_FIELDS: Final[frozenset[str]] = frozenset(
    {
        "invalidCount",
        "primaryPenalty",
        "sheetCount",
        "lastSheetUsedAreaFixed",
        "wastedWithinEnvelopeFixed",
        "scoreVersion",
    }
)
_BASELINE_CANDIDATE_FIELDS: Final[frozenset[str]] = frozenset({"kind"})
_SMART_CANDIDATE_FIELDS: Final[frozenset[str]] = frozenset({"kind", "trialId"})
_UNPLACED_REASONS: Final[frozenset[str]] = frozenset(
    {
        "NO_FEASIBLE_POSE",
        "SEARCH_BUDGET_EXHAUSTED",
        "MAX_SHEETS_REACHED",
        "CANCELLED",
    }
)
_TERMINATION_REASONS: Final[frozenset[str]] = frozenset(
    {
        "all_placed",
        "sheet_full",
        "work_budget_exhausted",
        "deadline",
        "max_sheets_reached",
        "cancelled",
    }
)
_UINT32_MAX: Final[int] = 2**32 - 1
_UINT64_MAX: Final[int] = 2**64 - 1
_INT64_MIN: Final[int] = -(2**63)
_INT64_MAX: Final[int] = 2**63 - 1


class NestingManifestStoreError(RuntimeError):
    """Lỗi nền của kho manifest production."""


class ManifestIdentifierError(ValueError):
    """Định danh không ở dạng canonical do server cấp."""


class ManifestContractError(ValueError):
    """Manifest thiếu hoặc lệch identity production bắt buộc."""


class ManifestNotFoundError(FileNotFoundError):
    """Không tìm thấy manifest đúng ID đã yêu cầu."""


class ManifestFingerprintMismatchError(NestingManifestStoreError):
    """ID tồn tại nhưng fingerprint không còn khớp request hiện tại."""

    code = "LAYOUT_MANIFEST_STALE"
    status_code = 409


class ManifestConflictError(NestingManifestStoreError):
    """Cùng manifest ID đã được công bố với nội dung khác."""


class ManifestIntegrityError(NestingManifestStoreError):
    """File trong kho không còn đúng envelope canonical đã công bố."""


class ManifestPathUnsafeError(NestingManifestStoreError):
    """Đường dẫn kho đi qua symlink/junction/reparse point."""


@dataclass(frozen=True)
class StoredNestingManifest:
    """Bản đọc bất biến; hai mapping là bản sao mới tách khỏi dữ liệu caller."""

    manifest_id: str
    layout_fingerprint: str
    content_sha256: str
    render_bundle_hash: str
    manifest: dict[str, Any]
    render_bundle: dict[str, Any]
    production_request: ProductionNestingRequest
    resolved_sources: dict[str, ResolvedPinnedSource]
    canonical_bytes: bytes


@dataclass(frozen=True)
class _SourceExpectation:
    """Descriptor và page binding canonical của đúng một source locator."""

    descriptor: dict[str, Any]
    pages: tuple[dict[str, Any], ...]


@dataclass(frozen=True)
class _PreparedSourcePins:
    """Pin đã khớp exact locator set; provisional vẫn thuộc lượt persist này."""

    by_locator: dict[str, PinnedNestingSource]
    proofs_by_locator: dict[str, VerifiedNestingSourceProof]
    discard_candidates: frozenset[str]


@dataclass(frozen=True)
class _ValidatedEnvelopeProof:
    """Canonical bytes đã qua native validator trong đúng lượt persist hiện tại."""

    canonical_bytes: bytes
    manifest_id: str
    layout_fingerprint: str
    native_build_identity: str


@dataclass(frozen=True)
class _DecodedManifestRecord:
    """Envelope đã full-validate nhưng chưa resolve source server-only."""

    manifest_id: str
    layout_fingerprint: str
    content_sha256: str
    manifest: dict[str, Any]
    production_request: ProductionNestingRequest
    source_expectations: dict[str, _SourceExpectation]
    canonical_bytes: bytes


def validate_manifest_id(manifest_id: object) -> str:
    """Chỉ nhận job ID V1 do server sinh: 16 byte, hex thường, không có path."""

    if not isinstance(manifest_id, str) or not _MANIFEST_ID_PATTERN.fullmatch(
        manifest_id
    ):
        raise ManifestIdentifierError(
            "manifestId phải là 32 ký tự hex thường do server cấp."
        )
    return manifest_id


def validate_layout_fingerprint(layout_fingerprint: object) -> str:
    """Chỉ nhận SHA-256 canonical; regex đồng thời chặn traversal, backslash và NUL."""

    if not isinstance(
        layout_fingerprint, str
    ) or not _IDENTITY_SHA256_PATTERN.fullmatch(
        layout_fingerprint
    ):
        raise ManifestIdentifierError(
            "layoutFingerprint phải có dạng sha256: + 64 ký tự hex thường."
        )
    return layout_fingerprint


def _detach_json_value(value: Any, path: str = "$", depth: int = 0) -> Any:
    """Đổi sang cây JSON thuần và từ chối kiểu/số không thể canonical hóa."""

    if depth > 128:
        raise ManifestContractError("Dữ liệu manifest lồng quá sâu.")
    if value is None or isinstance(value, (bool, str)):
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ManifestContractError(f"{path} chứa số không hữu hạn.")
        return value
    if isinstance(value, Mapping):
        detached: dict[str, Any] = {}
        for key, item in value.items():
            if not isinstance(key, str):
                raise ManifestContractError(f"{path} có khóa JSON không phải chuỗi.")
            detached[key] = _detach_json_value(item, f"{path}.{key}", depth + 1)
        return detached
    if isinstance(value, (list, tuple)):
        return [
            _detach_json_value(item, f"{path}[{index}]", depth + 1)
            for index, item in enumerate(value)
        ]
    raise ManifestContractError(f"{path} chứa kiểu dữ liệu không thuộc JSON.")


def canonical_json_bytes(value: Any) -> bytes:
    """Serialize JSON ổn định, UTF-8, không whitespace và không NaN/Infinity."""

    detached = _detach_json_value(value)
    return json.dumps(
        detached,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def _capabilities_for_production(
    production: ProductionNestingRequest,
) -> EngineCapabilities:
    """Dựng capability snapshot đúng build đã solve để dùng chung validator."""

    versions = production.algorithm_versions
    protocol = versions.get("protocolVersion")
    engine = versions.get("engineVersion")
    if (
        isinstance(protocol, bool)
        or not isinstance(protocol, int)
        or not isinstance(engine, str)
        or not engine
    ):
        raise ManifestContractError("Algorithm versions thiếu protocol/engine hợp lệ.")
    return EngineCapabilities(
        protocol_version=protocol,
        engine_version=engine,
        reflection="forbidden",
        default_rotation="free",
        continuous_translation=True,
        profiles=("fast", "balanced", "tight"),
        layout_intents=(
            "quantity_fulfillment",
            "autofill_single_sheet",
            "step_repeat_single_sheet",
        ),
        native_build_identity=production.native_build_identity,
        manifest_schema_version=MIXED_NESTING_MANIFEST_SCHEMA_VERSION,
        algorithm_versions=tuple(sorted(versions.items())),
    )


def _assert_current_production_schema(production_payload: Mapping[str, Any]) -> None:
    """Phân biệt artifact schema cũ hợp lệ với file bị hỏng cấu trúc.

    FIX (audit 2026-08-29 §MAP-NEST-04): kiểm hai version tag sau chốt
    canonical/SHA nhưng trước adapter schema hiện hành. Schema cũ cần solve lại
    (409 stale), còn tag thiếu, sai kiểu hoặc tự mâu thuẫn vẫn là integrity error.
    """

    versions = production_payload.get("algorithmVersions")
    engine_request = production_payload.get("engineRequest")
    if not isinstance(versions, dict) or not isinstance(engine_request, dict):
        raise ManifestIntegrityError(
            "Production request thiếu algorithmVersions hoặc engineRequest hợp lệ."
        )
    contract = engine_request.get("productionContract")
    if not isinstance(contract, dict):
        raise ManifestIntegrityError("Production request thiếu productionContract hợp lệ.")

    algorithm_schema = versions.get("productionSchemaVersion")
    contract_schema = contract.get("schemaVersion")
    if (
        isinstance(algorithm_schema, bool)
        or not isinstance(algorithm_schema, int)
        or isinstance(contract_schema, bool)
        or not isinstance(contract_schema, int)
        or algorithm_schema <= 0
        or contract_schema <= 0
        or algorithm_schema != contract_schema
    ):
        raise ManifestIntegrityError(
            "Hai version tag của production schema thiếu, sai kiểu hoặc không đồng nhất."
        )
    if algorithm_schema != MIXED_NESTING_PRODUCTION_SCHEMA_VERSION:
        raise ManifestFingerprintMismatchError(
            "Manifest dùng production schema cũ; cần solve lại bằng engine hiện hành."
        )


def _assert_current_engine_snapshot(production: ProductionNestingRequest) -> None:
    """Từ chối manifest của native build/version khác trước khi chạy decode validator."""

    capabilities = engine_capabilities()
    current_versions = capabilities.require_production_versions()
    exact_version_keys = set(current_versions) == set(
        PRODUCTION_ALGORITHM_VERSION_KEYS
    )
    if (
        not exact_version_keys
        or current_versions != production.algorithm_versions
        or capabilities.native_build_identity != production.native_build_identity
    ):
        raise ManifestFingerprintMismatchError(
            "Manifest được tạo bởi native build hoặc bộ phiên bản thuật toán khác; "
            "cần solve lại bằng engine hiện hành."
        )



def _require_exact_object(
    value: Any,
    fields: frozenset[str],
    path: str,
) -> dict[str, Any]:
    """Khóa tập field bắt buộc theo ``deny_unknown_fields`` của serde Rust."""

    return _require_object_fields(value, fields, frozenset(), path)


def _require_object_fields(
    value: Any,
    required: frozenset[str],
    optional: frozenset[str],
    path: str,
) -> dict[str, Any]:
    """Khóa field bắt buộc/tùy chọn và từ chối mọi field serde không biết."""

    if not isinstance(value, dict):
        raise ManifestContractError(f"{path} không phải object.")
    actual = set(value)
    missing = required.difference(actual)
    unknown = actual.difference(required.union(optional))
    if missing or unknown:
        details: list[str] = []
        if missing:
            details.append("thiếu " + ", ".join(sorted(missing)))
        if unknown:
            details.append("có field lạ " + ", ".join(sorted(unknown)))
        raise ManifestContractError(f"{path} {'; '.join(details)}.")
    return value


def _require_string(value: Any, path: str) -> str:
    if not isinstance(value, str):
        raise ManifestContractError(f"{path} không phải chuỗi.")
    return value


def _require_uint(value: Any, path: str, *, maximum: int) -> int:
    """Đọc u32/u64 như serde: bool không phải số nguyên và không được tràn miền."""

    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or value < 0
        or value > maximum
    ):
        raise ManifestContractError(f"{path} không phải số nguyên không âm hợp lệ.")
    return value


def _require_i64(value: Any, path: str) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or value < _INT64_MIN
        or value > _INT64_MAX
    ):
        raise ManifestContractError(f"{path} không phải số nguyên i64 hợp lệ.")
    return value


def _require_finite_number(value: Any, path: str) -> float:
    """Đọc f64 hữu hạn; JSON bool không được Python coi nhầm là số."""

    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ManifestContractError(f"{path} không phải số hữu hạn.")
    try:
        number = float(value)
    except (OverflowError, ValueError):
        raise ManifestContractError(f"{path} không phải số hữu hạn.") from None
    if not math.isfinite(number):
        raise ManifestContractError(f"{path} không phải số hữu hạn.")
    return number


def _instance_ordinal(instance_id: Any, part_id: str, path: str) -> int:
    """Parse đúng helper Rust ``format!(\"{part_id}#{ordinal:04}\")``."""

    if not isinstance(instance_id, str):
        raise ManifestContractError(f"{path}.instanceId không phải chuỗi canonical.")
    bound_part_id, separator, digits = instance_id.rpartition("#")
    if (
        separator != "#"
        or bound_part_id != part_id
        or not digits
        or len(digits) > 10
        or any(character < "0" or character > "9" for character in digits)
    ):
        raise ManifestContractError(
            f"{path}.instanceId không bind đúng partId và ordinal canonical."
        )
    ordinal = int(digits)
    if (
        ordinal <= 0
        or ordinal > _UINT32_MAX
        or instance_id != f"{part_id}#{ordinal:04d}"
    ):
        raise ManifestContractError(
            f"{path}.instanceId không bind đúng partId và ordinal canonical."
        )
    return ordinal


def _validate_manifest_score(value: Any, path: str) -> None:
    score = _require_exact_object(value, _SCORE_FIELDS, path)
    _require_uint(score["invalidCount"], f"{path}.invalidCount", maximum=_UINT64_MAX)
    _require_uint(
        score["primaryPenalty"], f"{path}.primaryPenalty", maximum=_UINT64_MAX
    )
    _require_uint(score["sheetCount"], f"{path}.sheetCount", maximum=_UINT32_MAX)
    _require_i64(score["lastSheetUsedAreaFixed"], f"{path}.lastSheetUsedAreaFixed")
    _require_i64(
        score["wastedWithinEnvelopeFixed"],
        f"{path}.wastedWithinEnvelopeFixed",
    )
    _require_uint(score["scoreVersion"], f"{path}.scoreVersion", maximum=_UINT32_MAX)


def _validate_manifest_serde_schema(manifest: dict[str, Any]) -> None:
    """Khóa toàn bộ cây manifest theo serde Rust trước khi công bố artifact."""

    _require_exact_object(manifest, _MANIFEST_FIELDS, "manifest")
    _require_uint(
        manifest["schemaVersion"], "manifest.schemaVersion", maximum=_UINT32_MAX
    )
    _require_string(manifest["manifestId"], "manifest.manifestId")
    _require_uint(
        manifest["protocolVersion"], "manifest.protocolVersion", maximum=_UINT32_MAX
    )
    _require_string(manifest["engineVersion"], "manifest.engineVersion")
    _require_string(manifest["jobId"], "manifest.jobId")
    _require_uint(
        manifest["requestRevision"],
        "manifest.requestRevision",
        maximum=_UINT64_MAX,
    )
    _require_string(manifest["inputHash"], "manifest.inputHash")
    _require_string(manifest["layoutFingerprint"], "manifest.layoutFingerprint")
    _require_string(manifest["layoutIntent"], "manifest.layoutIntent")
    _require_uint(manifest["seed"], "manifest.seed", maximum=_UINT64_MAX)
    _require_string(manifest["status"], "manifest.status")

    validation = _require_exact_object(
        manifest["validation"], _VALIDATION_FIELDS, "manifest.validation"
    )
    if not isinstance(validation["valid"], bool):
        raise ManifestContractError("manifest.validation.valid không phải boolean.")
    _require_uint(
        validation["validatorVersion"],
        "manifest.validation.validatorVersion",
        maximum=_UINT32_MAX,
    )

    provenance = _require_exact_object(
        manifest["provenance"], _PROVENANCE_FIELDS, "manifest.provenance"
    )
    _require_string(
        provenance["nativeBuildIdentity"],
        "manifest.provenance.nativeBuildIdentity",
    )
    for field in _PROVENANCE_FIELDS.difference({"nativeBuildIdentity"}):
        _require_uint(
            provenance[field],
            f"manifest.provenance.{field}",
            maximum=_UINT32_MAX,
        )

    search = _require_object_fields(
        manifest["search"],
        _SEARCH_REQUIRED_FIELDS,
        _SEARCH_OPTIONAL_FIELDS,
        "manifest.search",
    )
    _require_uint(
        search["trialsRun"], "manifest.search.trialsRun", maximum=_UINT32_MAX
    )
    _require_uint(
        search["trialsRejected"],
        "manifest.search.trialsRejected",
        maximum=_UINT32_MAX,
    )

    budget = _require_object_fields(
        search["budget"],
        _BUDGET_REQUIRED_FIELDS,
        _BUDGET_OPTIONAL_FIELDS,
        "manifest.search.budget",
    )
    for field in (
        "trialCount",
        "orientationProposalsPerPart",
        "beamWidth",
        "refinementRounds",
        "multiStartRestarts",
    ):
        _require_uint(
            budget[field], f"manifest.search.budget.{field}", maximum=_UINT32_MAX
        )
    _require_uint(
        budget["evaluationBudget"],
        "manifest.search.budget.evaluationBudget",
        maximum=_UINT64_MAX,
    )
    if "timeBudgetMs" in budget:
        _require_uint(
            budget["timeBudgetMs"],
            "manifest.search.budget.timeBudgetMs",
            maximum=_UINT64_MAX,
        )

    candidate = search["selectedCandidate"]
    if not isinstance(candidate, dict):
        raise ManifestContractError("manifest.search.selectedCandidate không phải object.")
    kind = candidate.get("kind")
    if kind == "baseline":
        _require_exact_object(
            candidate,
            _BASELINE_CANDIDATE_FIELDS,
            "manifest.search.selectedCandidate",
        )
    elif kind == "smart_trial":
        _require_exact_object(
            candidate,
            _SMART_CANDIDATE_FIELDS,
            "manifest.search.selectedCandidate",
        )
        _require_uint(
            candidate["trialId"],
            "manifest.search.selectedCandidate.trialId",
            maximum=_UINT64_MAX,
        )
    else:
        raise ManifestContractError(
            "manifest.search.selectedCandidate.kind không thuộc enum Rust."
        )

    _validate_manifest_score(search["selectedScore"], "manifest.search.selectedScore")
    if "baselineScore" in search:
        _validate_manifest_score(
            search["baselineScore"], "manifest.search.baselineScore"
        )


def _validate_manifest_instances(
    manifest: dict[str, Any],
    production: ProductionNestingRequest,
) -> None:
    """Khóa schema serde và binding instance/source/stats của manifest production."""

    raw_parts = production.engine_request.get("parts")
    placements = manifest.get("placements")
    unplaced = manifest.get("unplaced")
    stats = manifest.get("stats")
    sheet = production.engine_request.get("sheet")
    if (
        not isinstance(raw_parts, list)
        or not isinstance(placements, list)
        or not isinstance(unplaced, list)
        or not isinstance(stats, dict)
        or not isinstance(sheet, dict)
    ):
        raise ManifestContractError(
            "Manifest production thiếu parts/placements/unplaced/stats hợp lệ."
        )
    max_sheets = _require_uint(
        sheet.get("maxSheets"),
        "production.sheet.maxSheets",
        maximum=_UINT32_MAX,
    )
    if max_sheets == 0:
        raise ManifestContractError("production.sheet.maxSheets phải lớn hơn 0.")

    parts: dict[str, dict[str, Any]] = {}
    for raw_part in raw_parts:
        if (
            not isinstance(raw_part, dict)
            or not isinstance(raw_part.get("partId"), str)
        ):
            raise ManifestContractError("Part production không có partId hợp lệ.")
        if raw_part["partId"] in parts:
            raise ManifestContractError("Part production có partId bị trùng.")
        parts[raw_part["partId"]] = raw_part

    seen_instances: set[str] = set()
    ordinals_by_part: dict[str, set[int]] = {part_id: set() for part_id in parts}
    sheet_indices: set[int] = set()
    for index, raw_placement in enumerate(placements):
        path = f"placements[{index}]"
        placement = _require_exact_object(
            raw_placement,
            _PLACEMENT_FIELDS,
            path,
        )
        part_id = placement.get("partId")
        instance_id = placement.get("instanceId")
        part = parts.get(part_id) if isinstance(part_id, str) else None
        if part is None or not isinstance(instance_id, str):
            raise ManifestContractError(
                f"{path} có partId/instanceId không thuộc production request."
            )
        ordinal = _instance_ordinal(instance_id, part_id, path)
        if instance_id in seen_instances:
            raise ManifestContractError(f"{path}.instanceId bị trùng.")
        if placement.get("sourceRevision") != part.get("sourceRevision"):
            raise ManifestContractError(
                f"{path}.sourceRevision không khớp render bundle."
            )

        sheet_index = _require_uint(
            placement["sheetIndex"],
            f"{path}.sheetIndex",
            maximum=_UINT32_MAX,
        )
        if sheet_index >= max_sheets:
            raise ManifestContractError(
                f"{path}.sheetIndex vượt sheet.maxSheets của request."
            )
        pose = _require_exact_object(
            placement["pose"], _POSE_FIELDS, f"{path}.pose"
        )
        rotation = _require_finite_number(
            pose["rotationDeg"], f"{path}.pose.rotationDeg"
        )
        _require_finite_number(pose["translateXmm"], f"{path}.pose.translateXmm")
        _require_finite_number(pose["translateYmm"], f"{path}.pose.translateYmm")
        if rotation < 0.0 or rotation >= 360.0:
            raise ManifestContractError(
                f"{path}.pose.rotationDeg phải canonical trong [0, 360)."
            )

        seen_instances.add(instance_id)
        ordinals_by_part[part_id].add(ordinal)
        sheet_indices.add(sheet_index)

    for index, raw_item in enumerate(unplaced):
        path = f"unplaced[{index}]"
        item = _require_exact_object(raw_item, _UNPLACED_FIELDS, path)
        part_id = item.get("partId")
        instance_id = item.get("instanceId")
        if not isinstance(part_id, str) or part_id not in parts:
            raise ManifestContractError(
                f"{path}.partId không thuộc production request."
            )
        ordinal = _instance_ordinal(instance_id, part_id, path)
        if instance_id in seen_instances:
            raise ManifestContractError(f"{path}.instanceId bị trùng.")
        reason = item["reason"]
        if not isinstance(reason, str) or reason not in _UNPLACED_REASONS:
            raise ManifestContractError(f"{path}.reason không thuộc enum Rust.")
        seen_instances.add(instance_id)
        ordinals_by_part[part_id].add(ordinal)

    layout_intent = production.engine_request.get("layoutIntent")
    if layout_intent == "quantity_fulfillment":
        expected_instances = {
            f"{part_id}#{ordinal:04d}"
            for part_id, part in parts.items()
            for ordinal in range(1, int(part["quantity"]) + 1)
        }
        if seen_instances != expected_instances or unplaced:
            raise ManifestContractError(
                "Manifest quantity_fulfillment chưa phủ đủ exact instance set."
            )
    elif layout_intent in {"autofill_single_sheet", "step_repeat_single_sheet"}:
        if unplaced:
            raise ManifestContractError(
                "Manifest autofill không được có unplaced vì không có target quantity."
            )
        for part_id, ordinals in ordinals_by_part.items():
            if not ordinals or ordinals != set(range(1, max(ordinals) + 1)):
                raise ManifestContractError(
                    "Manifest autofill phải có ordinal liên tục từ 1 cho mọi part; "
                    f"part {part_id!r} không đạt."
                )
    else:
        raise ManifestContractError("layoutIntent production không được hỗ trợ.")

    stats = _require_exact_object(stats, _STATS_FIELDS, "stats")
    sheet_count = _require_uint(
        stats["sheetCount"], "stats.sheetCount", maximum=_UINT32_MAX
    )
    placed_count = _require_uint(
        stats["placedCount"], "stats.placedCount", maximum=_UINT64_MAX
    )
    unplaced_count = _require_uint(
        stats["unplacedCount"], "stats.unplacedCount", maximum=_UINT64_MAX
    )
    for field in (
        "elapsedMs",
        "attempts",
        "orientationEvaluations",
        "poseRefinements",
    ):
        _require_uint(stats[field], f"stats.{field}", maximum=_UINT64_MAX)
    utilization = _require_finite_number(
        stats["materialUtilization"], "stats.materialUtilization"
    )
    if utilization < 0.0 or utilization > 1.0:
        raise ManifestContractError(
            "stats.materialUtilization phải nằm trong [0, 1]."
        )
    termination_reason = stats["terminationReason"]
    if (
        not isinstance(termination_reason, str)
        or termination_reason not in _TERMINATION_REASONS
    ):
        raise ManifestContractError("stats.terminationReason không thuộc enum Rust.")

    expected_sheet_indices = set(range(len(sheet_indices)))
    if sheet_indices != expected_sheet_indices:
        raise ManifestContractError(
            "sheetIndex của placements phải liên tục từ 0, không được có lỗ."
        )
    if (
        placed_count != len(placements)
        or unplaced_count != len(unplaced)
        or sheet_count != len(sheet_indices)
    ):
        raise ManifestContractError(
            "Thống kê sheet/placed/unplaced không khớp record trong manifest."
        )


def _validate_manifest_for_production(
    manifest: dict[str, Any],
    production: ProductionNestingRequest,
) -> None:
    """Dùng cùng postcondition service, rồi kiểm binding part/source ở tầng store."""
    _validate_manifest_serde_schema(manifest)

    try:
        validate_production_manifest(
            manifest,
            production.engine_request,
            _capabilities_for_production(production),
        )
    except (EngineUnavailableError, MixedNestingError) as exc:
        raise ManifestContractError(
            "Placement manifest không qua postcondition production."
        ) from exc
    _validate_manifest_instances(manifest, production)


def _production_payload(production: ProductionNestingRequest) -> dict[str, Any]:
    return {
        "engineRequest": production.engine_request,
        "renderBundle": production.render_bundle,
        "renderBundleHash": production.render_bundle_hash,
        "inputHash": production.input_hash,
        "solverConfigHash": production.solver_config_hash,
        "geometryConstraintsHash": production.geometry_constraints_hash,
        "layoutFingerprint": production.layout_fingerprint,
        "algorithmVersions": production.algorithm_versions,
        "nativeBuildIdentity": production.native_build_identity,
    }


def _source_expectations(
    production: ProductionNestingRequest,
) -> dict[str, _SourceExpectation]:
    """Trích exact locator set cùng descriptor/page metadata từ RenderBundle V2."""

    parts = production.render_bundle.get("parts")
    if not isinstance(parts, list) or not parts:
        raise ManifestContractError("Render bundle không có part source để pin.")

    descriptors: dict[str, dict[str, Any]] = {}
    pages_by_locator: dict[str, dict[int, dict[str, Any]]] = {}
    descriptor_fields = {
        "locatorId",
        "contentHash",
        "byteSize",
        "pageCount",
        "revision",
    }
    for part_index, part in enumerate(parts):
        if not isinstance(part, dict):
            raise ManifestContractError(
                f"renderBundle.parts[{part_index}] không phải object."
            )
        source = part.get("source")
        if not isinstance(source, dict) or set(source) != descriptor_fields:
            raise ManifestContractError(
                f"renderBundle.parts[{part_index}].source không đúng descriptor."
            )
        detached_source = _detach_json_value(
            source, f"$.renderBundle.parts[{part_index}].source"
        )
        assert isinstance(detached_source, dict)
        locator_id = detached_source.get("locatorId")
        if not isinstance(locator_id, str) or not locator_id:
            raise ManifestContractError("Source locator trong render bundle không hợp lệ.")
        previous_descriptor = descriptors.setdefault(locator_id, detached_source)
        if previous_descriptor != detached_source:
            raise ManifestContractError(
                "Cùng source locator có descriptor mâu thuẫn trong render bundle."
            )

        page_bindings = part.get("pages")
        if (
            not isinstance(page_bindings, dict)
            or set(page_bindings) != {"front", "back", "cut"}
        ):
            raise ManifestContractError(
                f"renderBundle.parts[{part_index}].pages không hợp lệ."
            )
        locator_pages = pages_by_locator.setdefault(locator_id, {})
        for side, binding in page_bindings.items():
            if binding is None:
                continue
            if not isinstance(binding, dict):
                raise ManifestContractError(
                    f"renderBundle.parts[{part_index}].pages không đúng object binding."
                )
            metadata_fields = (
                "pageIndex",
                "pageBoxesMm",
                "userUnit",
                "rotateDeg",
                "sourcePageToCanonical",
            )
            if any(field not in binding for field in metadata_fields):
                raise ManifestContractError(
                    f"renderBundle.parts[{part_index}].pages.{side} thiếu metadata nguồn."
                )
            normalized_binding = _detach_json_value(
                {field: binding[field] for field in metadata_fields},
                f"$.renderBundle.parts[{part_index}].pages.{side}",
            )
            assert isinstance(normalized_binding, dict)
            page_index = normalized_binding.get("pageIndex")
            if isinstance(page_index, bool) or not isinstance(page_index, int):
                raise ManifestContractError("Page binding source thiếu pageIndex hợp lệ.")
            previous_binding = locator_pages.setdefault(page_index, normalized_binding)
            if previous_binding != normalized_binding:
                raise ManifestContractError(
                    "Cùng source page có metadata mâu thuẫn trong render bundle."
                )

    return {
        locator_id: _SourceExpectation(
            descriptor=descriptors[locator_id],
            pages=tuple(
                pages_by_locator[locator_id][page_index]
                for page_index in sorted(pages_by_locator[locator_id])
            ),
        )
        for locator_id in sorted(descriptors)
    }


def _prepare_source_pins(
    source_pins: Sequence[PinnedNestingSource],
    expectations: Mapping[str, _SourceExpectation],
    source_proofs: Sequence[VerifiedNestingSourceProof] | None = None,
) -> _PreparedSourcePins:
    """Khóa exact pin set và verify snapshot trước khi được phép promote."""

    try:
        pins = tuple(source_pins)
    except TypeError as exc:
        raise ManifestContractError("source_pins phải là một sequence hữu hạn.") from exc

    by_locator: dict[str, PinnedNestingSource] = {}
    for offset, pin in enumerate(pins):
        if not isinstance(pin, PinnedNestingSource):
            raise ManifestContractError(
                f"source_pins[{offset}] không phải PinnedNestingSource."
            )
        if pin.locator_id in by_locator:
            raise ManifestContractError("source_pins có locatorId trùng lặp.")
        by_locator[pin.locator_id] = pin
    if set(by_locator) != set(expectations):
        raise ManifestContractError(
            "source_pins không khớp exact locator set trong render bundle."
        )

    supplied_proofs: dict[str, VerifiedNestingSourceProof] = {}
    if source_proofs is not None:
        try:
            proof_values = tuple(source_proofs)
        except TypeError as exc:
            raise ManifestContractError(
                "source_proofs phải là một sequence hữu hạn."
            ) from exc
        for offset, proof in enumerate(proof_values):
            if not isinstance(proof, VerifiedNestingSourceProof):
                raise ManifestContractError(
                    f"source_proofs[{offset}] không phải VerifiedNestingSourceProof."
                )
            if proof.locator_id in supplied_proofs:
                raise ManifestContractError("source_proofs có locatorId trùng lặp.")
            supplied_proofs[proof.locator_id] = proof
        if supplied_proofs and set(supplied_proofs) != set(expectations):
            raise ManifestContractError(
                "source_proofs không khớp exact locator set trong render bundle."
            )

    discard_candidates: set[str] = set()
    verified_proofs: dict[str, VerifiedNestingSourceProof] = {}
    for locator_id in sorted(expectations):
        pin = by_locator[locator_id]
        expected = expectations[locator_id]
        if source_descriptor(pin) != expected.descriptor:
            raise ManifestFingerprintMismatchError(
                "Descriptor source pin không khớp render bundle đã solve."
            )
        try:
            proof = supplied_proofs.get(locator_id)
            if proof is None:
                proof = verify_source_pin(pin, expected.descriptor, expected.pages)
            else:
                # PERF (audit 2026-09-01 §PERF-NEST-02): proof preflight chỉ
                # tái dùng metadata. Snapshot vẫn SHA-256 lại trước publication.
                reverify_source_pin(
                    pin,
                    proof,
                    expected.descriptor,
                    expected.pages,
                    require_final=False,
                    renew=False,
                )
        except NestingSourceStaleError as exc:
            raise ManifestFingerprintMismatchError(
                "Source pin provisional đã mất hoặc không còn đúng fingerprint."
            ) from exc
        if isinstance(proof, VerifiedNestingSourceProof):
            verified_proofs[locator_id] = proof
        # PERF (audit 2026-09-01 §PERF-NEST-02): không quét toàn bộ marker
        # chỉ để hỏi phase. Nhánh rollback thử discard bằng token O(1); source đã
        # final tự fail/no-op, nên vẫn không thể xóa ownership của manifest cũ.
        discard_candidates.add(locator_id)

    return _PreparedSourcePins(
        by_locator=by_locator,
        proofs_by_locator=verified_proofs,
        discard_candidates=frozenset(discard_candidates),
    )


def preflight_production_source_pins(
    production_request: ProductionNestingRequest,
    source_pins: Sequence[PinnedNestingSource],
) -> tuple[VerifiedNestingSourceProof, ...]:
    """Verify exact pin set trước solve/render nhưng chưa chuyển quyền sở hữu."""

    try:
        production = validate_production_request_identity(production_request)
    except ProductionAdapterError as exc:
        raise ManifestContractError(
            "Production request không qua kiểm tra identity trước solve."
        ) from exc
    expectations = _source_expectations(production)
    prepared = _prepare_source_pins(source_pins, expectations)
    return tuple(
        prepared.proofs_by_locator[locator_id]
        for locator_id in sorted(prepared.proofs_by_locator)
    )


def _promote_prepared_sources(prepared: _PreparedSourcePins) -> None:
    """Promote toàn bộ pin trước publish; partial-final để TTL thu hồi an toàn."""

    for locator_id in sorted(prepared.by_locator):
        if not promote_source_pin(prepared.by_locator[locator_id]):
            raise ManifestFingerprintMismatchError(
                "Không promote được toàn bộ source pin trước khi công bố manifest."
            )


def _discard_unpublished_provisional_sources(
    prepared: _PreparedSourcePins,
) -> None:
    """Chỉ thu hồi pin đã chứng minh còn provisional khi chưa bắt đầu promote."""

    for locator_id in prepared.discard_candidates:
        discard_source_pin(prepared.by_locator[locator_id])


def _resolve_stored_sources(
    expectations: Mapping[str, _SourceExpectation],
    *,
    renew: bool,
    inspection_cache: dict[str, tuple[PinnedPageMetadata, ...]] | None = None,
    lease_resolutions: Mapping[str, NestingSourceLeaseResolution] | None = None,
) -> dict[str, ResolvedPinnedSource]:
    """Resolve server-only path; source thiếu/tamper luôn là stale 409."""

    if lease_resolutions is not None and not set(expectations).issubset(
        lease_resolutions
    ):
        raise ManifestFingerprintMismatchError(
            "Batch receipt không phủ đủ source locator của manifest."
        )
    resolved: dict[str, ResolvedPinnedSource] = {}
    try:
        for locator_id in sorted(expectations):
            expected = expectations[locator_id]
            arguments = (
                locator_id,
                expected.descriptor["contentHash"],
                expected.descriptor["byteSize"],
                expected.descriptor["pageCount"],
                expected.pages,
            )
            lease_resolution = (
                None
                if lease_resolutions is None
                else lease_resolutions[locator_id]
            )
            if inspection_cache is None and lease_resolution is None:
                # Giữ contract gọi cũ cho test-double/caller không dùng batch cache.
                resolved[locator_id] = resolve_final_source(
                    *arguments,
                    renew=renew,
                )
            else:
                resolved[locator_id] = resolve_final_source(
                    *arguments,
                    renew=renew,
                    inspection_cache=inspection_cache,
                    lease_resolution=lease_resolution,
                )
    except (KeyError, TypeError, NestingSourceStaleError) as exc:
        raise ManifestFingerprintMismatchError(
            "Source PDF của manifest đã mất, hết hạn hoặc không còn đúng fingerprint."
        ) from exc
    return resolved


def _resolve_preverified_sources(
    expectations: Mapping[str, _SourceExpectation],
    prepared: _PreparedSourcePins,
    *,
    renew: bool,
) -> dict[str, ResolvedPinnedSource]:
    """Hậu kiểm sau publish bằng SHA-256, không parse lại cùng PDF trong transaction."""

    if (
        set(prepared.by_locator) != set(expectations)
        or set(prepared.proofs_by_locator) != set(expectations)
    ):
        raise ManifestFingerprintMismatchError(
            "Proof source pin không khớp exact locator set sau publish."
        )
    resolved: dict[str, ResolvedPinnedSource] = {}
    try:
        for locator_id in sorted(expectations):
            expected = expectations[locator_id]
            resolved[locator_id] = reverify_source_pin(
                prepared.by_locator[locator_id],
                prepared.proofs_by_locator[locator_id],
                expected.descriptor,
                expected.pages,
                require_final=True,
                renew=renew,
            )
    except (KeyError, TypeError, NestingSourceStaleError) as exc:
        raise ManifestFingerprintMismatchError(
            "Source PDF đổi giữa verify, publish và readback manifest."
        ) from exc
    return resolved


def _build_envelope_bytes(
    *,
    production_request: ProductionNestingRequest,
    manifest: Mapping[str, Any],
) -> _ValidatedEnvelopeProof:
    try:
        production = validate_production_request_identity(production_request)
    except ProductionAdapterError as exc:
        raise ManifestContractError(
            "Production request không qua kiểm tra identity dựng lại."
        ) from exc
    detached_manifest = _detach_json_value(manifest, "$.manifest")
    if not isinstance(detached_manifest, dict):
        raise ManifestContractError("Placement manifest phải là một JSON object.")
    _validate_manifest_for_production(detached_manifest, production)

    manifest_id = validate_manifest_id(production.engine_request.get("jobId"))
    layout_fingerprint = validate_layout_fingerprint(
        production.layout_fingerprint
    )
    body = {
        "storageSchemaVersion": NESTING_MANIFEST_STORE_SCHEMA_VERSION,
        "manifestId": manifest_id,
        "layoutFingerprint": layout_fingerprint,
        "manifest": detached_manifest,
        "productionRequest": _production_payload(production),
    }
    content_sha256 = hashlib.sha256(canonical_json_bytes(body)).hexdigest()
    canonical = canonical_json_bytes({**body, "contentSha256": content_sha256})
    # PERF (audit 2026-09-01 §PERF-NEST-02): proof bind exact canonical bytes
    # chỉ được sinh sau full native validation ở trên. Nó không được serialize và
    # generic load/process khác vẫn bắt buộc chạy validator đầy đủ.
    return _ValidatedEnvelopeProof(
        canonical_bytes=canonical,
        manifest_id=manifest_id,
        layout_fingerprint=layout_fingerprint,
        native_build_identity=production.native_build_identity,
    )


def _is_reparse_point(path: Path) -> bool:
    """Nhận cả symlink POSIX lẫn Windows reparse point/junction khi runtime hỗ trợ."""

    try:
        if path.is_symlink():
            return True
        file_attributes = getattr(path.lstat(), "st_file_attributes", 0)
    except FileNotFoundError:
        return False
    except OSError as exc:
        raise ManifestPathUnsafeError(f"Không kiểm tra được đường dẫn kho: {path}") from exc
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    return bool(file_attributes & reparse_flag)


def _assert_no_reparse_chain(path: Path) -> None:
    """Fail-closed nếu bất kỳ thành phần đang tồn tại nào là symlink/junction."""

    absolute = Path(os.path.abspath(os.fspath(path)))
    current = Path(absolute.anchor)
    for part in absolute.parts[1:]:
        current /= part
        if os.path.lexists(current) and _is_reparse_point(current):
            raise ManifestPathUnsafeError(
                f"Đường dẫn kho manifest đi qua symlink/junction: {current}"
            )


def _regular_manifest_file_size(path: Path) -> int:
    """Kiểm đường/file trước khi dùng kích thước để lập ngân sách batch."""
    _assert_no_reparse_chain(path)
    try:
        metadata = path.lstat()
    except FileNotFoundError as exc:
        raise ManifestNotFoundError(path.name) from exc
    except OSError as exc:
        raise ManifestIntegrityError("Không kiểm tra được file manifest.") from exc
    if not stat.S_ISREG(metadata.st_mode):
        raise ManifestIntegrityError("Đích manifest không phải file thường.")
    return metadata.st_size


def _read_regular_file(path: Path, *, expected_size: int | None = None) -> bytes:
    """Đọc file thường; batch ràng buộc size trước cấp phát và kiểm lại bytes."""

    size = _regular_manifest_file_size(path)
    if expected_size is not None and size != expected_size:
        raise ManifestIntegrityError("File manifest đổi kích thước trong khi nạp batch.")

    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except FileNotFoundError as exc:
        raise ManifestNotFoundError(path.name) from exc
    except OSError as exc:
        raise ManifestIntegrityError("Không mở được file manifest an toàn.") from exc
    with os.fdopen(descriptor, "rb") as stream:
        opened = os.fstat(stream.fileno())
        if not stat.S_ISREG(opened.st_mode):
            raise ManifestIntegrityError("File manifest đổi loại trong lúc đọc.")
        if expected_size is None:
            return stream.read()
        if opened.st_size != expected_size:
            raise ManifestIntegrityError("File manifest đổi kích thước trước khi đọc.")
        payload = stream.read(expected_size + 1)
        if len(payload) != expected_size:
            raise ManifestIntegrityError("File manifest đổi kích thước trong khi đọc.")
        return payload


def _fsync_directory(path: Path) -> None:
    """Flush metadata thư mục khi nền tảng cho phép mở directory handle."""

    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    descriptor: int | None = None
    try:
        descriptor = os.open(path, flags)
        os.fsync(descriptor)
    except OSError:
        # Windows không cho fsync directory bằng API POSIX; file data đã fsync
        # trước publish và os.link vẫn bảo đảm no-replace nguyên tử trên NTFS.
        return
    finally:
        if descriptor is not None:
            os.close(descriptor)


def _decode_record_core(
    payload: bytes,
    *,
    expected_manifest_id: str,
    expected_layout_fingerprint: str,
    validated_envelope: _ValidatedEnvelopeProof | None = None,
) -> _DecodedManifestRecord:
    """Parse/full-validate envelope nhưng chưa tra source lease/path."""

    if validated_envelope is not None and (
        not isinstance(validated_envelope, _ValidatedEnvelopeProof)
        or validated_envelope.canonical_bytes != payload
        or validated_envelope.manifest_id != expected_manifest_id
        or validated_envelope.layout_fingerprint != expected_layout_fingerprint
    ):
        raise ManifestIntegrityError(
            "Proof native validation không khớp exact canonical envelope."
        )

    try:
        envelope = json.loads(payload.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise ManifestIntegrityError("File manifest không phải JSON UTF-8 hợp lệ.") from exc
    if not isinstance(envelope, dict):
        raise ManifestIntegrityError("Envelope manifest không phải JSON object.")

    expected_keys: set[str] = {
        "storageSchemaVersion",
        "manifestId",
        "layoutFingerprint",
        "contentSha256",
        "manifest",
        "productionRequest",
    }
    if set(envelope) != expected_keys:
        raise ManifestIntegrityError("Envelope manifest có tập trường không hợp lệ.")
    if envelope.get("storageSchemaVersion") != NESTING_MANIFEST_STORE_SCHEMA_VERSION:
        raise ManifestIntegrityError("Store schema của manifest không được hỗ trợ.")
    if canonical_json_bytes(envelope) != payload:
        raise ManifestIntegrityError("File manifest không còn ở dạng canonical.")

    stored_manifest_id = envelope.get("manifestId")
    stored_fingerprint = envelope.get("layoutFingerprint")
    if stored_manifest_id != expected_manifest_id:
        raise ManifestIntegrityError("manifestId trong envelope không khớp tên file.")
    if stored_fingerprint != expected_layout_fingerprint:
        raise ManifestFingerprintMismatchError(
            "Manifest tồn tại nhưng layoutFingerprint không khớp request hiện tại."
        )

    content_sha256 = envelope.get("contentSha256")
    if not isinstance(content_sha256, str) or not _CONTENT_SHA256_PATTERN.fullmatch(
        content_sha256
    ):
        raise ManifestIntegrityError("contentSha256 của manifest không hợp lệ.")
    body = {key: envelope[key] for key in expected_keys if key != "contentSha256"}
    actual_sha256 = hashlib.sha256(canonical_json_bytes(body)).hexdigest()
    if actual_sha256 != content_sha256:
        raise ManifestIntegrityError("Nội dung manifest/render bundle sai SHA-256.")

    manifest = envelope.get("manifest")
    production_payload = envelope.get("productionRequest")
    if not isinstance(manifest, dict) or not isinstance(production_payload, dict):
        raise ManifestIntegrityError(
            "Manifest hoặc productionRequest không phải JSON object."
        )
    if set(production_payload) != _PRODUCTION_PAYLOAD_FIELDS:
        raise ManifestIntegrityError(
            "productionRequest trong envelope có tập trường không hợp lệ."
        )
    _assert_current_production_schema(production_payload)
    try:
        production = ProductionNestingRequest(
            engine_request=production_payload["engineRequest"],
            render_bundle=production_payload["renderBundle"],
            render_bundle_hash=production_payload["renderBundleHash"],
            input_hash=production_payload["inputHash"],
            solver_config_hash=production_payload["solverConfigHash"],
            geometry_constraints_hash=production_payload[
                "geometryConstraintsHash"
            ],
            layout_fingerprint=production_payload["layoutFingerprint"],
            algorithm_versions=production_payload["algorithmVersions"],
            native_build_identity=production_payload["nativeBuildIdentity"],
        )
        rebuilt = validate_production_request_identity(production)
        if rebuilt.engine_request.get("jobId") != expected_manifest_id:
            raise ManifestContractError("Production request không khớp manifestId.")
        if rebuilt.layout_fingerprint != expected_layout_fingerprint:
            raise ManifestContractError("Production request không khớp fingerprint.")
    except (
        KeyError,
        TypeError,
        ProductionAdapterError,
        ManifestContractError,
    ) as exc:
        raise ManifestIntegrityError(
            "Production request/manifest không dựng lại đúng identity."
        ) from exc


    # NEST (audit 2026-08-28 §MANIFEST.REVALIDATE): build/version stale là trạng
    # thái nghiệp vụ 409, không phải hỏng file. Kiểm ngoài khối bọc integrity và
    # trước native geometry validator để không đánh tráo lỗi thành file corrupt.
    _assert_current_engine_snapshot(rebuilt)
    if validated_envelope is None:
        try:
            _validate_manifest_for_production(manifest, rebuilt)
        except ManifestContractError as exc:
            raise ManifestIntegrityError(
                "Placement manifest không qua kiểm định production khi đọc lại."
            ) from exc
    elif validated_envelope.native_build_identity != rebuilt.native_build_identity:
        raise ManifestIntegrityError(
            "Proof native validation không khớp build identity của envelope."
        )
    try:
        source_expectations = _source_expectations(rebuilt)
    except ManifestContractError as exc:
        raise ManifestIntegrityError(
            "Render bundle không dựng lại được exact source locator set."
        ) from exc

    return _DecodedManifestRecord(
        manifest_id=expected_manifest_id,
        layout_fingerprint=expected_layout_fingerprint,
        content_sha256=content_sha256,
        manifest=manifest,
        production_request=rebuilt,
        source_expectations=source_expectations,
        canonical_bytes=payload,
    )


def _materialize_decoded_record(
    decoded: _DecodedManifestRecord,
    resolved_sources: dict[str, ResolvedPinnedSource],
) -> StoredNestingManifest:
    return StoredNestingManifest(
        manifest_id=decoded.manifest_id,
        layout_fingerprint=decoded.layout_fingerprint,
        content_sha256=decoded.content_sha256,
        render_bundle_hash=decoded.production_request.render_bundle_hash,
        manifest=decoded.manifest,
        render_bundle=decoded.production_request.render_bundle,
        production_request=decoded.production_request,
        resolved_sources=resolved_sources,
        canonical_bytes=decoded.canonical_bytes,
    )


def _decode_record(
    payload: bytes,
    *,
    expected_manifest_id: str,
    expected_layout_fingerprint: str,
    validated_envelope: _ValidatedEnvelopeProof | None = None,
    prepared_sources: _PreparedSourcePins | None = None,
    source_inspection_cache: dict[
        str, tuple[PinnedPageMetadata, ...]
    ] | None = None,
) -> StoredNestingManifest:
    """Full-validate rồi resolve source cho đường persist/load một manifest."""

    decoded = _decode_record_core(
        payload,
        expected_manifest_id=expected_manifest_id,
        expected_layout_fingerprint=expected_layout_fingerprint,
        validated_envelope=validated_envelope,
    )
    # NEST (audit 2026-08-28 §SOURCE.PIN): path chỉ sống trong object server-side;
    # envelope canonical tuyệt đối không ghi snapshot path hoặc lease token.
    if prepared_sources is not None and prepared_sources.proofs_by_locator:
        # PERF (audit 2026-09-01 §PERF-NEST-02): readback cùng transaction
        # băm lại từng snapshot sau publish nhưng không inspect lại metadata đã
        # được full-verify ở preflight. Load độc lập/process khác vẫn đi nhánh dưới.
        resolved_sources = _resolve_preverified_sources(
            decoded.source_expectations,
            prepared_sources,
            renew=True,
        )
    else:
        resolved_sources = _resolve_stored_sources(
            decoded.source_expectations,
            renew=True,
            inspection_cache=source_inspection_cache,
        )
    return _materialize_decoded_record(decoded, resolved_sources)


class NestingManifestStore:
    """Kho disk bất biến; mỗi ``manifestId`` chỉ được công bố đúng một nội dung."""

    def __init__(self, *, root: Path | None = None) -> None:
        candidate = root if root is not None else resolve_artifact_root() / MANIFEST_DIRECTORY_NAME
        candidate = Path(candidate)
        _assert_no_reparse_chain(candidate)
        self._root = assert_root_safe(candidate)
        _assert_no_reparse_chain(self._root)

    @property
    def root(self) -> Path:
        return self._root

    def _checked_root(self, *, create: bool) -> Path:
        """Kiểm lại root ở mỗi lần dùng để bắt symlink bị thay sau khởi tạo."""

        _assert_no_reparse_chain(self._root)
        assert_root_safe(self._root)
        if create:
            self._root.mkdir(parents=True, exist_ok=True)
            _assert_no_reparse_chain(self._root)
        if self._root.exists() and not self._root.is_dir():
            raise ManifestPathUnsafeError("Root kho manifest không phải thư mục.")
        return self._root

    @staticmethod
    def _path_for_validated_id(root: Path, manifest_id: str) -> Path:
        """Chỉ nhận ID đã qua regex; không bao giờ nối path từ dữ liệu tùy ý."""

        return root / f"{manifest_id}.json"

    def persist(
        self,
        *,
        production_request: ProductionNestingRequest,
        manifest: Mapping[str, Any],
        source_pins: Sequence[PinnedNestingSource],
        source_proofs: Sequence[VerifiedNestingSourceProof] | None = None,
    ) -> StoredNestingManifest:
        """Công bố nguyên tử hoặc trả idempotent nếu canonical bytes đã tồn tại.

        Cùng ID nhưng khác dù chỉ một byte canonical sẽ raise
        :class:`ManifestConflictError`; store không bao giờ ghi đè manifest đã công bố.
        """

        # NEST (audit 2026-08-27 §MANIFEST.STORE): store chỉ nhận request đã
        # adapter validate; không ghép các dict/hash rời có thể thuộc hai lần solve.
        try:
            production = validate_production_request_identity(production_request)
        except ProductionAdapterError as exc:
            raise ManifestContractError(
                "Production request không qua kiểm tra identity dựng lại."
            ) from exc
        checked_id = validate_manifest_id(production.engine_request.get("jobId"))
        checked_fingerprint = validate_layout_fingerprint(
            production.layout_fingerprint
        )
        expectations = _source_expectations(production)
        prepared_sources = _prepare_source_pins(
            source_pins,
            expectations,
            source_proofs,
        )
        try:
            validated_envelope = _build_envelope_bytes(
                production_request=production,
                manifest=manifest,
            )
            canonical = validated_envelope.canonical_bytes
        except Exception:
            # NEST (audit 2026-08-28 §SOURCE.PIN): contract hỏng trước promote
            # vẫn thuộc lượt solve này nên thu hồi đúng provisional pin bằng token.
            _discard_unpublished_provisional_sources(prepared_sources)
            raise

        # Promote trước mọi nhánh publish. Từ mốc này không discard khi conflict/
        # IO fail: pin có thể đã final một phần hoặc đang được manifest khác dùng;
        # TTL final sẽ thu hồi orphan an toàn.
        _promote_prepared_sources(prepared_sources)

        with _WRITE_LOCK:
            root = self._checked_root(create=True)
            target = self._path_for_validated_id(root, checked_id)
            if os.path.lexists(target):
                existing = _read_regular_file(target)
                if existing != canonical:
                    raise ManifestConflictError(
                        "manifestId đã được công bố với nội dung khác; từ chối ghi đè."
                    )
                return _decode_record(
                    existing,
                    expected_manifest_id=checked_id,
                    expected_layout_fingerprint=checked_fingerprint,
                    validated_envelope=validated_envelope,
                    prepared_sources=prepared_sources,
                )

            temporary = root / (
                f".{checked_id}.{os.getpid()}.{threading.get_ident()}."
                f"{secrets.token_hex(8)}.tmp"
            )
            descriptor: int | None = None
            try:
                flags = (
                    os.O_WRONLY
                    | os.O_CREAT
                    | os.O_EXCL
                    | getattr(os, "O_BINARY", 0)
                )
                descriptor = os.open(temporary, flags, 0o600)
                with os.fdopen(descriptor, "wb") as stream:
                    descriptor = None
                    stream.write(canonical)
                    stream.flush()
                    os.fsync(stream.fileno())

                # NEST (audit 2026-08-27 §MANIFEST.STORE): hard-link cùng thư mục
                # là primitive publish no-replace giữa mọi process. Tuyệt đối không
                # check-then-os.replace vì process đến sau có thể ghi đè winner.
                _assert_no_reparse_chain(root)
                try:
                    os.link(temporary, target, follow_symlinks=False)
                except FileExistsError:
                    existing = _read_regular_file(target)
                    if existing != canonical:
                        raise ManifestConflictError(
                            "manifestId vừa được công bố với nội dung khác."
                        )
                    return _decode_record(
                        existing,
                        expected_manifest_id=checked_id,
                        expected_layout_fingerprint=checked_fingerprint,
                        validated_envelope=validated_envelope,
                        prepared_sources=prepared_sources,
                    )
                except OSError as exc:
                    raise ManifestIntegrityError(
                        "Không thể công bố manifest bằng primitive no-replace nguyên tử."
                    ) from exc
                _fsync_directory(root)
            finally:
                if descriptor is not None:
                    os.close(descriptor)
                try:
                    temporary.unlink(missing_ok=True)
                except OSError:
                    pass

            readback = _read_regular_file(target)
            if readback != canonical:
                raise ManifestIntegrityError(
                    "Đọc lại sau publish không khớp canonical bytes đã ghi."
                )
            return _decode_record(
                readback,
                expected_manifest_id=checked_id,
                expected_layout_fingerprint=checked_fingerprint,
                validated_envelope=validated_envelope,
                prepared_sources=prepared_sources,
            )

    def load(
        self,
        *,
        manifest_id: str,
        layout_fingerprint: str,
    ) -> StoredNestingManifest:
        """Đọc bắt buộc bằng đúng cặp ``manifestId + layoutFingerprint``."""

        # NEST (audit 2026-08-27 §MANIFEST.STORE): không lookup bằng ID mơ hồ.
        checked_id = validate_manifest_id(manifest_id)
        checked_fingerprint = validate_layout_fingerprint(layout_fingerprint)
        root = self._checked_root(create=False)
        if not root.exists():
            raise ManifestNotFoundError(checked_id)
        target = self._path_for_validated_id(root, checked_id)
        payload = _read_regular_file(target)
        return _decode_record(
            payload,
            expected_manifest_id=checked_id,
            expected_layout_fingerprint=checked_fingerprint,
        )

    def load_many(
        self,
        references: Sequence[Mapping[str, Any]],
    ) -> tuple[StoredNestingManifest, ...]:
        """Nạp batch reference bằng locator O(1); marker v1 quét tối đa một lượt.

        Mỗi envelope vẫn canonical/hash/native-validate độc lập. Batch chỉ chia sẻ
        Bước locator→receipt server-only dùng marker authoritative deterministic;
        chỉ kho legacy mới fallback scan. Cache metadata sau SHA-256 không sống
        qua request/process và không làm yếu chốt tamper/expiry.
        """

        try:
            raw_references = tuple(references)
        except TypeError as exc:
            raise ManifestContractError(
                "references phải là một sequence hữu hạn."
            ) from exc
        checked: list[tuple[str, str]] = []
        for offset, reference in enumerate(raw_references):
            if not isinstance(reference, Mapping):
                raise ManifestContractError(
                    f"references[{offset}] không phải object identity."
                )
            checked.append(
                (
                    validate_manifest_id(reference.get("manifestId")),
                    validate_layout_fingerprint(
                        reference.get("layoutFingerprint")
                    ),
                )
            )
        if not checked:
            return ()

        root = self._checked_root(create=False)
        if not root.exists():
            raise ManifestNotFoundError(checked[0][0])
        from contextlib import nullcontext
        from app.core.nesting_manifest_batch import (
            ManifestBatchIntegrityError,
            decode_manifest_batch,
        )

        def _path(reference: tuple[str, str]) -> Path:
            return self._path_for_validated_id(root, reference[0])

        def _decode(reference: tuple[str, str], payload: bytes) -> _DecodedManifestRecord:
            # PERF (audit 2026-09-07 §TEMPERF.F): không truyền proof để bỏ qua
            # native validator. Mọi record vẫn đi nguyên đường kiểm định cũ.
            return _decode_record_core(
                payload,
                expected_manifest_id=reference[0],
                expected_layout_fingerprint=reference[1],
            )

        if len(checked) == 1:
            # Một record không có việc để song song; giữ fast path cũ, không
            # trả thêm phí prepass/executor cho caller đơn.
            decoded_context = nullcontext([
                _decode(checked[0], _read_regular_file(_path(checked[0])))
            ])
        else:
            decoded_context = decode_manifest_batch(
                checked,
                get_size=lambda ref: _regular_manifest_file_size(_path(ref)),
                read_payload=lambda ref, size: _read_regular_file(
                    _path(ref), expected_size=size,
                ),
                decode=_decode,
            )
        try:
            with decoded_context as decoded_records:
                locator_ids: set[str] = set()
                for decoded in decoded_records:
                    locator_ids.update(decoded.source_expectations)
                # Chỉ đi tới source/lease sau khi TẤT CẢ record đã đạt. CPU đã
                # nhả nhưng reservation vẫn tính các cây decoded còn giữ trong RAM.
                lease_resolutions = resolve_nesting_source_leases(
                    tuple(sorted(locator_ids)),
                    require_final=True,
                )
                if lease_resolutions is None or set(lease_resolutions) != locator_ids:
                    raise ManifestFingerprintMismatchError(
                        "Batch source pin final đã mất, trùng locator hoặc hết hạn."
                    )

                inspection_cache: dict[str, tuple[PinnedPageMetadata, ...]] = {}
                stored: list[StoredNestingManifest] = []
                for decoded in decoded_records:
                    resolved_sources = _resolve_stored_sources(
                        decoded.source_expectations,
                        renew=True,
                        inspection_cache=inspection_cache,
                        lease_resolutions=lease_resolutions,
                    )
                    stored.append(_materialize_decoded_record(decoded, resolved_sources))
                return tuple(stored)
        except ManifestBatchIntegrityError as exc:
            raise ManifestIntegrityError(str(exc)) from exc

    def close(self) -> None:
        """Không có tài nguyên nền để đóng; chủ đích không dọn final manifest."""

        # NEST (audit 2026-08-27 §MANIFEST.STORE): manifest phải sống qua shutdown/restart.
        return None
