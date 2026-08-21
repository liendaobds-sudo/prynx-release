"""Hồi quy cache native của vòng dev, không gọi Cargo/maturin thật."""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest


SCRIPT = Path(__file__).parents[2] / "scripts" / "dev_native_cache.py"
SPEC = importlib.util.spec_from_file_location("dev_native_cache", SCRIPT)
assert SPEC and SPEC.loader
cache = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cache)

TOOLCHAIN = {
    "python": "test-python",
    "rustc": "rustc-test",
    "cargo": "cargo-test",
    "maturin": "maturin-test",
    "platform": "windows-test",
}


@pytest.fixture()
def fixture_repo(tmp_path: Path) -> tuple[Path, Path, Path]:
    root = tmp_path / "repo"
    for relative in (
        "native/src/generated",
        "imposition_core/src",
        "print_engine/src",
        "backend/app/assets/icc",
    ):
        (root / relative).mkdir(parents=True)
    files = {
        "native/Cargo.toml": "native",
        "native/Cargo.lock": "lock",
        "native/build.rs": "build",
        "native/src/lib.rs": "native source",
        "native/src/generated/dieline_engine.bundle.js": "stable bundle",
        "imposition_core/Cargo.toml": "core manifest",
        "imposition_core/src/lib.rs": "core source",
        "print_engine/Cargo.toml": "print manifest",
        "print_engine/src/lib.rs": "print source",
        "backend/app/assets/icc/sRGB.icc": "icc bytes",
    }
    for relative, content in files.items():
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content.encode())
    artifact_dir = root / "backend/venv/Lib/site-packages/pdfcompare_native"
    artifact_dir.mkdir(parents=True)
    (artifact_dir / "pdfcompare_native.cp311-win_amd64.pyd").write_bytes(b"native")
    stamp = root / "backend/venv/.prynx-native-dev-fingerprint.json"
    return root, stamp, artifact_dir


def _prepare(root: Path, stamp: Path, artifact: Path, *, force: bool = False):
    return cache.prepare_cache(
        root,
        stamp,
        artifact,
        force=force,
        environment={},
        toolchain=TOOLCHAIN,
    )


def _commit(root: Path, stamp: Path, artifact: Path) -> bool:
    return cache.commit_cache(
        root,
        stamp,
        artifact,
        environment={},
        toolchain=TOOLCHAIN,
    )


def test_missing_stamp_requires_build_then_unchanged_skips(fixture_repo):
    root, stamp, artifact = fixture_repo
    hit, _ = _prepare(root, stamp, artifact)
    assert hit is False
    assert _commit(root, stamp, artifact) is True
    hit, _ = _prepare(root, stamp, artifact)
    assert hit is True


def test_rewriting_bundle_with_same_bytes_does_not_rebuild(fixture_repo):
    root, stamp, artifact = fixture_repo
    _prepare(root, stamp, artifact)
    assert _commit(root, stamp, artifact)
    bundle = root / "native/src/generated/dieline_engine.bundle.js"
    bundle.write_bytes(bundle.read_bytes())
    hit, _ = _prepare(root, stamp, artifact)
    assert hit is True


@pytest.mark.parametrize(
    "relative",
    (
        "native/Cargo.toml",
        "native/Cargo.lock",
        "native/build.rs",
        "native/src/lib.rs",
        "native/src/generated/dieline_engine.bundle.js",
        "imposition_core/Cargo.toml",
        "imposition_core/src/lib.rs",
        "print_engine/Cargo.toml",
        "print_engine/src/lib.rs",
        "backend/app/assets/icc/sRGB.icc",
    ),
)
def test_native_input_change_requires_build(fixture_repo, relative):
    root, stamp, artifact = fixture_repo
    _prepare(root, stamp, artifact)
    assert _commit(root, stamp, artifact)
    path = root / relative
    path.write_bytes(path.read_bytes() + b" changed")
    hit, _ = _prepare(root, stamp, artifact)
    assert hit is False


def test_unrelated_file_change_does_not_rebuild(fixture_repo):
    root, stamp, artifact = fixture_repo
    _prepare(root, stamp, artifact)
    assert _commit(root, stamp, artifact)
    (root / "desktop-note.txt").write_text("frontend only", encoding="utf-8")
    hit, _ = _prepare(root, stamp, artifact)
    assert hit is True


def test_missing_artifact_or_toolchain_change_requires_build(fixture_repo):
    root, stamp, artifact = fixture_repo
    _prepare(root, stamp, artifact)
    assert _commit(root, stamp, artifact)
    next_toolchain = {**TOOLCHAIN, "rustc": "rustc-new"}
    hit, _ = cache.prepare_cache(
        root,
        stamp,
        artifact,
        environment={},
        toolchain=next_toolchain,
    )
    assert hit is False
    (artifact / "pdfcompare_native.cp311-win_amd64.pyd").unlink()
    hit, _ = _prepare(root, stamp, artifact)
    assert hit is False


def test_replaced_native_artifact_requires_build(fixture_repo):
    root, stamp, artifact = fixture_repo
    _prepare(root, stamp, artifact)
    assert _commit(root, stamp, artifact)
    native = artifact / "pdfcompare_native.cp311-win_amd64.pyd"
    native.write_bytes(b"different native artifact")
    hit, _ = _prepare(root, stamp, artifact)
    assert hit is False


def test_source_change_during_build_is_not_committed(fixture_repo):
    root, stamp, artifact = fixture_repo
    _prepare(root, stamp, artifact)
    (root / "native/src/lib.rs").write_bytes(b"changed during build")
    assert _commit(root, stamp, artifact) is False
    assert not stamp.exists()


def test_force_flag_always_requires_build(fixture_repo):
    root, stamp, artifact = fixture_repo
    _prepare(root, stamp, artifact)
    assert _commit(root, stamp, artifact)
    hit, _ = _prepare(root, stamp, artifact, force=True)
    assert hit is False
    assert _commit(root, stamp, artifact)
    hit, _ = _prepare(root, stamp, artifact)
    assert hit is True


def test_run_dev_places_cache_around_maturin():
    run_dev = SCRIPT.parents[1] / "run_dev.bat"
    raw = run_dev.read_bytes()
    source = raw.decode("utf-8")
    bundle = source.index("npm.cmd run build:dieline-sidecar")
    prepare = source.index("dev_native_cache.py prepare")
    maturin = source.index("maturin develop --release")
    commit = source.index("dev_native_cache.py commit")
    assert bundle < prepare < maturin < commit
    assert "--rebuild-native" in source
    assert "dev_native_cache.py prepare --force" in source
    # CMD có thể resume sai byte và biến đuôi `PrynX-dev\uploads` thành lệnh
    # nếu file UTF-8 bị trộn LF/CRLF sau khi apply patch.
    assert raw.count(b"\n") == raw.count(b"\r\n")
    assert "goto native_" not in source.lower()
    assert ":native_" not in source.lower()
