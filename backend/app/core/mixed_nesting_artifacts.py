"""Root lưu artifact riêng của "Bình lồng ghép tự do" — phase P14a.

Kế hoạch: ``docs/KE_HOACH_MIXED_TRUE_SHAPE_NESTING_DOC_LAP_2026-08-26.md`` §12.4.

Năm ràng buộc, mỗi cái có test:

1. **Root riêng, mặc định ``Path(settings.RESULTS_DIR).parent / "mixed_nesting_data"``**, override
   bằng ``PRYNX_MIXED_NESTING_DATA_DIR``.
2. **Fail-closed nếu root trùng, nằm trong, hoặc chứa một shared cleanup root.** Ba root dùng
   chung là ``UPLOAD_DIR``, ``RESULTS_DIR`` và ``backend/temp``. Lý do phải kiểm **cả hai
   chiều**: root nằm *trong* `RESULTS_DIR` thì cleanup hiện tại xoá file của ta; root *chứa*
   `RESULTS_DIR` thì sweeper của ta xoá file của người khác. Chiều thứ hai dễ bị bỏ sót và
   hậu quả nặng hơn.
3. **Chặn symlink/reparse point.** Trên Windows một directory junction trỏ ra ngoài là đường
   thoát khỏi mọi phép kiểm dựa trên chuỗi, nên phải so trên đường đã ``resolve()``.
4. **Không import và không sửa ``artifact_lease.py``/``cleanup.py``.** Có test AST chốt.
5. **Publish nguyên tử.** Ghi ``.partial`` rồi ``os.replace``; người đọc không bao giờ thấy
   file nửa vời.
"""

from __future__ import annotations

import logging
import os
import shutil
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Final, Iterator, Optional

logger = logging.getLogger(__name__)

#: Biến môi trường override root. Ghi vào ``docs/CAU_HINH_ENV.md`` cùng lô (P14b).
DATA_DIR_ENV: Final[str] = "PRYNX_MIXED_NESTING_DATA_DIR"

#: Tên thư mục mặc định, đặt **cạnh** ``RESULTS_DIR`` chứ không bên trong.
DEFAULT_DIR_NAME: Final[str] = "mixed_nesting_data"

#: TTL của artifact ở trạng thái terminal, giây.
ARTIFACT_TTL_SECONDS: Final[float] = 2 * 60 * 60

#: Trần tổng dung lượng root, byte. Vượt thì dọn artifact cũ nhất trước khi ghi mới.
MAX_TOTAL_BYTES: Final[int] = 2 * 1024 * 1024 * 1024


class ArtifactRootUnsafe(RuntimeError):
    """Root không an toàn. **Fail-closed**: không ghi gì cho tới khi cấu hình đúng."""


def _shared_cleanup_roots() -> list[Path]:
    """Ba root mà cleanup dùng chung của dự án đang quét.

    Đọc từ ``settings`` chứ không hard-code đường dẫn: nếu ai đổi cấu hình, phép kiểm phải
    đi theo.
    """
    from app.config import settings  # noqa: PLC0415 - tránh vòng import lúc nạp module

    roots = [Path(settings.UPLOAD_DIR), Path(settings.RESULTS_DIR)]
    # `backend/temp` là root tạm dùng chung; lấy tương đối từ file này để không phụ thuộc cwd.
    roots.append(Path(__file__).resolve().parents[2] / "temp")
    resolved: list[Path] = []
    for root in roots:
        try:
            resolved.append(root.resolve())
        except OSError:
            resolved.append(root.absolute())
    return resolved


def _is_within(inner: Path, outer: Path) -> bool:
    """``inner`` có nằm trong ``outer`` (hoặc bằng) không, so trên đường đã resolve."""
    try:
        inner.relative_to(outer)
        return True
    except ValueError:
        return False


def assert_root_safe(candidate: Path) -> Path:
    """Kiểm root rồi trả đường đã resolve. Raise :class:`ArtifactRootUnsafe` nếu không an toàn.

    Kiểm **trước khi tạo thư mục**: tạo rồi mới kiểm là đã kịp ghi vào chỗ sai.
    """
    if not candidate.is_absolute():
        raise ArtifactRootUnsafe(
            f"Root artifact phải là đường dẫn tuyệt đối, nhận: {candidate}"
        )

    # `strict=False` để resolve được cả đường chưa tồn tại, nhưng vẫn giải hết symlink của
    # phần đã tồn tại — đó là điểm chặn junction/reparse trên Windows.
    resolved = candidate.resolve()

    if resolved.exists() and not resolved.is_dir():
        raise ArtifactRootUnsafe(f"Root artifact đã tồn tại nhưng không phải thư mục: {resolved}")

    # Chặn symlink ở CHÍNH root: một junction trỏ ra ngoài làm mọi phép kiểm chuỗi vô nghĩa.
    if candidate.exists() and candidate.is_symlink():
        raise ArtifactRootUnsafe(f"Root artifact là symlink/junction: {candidate}")

    for shared in _shared_cleanup_roots():
        if resolved == shared:
            raise ArtifactRootUnsafe(
                f"Root artifact trùng root dùng chung {shared} — cleanup hiện tại sẽ xoá file."
            )
        if _is_within(resolved, shared):
            raise ArtifactRootUnsafe(
                f"Root artifact {resolved} nằm TRONG root dùng chung {shared} — "
                "cleanup hiện tại sẽ xoá file của tính năng này."
            )
        if _is_within(shared, resolved):
            raise ArtifactRootUnsafe(
                f"Root artifact {resolved} CHỨA root dùng chung {shared} — "
                "sweeper của tính năng này sẽ xoá file của tính năng khác."
            )
    return resolved


