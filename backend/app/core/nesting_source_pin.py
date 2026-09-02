"""Snapshot PDF bất biến cho manifest nesting Tem bế/CNC.

Nguồn renderer được copy sang inode mới, băm trong lúc copy và giữ bằng lease
trên đĩa. Manifest chỉ lưu locator/hash/metadata; tuyệt đối không lưu path/token.
"""

from __future__ import annotations

import hashlib
import math
import os
import stat
import tempfile
import uuid
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation, ROUND_HALF_EVEN, localcontext
from pathlib import Path
from typing import Any, BinaryIO, Callable, Mapping, Sequence

import pikepdf

from app.config import settings
from app.core import artifact_lease as artifact_lease_module
from app.core.artifact_lease import (
    ARTIFACT_INITIAL_LEASE_SECONDS,
    discard_artifact_lease,
    create_artifact_lease,
    promote_artifact_lease,
    refresh_resolved_nesting_source_lease,
    renew_resolved_nesting_source_lease,
    resolve_nesting_source_lease,
    resolve_nesting_source_lease_token,
)
from app.core.source_revision import (
    SourceFingerprint,
    assert_source_fingerprint_stat,
)
from app.database import SessionLocal
from app.models.job import UploadedFile


_PT_TO_MM = Decimal("25.4") / Decimal("72")
_QUANTUM = Decimal("0.000001")
_COPY_CHUNK_BYTES = 1024 * 1024


class NestingSourcePinError(ValueError):
    """Không thể tạo snapshot trước solve."""

    code = "NESTING_SOURCE_PIN_INVALID"
    status_code = 422


class NestingSourceStaleError(RuntimeError):
    """Nguồn của manifest đã mất hoặc không còn khớp snapshot."""

    code = "LAYOUT_MANIFEST_STALE"
    status_code = 409


@dataclass(frozen=True)
class PinnedPageMetadata:
    page_index: int
    page_boxes_mm: dict[str, list[float]]
    user_unit: float
    rotate_deg: int
    source_page_to_canonical: tuple[float, float, float, float, float, float]

    def to_binding_metadata(self) -> dict[str, Any]:
        return {
            "pageIndex": self.page_index,
            "pageBoxesMm": {
                key: list(value) for key, value in self.page_boxes_mm.items()
            },
            "userUnit": self.user_unit,
            "rotateDeg": self.rotate_deg,
            "sourcePageToCanonical": list(self.source_page_to_canonical),
        }


@dataclass(frozen=True)
class PinnedNestingSource:
    locator_id: str
    content_hash: str
    byte_size: int
    page_count: int
    revision: str
    pages: tuple[PinnedPageMetadata, ...]
    snapshot_path: Path
    lease_token: str
    lease_resolution: (
        artifact_lease_module.NestingSourceLeaseResolution | None
    ) = None


@dataclass(frozen=True)
class ResolvedPinnedSource:
    locator_id: str
    content_hash: str
    byte_size: int
    page_count: int
    revision: str
    pages: tuple[PinnedPageMetadata, ...]
    path: Path


@dataclass(frozen=True)
class VerifiedNestingSourceProof:
    """Bằng chứng full hash + inspect của đúng một source pin trong process hiện tại.

    Proof không thay SHA-256 ở lần dùng sau. Nó chỉ cho phép tái dùng metadata PDF
    khi snapshot vừa được băm lại và vẫn đúng cùng digest bất biến.
    """

    locator_id: str
    content_hash: str
    byte_size: int
    page_count: int
    revision: str
    pages: tuple[PinnedPageMetadata, ...]
    snapshot_path: Path
    lease_token: str
    lease_resolution: artifact_lease_module.NestingSourceLeaseResolution


