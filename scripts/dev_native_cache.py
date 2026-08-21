#!/usr/bin/env python3
"""Quản lý cache build native cho vòng dev của PrynX.

``run_dev.bat`` vẫn bundle khuôn bế trước, nhưng không cần gọi
``maturin develop --release`` nếu các đầu vào thực sự của extension không đổi.
Fingerprint dựa trên NỘI DUNG (không dựa vào mtime), vì Vite xoá và ghi lại
``native/src/generated/dieline_engine.bundle.js`` ở mỗi lượt chạy.

Lệnh ``prepare`` ghi fingerprint đang chờ trước khi build. ``commit`` chỉ ghi
cache sau khi build thành công và kiểm lại fingerprint lần nữa; nếu source đổi
trong lúc Rust đang compile, cache không bị đánh dấu nhầm là mới.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import subprocess
import sys
import tempfile
import struct
from pathlib import Path
from typing import Iterable, Mapping


# PERF (audit 2026-08-20 DEV.NATIVE.CACHE): tăng schema khi đổi hợp đồng
# fingerprint để cache cũ tự động vô hiệu hoá.
CACHE_SCHEMA = 2
EXIT_CACHE_HIT = 0
EXIT_BUILD_REQUIRED = 10
EXIT_CACHE_ERROR = 2

_SINGLE_INPUTS = (
    "native/Cargo.toml",
    "native/Cargo.lock",
    "native/build.rs",
    "imposition_core/Cargo.toml",
    "print_engine/Cargo.toml",
    # Native nhúng profile ICC này bằng include_bytes!.
    "backend/app/assets/icc/sRGB.icc",
)
_SOURCE_DIRECTORIES = (
    "native/src",
    "imposition_core/src",
    "print_engine/src",
)

# Chỉ hash giá trị; không ghi giá trị thật ra stamp vì có thể chứa khoá phát hành.
_BUILD_ENVIRONMENT = (
    "CARGO_BUILD_TARGET",
    "CARGO_TARGET_DIR",
    "CARGO_PROFILE_RELEASE_LTO",
    "CARGO_PROFILE_RELEASE_CODEGEN_UNITS",
    "CARGO_PROFILE_RELEASE_STRIP",
    "CARGO_ENCODED_RUSTFLAGS",
    "CARGO_BUILD_RUSTC",
    "RUSTC",
    "RUSTC_WRAPPER",
    "RUSTUP_TOOLCHAIN",
    "RUSTFLAGS",
    "PYO3_CROSS",
    "PYO3_CROSS_LIB_DIR",
    "PYO3_PYTHON",
    "PRYNX_DIELINE_KEY_B64",
    "PRYNX_DIELINE_VERSION",
    "PRYNX_BUILD_SOURCE_REVISION",
    "PRYNX_BUILD_SOURCE_DIRTY",
    "PRYNX_BUILD_TIMESTAMP_UTC",
)
_ARTIFACT_SUFFIXES = {".pyd", ".so", ".dylib"}


class NativeCacheError(RuntimeError):
    """Lỗi khiến caller phải build lại thay vì tin cache."""


def _iter_input_files(root: Path) -> list[tuple[str, Path]]:
    """Liệt kê file đầu vào mà native crate có thể nhúng/biên dịch."""

    files: dict[str, Path] = {}
    for relative in _SINGLE_INPUTS:
        path = root / Path(relative)
        if not path.is_file():
            raise NativeCacheError(f"Không tìm thấy đầu vào native: {relative}")
        files[relative] = path

    for relative_dir in _SOURCE_DIRECTORIES:
        directory = root / Path(relative_dir)
        if not directory.is_dir():
            raise NativeCacheError(f"Không tìm thấy thư mục native: {relative_dir}")
        for path in directory.rglob("*"):
            if path.is_file():
                relative = path.relative_to(root).as_posix()
                files[relative] = path

    return sorted(files.items(), key=lambda item: item[0])


def _read_tool_output(command: list[str], *, timeout: float = 10.0) -> str:
    try:
        result = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return f"<unavailable:{type(exc).__name__}>"
    output = (result.stdout or result.stderr or "").strip()
    if result.returncode != 0:
        return f"<exit:{result.returncode}:{output}>"
    return output


def collect_toolchain_identity(python_executable: str | None = None) -> dict[str, str]:
    """Lấy danh tính toolchain ngắn để đổi compiler/ABI thì build lại."""

    python_path = str(Path(python_executable or sys.executable).resolve())
    return {
        "python": (
            f"{python_path}|{platform.python_implementation()}|"
            f"{platform.python_version()}|"
            f"{getattr(sys.implementation, 'cache_tag', '')}"
        ),
        "rustc": _read_tool_output(["rustc", "-Vv"]),
        "cargo": _read_tool_output(["cargo", "-V"]),
        "maturin": _read_tool_output(
            [python_executable or sys.executable, "-m", "maturin", "--version"]
        ),
        # Không dùng platform.architecture(): trên Windows hàm này gọi
        # subprocess với codepage hệ thống và có thể lỗi khi console không
        # biểu diễn được tên/đường dẫn Unicode.
        "platform": f"{platform.system()}|{platform.machine()}|{struct.calcsize('P') * 8}-bit",
    }


def compute_fingerprint(
    root: Path,
    *,
    environment: Mapping[str, str] | None = None,
    toolchain: Mapping[str, str] | None = None,
) -> str:
    """Tính hash ổn định theo nội dung source, môi trường và toolchain."""

    root = root.resolve()
    environment = os.environ if environment is None else environment
    toolchain = (
        collect_toolchain_identity() if toolchain is None else toolchain
    )
    digest = hashlib.sha256()

    def add(label: str, value: bytes) -> None:
        encoded_label = label.encode("utf-8")
        digest.update(len(encoded_label).to_bytes(4, "big"))
        digest.update(encoded_label)
        digest.update(len(value).to_bytes(8, "big"))
        digest.update(value)

    add("cache-schema", str(CACHE_SCHEMA).encode("ascii"))
    for relative, path in _iter_input_files(root):
        add(f"file:{relative}", path.read_bytes())

    for name in _BUILD_ENVIRONMENT:
        marker = "<unset>" if name not in environment else environment[name]
        add(f"env:{name}", str(marker).encode("utf-8"))

    for name in sorted(toolchain):
        add(f"tool:{name}", str(toolchain[name]).encode("utf-8"))

    return digest.hexdigest()


def _artifact_files(artifact_dir: Path) -> list[Path]:
    if not artifact_dir.is_dir():
        return []
    return sorted(
        (
            path
            for path in artifact_dir.rglob("*")
            if path.is_file()
            and path.suffix.lower() in _ARTIFACT_SUFFIXES
            and path.stat().st_size > 0
        ),
        key=lambda path: path.as_posix(),
    )


def _artifact_signature(artifact_dir: Path) -> list[dict[str, int | str]]:
    """Dấu vết nhẹ của extension đã cài, không phải hash toàn DLL mỗi lượt."""

    signature: list[dict[str, int | str]] = []
    for path in _artifact_files(artifact_dir):
        stat = path.stat()
        signature.append(
            {
                "path": path.relative_to(artifact_dir).as_posix(),
                "size": stat.st_size,
                "mtime_ns": stat.st_mtime_ns,
            }
        )
    return signature


def _load_json(path: Path) -> dict[str, object] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def _valid_record(value: dict[str, object] | None) -> bool:
    fingerprint = value.get("fingerprint") if value else None
    return bool(
        value
        and value.get("schema") == CACHE_SCHEMA
        and isinstance(fingerprint, str)
        and len(fingerprint) == 64
        and all(character in "0123456789abcdef" for character in fingerprint)
    )


def _atomic_write(path: Path, value: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    temporary_path = Path(temporary_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(value, stream, ensure_ascii=True, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary_path, path)
    finally:
        try:
            temporary_path.unlink()
        except FileNotFoundError:
            pass


def prepare_cache(
    root: Path,
    stamp: Path,
    artifact_dir: Path,
    *,
    force: bool = False,
    environment: Mapping[str, str] | None = None,
    toolchain: Mapping[str, str] | None = None,
) -> tuple[bool, str]:
    """Chuẩn bị cache; trả ``(hit, detail)`` và tạo pending record khi miss."""

    fingerprint = compute_fingerprint(
        root, environment=environment, toolchain=toolchain
    )
    pending = stamp.with_suffix(stamp.suffix + ".pending")
    record = _load_json(stamp)
    artifacts = _artifact_signature(artifact_dir)
    if not force and _valid_record(record):
        if (
            record
            and record.get("fingerprint") == fingerprint
            and record.get("artifacts") == artifacts
            and artifacts
        ):
            pending.unlink(missing_ok=True)
            return True, fingerprint

    _atomic_write(
        pending,
        {"schema": CACHE_SCHEMA, "fingerprint": fingerprint},
    )
    reason = "ép build theo yêu cầu" if force else "đầu vào native hoặc artifact đã thay đổi"
    return False, reason


def commit_cache(
    root: Path,
    stamp: Path,
    artifact_dir: Path,
    *,
    environment: Mapping[str, str] | None = None,
    toolchain: Mapping[str, str] | None = None,
) -> bool:
    """Ghi stamp sau build, chỉ khi source không đổi trong lúc build."""

    pending = stamp.with_suffix(stamp.suffix + ".pending")
    record = _load_json(pending)
    artifacts = _artifact_signature(artifact_dir)
    if not _valid_record(record) or not artifacts:
        return False
    current = compute_fingerprint(
        root, environment=environment, toolchain=toolchain
    )
    if record["fingerprint"] != current:
        pending.unlink(missing_ok=True)
        return False
    _atomic_write(
        stamp,
        {
            "schema": CACHE_SCHEMA,
            "fingerprint": current,
            "artifacts": artifacts,
        },
    )
    pending.unlink(missing_ok=True)
    return True


def _default_paths(root: Path) -> tuple[Path, Path]:
    venv = root / "backend" / "venv"
    return (
        venv / ".prynx-native-dev-fingerprint.json",
        venv / "Lib" / "site-packages" / "pdfcompare_native",
    )


def _add_common_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--root", type=Path, default=Path("."), help="gốc repo")
    parser.add_argument("--stamp", type=Path, help="file fingerprint cache")
    parser.add_argument("--artifact-dir", type=Path, help="thư mục extension đã cài")


def main(argv: Iterable[str] | None = None) -> int:
    # run_dev.bat thường chạy trong console codepage cũ (charmap). Bảo đảm
    # thông báo tiếng Việt không làm helper lỗi trước khi trả mã cache.
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    prepare_parser = subparsers.add_parser("prepare", help="kiểm cache trước build")
    _add_common_arguments(prepare_parser)
    prepare_parser.add_argument("--force", action="store_true")
    commit_parser = subparsers.add_parser("commit", help="ghi cache sau build")
    _add_common_arguments(commit_parser)
    args = parser.parse_args(list(argv) if argv is not None else None)

    root = args.root.resolve()
    default_stamp, default_artifact = _default_paths(root)
    stamp = (args.stamp or default_stamp).resolve()
    artifact_dir = (args.artifact_dir or default_artifact).resolve()
    try:
        if args.command == "prepare":
            hit, detail = prepare_cache(
                root, stamp, artifact_dir, force=args.force
            )
            if hit:
                print("CACHE NATIVE: bo qua maturin (input khong doi).")
                return EXIT_CACHE_HIT
            print(f"CACHE NATIVE: can build ({detail}).")
            return EXIT_BUILD_REQUIRED

        if commit_cache(root, stamp, artifact_dir):
            print("CACHE NATIVE: da ghi sau khi build thanh cong.")
            return EXIT_CACHE_HIT
        print("CANH BAO: khong ghi duoc cache native; luot sau se build lai.")
        return EXIT_CACHE_ERROR
    except (NativeCacheError, OSError, ValueError) as exc:
        print(f"CANH BAO: cache native khong kha dung: {exc}")
        return EXIT_CACHE_ERROR


if __name__ == "__main__":
    raise SystemExit(main())
