"""Xuất PDF và root artifact riêng — phase P14a.

Kế hoạch: ``docs/KE_HOACH_MIXED_TRUE_SHAPE_NESTING_DOC_LAP_2026-08-26.md`` §12.4, §13, §16.3.

Năm nhóm, khớp từng câu của gate P14a:

1. **Root nằm ngoài mọi shared cleanup root**, và override lồng/symlink **fail-closed**.
2. **Parity preview ↔ export**: đọc lại PDF vừa xuất bằng parser độc lập và so với pose tính
   lại từ manifest — đủ cả góc không-cardinal và X/Y phần lẻ.
3. **Không mirror**: dấu diện tích mọi vòng sau khi ghi phải giữ nguyên.
4. **Publish nguyên tử**: không để lại ``.partial``; lỗi giữa đường thì không có file nào.
5. **Owner isolation**: artifact của owner khác trả 404.
"""

from __future__ import annotations

import math
import os
from pathlib import Path
from typing import Any

import pytest

from app.schemas.mixed_nesting import MIXED_NESTING_PROTOCOL_VERSION

from app.core.mixed_nesting_artifacts import (
    DATA_DIR_ENV,
    DEFAULT_DIR_NAME,
    ArtifactRootUnsafe,
    MixedNestingArtifactStore,
    assert_root_safe,
    resolve_root,
)
from app.workers.mixed_nesting_pdf_export import (
    EXPORT_RULE_VERSION,
    ExportError,
    PartGeometry,
    derive_reference_point,
    expected_rings,
    export_manifest_to_pdf,
    pose_matrix,
    read_back_rings,
    signed_area,
    transform_ring,
)

_REPO_ROOT = Path(__file__).resolve().parents[2]


def rect(w: float, h: float) -> list[tuple[float, float]]:
    return [(0.0, 0.0), (w, 0.0), (w, h), (0.0, h)]


def shape_l() -> list[tuple[float, float]]:
    return [(0.0, 0.0), (70.0, 0.0), (70.0, 25.0), (25.0, 25.0), (25.0, 70.0), (0.0, 70.0)]


SHEET: dict[str, Any] = {
    "widthMm": 700.0,
    "heightMm": 1000.0,
    "marginMm": {"left": 10.0, "right": 10.0, "top": 10.0, "bottom": 10.0},
    "maxSheets": 20,
}


def manifest(
    placements: list[dict[str, Any]] | None = None, **overrides: Any
) -> dict[str, Any]:
    items = placements if placements is not None else [
        {
            "instanceId": "part-a#0001",
            "partId": "part-a",
            "sheetIndex": 0,
            # Góc không-cardinal + toạ độ phần lẻ: đúng thứ §13 đòi fixture phải có.
            "pose": {
                "rotationDeg": 13.372849,
                "translateXmm": 123.456789,
                "translateYmm": 267.891234,
            },
        }
    ]
    sheet_count = max((int(item["sheetIndex"]) for item in items), default=-1) + 1
    payload: dict[str, Any] = {
        "protocolVersion": MIXED_NESTING_PROTOCOL_VERSION,
        "engineVersion": "0.2.0",
        "jobId": "job-export-1",
        "seed": 20260826,
        "status": "completed",
        "placements": items,
        "unplaced": [],
        "stats": {
            "sheetCount": max(1, sheet_count),
            "placedCount": len(items),
            "unplacedCount": 0,
            "materialUtilization": 0.1,
            "elapsedMs": 100,
            "attempts": 1,
            "orientationEvaluations": 1,
            "poseRefinements": 1,
            "terminationReason": "all_placed",
        },
        "validation": {"valid": True, "validatorVersion": 1},
    }
    payload.update(overrides)
    return payload


PARTS = [PartGeometry(part_id="part-a", outer=rect(90.0, 60.0), holes=[])]


# ─────────────────────────────────────────────────────────────────────────────
#  1. Root artifact
# ─────────────────────────────────────────────────────────────────────────────


def test_root_mac_dinh_nam_canh_results_khong_o_trong(monkeypatch, tmp_path):
    from app.config import settings

    monkeypatch.setattr(settings, "RESULTS_DIR", str(tmp_path / "results"))
    monkeypatch.setattr(settings, "UPLOAD_DIR", str(tmp_path / "uploads"))
    monkeypatch.delenv(DATA_DIR_ENV, raising=False)

    root = resolve_root()
    assert root.name == DEFAULT_DIR_NAME
    assert root.parent == tmp_path.resolve()
    # Cạnh, KHÔNG bên trong.
    assert not str(root).startswith(str((tmp_path / "results").resolve()))