def _q(value: Any, field: str) -> float:
    if isinstance(value, bool):
        raise ValueError(f"{field} phải là số hữu hạn.")
    try:
        decimal_value = Decimal(str(value))
        if not decimal_value.is_finite():
            raise ValueError(f"{field} phải là số hữu hạn.")
        with localcontext() as context:
            context.prec = max(50, len(decimal_value.as_tuple().digits) + 24)
            rounded = decimal_value.quantize(_QUANTUM, rounding=ROUND_HALF_EVEN)
    except (InvalidOperation, TypeError, ValueError, OverflowError) as exc:
        raise ValueError(f"{field} không thể chuẩn hoá 6 chữ số.") from exc
    result = float(rounded)
    return 0.0 if result == 0.0 else result


def _canonical_uuid(value: Any, field: str) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{field} phải là UUID canonical.")
    try:
        canonical = str(uuid.UUID(value))
    except (ValueError, AttributeError) as exc:
        raise ValueError(f"{field} phải là UUID canonical.") from exc
    if value != canonical:
        raise ValueError(f"{field} phải là UUID canonical chữ thường.")
    return canonical


def _is_reparse_point(path: Path) -> bool:
    try:
        if path.is_symlink():
            return True
        attributes = getattr(path.lstat(), "st_file_attributes", 0)
    except FileNotFoundError:
        return False
    flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    return bool(attributes & flag)


def _assert_no_reparse_chain(path: Path) -> None:
    absolute = Path(os.path.abspath(os.fspath(path)))
    current = Path(absolute.anchor)
    for part in absolute.parts[1:]:
        current /= part
        if os.path.lexists(current) and _is_reparse_point(current):
            raise NestingSourcePinError(
                f"Đường dẫn source pin đi qua symlink/junction: {current}"
            )


def _stat_identity(value: os.stat_result) -> tuple[int, int, int, int, int]:
    return (
        int(value.st_dev),
        int(value.st_ino),
        int(value.st_size),
        int(value.st_mtime_ns),
        int(value.st_ctime_ns),
    )


def _fsync_directory(path: Path) -> None:
    descriptor: int | None = None
    try:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        os.fsync(descriptor)
    except OSError:
        return
    finally:
        if descriptor is not None:
            os.close(descriptor)


def _copy_snapshot(
    source: Path,
    target: Path,
    *,
    expected_fingerprint: SourceFingerprint | None = None,
) -> tuple[str, int]:
    _assert_no_reparse_chain(source)
    _assert_no_reparse_chain(target.parent)
    source_flags = (
        os.O_RDONLY
        | getattr(os, "O_BINARY", 0)
        | getattr(os, "O_NOFOLLOW", 0)
    )
    target_flags = (
        os.O_WRONLY
        | os.O_CREAT
        | os.O_EXCL
        | getattr(os, "O_BINARY", 0)
    )
    source_fd: int | None = None
    target_fd: int | None = None
    try:
        source_fd = os.open(source, source_flags)
        before = os.fstat(source_fd)
        if not stat.S_ISREG(before.st_mode):
            raise NestingSourcePinError("Nguồn pin không phải file thường.")
        if expected_fingerprint is not None:
            # NESTING (audit 2026-08-28 §SOURCE.2): khóa đúng revision trên FD
            # trước khi tạo target để job chờ lâu không pin nhầm file mới cùng path.
            assert_source_fingerprint_stat(expected_fingerprint, source, before)
        target_fd = os.open(target, target_flags, 0o600)
        target_open = os.fstat(target_fd)
        if (
            not stat.S_ISREG(target_open.st_mode)
            or (target_open.st_dev, target_open.st_ino)
            == (before.st_dev, before.st_ino)
        ):
            raise NestingSourcePinError("Snapshot phải là inode/file mới độc lập.")

        digest = hashlib.sha256()
        copied = 0
        while True:
            chunk = os.read(source_fd, _COPY_CHUNK_BYTES)
            if not chunk:
                break
            digest.update(chunk)
            view = memoryview(chunk)
            while view:
                written = os.write(target_fd, view)
                if written <= 0:
                    raise OSError("Không ghi được snapshot nesting.")
                view = view[written:]
            copied += len(chunk)
        os.fsync(target_fd)
        after = os.fstat(source_fd)
        target_after = os.fstat(target_fd)
        try:
            path_after = source.stat(follow_symlinks=False)
        except OSError as exc:
            raise NestingSourcePinError(
                "Đường dẫn PDF nguồn đổi trong lúc tạo snapshot."
            ) from exc
        if (
            _stat_identity(before) != _stat_identity(after)
            or _stat_identity(before) != _stat_identity(path_after)
        ):
            raise NestingSourcePinError("PDF nguồn đổi trong lúc tạo snapshot.")
        if copied != before.st_size or target_after.st_size != copied:
            raise NestingSourcePinError("Kích thước snapshot không khớp nguồn.")
        return "sha256:" + digest.hexdigest(), copied
    finally:
        if target_fd is not None:
            os.close(target_fd)
        if source_fd is not None:
            os.close(source_fd)


