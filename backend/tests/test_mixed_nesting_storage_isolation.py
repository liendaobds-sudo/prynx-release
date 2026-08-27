"""Cách ly kho lưu: không đụng tới cleanup/artifact của tính năng khác — phase P14b.

Kế hoạch: ``docs/KE_HOACH_MIXED_TRUE_SHAPE_NESTING_DOC_LAP_2026-08-26.md`` §12.4, §16.5.

§12.4 nói rõ: "Không import hoặc sửa ``artifact_lease.py``/``cleanup.py``". Bộ test này chứng
minh điều đó **theo cấu trúc** (AST) và **theo hành vi** (đặt file thật của tính năng khác
cạnh root rồi chạy sweeper, kiểm chúng còn nguyên).

Đây là loại hồi quy tệ nhất có thể xảy ra: một sweeper mới xoá artifact của Imposition/VDP/Edit
và không ai biết cho tới khi khách mất file.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

from app.core.mixed_nesting_artifacts import (
    ArtifactRootUnsafe,
    MixedNestingArtifactStore,
    assert_root_safe,
)

_REPO_ROOT = Path(__file__).resolve().parents[2]

#: Mọi file mới của tính năng này. Thêm file thì thêm vào đây.
_FEATURE_FILES = (
    "backend/app/core/mixed_nesting_artifacts.py",
    "backend/app/core/mixed_nesting_jobs.py",
    "backend/app/core/mixed_nesting_service.py",
    "backend/app/workers/mixed_nesting_pdf_source.py",
    "backend/app/workers/mixed_nesting_pdf_export.py",
    "backend/app/api/routes/mixed_nesting.py",
    "backend/app/schemas/mixed_nesting.py",
    "backend/app/schemas/mixed_nesting_source.py",
)

#: Module dùng chung mà tính năng này KHÔNG được import.
_FORBIDDEN_MODULES = (
    "app.core.artifact_lease",
    "app.core.cleanup",
)


def _imports_of(relative: str) -> set[str]:
    tree = ast.parse((_REPO_ROOT / relative).read_text(encoding="utf-8"))
    modules: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            modules.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            modules.add(node.module)
    return modules


# ─────────────────────────────────────────────────────────────────────────────
#  1. Cách ly theo cấu trúc
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("relative", _FEATURE_FILES)
def test_khong_import_artifact_lease_hay_cleanup(relative):
    modules = _imports_of(relative)
    for cam in _FORBIDDEN_MODULES:
        assert not any(
            item == cam or item.startswith(cam + ".") for item in modules
        ), f"{relative} import {cam}"


@pytest.mark.parametrize("relative", _FEATURE_FILES)
def test_khong_import_solver_hay_tinh_nang_cu(relative):
    modules = _imports_of(relative)
    for cam in (
        "app.core.imposition",
        "app.api.routes.imposition",
        "app.workers.sticker_engine",
        "app.workers.nup_engine",
        "app.core.nfp",
        "app.workers.vdp_engine",
    ):
        assert not any(
            item == cam or item.startswith(cam + ".") for item in modules
        ), f"{relative} import {cam}"


def test_hai_file_dung_chung_khong_bi_sua():
    """``artifact_lease.py``/``cleanup.py`` không được mang dấu vết của tính năng này."""
    for relative in ("backend/app/core/artifact_lease.py", "backend/app/core/cleanup.py"):
        path = _REPO_ROOT / relative
        if not path.is_file():
            pytest.skip(f"{relative} không tồn tại trong bản này")
        source = path.read_text(encoding="utf-8")
        assert "mixed_nesting" not in source, f"{relative} đã bị sửa cho tính năng mới"
        assert "mixed-nesting" not in source


def test_chi_dung_dung_parser_dung_chung():
    """Được tái dùng ``pdf_content_parser`` (đọc-only), nhưng không tự viết tokenizer thứ hai."""
    source_imports = _imports_of("backend/app/workers/mixed_nesting_pdf_source.py")
    assert "app.workers.pdf_content_parser" in source_imports
    # Và không import bất kỳ engine ghi PDF nào của tính năng khác.
    for cam in ("app.workers.pdf_ops", "app.workers.nup_output_finalize"):
        assert cam not in source_imports


# ─────────────────────────────────────────────────────────────────────────────
#  2. Cách ly theo hành vi
# ─────────────────────────────────────────────────────────────────────────────


@pytest.fixture()
def isolated(monkeypatch, tmp_path):
    """Dựng ba root dùng chung có file thật, cộng root riêng của tính năng."""
    from app.config import settings

    uploads = tmp_path / "uploads"
    results = tmp_path / "results"
    uploads.mkdir()
    results.mkdir()
    monkeypatch.setattr(settings, "UPLOAD_DIR", str(uploads))
    monkeypatch.setattr(settings, "RESULTS_DIR", str(results))

    # File của tính năng KHÁC, đặt đúng chỗ chúng thật sự nằm.
    (uploads / "khach-gui.pdf").write_bytes(b"%PDF-1.7\nupload")
    (results / "merged_manifest_abc.pdf").write_bytes(b"%PDF-1.7\ncombine")
    (results / "nup_out.pdf").write_bytes(b"%PDF-1.7\nnup")

    store = MixedNestingArtifactStore(root=tmp_path / "mixed_nesting_data", ttl_seconds=0.0)
    store.ensure_root()
    try:
        yield store, uploads, results
    finally:
        store.close()
        store.purge_root()


def test_sweep_ttl_khong_cham_file_tinh_nang_khac(isolated):
    store, uploads, results = isolated
    store.publish(
        artifact_id="mine",
        owner="owner-a",
        job_id="job-1",
        source_revision="rev",
        payload=b"%PDF-1.7\nmine",
        sheet_count=1,
    )
    store.sweep_now()

    assert (uploads / "khach-gui.pdf").is_file()
    assert (results / "merged_manifest_abc.pdf").is_file()
    assert (results / "nup_out.pdf").is_file()


def test_sweep_mo_coi_khong_cham_file_tinh_nang_khac(isolated):
    store, uploads, results = isolated
    store.sweep_orphan_files()
    assert (uploads / "khach-gui.pdf").is_file()
    assert (results / "merged_manifest_abc.pdf").is_file()


def test_close_khong_cham_file_tinh_nang_khac(isolated):
    store, uploads, results = isolated
    store.publish(
        artifact_id="mine",
        owner="owner-a",
        job_id="job-1",
        source_revision="rev",
        payload=b"%PDF-1.7\nmine",
        sheet_count=1,
    )
    store.close()
    assert list(store.root.glob("*.pdf")) == []
    assert (uploads / "khach-gui.pdf").is_file()
    assert (results / "merged_manifest_abc.pdf").is_file()
    assert (results / "nup_out.pdf").is_file()


def test_root_khong_the_dat_vao_ba_root_dung_chung(isolated, tmp_path):
    store, uploads, results = isolated
    backend_temp = _REPO_ROOT / "backend" / "temp"
    for shared in (uploads, results, backend_temp):
        with pytest.raises(ArtifactRootUnsafe):
            assert_root_safe(shared)
        with pytest.raises(ArtifactRootUnsafe):
            assert_root_safe(shared / "long_ghep")


def test_root_that_nam_ngoai_ba_root_dung_chung(isolated):
    store, uploads, results = isolated
    resolved = store.root.resolve()
    for shared in (uploads.resolve(), results.resolve()):
        assert not str(resolved).startswith(str(shared) + "\\")
        assert not str(resolved).startswith(str(shared) + "/")
        assert resolved != shared


def test_purge_root_van_kiem_an_toan(isolated):
    """``purge_root`` chỉ dùng trong test, nhưng vẫn phải kiểm — nếu không nó là rm -rf mù."""
    store, _uploads, _results = isolated
    source = (
        _REPO_ROOT / "backend" / "app" / "core" / "mixed_nesting_artifacts.py"
    ).read_text(encoding="utf-8")
    purge_at = source.index("def purge_root")
    body = source[purge_at : purge_at + 400]
    assert "assert_root_safe" in body, "purge_root phải kiểm root trước khi xoá"
