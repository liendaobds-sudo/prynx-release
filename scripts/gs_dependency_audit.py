"""Đo phụ thuộc Ghostscript thật trên corpus — Bước 0 của lộ trình gỡ hẳn GS.

# Vì sao cần bộ đo này thay vì đọc code

Đếm số nhánh `gs_path` trong code chỉ cho biết *có bao nhiêu nhánh*, không cho biết
*nhánh nào còn được đi trên file thật*. Hai con số đó khác nhau rất xa: phần lớn
nhánh GS còn lại là fallback không bao giờ chạm tới, và một vài nhánh trông vô hại
lại là phụ thuộc cứng. Không có số đo thì mọi ước lượng công việc là đoán — và tài
liệu đã có sẵn một ví dụ: con số "22/33 file" của `OUTLINE_FONTS` là của bản
fontTools, lạc hậu ngay khi engine đổi.

# Cách đo

Chặn Ghostscript ở mức **cấu hình sản phẩm** (`PRYNX_NO_GS_BUILD=1` ⇒
`GHOSTSCRIPT_PATH` rỗng; cấu hình fallback GS đã bị xoá) rồi chạy từng đường sản
xuất trên từng file. Năm kết quả có thể:

* `OK`      — chạy xong bằng engine nội bộ.
* `REFUSED` — dừng an toàn có lý do (fail-closed). Đây **không** phải phụ thuộc GS,
              nhưng là chức năng chưa phủ.
* `GS`      — cần Ghostscript: đường này còn phụ thuộc thật.
* `ERROR`   — nổ ngoài dự kiến; phải xem từng ca.
* `TIMEOUT` — vượt thời gian an toàn của một thao tác; là lỗi chặn release.

Bộ đếm `gs_usage` được reset trước mỗi thao tác nên `GS` là số đo, không phải suy
diễn từ thông điệp lỗi.

Chạy:
    backend\\venv\\Scripts\\python.exe scripts\\gs_dependency_audit.py private_test_corpus\\incoming
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import importlib.metadata
import importlib.util
import io
import json
import logging
import math
import multiprocessing
import os
import platform
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path


def _configure_stdio_utf8() -> None:
    """Giữ bảng audit đọc được trên Windows PowerShell dùng bảng mã cũ."""
    for name in ("stdout", "stderr"):
        stream = getattr(sys, name, None)
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is None:
            continue
        try:
            reconfigure(encoding="utf-8", errors="backslashreplace")
        except (AttributeError, io.UnsupportedOperation):
            pass


_configure_stdio_utf8()

REPO = Path(__file__).resolve().parent.parent
DEFAULT_OPERATION_TIMEOUT_SECONDS = 180.0
TERMINAL_STATUSES = frozenset({"OK", "REFUSED", "GS", "ERROR", "TIMEOUT"})
ARTIFACT_SCHEMA_VERSION = 3
FINGERPRINT_ALGORITHM = "sha256-content-v2"
WORKER_ENV_KEYS = (
    "RESULTS_DIR",
    "UPLOAD_DIR",
    "TMP",
    "TEMP",
    "TMPDIR",
    "PRYNX_TOKEN_SOURCE",
)
WORKER_STARTUP_TIMEOUT_SECONDS = 30.0
RUNTIME_MODULES = ("pdfcompare_native", "pypdfium2", "pypdfium2_raw")
FINGERPRINT_ENV_KEYS = (
    "PRYNX_NO_GS_BUILD",
    "GHOSTSCRIPT_PATH",
    "PRYNX_PPE_MEMORY_BUDGET_MB",
    "PRYNX_OUTLINE_TRUST_PPE",
    "PRYNX_DETECT_RASTER_MAX",
    "PRYNX_MAX_HEAVY_JOBS",
    "PDFIUM_DLL_PATH",
    "PDFIUM_PLATFORM",
    "OMP_NUM_THREADS",
    "OPENBLAS_NUM_THREADS",
    "MKL_NUM_THREADS",
    "RAYON_NUM_THREADS",
    "PRYNX_RELEASE_NATIVE_SITE",
    "PYTHONPATH",
    "VIRTUAL_ENV",
    "LANG",
    "LC_ALL",
)

# PHẢI đặt trước khi import app.config: `Settings` đọc marker no-GS ngay lúc dựng
# class, nên đặt sau đó thì đo một cấu hình khác cấu hình sản phẩm.
os.environ["PRYNX_NO_GS_BUILD"] = "1"
os.environ.pop("GHOSTSCRIPT_PATH", None)

sys.path.insert(0, str(REPO / "backend"))


@dataclass
class Outcome:
    status: str  # OK | REFUSED | GS | ERROR | TIMEOUT
    detail: str = ""
    gs_calls: int = 0
    seconds: float = 0.0
    extra: dict = field(default_factory=dict)


class _PpeOutlineCounter(logging.Handler):
    """Đếm glyph dùng hình học PPE so với glyph lùi về fontTools.

    Con số này là thứ quyết định `OUTLINE_FONTS` còn cần fontTools tới mức nào —
    không có nó thì "đã nối PPE" chỉ là lời khai, không phải số đo.
    """

    PATTERN = re.compile(r"(\d+) glyph dùng hình học PPE, (\d+) lùi về fontTools")

    def __init__(self):
        super().__init__(level=logging.INFO)
        self.ppe = 0
        self.fallback = 0

    def reset(self) -> None:
        self.ppe = self.fallback = 0

    def emit(self, record) -> None:
        try:
            m = self.PATTERN.search(record.getMessage())
        except Exception:  # noqa: BLE001
            return
        if m:
            self.ppe += int(m.group(1))
            self.fallback += int(m.group(2))


OUTLINE_COUNTER = _PpeOutlineCounter()


def _run(fn) -> Outcome:
    """Chạy một thao tác, phân loại kết quả, đo số lần GS bị gọi."""
    from app.core import gs_usage
    from app.core.gs_availability import GhostscriptUnavailable, InternalEngineUnsupported

    gs_usage.reset_for_tests()
    OUTLINE_COUNTER.reset()
    started = time.perf_counter()
    try:
        status, detail, extra = fn()
    except InternalEngineUnsupported as exc:
        return Outcome("REFUSED", str(exc)[:200], gs_usage.summary()["total_gs_calls"],
                       time.perf_counter() - started)
    except GhostscriptUnavailable as exc:
        return Outcome("GS", str(exc)[:160], gs_usage.summary()["total_gs_calls"],
                       time.perf_counter() - started)
    except Exception as exc:  # noqa: BLE001
        # Thông điệp GS có thể bị nuốt rồi bọc lại ở tầng trên; nhận cả hai dấu hiệu.
        text = f"{type(exc).__name__}: {exc}"
        calls = gs_usage.summary()["total_gs_calls"]
        status = "GS" if calls or "Ghostscript" in text or "ghostscript" in text else "ERROR"
        return Outcome(status, text[:200], calls,
                       time.perf_counter() - started)
    calls = gs_usage.summary()["total_gs_calls"]
    if calls:
        status = "GS"
    if OUTLINE_COUNTER.ppe or OUTLINE_COUNTER.fallback:
        extra = dict(extra or {})
        extra["ppe_glyphs"] = OUTLINE_COUNTER.ppe
        extra["fallback_glyphs"] = OUTLINE_COUNTER.fallback
    return Outcome(status, detail[:200], calls, time.perf_counter() - started, extra or {})


# ─────────────────────────────────────────────────────────────────────────────
#  Từng đường sản xuất
# ─────────────────────────────────────────────────────────────────────────────

def op_separations(pdf: str):
    from app.core.separations import SeparationEngine

    r = asyncio.run(SeparationEngine().extract_separations(pdf, 1, 100, ink_accurate=True))
    engine = str(r.get("engine"))
    if not r.get("plates"):
        return ("REFUSED", "không tách được kẽm", {})
    if engine != "ppe":
        # `pdfium_approx` không phải phụ thuộc GS, nhưng cũng KHÔNG đủ tin để đo mực
        # — TAC sẽ bị bỏ. Ghi riêng để không lẫn với OK.
        return ("REFUSED", f"engine={engine} accuracy={r.get('accuracy')}", {})
    return ("OK", f"{len(r['plates'])} kẽm, TAC {r.get('max_tac_pct')}", {})


def op_softproof(pdf: str):
    from app.core.softproof import SoftProofEngine

    r = asyncio.run(SoftProofEngine().render_softproof(pdf, 1, "fogra39"))
    if not r.get("success"):
        return ("REFUSED", str(r.get("warning"))[:160], {})
    if r.get("engine") != "ppe+lcms":
        return ("REFUSED", f"engine={r.get('engine')}", {})
    return ("OK", "", {})


def op_overprint_preview(pdf: str):
    from app.api.routes import preflight as routes

    original = routes._get_file_path
    routes._get_file_path = lambda _id: pdf  # type: ignore[assignment]
    try:
        r = asyncio.run(
            routes.render_overprint_preview(
                routes.OverprintPreviewRequest(file_id="corpus", page=1, dpi=72)
            )
        )
    finally:
        routes._get_file_path = original  # type: ignore[assignment]
    if not r.get("success"):
        return ("REFUSED", str(r.get("error"))[:160], {})
    return ("OK", f"diff={r.get('diff_pixel_count')}", {})


def op_preflight(pdf: str):
    from app.core.preflight_engine import PreflightEngine

    report = PreflightEngine().run(pdf)
    if report is None:
        return ("REFUSED", "không dựng được báo cáo", {})
    return ("OK", "", {})


def make_action_op(action: str):
    def op(pdf: str):
        from app.core.action_engine import ActionEngine

        engine = ActionEngine()
        result = asyncio.run(engine.execute(pdf, action))
        out = getattr(result, "output_path", None)
        try:
            if not result.success:
                err = str(result.error)
                # `_run` nâng thành GS nếu engine thực sự ghi nhận một lần gọi.
                return ("REFUSED", err[:160], {})
            log0 = result.log[0] if result.log else None
            used = getattr(log0, "engine", "?")
            report = getattr(log0, "report", None) or {}
            extra = {"engine": used}
            if report.get("warnings"):
                extra["warnings"] = list(report["warnings"])[:3]
            return ("OK", f"engine={used}", extra)
        finally:
            if out and os.path.isfile(out) and out != pdf:
                try:
                    os.remove(out)
                except OSError:
                    pass

    op.__name__ = f"op_action_{action.lower()}"
    return op


def make_pdfx_op(standard: str):
    def op(pdf: str):
        from app.core.pdfx_export import PdfxExportEngine

        engine = PdfxExportEngine()
        out = asyncio.run(engine.export_pdfx(pdf, standard))
        try:
            report = engine.check_compliance(out, standard)
            # `check_compliance` trả khoá `id`/`label`, KHÔNG có `name`. Đọc sai khoá
            # ở đây từng làm bộ đo ném `KeyError` rồi tự phân loại thành ERROR — tức
            # bộ đo báo lỗi sản phẩm cho lỗi của chính nó.
            failed = [c.get("label") or c.get("id", "?") for c in report["checks"]
                      if not c["passed"]]
            extra = {"engine": engine.last_engine, "warnings": list(engine.last_warnings or [])[:3]}
            if not report["passed"]:
                return ("REFUSED", "không đạt: " + ", ".join(failed[:4]), extra)
            return ("OK", f"engine={engine.last_engine}", extra)
        finally:
            if out and os.path.isfile(out):
                try:
                    os.remove(out)
                except OSError:
                    pass

    op.__name__ = f"op_pdfx_{standard}"
    return op


def op_convert_cmyk(pdf: str):
    import tempfile

    from app.core import icc_profiles, pdf_actions_native

    with tempfile.TemporaryDirectory() as tmp:
        out = str(Path(tmp) / "cmyk.pdf")
        r = pdf_actions_native.convert_to_cmyk(
            pdf, out,
            icc_profiles.resolve_cmyk_profile_path(),
            icc_profiles.resolve_srgb_profile_path(),
        )
        if not r.get("supported"):
            return ("REFUSED", "; ".join(r.get("blockers", []))[:160], {})
        return ("OK", "", {})


def op_convert_gray(pdf: str):
    import tempfile

    from app.core import pdf_actions_native

    with tempfile.TemporaryDirectory() as tmp:
        out = str(Path(tmp) / "gray.pdf")
        r = pdf_actions_native.convert_to_grayscale(pdf, out)
        if not r.get("supported"):
            return ("REFUSED", "; ".join(r.get("blockers", []))[:160], {})
        return ("OK", "", {})


def op_optimize(pdf: str):
    import tempfile

    from app.core import pdf_actions_native

    with tempfile.TemporaryDirectory() as tmp:
        out = str(Path(tmp) / "opt.pdf")
        r = pdf_actions_native.optimize_pdf(pdf, out, "ebook")
        if not r.get("supported"):
            return ("REFUSED", "; ".join(r.get("warnings", []))[:160], {})
        return ("OK", "", {})


def op_spot_to_cmyk(pdf: str):
    from app.core.ink_manager import InkManagerEngine

    out = asyncio.run(InkManagerEngine().convert_spot_to_cmyk(pdf, None))
    try:
        if not out or not os.path.isfile(out):
            return ("REFUSED", "không tạo được file", {})
        return ("OK", "", {})
    finally:
        if out and os.path.isfile(out):
            try:
                os.remove(out)
            except OSError:
                pass


OPERATIONS = [
    ("separations_ink", op_separations),
    ("softproof", op_softproof),
    ("overprint_preview", op_overprint_preview),
    ("preflight", op_preflight),
    ("act:CONVERT_TO_CMYK", make_action_op("CONVERT_TO_CMYK")),
    ("act:DOWNSCALE_IMAGES", make_action_op("DOWNSCALE_IMAGES")),
    ("act:EMBED_FONTS", make_action_op("EMBED_FONTS")),
    ("act:SET_BLACK_OVERPRINT", make_action_op("SET_BLACK_OVERPRINT")),
    ("act:FLATTEN_TRANSPARENCY", make_action_op("FLATTEN_TRANSPARENCY")),
    ("act:OUTLINE_FONTS", make_action_op("OUTLINE_FONTS")),
    ("pdfx:x4", make_pdfx_op("x4")),
    ("pdfx:x1a", make_pdfx_op("x1a")),
    ("convert_colors:cmyk", op_convert_cmyk),
    ("convert_colors:gray", op_convert_gray),
    ("optimize", op_optimize),
    ("spot_to_cmyk", op_spot_to_cmyk),
]


def _provenance_source_files(
    runtime_config: dict[str, str] | None = None,
) -> list[tuple[str, Path]]:
    """Liệt kê đúng source, module và binary quyết định kết quả gate no-GS."""
    entries: dict[str, Path] = {}

    def add(path: Path, label: str | None = None) -> None:
        if not path.is_file():
            return
        if label is None:
            label = path.relative_to(REPO).as_posix()
        entries[label] = path

    add(Path(__file__).resolve())
    for path in (REPO / "backend" / "app").rglob("*"):
        if "__pycache__" in path.parts or path.suffix.lower() in {".pyc", ".pyo"}:
            continue
        add(path)
    for name in ("requirements.txt", "requirements-win-gpu.txt"):
        add(REPO / "backend" / name)

    for crate_name in ("native", "print_engine"):
        crate = REPO / crate_name
        for name in ("Cargo.toml", "Cargo.lock", "build.rs"):
            add(crate / name)
        source = crate / "src"
        if source.is_dir():
            for path in source.rglob("*"):
                add(path)

    # PDFium là đầu vào native có thể đổi mà source Rust không đổi.
    for path in (REPO / "native" / "pdfium_lib").rglob("*"):
        add(path)
    add(REPO / "native" / "pdfium.dll")
    add(REPO / ".cargo" / "config.toml")

    # Khóa đúng Python executable và toàn bộ file của ba package native/PDFium
    # thực tế được import. `pypdfium2_raw/pdfium.dll` là bundled PDFium runtime.
    add(Path(sys.executable), "runtime/python/executable")
    base_executable = Path(getattr(sys, "_base_executable", sys.executable))
    add(base_executable, "runtime/python/base-executable")
    base_prefix = Path(sys.base_prefix)
    if base_prefix.is_dir():
        for path in sorted(base_prefix.glob("python3*.dll")):
            add(path, f"runtime/python/{path.name}")
    for module_name in RUNTIME_MODULES:
        try:
            spec = importlib.util.find_spec(module_name)
        except (ImportError, AttributeError, ValueError):
            spec = None
        if spec is None:
            raise RuntimeError(f"thiếu runtime module bắt buộc: {module_name}")
        module_labels = []
        origin = getattr(spec, "origin", None)
        if origin and origin not in {"built-in", "frozen"}:
            label = f"runtime/module/{module_name}/{Path(origin).name}"
            add(Path(origin), label)
            module_labels.append(label)
        locations = list(getattr(spec, "submodule_search_locations", None) or [])
        for location in locations:
            root = Path(location)
            for path in root.rglob("*"):
                if "__pycache__" in path.parts or path.suffix.lower() in {".pyc", ".pyo"}:
                    continue
                if path.is_file():
                    relative = path.relative_to(root).as_posix()
                    label = f"runtime/module/{module_name}/{relative}"
                    add(path, label)
                    module_labels.append(label)
        binary_suffixes = (".pyd", ".so", ".dll", ".dylib")
        if module_name in {"pdfcompare_native", "pypdfium2_raw"} and not any(
            label.lower().endswith(binary_suffixes) for label in module_labels
        ):
            raise RuntimeError(f"thiếu binary runtime bắt buộc: {module_name}")

    # ICC có thể được trỏ ra ngoài backend/app qua cấu hình; vẫn phải khóa đúng
    # profile thực tế thay vì chỉ khóa default nằm trong repo.
    if runtime_config:
        icc_dir_value = runtime_config.get("ICC_PROFILE_DIR", "")
        if icc_dir_value:
            icc_dir = Path(icc_dir_value)
            if not icc_dir.is_dir():
                raise RuntimeError("ICC_PROFILE_DIR không tồn tại")
            icc_files = [path for path in sorted(icc_dir.rglob("*")) if path.is_file()]
            if not icc_files:
                raise RuntimeError("ICC_PROFILE_DIR không có profile")
            for index, path in enumerate(icc_files):
                add(path, f"runtime/icc/{index}/{path.name}")
            default_profile = runtime_config.get("DEFAULT_CMYK_PROFILE", "")
            if default_profile and not (icc_dir / default_profile).is_file():
                raise RuntimeError("DEFAULT_CMYK_PROFILE không tồn tại")

    return sorted(entries.items())


def _runtime_distribution_facts() -> list[str]:
    """Inventory distribution deterministic, gồm hash metadata/RECORD cài thật."""
    facts = []
    rows = []
    for distribution in importlib.metadata.distributions():
        name = distribution.metadata.get("Name") or "unknown"
        normalized = re.sub(r"[-_.]+", "-", name).lower()
        version = distribution.version or "unknown"
        manifest_parts = []
        for metadata_name in ("METADATA", "RECORD", "WHEEL", "direct_url.json"):
            content = distribution.read_text(metadata_name)
            if content is not None:
                file_digest = hashlib.sha256(content.encode("utf-8")).hexdigest()
                manifest_parts.append(f"{metadata_name}:{file_digest}")
        rows.append((normalized, version, "|".join(manifest_parts)))
    installed_names = {name for name, _version, _manifests in rows}
    required_names = {"pdfcompare-native", "pypdfium2"}
    missing = required_names - installed_names
    if missing:
        raise RuntimeError("thiếu distribution runtime bắt buộc")
    for index, (name, version, manifests) in enumerate(sorted(rows)):
        facts.append(f"{index}:{name}=={version}|{manifests}")
    return facts


def _runtime_platform_facts() -> list[str]:
    return [
        f"implementation:{sys.implementation.name}",
        f"python:{platform.python_version()}",
        f"system:{platform.system()}",
        f"release:{platform.release()}",
        f"machine:{platform.machine()}",
        f"architecture:{platform.architecture()[0]}",
        f"pointer-bits:{64 if sys.maxsize > 2**32 else 32}",
    ]


def _fingerprint_environment_facts() -> list[str]:
    return [f"{name}={os.environ.get(name, '')}" for name in FINGERPRINT_ENV_KEYS]


def _runtime_config_from_settings(settings) -> dict[str, str]:
    names = (
        "GHOSTSCRIPT_PATH",
        "PRYNX_PPE_MEMORY_BUDGET_MB",
        "ICC_PROFILE_DIR",
        "DEFAULT_CMYK_PROFILE",
        "IS_DESKTOP_APP",
        "DEV_MODE",
    )
    return {name: str(getattr(settings, name, "")) for name in names}


def _load_settings_for_audit():
    """Import Settings trong sandbox cha để import-time mkdir không chạm repo."""
    root = (REPO / "tmp" / "gs_dependency_audit_parent").resolve()
    root.mkdir(parents=True, exist_ok=True)
    workspace = Path(tempfile.mkdtemp(prefix="settings-", dir=str(root))).resolve()
    temp_dir = workspace / "temp"
    temp_dir.mkdir(parents=True, exist_ok=True)
    expected_env = {
        "RESULTS_DIR": str(workspace / "results"),
        "UPLOAD_DIR": str(workspace / "uploads"),
        "TMP": str(temp_dir),
        "TEMP": str(temp_dir),
        "TMPDIR": str(temp_dir),
        "PRYNX_TOKEN_SOURCE": "stdin",
    }
    previous_env = {name: os.environ.get(name) for name in WORKER_ENV_KEYS}
    try:
        os.environ.update(expected_env)
        from app.config import settings

        return settings
    finally:
        for name, previous in previous_env.items():
            if previous is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = previous
        try:
            shutil.rmtree(workspace)
        except OSError as exc:
            raise _WorkspaceCleanupError(
                f"không dọn được settings workspace ({type(exc).__name__})"
            ) from exc


def _stable_content_digest(path: Path) -> tuple[int, bytes]:
    """Băm nội dung và từ chối file đổi ngay trong lúc đang đọc."""
    before = path.stat()
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    after = path.stat()
    before_token = (before.st_size, before.st_mtime_ns)
    after_token = (after.st_size, after.st_mtime_ns)
    if before_token != after_token:
        raise RuntimeError(f"file đổi trong lúc tính fingerprint: {path}")
    return before.st_size, digest.digest()


def _hash_field(digest, value: str | bytes) -> None:
    data = value.encode("utf-8") if isinstance(value, str) else value
    digest.update(len(data).to_bytes(8, "big"))
    digest.update(data)


def _build_provenance_fingerprint(
    files: list[Path],
    operation_names: list[str],
    *,
    operation_timeout_seconds: float,
    source_files: list[Path] | None = None,
    runtime_config: dict[str, str] | None = None,
) -> str:
    """Fingerprint nội dung deterministic cho một lượt audit có thể resume."""
    digest = hashlib.sha256()
    _hash_field(digest, FINGERPRINT_ALGORITHM)
    _hash_field(digest, f"operation-timeout:{operation_timeout_seconds:g}")
    for fact_type, facts in (
        ("platform", _runtime_platform_facts()),
        ("environment", _fingerprint_environment_facts()),
        ("distribution", _runtime_distribution_facts()),
        ("config", [f"{key}={value}" for key, value in sorted((runtime_config or {}).items())]),
    ):
        for fact in facts:
            _hash_field(digest, fact_type)
            _hash_field(digest, fact)

    if source_files is None:
        sources = _provenance_source_files(runtime_config)
    else:
        sources = [
            (f"test-source/{index}/{path.name}", path)
            for index, path in enumerate(source_files)
        ]
    for label, path in sources:
        size, content_digest = _stable_content_digest(path)
        _hash_field(digest, "source")
        _hash_field(digest, label)
        _hash_field(digest, str(size))
        _hash_field(digest, content_digest)

    for index, pdf in enumerate(files):
        size, content_digest = _stable_content_digest(pdf)
        _hash_field(digest, "corpus")
        _hash_field(digest, f"{index}/{pdf.name}")
        _hash_field(digest, str(size))
        _hash_field(digest, content_digest)

    for index, operation_name in enumerate(operation_names):
        _hash_field(digest, "operation")
        _hash_field(digest, f"{index}/{operation_name}")
    return digest.hexdigest()


def _load_resume_results(
    out_path: Path,
    expected_fingerprint: str,
    expected_corpus_keys: list[str] | None = None,
) -> tuple[dict[str, dict[str, dict]], bool, str]:
    """Chỉ trả kết quả cũ khi schema và provenance khớp tuyệt đối."""
    payload = json.loads(out_path.read_text(encoding="utf-8"))
    schema = payload.get("schema_version")
    if schema != ARTIFACT_SCHEMA_VERSION:
        return (
            {},
            False,
            f"Artifact cũ/khác schema ({schema!r}); bắt đầu artifact mới.",
        )
    if payload.get("fingerprint_algorithm") != FINGERPRINT_ALGORITHM:
        return {}, False, "Thuật toán fingerprint đã đổi; bắt đầu artifact mới."
    if payload.get("fingerprint") != expected_fingerprint:
        return (
            {},
            False,
            "Fingerprint source/corpus/operations đã đổi; bắt đầu artifact mới.",
        )
    if payload.get("provenance_valid") is not True:
        return {}, False, "Artifact đã bị đánh dấu provenance không hợp lệ; bắt đầu mới."
    loaded = payload.get("files", {})
    if not isinstance(loaded, dict):
        raise ValueError("trường files không phải object")
    if expected_corpus_keys is not None:
        if payload.get("corpus") != expected_corpus_keys:
            return {}, False, "Danh mục corpus mờ không khớp; bắt đầu artifact mới."
        if not set(loaded).issubset(expected_corpus_keys):
            return {}, False, "Artifact chứa định danh corpus không hợp lệ; bắt đầu mới."
    completed = sum(
        1
        for per_file in loaded.values()
        if isinstance(per_file, dict)
        for record in per_file.values()
        if _is_terminal_result(record)
    )
    return loaded, True, f"Tiếp tục: tái dùng {completed} kết quả operation terminal."


def _opaque_corpus_key(index: int, fingerprint: str) -> str:
    token = hashlib.sha256(f"{fingerprint}:{index}".encode("ascii")).hexdigest()[:12]
    return f"doc-{index + 1:03d}-{token}"


def _is_opaque_corpus_key(value) -> bool:
    return isinstance(value, str) and bool(
        re.fullmatch(r"doc-\d{3,}-[0-9a-f]{12}", value)
    )


def _scrub_text(value, sensitive_paths=()) -> str:
    """Ẩn tên corpus và mọi đường dẫn có thể lọt từ exception/engine."""
    text = str(value or "").replace("\r", " ").replace("\n", " ")
    replacements = []
    for raw_path in sensitive_paths:
        path = Path(raw_path)
        candidates = {str(path), path.name}
        try:
            candidates.add(str(path.resolve()))
        except OSError:
            pass
        for candidate in candidates:
            if candidate:
                replacements.extend({candidate, candidate.replace("\\", "/")})
    replacements.extend({str(REPO), str(REPO).replace("\\", "/"), str(sys.prefix)})
    for candidate in sorted(set(replacements), key=len, reverse=True):
        text = re.sub(re.escape(candidate), "<redacted>", text, flags=re.IGNORECASE)
    # Fail-closed: đường dẫn Windows còn sót làm ẩn toàn bộ phần còn lại của dòng.
    text = re.sub(r"(?i)\b[a-z]:[\\/][^\r\n]*", "<redacted>", text)
    text = re.sub(r"\\\\[^\\\s]+\\[^\r\n]*", "<redacted>", text)
    text = re.sub(r"(?i)file:/+[^\r\n]*", "<redacted>", text)
    text = re.sub(r"(?<![\w:])/(?:[^\s/]+/)+[^\s,;:)\]]+", "<redacted>", text)
    text = re.sub(r"(?i)\b[^\s\\/:*?\"<>|]+\.pdf\b", "<corpus>", text)
    return re.sub(r"\s+", " ", text).strip()[:200]


def _scrub_value(value, sensitive_paths=()):
    if isinstance(value, str):
        return _scrub_text(value, sensitive_paths)
    if isinstance(value, dict):
        return {
            _scrub_text(key, sensitive_paths): _scrub_value(item, sensitive_paths)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [_scrub_value(item, sensitive_paths) for item in value]
    if isinstance(value, tuple):
        return tuple(_scrub_value(item, sensitive_paths) for item in value)
    return value


def _sanitize_outcome(outcome: Outcome, sensitive_paths=()) -> Outcome:
    return Outcome(
        status=outcome.status,
        detail=_scrub_text(outcome.detail, sensitive_paths),
        gs_calls=outcome.gs_calls,
        seconds=outcome.seconds,
        extra=_scrub_value(outcome.extra, sensitive_paths),
    )


def _configure_operation_logging() -> None:
    """Cấu hình bộ đếm outline trong process thực thi operation."""
    logging.basicConfig(level=logging.CRITICAL)
    outline_log = logging.getLogger("app.core.outline_text")
    if OUTLINE_COUNTER not in outline_log.handlers:
        outline_log.addHandler(OUTLINE_COUNTER)
    outline_log.setLevel(logging.INFO)
    # Bộ đếm đọc record trực tiếp; không để log engine làm bẩn bảng audit.
    outline_log.propagate = False


def _operation_worker(connection, expected_env: dict[str, str]) -> None:
    """Worker top-level/picklable; đọc sandbox từ env trước mọi import app."""
    worker_log = None
    try:
        actual_env = {name: os.environ.get(name, "") for name in WORKER_ENV_KEYS}
        if actual_env != expected_env:
            connection.send({"kind": "startup_error", "detail": "worker env mismatch"})
            return
        workspace = Path(expected_env["TMP"]).parent
        os.chdir(workspace)
        # Chặn cả output cấp file-descriptor để subprocess/native không thể lộ
        # tên corpus qua console; log nằm trong workspace và parent sẽ xóa.
        worker_log = (workspace / "worker-output.log").open("ab", buffering=0)
        for descriptor in (1, 2):
            os.dup2(worker_log.fileno(), descriptor)
        # `tempfile` có thể đã được multiprocessing import; buộc nó đọc lại
        # TMP/TEMP của process con thay vì dùng cache kế thừa.
        tempfile.tempdir = None
        (workspace / ".worker-env-ready").write_text(
            "\n".join(WORKER_ENV_KEYS),
            encoding="ascii",
        )
        from app.config import settings as worker_settings

        configured_paths = {
            "RESULTS_DIR": worker_settings.RESULTS_DIR,
            "UPLOAD_DIR": worker_settings.UPLOAD_DIR,
            "TMP": tempfile.gettempdir(),
        }
        for name, configured in configured_paths.items():
            if os.path.normcase(os.path.abspath(configured)) != os.path.normcase(
                os.path.abspath(expected_env[name])
            ):
                connection.send(
                    {"kind": "startup_error", "detail": "worker config escaped sandbox"}
                )
                return
        _configure_operation_logging()
        operation_by_name = dict(OPERATIONS)
        connection.send({"kind": "ready"})
        while True:
            request = connection.recv()
            if request is None:
                break
            operation_name, pdf = request
            fn = operation_by_name.get(operation_name)
            if fn is None:
                outcome = Outcome("ERROR", f"thao tác không tồn tại: {operation_name}")
            else:
                try:
                    with _silence(io.StringIO()):
                        outcome = _run(lambda fn=fn, pdf=pdf: fn(pdf))
                except BaseException as exc:  # noqa: BLE001 — giữ worker protocol terminal
                    outcome = Outcome("ERROR", f"{type(exc).__name__}: {exc}"[:200])
            connection.send({
                "kind": "outcome",
                "outcome": {
                    "status": outcome.status,
                    "detail": outcome.detail,
                    "gs_calls": outcome.gs_calls,
                    "seconds": outcome.seconds,
                    "extra": outcome.extra,
                },
            })
    except (EOFError, BrokenPipeError, OSError):
        pass
    except BaseException:  # noqa: BLE001 — không để child traceback lộ đường dẫn
        try:
            connection.send({"kind": "startup_error", "detail": "worker startup failed"})
        except (BrokenPipeError, EOFError, OSError):
            pass
    finally:
        connection.close()
        if worker_log is not None:
            worker_log.close()


def _terminate_process_tree(process) -> None:
    """Dừng worker và mọi process con mà operation đã sinh ra.

    `multiprocessing.Process.terminate()` trên Windows chỉ dừng đúng worker, dễ
    để lại converter/PDF helper chạy nền. `taskkill /T` giới hạn theo PID worker
    do chính audit sinh ra và thu cả cây con trước khi ta bỏ handle.
    """
    pid = getattr(process, "pid", None)
    if not pid:
        return
    if os.name == "nt":
        try:
            completed = subprocess.run(
                ["taskkill", "/PID", str(pid), "/T", "/F"],
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=15,
            )
            if completed.returncode != 0 and process.is_alive():
                process.terminate()
        except (OSError, subprocess.SubprocessError):
            process.terminate()
    else:
        process.terminate()
    process.join(timeout=5)
    if process.is_alive():
        process.kill()
        process.join(timeout=5)


class _WorkspaceCleanupError(RuntimeError):
    pass


class _OperationRunner:
    """Mỗi operation có process + workspace riêng do process cha quản lý."""

    def __init__(self, workspace_root: Path | None = None) -> None:
        self._context = multiprocessing.get_context("spawn")
        default_root = REPO / "tmp" / "gs_dependency_audit_workers"
        self._workspace_root = Path(workspace_root or default_root).resolve()
        self._parent_connection = None
        self._process = None
        self._workspace: Path | None = None
        self._poisoned_cleanup_error: str | None = None

    def _create_workspace(self) -> dict[str, str]:
        self._workspace_root.mkdir(parents=True, exist_ok=True)
        workspace = Path(
            tempfile.mkdtemp(prefix="worker-", dir=str(self._workspace_root))
        ).resolve()
        results = workspace / "results"
        uploads = workspace / "uploads"
        temp_dir = workspace / "temp"
        for directory in (results, uploads, temp_dir):
            directory.mkdir(parents=True, exist_ok=True)
        self._workspace = workspace
        return {
            "RESULTS_DIR": str(results),
            "UPLOAD_DIR": str(uploads),
            "TMP": str(temp_dir),
            "TEMP": str(temp_dir),
            "TMPDIR": str(temp_dir),
            "PRYNX_TOKEN_SOURCE": "stdin",
        }

    def _start_worker(self) -> None:
        expected_env = self._create_workspace()
        parent_connection, child_connection = self._context.Pipe()
        process = self._context.Process(
            target=_operation_worker,
            args=(child_connection, expected_env),
            name="prynx-no-gs-audit-worker",
        )
        previous_env = {name: os.environ.get(name) for name in WORKER_ENV_KEYS}
        try:
            os.environ.update(expected_env)
            process.start()
        finally:
            for name, previous in previous_env.items():
                if previous is None:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = previous
            child_connection.close()
        self._parent_connection = parent_connection
        self._process = process
        if not parent_connection.poll(WORKER_STARTUP_TIMEOUT_SECONDS):
            raise RuntimeError("worker không xác nhận sandbox đúng hạn")
        ready = parent_connection.recv()
        if ready.get("kind") != "ready":
            raise RuntimeError("worker từ chối sandbox")

    def _clear_process_handles(self) -> None:
        if self._parent_connection is not None:
            try:
                self._parent_connection.close()
            except OSError:
                pass
        self._parent_connection = None
        self._process = None

    def _kill_worker(self) -> None:
        process = self._process
        if process is not None:
            _terminate_process_tree(process)
        self._clear_process_handles()

    @staticmethod
    def _remove_readonly(function, path, _exc_info) -> None:
        os.chmod(path, stat.S_IWRITE)
        function(path)

    def _cleanup_workspace(self) -> str | None:
        workspace = self._workspace
        if workspace is None:
            return None
        try:
            workspace.relative_to(self._workspace_root)
        except ValueError:
            return "workspace nằm ngoài vùng cô lập"
        last_error = None
        for _attempt in range(3):
            try:
                if workspace.exists():
                    shutil.rmtree(workspace, onerror=self._remove_readonly)
                if not workspace.exists():
                    self._workspace = None
                    return None
            except OSError as exc:
                last_error = exc
            time.sleep(0.05)
        return f"không dọn được workspace cô lập ({type(last_error).__name__})"

    def _stop_worker(self, *, force: bool) -> str | None:
        process = self._process
        connection = self._parent_connection
        if process is None:
            self._clear_process_handles()
            return None
        if force:
            self._kill_worker()
            return None
        try:
            if connection is not None:
                connection.send(None)
            process.join(timeout=5)
        except (BrokenPipeError, EOFError, OSError):
            self._kill_worker()
            return "worker không đóng giao thức sạch"
        if process.is_alive():
            self._kill_worker()
            return "worker không dừng đúng hạn"
        self._clear_process_handles()
        return None

    def _finalize_worker(self, *, force: bool) -> tuple[str | None, str | None]:
        stop_error = None
        try:
            stop_error = self._stop_worker(force=force)
        except BaseException as exc:  # noqa: BLE001 — cleanup workspace vẫn bắt buộc
            stop_error = f"không dừng được worker ({type(exc).__name__})"
            self._clear_process_handles()
        finally:
            try:
                cleanup_error = self._cleanup_workspace()
            except BaseException as exc:  # noqa: BLE001 — chuyển thành terminal fail
                cleanup_error = f"không dọn được workspace ({type(exc).__name__})"
        return stop_error, cleanup_error

    def run(self, operation_name: str, pdf: str, timeout_seconds: float) -> Outcome:
        if self._poisoned_cleanup_error:
            return Outcome("ERROR", self._poisoned_cleanup_error)
        started = time.perf_counter()
        outcome = None
        force_stop = False
        pending_exception = None
        workspace_for_scrub = None
        try:
            self._start_worker()
            workspace_for_scrub = self._workspace
            connection = self._parent_connection
            # Child chỉ nhận bản sao tên mờ trong sandbox: không thể ghi đè input
            # gốc và exception native cũng không biết tên/path corpus thật.
            sandbox_input = self._workspace / "input.pdf"
            shutil.copyfile(pdf, sandbox_input)
            connection.send((operation_name, str(sandbox_input)))
            operation_started = time.perf_counter()
            if not connection.poll(timeout_seconds):
                force_stop = True
                outcome = Outcome(
                    "TIMEOUT",
                    f"vượt quá {timeout_seconds:g} giây; đã dừng cây process",
                    seconds=time.perf_counter() - operation_started,
                )
            else:
                message = connection.recv()
                if message.get("kind") != "outcome":
                    force_stop = True
                    outcome = Outcome("ERROR", "worker trả giao thức không hợp lệ")
                else:
                    outcome = Outcome(**message["outcome"])
                    # Mỗi operation là một process: thu cả cây con trước khi xóa
                    # workspace, không dựa vào finally của child.
                    force_stop = True
        except (EOFError, BrokenPipeError, OSError, RuntimeError) as exc:
            force_stop = True
            outcome = Outcome(
                "ERROR",
                f"worker kết thúc bất thường: {type(exc).__name__}",
                seconds=time.perf_counter() - started,
            )
        except BaseException as exc:  # noqa: BLE001 — vẫn phải dọn sandbox trước khi thoát
            force_stop = True
            pending_exception = exc

        stop_error, cleanup_error = self._finalize_worker(force=force_stop)
        if cleanup_error:
            self._poisoned_cleanup_error = cleanup_error
        lifecycle_error = cleanup_error or stop_error
        if pending_exception is not None:
            if lifecycle_error:
                raise _WorkspaceCleanupError(lifecycle_error) from pending_exception
            raise pending_exception
        if outcome is None:
            outcome = Outcome("ERROR", "worker không trả kết quả terminal")
        if lifecycle_error:
            outcome = Outcome(
                "ERROR",
                lifecycle_error,
                seconds=outcome.seconds,
                extra={"original_status": outcome.status},
            )
        sensitive = [pdf]
        if workspace_for_scrub is not None:
            sensitive.append(workspace_for_scrub)
        return _sanitize_outcome(outcome, sensitive)

    def close(self, *, force: bool = False) -> None:
        stop_error, cleanup_error = self._finalize_worker(
            force=force or self._process is not None
        )
        if cleanup_error or stop_error:
            raise _WorkspaceCleanupError(cleanup_error or stop_error)

    def __enter__(self):
        return self

    def __exit__(self, exc_type, _exc, _tb):
        self.close(force=exc_type is not None)
        return False


def _positive_seconds(value: str) -> float:
    try:
        seconds = float(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("timeout phải là số giây") from exc
    if not math.isfinite(seconds) or seconds <= 0:
        raise argparse.ArgumentTypeError("timeout phải là số dương hữu hạn")
    return seconds


def _is_terminal_result(record) -> bool:
    return isinstance(record, dict) and record.get("status") in TERMINAL_STATUSES


def _outcome_record(outcome: Outcome) -> dict:
    return {
        "status": outcome.status,
        "detail": outcome.detail,
        "gs_calls": outcome.gs_calls,
        "seconds": round(outcome.seconds, 2),
        **({"extra": outcome.extra} if outcome.extra else {}),
    }


def _measure_operations(
    corpus_entries: list[tuple[str, Path]],
    ops,
    results: dict[str, dict[str, dict]],
    *,
    resume: bool,
    out_path: Path,
    runner: _OperationRunner,
    timeout_seconds: float,
    fingerprint: str,
) -> None:
    """Đo và checkpoint sau từng operation, kể cả ERROR/TIMEOUT."""
    corpus_keys = [key for key, _pdf in corpus_entries]
    for i, (corpus_key, pdf) in enumerate(corpus_entries, 1):
        print(f"[{i}/{len(corpus_entries)}] {corpus_key}", flush=True)
        existing = results.get(corpus_key)
        per_file = existing if isinstance(existing, dict) else {}
        results[corpus_key] = per_file
        for name, _fn in ops:
            if resume and _is_terminal_result(per_file.get(name)):
                continue
            outcome = _sanitize_outcome(
                runner.run(name, str(pdf), timeout_seconds),
                [pdf],
            )
            per_file[name] = _outcome_record(outcome)
            flag = {
                "OK": "  ",
                "REFUSED": " ~",
                "GS": " GS",
                "ERROR": " !!",
                "TIMEOUT": " TO",
            }[outcome.status]
            print(f"    {flag} {name:<26} {outcome.detail[:90]}", flush=True)
            # BUILD (audit 2026-08-03 §REL.09): checkpoint mức operation để một
            # operation treo/phiên bị ngắt không làm mất cả file đang đo dở.
            _write_artifact(out_path, results, corpus_keys, fingerprint)


def _blocking_operations(summary: dict[str, dict]) -> list[str]:
    return [
        name for name, counts in summary.items()
        if counts.get("GS", 0) or counts.get("ERROR", 0) or counts.get("TIMEOUT", 0)
    ]


def main() -> int:
    ap = argparse.ArgumentParser(description="Đo phụ thuộc Ghostscript trên corpus")
    ap.add_argument("target", help="thư mục chứa .pdf hoặc một file .pdf")
    ap.add_argument("--only", help="lọc theo tên thao tác (khớp chuỗi con)")
    ap.add_argument("--limit", type=int, default=0, help="chỉ chạy N file đầu")
    ap.add_argument(
        "--resume",
        action="store_true",
        help=(
            "tái dùng operation terminal chỉ khi fingerprint source/corpus/operations khớp"
        ),
    )
    ap.add_argument(
        "--operation-timeout",
        type=_positive_seconds,
        default=DEFAULT_OPERATION_TIMEOUT_SECONDS,
        metavar="SECONDS",
        help=(
            "timeout cho từng operation; mặc định "
            f"{DEFAULT_OPERATION_TIMEOUT_SECONDS:g} giây"
        ),
    )
    ap.add_argument(
        "--gate",
        action="store_true",
        help="trả mã 1 nếu còn GS, ERROR hoặc TIMEOUT; REFUSED được phép",
    )
    ap.add_argument(
        "--out",
        default=str(REPO / "tmp" / "gs_dependency_audit.json"),
        help="nơi ghi artifact JSON",
    )
    args = ap.parse_args()

    target = Path(args.target)
    files = sorted(target.glob("*.pdf")) if target.is_dir() else [target]
    if args.limit:
        files = files[: args.limit]
    if not files:
        print("không có PDF nào để đo", file=sys.stderr)
        return 2
    files = [path.resolve() for path in files]

    ops = [(n, f) for n, f in OPERATIONS if not args.only or args.only in n]
    if not ops:
        print("không có thao tác nào khớp bộ lọc --only", file=sys.stderr)
        return 2

    try:
        settings = _load_settings_for_audit()
    except _WorkspaceCleanupError:
        print("DỪNG: không dọn sạch được settings workspace.", file=sys.stderr)
        return 2

    # Chốt: nếu vẫn còn đường dẫn GS thì phép đo vô nghĩa (mọi thứ sẽ báo OK nhờ GS).
    if settings.GHOSTSCRIPT_PATH:
        print(
            "DỪNG: GHOSTSCRIPT_PATH vẫn có giá trị — phép đo sẽ sai. "
            "Kiểm PRYNX_NO_GS_BUILD.",
            file=sys.stderr,
        )
        return 2
    # GS-SUNSET (audit 2026-07-28 §FL.4): thuộc tính fallback đã bị xoá khỏi Settings.
    # getattr giữ cổng audit tương thích và không crash với hợp đồng no-GS cố định.
    if getattr(settings, "PRYNX_ALLOW_GS_FALLBACK", False):
        print("DỪNG: PRYNX_ALLOW_GS_FALLBACK vẫn bật.", file=sys.stderr)
        return 2

    print(f"Corpus: {len(files)} file | thao tác: {len(ops)}")
    print(f"GHOSTSCRIPT_PATH = {settings.GHOSTSCRIPT_PATH!r}  (đã chặn)")
    print(f"Timeout mỗi thao tác = {args.operation_timeout:g} giây")
    print("Đang tính fingerprint nội dung source/corpus/operations...", flush=True)
    runtime_config = _runtime_config_from_settings(settings)
    try:
        fingerprint = _build_provenance_fingerprint(
            files,
            [name for name, _fn in ops],
            operation_timeout_seconds=args.operation_timeout,
            runtime_config=runtime_config,
        )
    except (OSError, RuntimeError) as exc:
        print(
            f"DỪNG: không chốt được fingerprint ({type(exc).__name__})",
            file=sys.stderr,
        )
        return 2
    print(f"Fingerprint = {fingerprint[:16]}…")
    print()
    corpus_entries = [
        (_opaque_corpus_key(index, fingerprint), pdf)
        for index, pdf in enumerate(files)
    ]
    corpus_keys = [key for key, _pdf in corpus_entries]

    out_path = Path(args.out)
    results: dict[str, dict[str, dict]] = {}
    if args.resume and out_path.is_file():
        try:
            results, _resumed, message = _load_resume_results(
                out_path,
                fingerprint,
                corpus_keys,
            )
            print(message)
        except Exception as exc:  # noqa: BLE001
            print(
                f"không đọc được artifact cũ ({type(exc).__name__}) — chạy lại từ đầu"
            )

    try:
        with _OperationRunner() as runner:
            _measure_operations(
                corpus_entries,
                ops,
                results,
                resume=args.resume,
                out_path=out_path,
                runner=runner,
                timeout_seconds=args.operation_timeout,
                fingerprint=fingerprint,
            )
    except _WorkspaceCleanupError:
        _write_artifact(
            out_path,
            results,
            corpus_keys,
            fingerprint,
            provenance_valid=False,
        )
        print("DỪNG: không dọn sạch được workspace cô lập.", file=sys.stderr)
        return 2

    # BUILD (audit 2026-08-03 §REL.09): lượt audit dài không được đạt nếu source
    # hoặc corpus đổi sau lúc fingerprint đầu vào được chốt.
    print("Đang xác nhận lại fingerprint sau khi đo...", flush=True)
    try:
        final_fingerprint = _build_provenance_fingerprint(
            files,
            [name for name, _fn in ops],
            operation_timeout_seconds=args.operation_timeout,
            runtime_config=runtime_config,
        )
    except (OSError, RuntimeError) as exc:
        _write_artifact(
            out_path,
            results,
            corpus_keys,
            fingerprint,
            provenance_valid=False,
        )
        print(
            f"DỪNG: không xác nhận được fingerprint cuối ({type(exc).__name__})",
            file=sys.stderr,
        )
        return 2
    if final_fingerprint != fingerprint:
        _write_artifact(
            out_path,
            results,
            corpus_keys,
            fingerprint,
            provenance_valid=False,
        )
        print(
            "DỪNG: source/corpus/operations đã đổi trong lúc audit; "
            "artifact bị vô hiệu hóa.",
            file=sys.stderr,
        )
        return 2

    # ── Tổng hợp ───────────────────────────────────────────────────────────
    print("\n" + "=" * 78)
    print(
        f"{'thao tác':<26} {'OK':>4} {'REFUSED':>8} "
        f"{'GS':>4} {'ERROR':>6} {'TIMEOUT':>8}"
    )
    print("-" * 78)
    completed_keys = [key for key in corpus_keys if key in results]
    summary: dict[str, dict] = {}
    for name, _fn in ops:
        c = Counter(
            results[key].get(name, {}).get("status", "ERROR")
            for key in completed_keys
        )
        summary[name] = dict(c)
        print(
            f"{name:<26} {c['OK']:>4} {c['REFUSED']:>8} "
            f"{c['GS']:>4} {c['ERROR']:>6} {c['TIMEOUT']:>8}"
        )
    print("=" * 78)

    gs_ops = [n for n, s in summary.items() if s.get("GS")]
    if gs_ops:
        print("\nCÒN PHỤ THUỘC GHOSTSCRIPT:")
        for n in gs_ops:
            bad_count = sum(
                results[key].get(n, {}).get("status") == "GS"
                for key in completed_keys
            )
            print(f"  {n}: {bad_count} file")
    else:
        print("\nKhông thao tác nào cần Ghostscript trên corpus này.")

    ppe = sum(
        (results[key].get("act:OUTLINE_FONTS", {}).get("extra", {}) or {}).get("ppe_glyphs", 0)
        for key in completed_keys
    )
    fb = sum(
        (results[key].get("act:OUTLINE_FONTS", {}).get("extra", {}) or {}).get("fallback_glyphs", 0)
        for key in completed_keys
    )
    if ppe or fb:
        print(f"\nOUTLINE_FONTS: {ppe} glyph dùng hình học PPE, {fb} lùi về fontTools")

    _write_artifact(out_path, results, corpus_keys, fingerprint, summary)
    print("\nArtifact audit đã được ghi.")
    blocking = _blocking_operations(summary)
    if args.gate and blocking:
        print(
            "GATE THẤT BẠI: còn GS/ERROR/TIMEOUT ở " + ", ".join(blocking),
            file=sys.stderr,
        )
        return 1
    return 0


def _write_artifact(
    out_path: Path,
    results: dict,
    corpus_keys,
    fingerprint: str,
    summary: dict | None = None,
    *,
    provenance_valid: bool = True,
) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    corpus_keys = list(corpus_keys)
    if any(not _is_opaque_corpus_key(key) for key in corpus_keys):
        raise ValueError("corpus key không mờ")
    if not set(results).issubset(corpus_keys):
        raise ValueError("results chứa corpus key ngoài manifest")
    payload = {
        "schema_version": ARTIFACT_SCHEMA_VERSION,
        "fingerprint_algorithm": FINGERPRINT_ALGORITHM,
        "fingerprint": fingerprint,
        "provenance_valid": provenance_valid,
        "files": results,
        "corpus": corpus_keys,
    }
    if summary is not None:
        payload["summary"] = summary
    # Ghi qua file tạm cùng thư mục rồi replace: mất điện/Ctrl+C giữa lúc serialize
    # không được phá artifact đang dùng cho --resume.
    temp_path = out_path.with_name(out_path.name + ".tmp")
    temp_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    os.replace(temp_path, out_path)


class _silence:
    """Nuốt stdout/stderr của engine để bảng đo đọc được.

    Không nuốt logging: `OUTLINE_COUNTER` cần đọc log, và log cấu hình ở mức
    CRITICAL nên không làm bẩn màn hình.
    """

    def __init__(self, buf):
        self._buf = buf

    def __enter__(self):
        self._out, self._err = sys.stdout, sys.stderr
        sys.stdout = sys.stderr = self._buf

    def __exit__(self, *exc):
        sys.stdout, sys.stderr = self._out, self._err
        return False


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\nđã dừng theo yêu cầu", file=sys.stderr)
        raise SystemExit(130)
    except Exception as exc:  # noqa: BLE001 — console không được lộ path corpus
        print(f"DỪNG: audit lỗi ({type(exc).__name__})", file=sys.stderr)
        raise SystemExit(2)