def _inherited(page: pikepdf.Page, key: str) -> Any:
    current: Any = page.obj
    seen: set[tuple[int, int] | int] = set()
    for _depth in range(64):
        marker = getattr(current, "objgen", None)
        marker = marker if marker and marker != (0, 0) else id(current)
        if marker in seen:
            raise ValueError(f"Pages tree lặp khi đọc {key}.")
        seen.add(marker)
        value = current.get(key)
        if value is not None:
            return value
        current = current.get("/Parent")
        if current is None:
            return None
    raise ValueError("Pages tree vượt giới hạn kế thừa.")


def _raw_box(value: Any, field: str) -> tuple[float, float, float, float]:
    try:
        items = list(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field} không phải PageBox.") from exc
    if len(items) != 4:
        raise ValueError(f"{field} phải có bốn toạ độ.")
    coordinates = tuple(float(item) for item in items)
    if not all(math.isfinite(item) for item in coordinates):
        raise ValueError(f"{field} chứa số không hữu hạn.")
    if coordinates[2] <= coordinates[0] or coordinates[3] <= coordinates[1]:
        raise ValueError(f"{field} có chiều rộng/chiều cao không dương.")
    return coordinates


def _physical_box(
    box: tuple[float, float, float, float], user_unit: float, field: str
) -> list[float]:
    scale = Decimal(str(user_unit)) * _PT_TO_MM
    return [
        _q(Decimal(str(value)) * scale, f"{field}[{index}]")
        for index, value in enumerate(box)
    ]


def _source_affine(
    media_box_mm: Sequence[float], rotation: int
) -> tuple[float, float, float, float, float, float]:
    x0, y0, x1, y1 = media_box_mm
    if rotation == 0:
        values = (1.0, 0.0, 0.0, 1.0, -x0, -y0)
    elif rotation == 90:
        values = (0.0, -1.0, 1.0, 0.0, -y0, x1)
    elif rotation == 180:
        values = (-1.0, 0.0, 0.0, -1.0, x1, y1)
    else:
        values = (0.0, 1.0, -1.0, 0.0, y1, -x0)
    return tuple(_q(value, f"sourcePageToCanonical[{index}]") for index, value in enumerate(values))