def test_root_nam_trong_shared_root_thi_fail_closed(monkeypatch, tmp_path):
    from app.config import settings

    results = tmp_path / "results"
    monkeypatch.setattr(settings, "RESULTS_DIR", str(results))
    monkeypatch.setattr(settings, "UPLOAD_DIR", str(tmp_path / "uploads"))

    with pytest.raises(ArtifactRootUnsafe) as excinfo:
        assert_root_safe(results / "mixed")
    assert "nằm TRONG" in str(excinfo.value)


def test_root_chua_shared_root_thi_fail_closed(monkeypatch, tmp_path):
    """Chiều dễ bị bỏ sót: root của ta CHỨA root người khác ⇒ sweeper của ta xoá file họ."""
    from app.config import settings

    monkeypatch.setattr(settings, "RESULTS_DIR", str(tmp_path / "shared" / "results"))
    monkeypatch.setattr(settings, "UPLOAD_DIR", str(tmp_path / "shared" / "uploads"))

    with pytest.raises(ArtifactRootUnsafe) as excinfo:
        assert_root_safe(tmp_path / "shared")
    assert "CHỨA" in str(excinfo.value)


def test_root_trung_shared_root_thi_fail_closed(monkeypatch, tmp_path):
    from app.config import settings

    results = tmp_path / "results"
    monkeypatch.setattr(settings, "RESULTS_DIR", str(results))
    monkeypatch.setattr(settings, "UPLOAD_DIR", str(tmp_path / "uploads"))
    with pytest.raises(ArtifactRootUnsafe):
        assert_root_safe(results)