def resolve_root(*, override: Optional[str] = None) -> Path:
    """Root artifact đã kiểm an toàn. Không tạo thư mục."""
    from app.config import settings  # noqa: PLC0415

    raw = override if override is not None else os.environ.get(DATA_DIR_ENV, "")
    if raw.strip():
        candidate = Path(raw.strip())
        if not candidate.is_absolute():
            candidate = candidate.absolute()
    else:
        candidate = Path(settings.RESULTS_DIR).absolute().parent / DEFAULT_DIR_NAME
    return assert_root_safe(candidate)


@dataclass
class ArtifactRecord:
    artifact_id: str
    owner: str
    job_id: str
    #: Băm revision của mọi nguồn đã dùng — chống "đổi khuôn nhưng giữ file cũ".
    source_revision: str
    path: Path
    size_bytes: int
    sheet_count: int
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.monotonic)
    #: Số người đang stream. File đang tải về **không được** xoá.
    readers: int = 0


class MixedNestingArtifactStore:
    """Quản lý file PDF đã xuất: root riêng, TTL, quota, publish nguyên tử.

    Cố ý **không** dùng ``artifact_lease.py``: §12.4 cấm import/sửa file đó, và vòng đời ở
    đây khác (gắn với job của tính năng này, không phải với phiên workspace).
    """

    def __init__(
        self,
        *,
        root: Optional[Path] = None,
        ttl_seconds: float = ARTIFACT_TTL_SECONDS,
        max_total_bytes: int = MAX_TOTAL_BYTES,
    ) -> None:
        self._root = assert_root_safe(root) if root is not None else resolve_root()
        self._ttl_seconds = max(0.0, float(ttl_seconds))
        self._max_total_bytes = max(0, int(max_total_bytes))
        self._lock = threading.RLock()
        self._artifacts: dict[str, ArtifactRecord] = {}
        self._ready = False

    @property
    def root(self) -> Path:
        return self._root

    def ensure_root(self) -> Path:
        """Tạo root nếu chưa có. Kiểm lại an toàn mỗi lần — cấu hình có thể vừa đổi."""
        with self._lock:
            assert_root_safe(self._root)
            self._root.mkdir(parents=True, exist_ok=True)
            self._ready = True
            return self._root

    # ── Publish ─────────────────────────────────────────────────────────────

    def publish(
        self,
        *,
        artifact_id: str,
        owner: str,
        job_id: str,
        source_revision: str,
        payload: bytes,
        sheet_count: int,
    ) -> ArtifactRecord:
        """Ghi file **nguyên tử** rồi ghi nhận vào registry.

        Thứ tự: ghi ``.partial`` → ``os.replace`` → ghi registry. Người đọc chỉ thấy file
        khi nó đã đủ byte, và registry chỉ trỏ tới file đã hoàn tất.
        """
        self.ensure_root()
        self._make_room(len(payload))

        final_path = self._root / f"{artifact_id}.pdf"
        partial_path = self._root / f"{artifact_id}.partial.pdf"
        try:
            with open(partial_path, "wb") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(partial_path, final_path)
        except BaseException:
            # Thất bại giữa đường: dọn file dở, KHÔNG để lại rác cho sweeper phải đoán.
            try:
                partial_path.unlink(missing_ok=True)
            except OSError:
                pass
            raise

        record = ArtifactRecord(
            artifact_id=artifact_id,
            owner=owner,
            job_id=job_id,
            source_revision=source_revision,
            path=final_path,
            size_bytes=len(payload),
            sheet_count=sheet_count,
        )
        with self._lock:
            self._artifacts[artifact_id] = record
        return record

    # ── Truy vấn ────────────────────────────────────────────────────────────

    def get(self, artifact_id: str, owner: str) -> Optional[ArtifactRecord]:
        self._sweep()
        with self._lock:
            record = self._artifacts.get(artifact_id)
            # Artifact của owner khác coi như KHÔNG TỒN TẠI.
            if record is None or record.owner != owner:
                return None
            if not record.path.is_file():
                self._artifacts.pop(artifact_id, None)
                return None
            record.updated_at = time.monotonic()
            return record

    def for_job(self, job_id: str, owner: str) -> Optional[ArtifactRecord]:
        self._sweep()
        with self._lock:
            for record in self._artifacts.values():
                if record.job_id == job_id and record.owner == owner:
                    return record
        return None

    def open_for_read(self, artifact_id: str, owner: str) -> Iterator[bytes]:
        """Đọc từng khối, có đánh dấu đang-stream để sweeper không xoá giữa lúc tải."""
        record = self.get(artifact_id, owner)
        if record is None:
            raise FileNotFoundError(artifact_id)
        with self._lock:
            record.readers += 1
        try:
            with open(record.path, "rb") as handle:
                while True:
                    chunk = handle.read(256 * 1024)
                    if not chunk:
                        break
                    yield chunk
        finally:
            with self._lock:
                record.readers = max(0, record.readers - 1)

    def delete(self, artifact_id: str, owner: str) -> bool:
        with self._lock:
            record = self._artifacts.get(artifact_id)
            if record is None or record.owner != owner:
                return False
            if record.readers > 0:
                # Đang có người tải: chỉ bỏ khỏi registry, để sweeper dọn file sau.
                self._artifacts.pop(artifact_id, None)
                return True
            self._artifacts.pop(artifact_id, None)
        self._remove_file(record.path)
        return True

    # ── Dọn ─────────────────────────────────────────────────────────────────

    def _remove_file(self, path: Path) -> None:
        try:
            path.unlink(missing_ok=True)
        except OSError:
            logger.warning("[MIXED-NESTING] không xoá được artifact %s", path, exc_info=True)

    def _make_room(self, incoming_bytes: int) -> None:
        """Dọn artifact cũ nhất tới khi còn chỗ. Không đụng file đang stream."""
        if self._max_total_bytes <= 0:
            return
        with self._lock:
            total = sum(item.size_bytes for item in self._artifacts.values())
            if total + incoming_bytes <= self._max_total_bytes:
                return
            candidates = sorted(
                (item for item in self._artifacts.values() if item.readers == 0),
                key=lambda item: item.updated_at,
            )
            removed: list[Path] = []
            for record in candidates:
                if total + incoming_bytes <= self._max_total_bytes:
                    break
                self._artifacts.pop(record.artifact_id, None)
                removed.append(record.path)
                total -= record.size_bytes
        for path in removed:
            self._remove_file(path)

    def _sweep(self) -> None:
        now = time.monotonic()
        with self._lock:
            expired = [
                record
                for record in self._artifacts.values()
                if record.readers == 0 and now - record.updated_at >= self._ttl_seconds
            ]
            for record in expired:
                self._artifacts.pop(record.artifact_id, None)
        for record in expired:
            self._remove_file(record.path)

    def sweep_now(self) -> int:
        """Quét TTL và trả số artifact đã dọn. Dùng cho vòng nền ở P14b."""
        with self._lock:
            truoc = len(self._artifacts)
        self._sweep()
        with self._lock:
            return truoc - len(self._artifacts)

    def sweep_orphan_files(self) -> int:
        """Xoá file trong root **không** có trong registry (sót từ lần chạy trước).

        Chạy lúc khởi động: sidecar vừa restart thì registry rỗng nhưng file cũ còn nằm đó.
        Chỉ xoá file khớp mẫu tên của tính năng này để không bao giờ chạm file của ai khác.
        """
        if not self._root.exists():
            return 0
        with self._lock:
            known = {record.path for record in self._artifacts.values()}
        removed = 0
        for path in self._root.iterdir():
            if not path.is_file():
                continue
            if path.suffix != ".pdf":
                continue
            if path in known:
                continue
            self._remove_file(path)
            removed += 1
        return removed

    def close(self) -> None:
        """Dọn toàn bộ artifact. Gọi ở shutdown; idempotent."""
        with self._lock:
            records = list(self._artifacts.values())
            self._artifacts.clear()
        for record in records:
            self._remove_file(record.path)

    def purge_root(self) -> None:
        """Xoá cả root. **Chỉ dùng trong test.**"""
        assert_root_safe(self._root)
        shutil.rmtree(self._root, ignore_errors=True)


_STORE_LOCK = threading.Lock()
_STORE: Optional[MixedNestingArtifactStore] = None


def artifact_store() -> MixedNestingArtifactStore:
    """Singleton, dựng muộn để lỗi cấu hình root không làm sập lúc import module."""
    global _STORE  # noqa: PLW0603 - singleton cấp module là chủ đích
    if _STORE is not None:
        return _STORE
    with _STORE_LOCK:
        if _STORE is None:
            _STORE = MixedNestingArtifactStore()
        return _STORE


def reset_artifact_store() -> None:
    """Chỉ dùng cho test."""
    global _STORE  # noqa: PLW0603
    with _STORE_LOCK:
        _STORE = None