def _inspect_pdf(
    path: str | os.PathLike[str] | BinaryIO,
) -> tuple[PinnedPageMetadata, ...]:
    try:
        pdf = pikepdf.Pdf.open(path)
    except Exception as exc:
        raise ValueError("Không mở được PDF snapshot bằng parser strict.") from exc
    try:
        if len(pdf.pages) <= 0:
            raise ValueError("PDF snapshot không có trang.")
        pages: list[PinnedPageMetadata] = []
        for page_index, page in enumerate(pdf.pages):
            raw_media = _inherited(page, "/MediaBox")
            if raw_media is None:
                raise ValueError(f"Trang {page_index + 1} thiếu MediaBox.")
            media = _raw_box(raw_media, f"pages[{page_index}].MediaBox")
            raw_crop = _inherited(page, "/CropBox")
            crop = media if raw_crop is None else _raw_box(
                raw_crop, f"pages[{page_index}].CropBox"
            )
            raw_trim = _inherited(page, "/TrimBox")
            trim = crop if raw_trim is None else _raw_box(
                raw_trim, f"pages[{page_index}].TrimBox"
            )

            raw_user_unit = page.obj.get("/UserUnit", 1)
            user_unit = _q(float(raw_user_unit), f"pages[{page_index}].UserUnit")
            if not 0.0 < user_unit <= 75000.0:
                raise ValueError(f"Trang {page_index + 1} có UserUnit ngoài miền.")
            raw_rotation = _inherited(page, "/Rotate")
            raw_rotation = 0 if raw_rotation is None else raw_rotation
            rotation_float = float(raw_rotation)
            rounded_rotation = round(rotation_float)
            if (
                not math.isfinite(rotation_float)
                or abs(rotation_float - rounded_rotation) > 1e-9
                or rounded_rotation % 90 != 0
            ):
                raise ValueError(f"Trang {page_index + 1} có Rotate không hợp lệ.")
            rotation = int(rounded_rotation) % 360
            boxes = {
                "mediaBox": _physical_box(
                    media, user_unit, f"pages[{page_index}].mediaBox"
                ),
                "cropBox": _physical_box(
                    crop, user_unit, f"pages[{page_index}].cropBox"
                ),
                "trimBox": _physical_box(
                    trim, user_unit, f"pages[{page_index}].trimBox"
                ),
            }
            pages.append(
                PinnedPageMetadata(
                    page_index=page_index,
                    page_boxes_mm=boxes,
                    user_unit=user_unit,
                    rotate_deg=rotation,
                    source_page_to_canonical=_source_affine(
                        boxes["mediaBox"], rotation
                    ),
                )
            )
        return tuple(pages)
    finally:
        pdf.close()


def _hash_file(
    path: Path,
    *,
    copy_to: BinaryIO | None = None,
) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode):
            raise NestingSourceStaleError("Snapshot không còn là file thường.")
        while True:
            chunk = os.read(descriptor, _COPY_CHUNK_BYTES)
            if not chunk:
                break
            digest.update(chunk)
            if copy_to is not None:
                view = memoryview(chunk)
                while view:
                    written = copy_to.write(view)
                    if written is None or written <= 0:
                        raise OSError("Không sao chép được snapshot để inspect ổn định.")
                    view = view[written:]
            size += len(chunk)
        # PERF/SEC (audit 2026-09-01 §PERF-NEST-02): proof digest phải bind
        # đúng file còn nằm tại locator, không chỉ inode mà FD đã mở trước khi path
        # bị thay. Đây là TOCTOU fence; tuyệt đối không dùng stat thay cho SHA-256.
        after = os.fstat(descriptor)
        path_after = path.stat(follow_symlinks=False)
        if (
            _stat_identity(before) != _stat_identity(after)
            or _stat_identity(before) != _stat_identity(path_after)
            or size != before.st_size
        ):
            raise NestingSourceStaleError("Snapshot đổi trong lúc băm SHA-256.")
    finally:
        os.close(descriptor)
    return "sha256:" + digest.hexdigest(), size


def source_descriptor(
    source: PinnedNestingSource | ResolvedPinnedSource,
) -> dict[str, Any]:
    return {
        "locatorId": source.locator_id,
        "contentHash": source.content_hash,
        "byteSize": source.byte_size,
        "pageCount": source.page_count,
        "revision": source.revision,
    }