def test_root_la_symlink_thi_fail_closed(monkeypatch, tmp_path):
    from app.config import settings

    monkeypatch.setattr(settings, "RESULTS_DIR", str(tmp_path / "results"))
    monkeypatch.setattr(settings, "UPLOAD_DIR", str(tmp_path / "uploads"))

    real = tmp_path / "that"
    real.mkdir()
    link = tmp_path / "lien_ket"
    try:
        link.symlink_to(real, target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("máy không cho tạo symlink (cần quyền admin trên Windows)")

    with pytest.raises(ArtifactRootUnsafe) as excinfo:
        assert_root_safe(link)
    assert "symlink" in str(excinfo.value).lower()


def test_symlink_tro_vao_shared_root_bi_bat_sau_khi_resolve(monkeypatch, tmp_path):
    """Chốt thật: phép kiểm phải so trên đường ĐÃ resolve, không so chuỗi."""
    from app.config import settings

    results = tmp_path / "results"
    results.mkdir()
    monkeypatch.setattr(settings, "RESULTS_DIR", str(results))
    monkeypatch.setattr(settings, "UPLOAD_DIR", str(tmp_path / "uploads"))

    link = tmp_path / "ngoai_nhin_vo_hai"
    try:
        link.symlink_to(results, target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("máy không cho tạo symlink")

    with pytest.raises(ArtifactRootUnsafe):
        assert_root_safe(link)


def test_root_tuong_doi_bi_tu_choi():
    with pytest.raises(ArtifactRootUnsafe):
        assert_root_safe(Path("mixed_nesting_data"))


def test_root_la_file_thi_fail_closed(monkeypatch, tmp_path):
    from app.config import settings

    monkeypatch.setattr(settings, "RESULTS_DIR", str(tmp_path / "results"))
    monkeypatch.setattr(settings, "UPLOAD_DIR", str(tmp_path / "uploads"))
    target = tmp_path / "khong_phai_thu_muc"
    target.write_text("x", encoding="utf-8")
    with pytest.raises(ArtifactRootUnsafe):
        assert_root_safe(target)


def test_override_env_duoc_dung(monkeypatch, tmp_path):
    from app.config import settings

    monkeypatch.setattr(settings, "RESULTS_DIR", str(tmp_path / "results"))
    monkeypatch.setattr(settings, "UPLOAD_DIR", str(tmp_path / "uploads"))
    monkeypatch.setenv(DATA_DIR_ENV, str(tmp_path / "rieng"))
    assert resolve_root() == (tmp_path / "rieng").resolve()


def test_khong_import_artifact_lease_hay_cleanup():
    """§12.4 cấm import/sửa hai file đó. Kiểm bằng AST, không bằng tìm chuỗi."""
    import ast

    tree = ast.parse(
        (_REPO_ROOT / "backend" / "app" / "core" / "mixed_nesting_artifacts.py").read_text(
            encoding="utf-8"
        )
    )
    modules: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            modules.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            modules.add(node.module)
    for cam in ("app.core.artifact_lease", "app.core.cleanup"):
        assert cam not in modules


# ─────────────────────────────────────────────────────────────────────────────
#  2. Publish nguyên tử, TTL, quota, owner
# ─────────────────────────────────────────────────────────────────────────────


@pytest.fixture()
def store(monkeypatch, tmp_path):
    from app.config import settings

    monkeypatch.setattr(settings, "RESULTS_DIR", str(tmp_path / "results"))
    monkeypatch.setattr(settings, "UPLOAD_DIR", str(tmp_path / "uploads"))
    instance = MixedNestingArtifactStore(root=tmp_path / "mn_data", ttl_seconds=300.0)
    instance.ensure_root()
    try:
        yield instance
    finally:
        instance.close()
        instance.purge_root()


def test_publish_nguyen_tu_khong_de_lai_partial(store):
    record = store.publish(
        artifact_id="a1",
        owner="owner-a",
        job_id="job-1",
        source_revision="rev1",
        payload=b"%PDF-1.7\n1234",
        sheet_count=1,
    )
    assert record.path.is_file()
    assert record.size_bytes == len(b"%PDF-1.7\n1234")
    con_lai = [item.name for item in store.root.iterdir()]
    assert con_lai == ["a1.pdf"], f"còn file lạ: {con_lai}"


def test_ghi_loi_giua_duong_khong_de_lai_rac(store, monkeypatch):
    real_replace = os.replace

    def no_replace(src, dst):
        raise OSError("gia lap loi ghi")

    monkeypatch.setattr(os, "replace", no_replace)
    with pytest.raises(OSError):
        store.publish(
            artifact_id="a2",
            owner="owner-a",
            job_id="job-1",
            source_revision="rev1",
            payload=b"%PDF-1.7\nx",
            sheet_count=1,
        )
    monkeypatch.setattr(os, "replace", real_replace)
    assert list(store.root.iterdir()) == []


def test_owner_khac_khong_doc_duoc(store):
    store.publish(
        artifact_id="a3",
        owner="owner-a",
        job_id="job-1",
        source_revision="rev1",
        payload=b"%PDF-1.7\nx",
        sheet_count=1,
    )
    assert store.get("a3", "owner-a") is not None
    assert store.get("a3", "owner-b") is None
    assert store.for_job("job-1", "owner-b") is None
    assert store.delete("a3", "owner-b") is False
    assert store.get("a3", "owner-a") is not None


def test_stream_duoc_bao_ve_khoi_sweeper(store):
    store.publish(
        artifact_id="a4",
        owner="owner-a",
        job_id="job-1",
        source_revision="rev1",
        payload=b"%PDF-1.7\n" + b"x" * 1000,
        sheet_count=1,
    )
    reader = store.open_for_read("a4", "owner-a")
    first = next(reader)
    assert first.startswith(b"%PDF-")
    # Đang stream: xoá chỉ bỏ khỏi registry, file vẫn đọc hết được.
    assert store.delete("a4", "owner-a") is True
    remaining = b"".join(reader)
    assert len(first) + len(remaining) == 1009


def test_ttl_don_artifact_het_han(monkeypatch, tmp_path):
    from app.config import settings

    monkeypatch.setattr(settings, "RESULTS_DIR", str(tmp_path / "results"))
    monkeypatch.setattr(settings, "UPLOAD_DIR", str(tmp_path / "uploads"))
    instance = MixedNestingArtifactStore(root=tmp_path / "mn_data", ttl_seconds=0.0)
    instance.ensure_root()
    try:
        instance.publish(
            artifact_id="a5",
            owner="owner-a",
            job_id="job-1",
            source_revision="rev1",
            payload=b"%PDF-1.7\nx",
            sheet_count=1,
        )
        assert instance.get("a5", "owner-a") is None
        assert instance.sweep_now() >= 0
    finally:
        instance.close()
        instance.purge_root()


def test_quota_don_cai_cu_nhat(monkeypatch, tmp_path):
    from app.config import settings

    monkeypatch.setattr(settings, "RESULTS_DIR", str(tmp_path / "results"))
    monkeypatch.setattr(settings, "UPLOAD_DIR", str(tmp_path / "uploads"))
    instance = MixedNestingArtifactStore(
        root=tmp_path / "mn_data", ttl_seconds=300.0, max_total_bytes=2500
    )
    instance.ensure_root()
    try:
        for index in range(3):
            instance.publish(
                artifact_id=f"q{index}",
                owner="owner-a",
                job_id=f"job-{index}",
                source_revision="rev",
                payload=b"x" * 1000,
                sheet_count=1,
            )
        assert instance.get("q0", "owner-a") is None, "cái cũ nhất phải bị dọn"
        assert instance.get("q2", "owner-a") is not None
    finally:
        instance.close()
        instance.purge_root()


def test_sweep_file_mo_coi_sau_restart(store):
    (store.root / "mo-coi.pdf").write_bytes(b"%PDF-1.7\nx")
    store.publish(
        artifact_id="a6",
        owner="owner-a",
        job_id="job-1",
        source_revision="rev1",
        payload=b"%PDF-1.7\nx",
        sheet_count=1,
    )
    assert store.sweep_orphan_files() == 1
    assert (store.root / "a6.pdf").is_file()
    assert not (store.root / "mo-coi.pdf").exists()


def test_sweep_khong_cham_file_khac_duoi(store):
    (store.root / "ghi-chu.txt").write_text("khong phai artifact", encoding="utf-8")
    assert store.sweep_orphan_files() == 0
    assert (store.root / "ghi-chu.txt").is_file()


# ─────────────────────────────────────────────────────────────────────────────
#  3. Pose: rigid, không mirror
# ─────────────────────────────────────────────────────────────────────────────


def test_dinh_thuc_luon_bang_mot():
    for angle in (0.0, 13.372849, 45.0, 90.0, 217.5, 359.999999):
        assert pose_matrix(angle, 10.0, 20.0, (3.0, 4.0)).determinant == pytest.approx(1.0, abs=1e-12)


def test_pivot_la_trong_tam_va_khop_quy_tac_rust():
    """Quy tắc pivot phải khớp `normalize.rs`; đổi quy tắc mà quên bên này là sai bản in."""
    source = (
        _REPO_ROOT / "imposition_core" / "src" / "mixed_nesting" / "normalize.rs"
    ).read_text(encoding="utf-8")
    assert "pub const REFERENCE_POINT_RULE_VERSION: u32 = 1;" in source
    assert "Trọng tâm diện tích của vòng" in source

    centroid = derive_reference_point(rect(80.0, 40.0))
    assert centroid == pytest.approx((40.0, 20.0), abs=1e-12)
    # Bất biến với chiều vòng.
    assert derive_reference_point(list(reversed(rect(80.0, 40.0)))) == pytest.approx(
        (40.0, 20.0), abs=1e-12
    )


def test_khong_mirror_dau_dien_tich_giu_nguyen():
    ring = shape_l()
    truoc = signed_area(ring)
    pivot = derive_reference_point(ring)
    assert pivot is not None
    for angle in (13.372849, 90.0, 217.5):
        sau = signed_area(transform_ring(ring, angle, 123.456, 78.9, pivot))
        assert math.copysign(1.0, sau) == math.copysign(1.0, truoc)
        assert abs(sau) == pytest.approx(abs(truoc), rel=1e-9)


# ─────────────────────────────────────────────────────────────────────────────
#  4. Parity preview ↔ export qua đường đọc lại độc lập
# ─────────────────────────────────────────────────────────────────────────────


def _drop_closing_vertex(ring: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Bỏ đỉnh đóng vòng lặp lại đỉnh đầu.

    Toán tử ``h`` của PDF khép vòng nên parser sinh thêm một đoạn về đỉnh đầu; vòng đọc lại
    có `n+1` đỉnh trong khi vòng mong đợi có `n`. Đó là **cùng một hình**, không phải lệch.
    """
    if len(ring) >= 2 and math.hypot(ring[0][0] - ring[-1][0], ring[0][1] - ring[-1][1]) <= 1e-6:
        return ring[:-1]
    return ring


def _match_rings(actual, wanted, tolerance_mm=0.001):
    """Ghép từng vòng đọc lại với vòng mong đợi theo trọng tâm, rồi so **từng đỉnh**.

    Đây là phép kiểm parity thật: đường ghi (dựng content stream) và đường đọc (parser của
    P12) là hai đường độc lập, nên khớp tới `0,001 mm` nghĩa là pose đi qua PDF không bị làm
    tròn hay biến dạng.
    """
    remaining = list(wanted)
    for item in actual:
        ring = _drop_closing_vertex(list(item.ring_mm))
        centroid = derive_reference_point(ring)
        assert centroid is not None
        best_index = None
        best_distance = float("inf")
        for index, candidate in enumerate(remaining):
            if candidate.sheet_index != item.sheet_index:
                continue
            other = derive_reference_point(candidate.ring_mm)
            if other is None:
                continue
            distance = math.hypot(centroid[0] - other[0], centroid[1] - other[1])
            if distance < best_distance:
                best_distance = distance
                best_index = index
        assert best_index is not None, "không tìm được vòng mong đợi tương ứng"
        assert best_distance <= tolerance_mm, f"trọng tâm lệch {best_distance:.5f} mm"
        expected = remaining.pop(best_index)
        assert len(ring) == len(expected.ring_mm)
        for (got_x, got_y), (want_x, want_y) in zip(ring, expected.ring_mm):
            assert got_x == pytest.approx(want_x, abs=tolerance_mm)
            assert got_y == pytest.approx(want_y, abs=tolerance_mm)
    assert remaining == [], f"còn {len(remaining)} vòng mong đợi không xuất hiện trong PDF"


def test_parity_goc_khong_cardinal_va_toa_do_phan_le():
    payload = export_manifest_to_pdf(manifest=manifest(), sheet=SHEET, parts=PARTS)
    assert payload.startswith(b"%PDF-")
    _match_rings(read_back_rings(payload), expected_rings(manifest=manifest(), parts=PARTS))


def test_parity_nhieu_to_va_co_lo():
    parts = [PartGeometry(part_id="part-a", outer=rect(90.0, 60.0), holes=[rect(20.0, 10.0)])]
    items = [
        {
            "instanceId": "part-a#0001",
            "partId": "part-a",
            "sheetIndex": 0,
            "pose": {"rotationDeg": 41.25, "translateXmm": 200.5, "translateYmm": 300.25},
        },
        {
            "instanceId": "part-a#0002",
            "partId": "part-a",
            "sheetIndex": 1,
            "pose": {"rotationDeg": 0.0, "translateXmm": 100.0, "translateYmm": 100.0},
        },
    ]
    data = manifest(items)
    payload = export_manifest_to_pdf(manifest=data, sheet=SHEET, parts=parts)
    read_back = read_back_rings(payload)
    # Mỗi placement có 2 vòng (ngoài + lỗ) ⇒ 4 vòng trên 2 trang.
    assert len(read_back) == 4
    assert {item.sheet_index for item in read_back} == {0, 1}
    _match_rings(read_back, expected_rings(manifest=data, parts=parts))


def test_kho_trang_dung_1_1_theo_mm():
    payload = export_manifest_to_pdf(
        manifest=manifest(), sheet={**SHEET, "widthMm": 100.37, "heightMm": 60.73}, parts=PARTS
    )
    import io

    import pikepdf

    document = pikepdf.Pdf.open(io.BytesIO(payload))
    try:
        media = document.pages[0].mediabox
        width_pt = float(media[2] - media[0])
        height_pt = float(media[3] - media[1])
    finally:
        document.close()
    assert width_pt == pytest.approx(100.37 * 72 / 25.4, abs=1e-6)
    assert height_pt == pytest.approx(60.73 * 72 / 25.4, abs=1e-6)


def test_so_trang_bang_so_to():
    items = [
        {
            "instanceId": f"part-a#000{index + 1}",
            "partId": "part-a",
            "sheetIndex": index,
            "pose": {"rotationDeg": 0.0, "translateXmm": 100.0, "translateYmm": 100.0},
        }
        for index in range(3)
    ]
    payload = export_manifest_to_pdf(manifest=manifest(items), sheet=SHEET, parts=PARTS)
    import io

    import pikepdf

    document = pikepdf.Pdf.open(io.BytesIO(payload))
    try:
        assert len(document.pages) == 3
    finally:
        document.close()


# ─────────────────────────────────────────────────────────────────────────────
#  5. Từ chối xuất khi chưa đủ điều kiện
# ─────────────────────────────────────────────────────────────────────────────


def test_khong_xuat_khi_chua_qua_validator():
    data = manifest(validation={"valid": False, "validatorVersion": 1})
    with pytest.raises(ExportError) as excinfo:
        export_manifest_to_pdf(manifest=data, sheet=SHEET, parts=PARTS)
    assert excinfo.value.code == "MIXED_NESTING_EXPORT_NOT_VALIDATED"
    assert excinfo.value.status == 409


@pytest.mark.parametrize("status", ["cancelled", "failed"])
def test_khong_xuat_khi_chua_hoan_tat(status):
    with pytest.raises(ExportError) as excinfo:
        export_manifest_to_pdf(manifest=manifest(status=status), sheet=SHEET, parts=PARTS)
    assert excinfo.value.code == "MIXED_NESTING_EXPORT_NOT_COMPLETED"


def test_thieu_hinh_hoc_nguon_thi_tu_choi():
    with pytest.raises(ExportError) as excinfo:
        export_manifest_to_pdf(manifest=manifest(), sheet=SHEET, parts=[])
    assert excinfo.value.code == "MIXED_NESTING_EXPORT_MISSING_PART"


def test_contour_suy_bien_thi_tu_choi():
    with pytest.raises(ExportError) as excinfo:
        export_manifest_to_pdf(
            manifest=manifest(),
            sheet=SHEET,
            parts=[PartGeometry(part_id="part-a", outer=[(0.0, 0.0), (1.0, 0.0)], holes=[])],
        )
    assert excinfo.value.code == "MIXED_NESTING_EXPORT_BAD_GEOMETRY"


def test_khong_co_to_nao_thi_tu_choi():
    data = manifest([])
    data["stats"]["sheetCount"] = 0
    with pytest.raises(ExportError) as excinfo:
        export_manifest_to_pdf(manifest=data, sheet=SHEET, parts=PARTS)
    assert excinfo.value.code == "MIXED_NESTING_EXPORT_EMPTY"


def test_export_rule_version_duoc_khai():
    assert EXPORT_RULE_VERSION == 1


def test_export_khong_dung_pdfium():
    """Cùng lý do như P12: gate thread-race đúng theo cấu trúc, không nhờ bọc khóa."""
    import ast

    tree = ast.parse(
        (
            _REPO_ROOT / "backend" / "app" / "workers" / "mixed_nesting_pdf_export.py"
        ).read_text(encoding="utf-8")
    )
    modules: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            modules.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            modules.add(node.module)
    assert "pypdfium2" not in modules
    assert "pikepdf" in modules


# ─────────────────────────────────────────────────────────────────────────────
#  6. Phân giải hình học ở tầng route — nguồn chân lý là request đã validate
# ─────────────────────────────────────────────────────────────────────────────
#
# Nhóm này bù một ĐIỂM MÙ: các nhóm trên gọi `export_manifest_to_pdf` trực tiếp nên chưa
# bao giờ chạm bước route tra hình học theo `partId`. Bản đầu tra registry nguồn PDF và khớp
# `partId.endswith(candidate_id)`; nó sai ở ca dùng chính của tool mà 33 test kia vẫn xanh.


def _request(parts: list[dict[str, Any]], **overrides: Any) -> dict[str, Any]:
    """Request đã validate, dạng camelCase đúng như registry job đang giữ."""
    payload: dict[str, Any] = {
        "protocolVersion": MIXED_NESTING_PROTOCOL_VERSION,
        "sheet": SHEET,
        "parts": parts,
        "gapMm": 2.0,
        "profile": "balanced",
        "seed": 20260826,
    }
    payload.update(overrides)
    return payload


def _part(part_id: str, outer: list[tuple[float, float]], holes=None) -> dict[str, Any]:
    return {
        "partId": part_id,
        "quantity": 1,
        "outer": [[x, y] for x, y in outer],
        "holes": [[[x, y] for x, y in hole] for hole in (holes or [])],
        "rotationConstraint": {"mode": "inherit"},
    }


def _placement(
    instance_id: str,
    part_id: str,
    sheet_index: int = 0,
    *,
    tx: float = 123.456789,
    ty: float = 267.891234,
) -> dict[str, Any]:
    """Một placement với góc không-cardinal và toạ độ phần lẻ.

    `tx`/`ty` mở ra vì `_match_rings` ghép vòng theo **trọng tâm**: đặt hai hình khác nhau ở
    cùng pose thì trọng tâm gần trùng và nó ghép chéo, cho ra lỗi giả.
    """
    return {
        "instanceId": instance_id,
        "partId": part_id,
        "sheetIndex": sheet_index,
        "pose": {"rotationDeg": 13.372849, "translateXmm": tx, "translateYmm": ty},
    }


def test_hai_khuon_khac_file_cung_ma_ung_vien_khong_lay_lan_hinh():
    """Hồi quy của một lỗi THẬT: hai khuôn khác nhau bị gán cùng một hình.

    ``candidate_id`` chỉ duy nhất trong MỘT file (``p{trang}-c{n}``), nên thả hai PDF một
    trang — ca dùng chính của tool — thì cả hai đều ra ``p1-c1``. Bản đầu khớp
    ``partId.endswith(candidate_id)`` nên hai ``partId`` khác nhau cùng trúng record đầu
    tiên, và con thứ hai nhận hình của con thứ nhất: thợ bế nhận sai đường bế.
    """
    from app.api.routes import mixed_nesting as route

    hop_a = rect(90.0, 60.0)
    hop_b = shape_l()
    request = _request([_part("hop-a-p1-c1", hop_a), _part("hop-b-p1-c1", hop_b)])
    data = manifest(
        [
            _placement("hop-a-p1-c1#0001", "hop-a-p1-c1"),
            _placement("hop-b-p1-c1#0001", "hop-b-p1-c1", sheet_index=0),
        ]
    )

    parts, _revision = route._part_geometry_for(data, request)  # noqa: SLF001
    by_id = {part.part_id: part for part in parts}
    assert len(by_id) == 2, "phải trả đủ hai khuôn, không gộp"
    # Chốt bằng SỐ ĐỈNH và diện tích: hình chữ nhật 4 đỉnh, hình L 6 đỉnh. Lấy lẫn là lộ ngay.
    assert len(by_id["hop-a-p1-c1"].outer) == 4
    assert len(by_id["hop-b-p1-c1"].outer) == 6
    assert abs(signed_area(by_id["hop-a-p1-c1"].outer)) == pytest.approx(90.0 * 60.0)
    assert abs(signed_area(by_id["hop-b-p1-c1"].outer)) != pytest.approx(90.0 * 60.0)


def test_hinh_hoc_lay_dung_tu_request_khong_phai_tu_registry_nguon():
    """Chốt cấu trúc: hàm không được tra ``mixed_nesting_sources``.

    Registry nguồn có TTL 1 giờ; phụ thuộc nó nghĩa là xuất lại sau một giờ thì đứt, dù
    phương án đã validate vẫn còn nguyên.
    """
    import ast
    import inspect

    from app.api.routes import mixed_nesting as route

    tree = ast.parse(inspect.getsource(route._part_geometry_for))  # noqa: SLF001
    ten_duoc_doc = {
        node.id for node in ast.walk(tree) if isinstance(node, ast.Name)
    } | {
        node.attr for node in ast.walk(tree) if isinstance(node, ast.Attribute)
    }
    assert "mixed_nesting_sources" not in ten_duoc_doc
    assert "all_for_owner" not in ten_duoc_doc


def test_thieu_hinh_hoc_trong_request_thi_409_co_ma():
    from fastapi import HTTPException

    from app.api.routes import mixed_nesting as route

    request = _request([_part("co-mat", rect(50.0, 50.0))])
    data = manifest([_placement("thieu#0001", "thieu")])
    with pytest.raises(HTTPException) as excinfo:
        route._part_geometry_for(data, request)  # noqa: SLF001
    assert excinfo.value.status_code == 409
    assert excinfo.value.detail["code"] == "MIXED_NESTING_EXPORT_MISSING_SOURCE"
    assert "thieu" in excinfo.value.detail["message"]


def test_lo_khoet_di_theo_dung_khuon():
    from app.api.routes import mixed_nesting as route

    request = _request(
        [
            _part("co-lo", rect(90.0, 60.0), holes=[rect(20.0, 10.0)]),
            _part("khong-lo", rect(90.0, 60.0)),
        ]
    )
    data = manifest(
        [_placement("co-lo#0001", "co-lo"), _placement("khong-lo#0001", "khong-lo")]
    )
    parts, _revision = route._part_geometry_for(data, request)  # noqa: SLF001
    by_id = {part.part_id: part for part in parts}
    assert len(by_id["co-lo"].holes) == 1
    assert by_id["khong-lo"].holes == []


def test_source_revision_doi_khi_va_chi_khi_hinh_doi():
    """Chốt "đổi khuôn nhưng giữ file cũ": băm phải đi theo hình THỰC SỰ đã nesting."""
    from app.api.routes import mixed_nesting as route

    data = manifest([_placement("k#0001", "k")])
    goc = _request([_part("k", rect(90.0, 60.0))])
    _parts, rev_goc = route._part_geometry_for(data, goc)  # noqa: SLF001

    # Gọi lại với cùng hình ⇒ băm không đổi.
    _parts, rev_lai = route._part_geometry_for(data, _request([_part("k", rect(90.0, 60.0))]))  # noqa: SLF001
    assert rev_lai == rev_goc

    # Đổi 0,001 mm ⇒ băm phải khác, nếu không thì file cũ bị dùng lẫn cho khuôn mới.
    doi = _request([_part("k", rect(90.001, 60.0))])
    _parts, rev_doi = route._part_geometry_for(data, doi)  # noqa: SLF001
    assert rev_doi != rev_goc


def test_xuat_duoc_bang_hinh_lay_tu_request():
    """Nối hai đầu: hình lấy từ request phải xuất ra PDF hợp lệ và đọc lại đúng."""
    from app.api.routes import mixed_nesting as route

    request = _request([_part("part-a", rect(90.0, 60.0))])
    data = manifest([_placement("part-a#0001", "part-a")])
    parts, _revision = route._part_geometry_for(data, request)  # noqa: SLF001

    payload = export_manifest_to_pdf(manifest=data, sheet=SHEET, parts=parts)
    assert payload.startswith(b"%PDF-")
    _match_rings(read_back_rings(payload), expected_rings(manifest=data, parts=parts))


def test_doc_duoc_request_do_CHINH_schema_sinh_ra_khong_phai_dict_tu_tay():
    """Chốt mắt nối cuối: đọc request do **schema thật** sinh, không phải dict test tự dựng.

    `to_engine_request` dùng ``by_alias=True`` nên khoá là camelCase (``partId``). Nếu ai đổi
    sang ``model_dump()`` không alias thì khoá thành ``part_id`` và lệnh xuất vỡ **lúc chạy
    thật** trong khi mọi test tự dựng dict vẫn xanh — đúng loại điểm mù đã làm lọt lỗi lấy
    lẫn hình. Test này đi qua đường thật nên bắt được.
    """
    from app.api.routes import mixed_nesting as route
    from app.schemas.mixed_nesting import CreateJobRequest

    body = {
        "protocolVersion": MIXED_NESTING_PROTOCOL_VERSION,
        "seed": 20260826,
        "profile": "fast",
        "sheet": SHEET,
        "gapMm": 3.0,
        "orientationPolicy": {
            "defaultRotation": {"mode": "free"},
            "reflection": "forbidden",
        },
        "parts": [
            {
                "partId": "hop-a-p1-c1",
                "quantity": 1,
                "outer": [[x, y] for x, y in rect(90.0, 60.0)],
                "holes": [],
                "rotationConstraint": {"mode": "inherit"},
            },
            {
                "partId": "hop-b-p1-c1",
                "quantity": 1,
                "outer": [[x, y] for x, y in shape_l()],
                "holes": [],
                "rotationConstraint": {"mode": "inherit"},
            },
        ],
    }
    request = CreateJobRequest.model_validate(body).to_engine_request(job_id="job-export-1")

    data = manifest(
        [
            _placement("hop-a-p1-c1#0001", "hop-a-p1-c1", tx=120.5, ty=200.25),
            _placement("hop-b-p1-c1#0001", "hop-b-p1-c1", tx=420.75, ty=650.125),
        ]
    )
    parts, revision = route._part_geometry_for(data, request)  # noqa: SLF001
    by_id = {part.part_id: part for part in parts}
    assert len(by_id["hop-a-p1-c1"].outer) == 4
    assert len(by_id["hop-b-p1-c1"].outer) == 6
    assert revision

    # Và xuất được thật, đọc lại khớp pose.
    payload = export_manifest_to_pdf(manifest=data, sheet=request["sheet"], parts=parts)
    _match_rings(read_back_rings(payload), expected_rings(manifest=data, parts=parts))