def _expected_page_map(
    expected_pages: Sequence[Mapping[str, Any]],
) -> dict[int, dict[str, Any]]:
    result: dict[int, dict[str, Any]] = {}
    for offset, raw in enumerate(expected_pages):
        if not isinstance(raw, Mapping):
            raise NestingSourceStaleError(f"PageBinding[{offset}] không hợp lệ.")
        page_index = raw.get("pageIndex")
        if isinstance(page_index, bool) or not isinstance(page_index, int):
            raise NestingSourceStaleError("pageIndex nguồn không hợp lệ.")
        required = (
            "pageBoxesMm",
            "userUnit",
            "rotateDeg",
            "sourcePageToCanonical",
        )
        if any(key not in raw for key in required):
            raise NestingSourceStaleError("PageBinding thiếu metadata nguồn.")
        normalized = {
            "pageIndex": page_index,
            "pageBoxesMm": raw["pageBoxesMm"],
            "userUnit": raw["userUnit"],
            "rotateDeg": raw["rotateDeg"],
            "sourcePageToCanonical": raw["sourcePageToCanonical"],
        }
        previous = result.setdefault(page_index, normalized)
        if previous != normalized:
            raise NestingSourceStaleError("Cùng source page có metadata mâu thuẫn.")
    return result


def _assert_verified_snapshot(
    *,
    content_hash: str,
    byte_size: int,
    pages: tuple[PinnedPageMetadata, ...],
    expected_source: Mapping[str, Any],
    expected_pages: Sequence[Mapping[str, Any]],
) -> None:
    actual = {
        "locatorId": expected_source.get("locatorId"),
        "contentHash": content_hash,
        "byteSize": byte_size,
        "pageCount": len(pages),
        "revision": content_hash,
    }
    if dict(expected_source) != actual:
        raise NestingSourceStaleError("Descriptor source pin không còn khớp.")
    expected_map = _expected_page_map(expected_pages)
    actual_map = {page.page_index: page.to_binding_metadata() for page in pages}
    for page_index, expected in expected_map.items():
        if page_index not in actual_map or actual_map[page_index] != expected:
            raise NestingSourceStaleError(
                f"Metadata source page {page_index} không còn khớp."
            )


def _verify_snapshot(
    path: Path,
    *,
    expected_source: Mapping[str, Any],
    expected_pages: Sequence[Mapping[str, Any]],
    inspection_cache: dict[str, tuple[PinnedPageMetadata, ...]] | None = None,
) -> tuple[str, int, tuple[PinnedPageMetadata, ...]]:
    try:
        # PERF/SEC (audit 2026-09-01 §PERF-NEST-02): parser chỉ đọc đúng chuỗi
        # byte vừa được SHA-256, không mở lại path trong khe TOCTOU hash→inspect.
        # TemporaryFile để OS tự quản page cache, tránh giữ PDF tối đa 500 MB ×
        # nhiều lane trong heap Python. Băm hậu kiểm path bắt cả tamper cùng
        # size/mtime xảy ra trong lúc parser đang đọc bản sao ổn định.
        with tempfile.TemporaryFile(mode="w+b") as stable_snapshot:
            content_hash, byte_size = _hash_file(
                path,
                copy_to=stable_snapshot,
            )
            stable_snapshot.flush()
            stable_snapshot.seek(0)
            pages = (
                inspection_cache.get(content_hash)
                if inspection_cache is not None
                else None
            )
            if pages is None:
                pages = _inspect_pdf(stable_snapshot)
        after_hash, after_size = _hash_file(path)
        if after_hash != content_hash or after_size != byte_size:
            raise NestingSourceStaleError(
                "Snapshot đổi giữa lúc băm SHA-256 và inspect PDF."
            )
    except NestingSourceStaleError:
        raise
    except (
        OSError,
        TypeError,
        ValueError,
        OverflowError,
        RuntimeError,
        pikepdf.PdfError,
    ) as exc:
        raise NestingSourceStaleError(
            "Snapshot PDF đã mất, hỏng hoặc không còn đọc được."
        ) from exc
    _assert_verified_snapshot(
        content_hash=content_hash,
        byte_size=byte_size,
        pages=pages,
        expected_source=expected_source,
        expected_pages=expected_pages,
    )
    if inspection_cache is not None:
        cached = inspection_cache.setdefault(content_hash, pages)
        if cached != pages:  # pragma: no cover - cache chỉ sống trong một batch load
            raise NestingSourceStaleError(
                "Cache inspect source có metadata mâu thuẫn cho cùng SHA-256."
            )
    return content_hash, byte_size, pages


def pin_pdf_path(
    source_path: str | os.PathLike[str],
    *,
    expected_fingerprint: SourceFingerprint | None = None,
) -> PinnedNestingSource:
    """Pin một PDF nội bộ đã qua chính sách path của workflow Imposition.

    API này không nhận locator_id, nơi lưu hay TTL từ caller. Mọi identity và
    lease vẫn do server sinh; _copy_snapshot tiếp tục là chốt chống TOCTOU,
    symlink/junction và thay đổi file trong lúc băm/copy.
    """

    try:
        source = Path(os.path.abspath(os.fspath(source_path)))
    except (TypeError, ValueError, OSError) as exc:
        raise NestingSourcePinError("Đường dẫn PDF nguồn cần pin không hợp lệ.") from exc
    if source.suffix.lower() != ".pdf":
        raise NestingSourcePinError("Nguồn pin phải là file PDF.")
    if expected_fingerprint is not None and not isinstance(
        expected_fingerprint, SourceFingerprint
    ):
        raise TypeError("expected_fingerprint phải là SourceFingerprint hoặc None.")

    upload_root = Path(os.path.abspath(os.fspath(settings.UPLOAD_DIR)))
    upload_root.mkdir(parents=True, exist_ok=True)
    _assert_no_reparse_chain(upload_root)
    locator_id = str(uuid.uuid4())
    target = upload_root / f"nesting_source_{uuid.UUID(locator_id).hex}.pdf"
    token: str | None = None
    try:
        content_hash, byte_size = _copy_snapshot(
            source,
            target,
            expected_fingerprint=expected_fingerprint,
        )
        _fsync_directory(upload_root)
        pages = _inspect_pdf(target)
        token = create_artifact_lease(
            "nesting_source",
            target,
            locator_id=locator_id,
            initial_ttl_seconds=ARTIFACT_INITIAL_LEASE_SECONDS,
        )
        lease_resolution = resolve_nesting_source_lease_token(
            token,
            expected_locator_id=locator_id,
            expected_artifact_path=target,
            require_final=False,
        )
        if lease_resolution is None:
            raise NestingSourcePinError(
                "Không dựng được receipt lease cho snapshot nesting vừa tạo."
            )
        return PinnedNestingSource(
            locator_id=locator_id,
            content_hash=content_hash,
            byte_size=byte_size,
            page_count=len(pages),
            revision=content_hash,
            pages=pages,
            snapshot_path=target,
            lease_token=token,
            lease_resolution=lease_resolution,
        )
    except Exception:
        can_unlink = token is None
        if token is not None:
            can_unlink = discard_artifact_lease(
                token,
                expected_locator_id=locator_id,
                expected_artifact_path=target,
            )
        if can_unlink:
            try:
                target.unlink(missing_ok=True)
            except OSError:
                pass
        raise


def pin_uploaded_pdf(
    file_id: str,
    *,
    session_factory: Callable[[], Any] = SessionLocal,
) -> PinnedNestingSource:
    """Resolve upload từ database rồi dùng chung đường pin PDF nội bộ."""

    try:
        _canonical_uuid(file_id, "fileId")
    except ValueError as exc:
        raise NestingSourcePinError(str(exc)) from exc
    database = session_factory()
    try:
        uploaded = (
            database.query(UploadedFile)
            .filter(UploadedFile.id == file_id)
            .first()
        )
        source_value = uploaded.file_path if uploaded is not None else None
    finally:
        database.close()
    if not isinstance(source_value, str) or not source_value:
        raise NestingSourcePinError("Không tìm thấy PDF nguồn cần pin.")
    return pin_pdf_path(source_value)


def verify_source_pin(
    pin: PinnedNestingSource,
    expected_source: Mapping[str, Any],
    expected_pages: Sequence[Mapping[str, Any]],
) -> VerifiedNestingSourceProof:
    if not isinstance(pin, PinnedNestingSource):
        raise NestingSourceStaleError("Source pin không đúng kiểu.")
    if source_descriptor(pin) != dict(expected_source):
        raise NestingSourceStaleError("Descriptor source pin không còn khớp.")
    if pin.lease_resolution is None:
        lease = resolve_nesting_source_lease(
            pin.locator_id,
            require_final=False,
        )
    else:
        lease = refresh_resolved_nesting_source_lease(
            pin.lease_resolution,
            require_final=False,
        )
    if lease is None or os.path.normcase(
        os.path.abspath(lease.artifact_path)
    ) != os.path.normcase(
        os.path.abspath(pin.snapshot_path)
    ):
        raise NestingSourceStaleError("Lease source pin không còn tồn tại.")
    content_hash, byte_size, pages = _verify_snapshot(
        lease.artifact_path,
        expected_source=expected_source,
        expected_pages=expected_pages,
    )
    return VerifiedNestingSourceProof(
        locator_id=pin.locator_id,
        content_hash=content_hash,
        byte_size=byte_size,
        page_count=len(pages),
        revision=content_hash,
        pages=pages,
        snapshot_path=pin.snapshot_path,
        lease_token=pin.lease_token,
        lease_resolution=lease,
    )

def reverify_source_pin(
    pin: PinnedNestingSource,
    proof: VerifiedNestingSourceProof,
    expected_source: Mapping[str, Any],
    expected_pages: Sequence[Mapping[str, Any]],
    *,
    require_final: bool,
    renew: bool = False,
) -> ResolvedPinnedSource:
    """Băm lại snapshot, tái dùng metadata chỉ khi proof bind đúng cùng pin/digest."""

    if not isinstance(pin, PinnedNestingSource) or not isinstance(
        proof, VerifiedNestingSourceProof
    ):
        raise NestingSourceStaleError("Source pin hoặc proof không đúng kiểu.")
    if not isinstance(require_final, bool) or not isinstance(renew, bool):
        raise NestingSourceStaleError("Phase verify source pin không hợp lệ.")
    if (
        proof.locator_id != pin.locator_id
        or proof.content_hash != pin.content_hash
        or proof.byte_size != pin.byte_size
        or proof.page_count != pin.page_count
        or proof.revision != pin.revision
        or proof.snapshot_path != pin.snapshot_path
        or proof.lease_token != pin.lease_token
        or proof.lease_resolution.token != pin.lease_token
        or proof.lease_resolution.locator_id != pin.locator_id
        or proof.lease_resolution.artifact_path != pin.snapshot_path
        or source_descriptor(pin) != dict(expected_source)
    ):
        raise NestingSourceStaleError("Proof source pin không còn đúng binding.")
    _assert_verified_snapshot(
        content_hash=proof.content_hash,
        byte_size=proof.byte_size,
        pages=proof.pages,
        expected_source=expected_source,
        expected_pages=expected_pages,
    )

    # PERF (audit 2026-09-01 §PERF-NEST-02): marker authoritative deterministic
    # đã claim locator bằng no-replace. Trong transaction chỉ đọc đúng receipt O(1);
    # marker token v1 lịch sử mới cần batch-scan khi load độc lập.
    lease = refresh_resolved_nesting_source_lease(
        proof.lease_resolution,
        require_final=require_final,
    )
    if lease is None or os.path.normcase(
        os.path.abspath(lease.artifact_path)
    ) != os.path.normcase(
        os.path.abspath(pin.snapshot_path)
    ):
        raise NestingSourceStaleError("Lease source pin không còn đúng phase/path.")
    try:
        content_hash, byte_size = _hash_file(lease.artifact_path)
    except NestingSourceStaleError:
        raise
    except (OSError, TypeError, ValueError, OverflowError, RuntimeError) as exc:
        raise NestingSourceStaleError(
            "Snapshot PDF đã mất, hỏng hoặc không còn đọc được."
        ) from exc
    if content_hash != proof.content_hash or byte_size != proof.byte_size:
        raise NestingSourceStaleError("Snapshot PDF đã đổi sau lần inspect đầy đủ.")

    if renew and not renew_resolved_nesting_source_lease(lease):
        raise NestingSourceStaleError("Không gia hạn được source pin final.")
    return ResolvedPinnedSource(
        locator_id=proof.locator_id,
        content_hash=proof.content_hash,
        byte_size=proof.byte_size,
        page_count=proof.page_count,
        revision=proof.revision,
        pages=proof.pages,
        path=lease.artifact_path,
    )


def promote_source_pin(pin: PinnedNestingSource) -> bool:
    return isinstance(pin, PinnedNestingSource) and promote_artifact_lease(
        pin.lease_token,
        expected_locator_id=pin.locator_id,
        expected_artifact_path=pin.snapshot_path,
    )


def resolve_final_source(
    locator_id: str,
    expected_hash: str,
    expected_byte_size: int,
    expected_page_count: int,
    expected_pages: Sequence[Mapping[str, Any]],
    *,
    renew: bool = True,
    inspection_cache: dict[str, tuple[PinnedPageMetadata, ...]] | None = None,
    lease_resolution: (
        artifact_lease_module.NestingSourceLeaseResolution | None
    ) = None,
) -> ResolvedPinnedSource:
    try:
        canonical_locator = _canonical_uuid(locator_id, "locatorId")
    except ValueError as exc:
        raise NestingSourceStaleError(str(exc)) from exc
    expected_source = {
        "locatorId": canonical_locator,
        "contentHash": expected_hash,
        "byteSize": expected_byte_size,
        "pageCount": expected_page_count,
        "revision": expected_hash,
    }
    if lease_resolution is None:
        lease = resolve_nesting_source_lease(
            canonical_locator,
            require_final=True,
        )
    elif (
        # [RELEASE-QA FIX 2026-09-02]: backend reload tạo lại dataclass receipt;
        # luôn đối chiếu class hiện hành của module để không từ chối lease hợp lệ.
        not isinstance(
            lease_resolution,
            artifact_lease_module.NestingSourceLeaseResolution,
        )
        or lease_resolution.locator_id != canonical_locator
        or lease_resolution.phase != "final"
    ):
        raise NestingSourceStaleError("Receipt lease source pin không đúng binding.")
    else:
        lease = lease_resolution
    if lease is None:
        raise NestingSourceStaleError("Source pin final đã mất hoặc hết hạn.")
    content_hash, byte_size, pages = _verify_snapshot(
        lease.artifact_path,
        expected_source=expected_source,
        expected_pages=expected_pages,
        inspection_cache=inspection_cache,
    )
    if renew and not renew_resolved_nesting_source_lease(lease):
        raise NestingSourceStaleError("Không gia hạn được source pin final.")
    return ResolvedPinnedSource(
        locator_id=canonical_locator,
        content_hash=content_hash,
        byte_size=byte_size,
        page_count=len(pages),
        revision=content_hash,
        pages=pages,
        path=lease.artifact_path,
    )


def discard_source_pin(pin: PinnedNestingSource) -> None:
    if not isinstance(pin, PinnedNestingSource):
        return
    if not discard_artifact_lease(
        pin.lease_token,
        expected_locator_id=pin.locator_id,
        expected_artifact_path=pin.snapshot_path,
    ):
        return
    expected_name = f"nesting_source_{uuid.UUID(pin.locator_id).hex}.pdf"
    path = Path(os.path.abspath(pin.snapshot_path))
    if (
        path.parent == Path(os.path.abspath(os.fspath(settings.UPLOAD_DIR)))
        and path.name == expected_name
    ):
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass
