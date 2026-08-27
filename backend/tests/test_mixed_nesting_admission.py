"""Admission của "Bình lồng ghép tự do" — phase P6b.

Kế hoạch: ``docs/KE_HOACH_MIXED_TRUE_SHAPE_NESTING_DOC_LAP_2026-08-26.md`` §14, §17, §18.

Bốn thứ được khoá ở đây, mỗi thứ tương ứng một câu trong gate P6b:

1. **Số worker đi qua ``plan_worker_count``**, không qua bảng cap chép tay. Test gọi
   chính planner nguồn chân lý và giả lập RAM ở ba tier.
2. **Máy ``≥16 GB`` không bị hard-cap.** Đây là rule #1 của AGENTS.md; đã có một lần
   hồi quy vì cap vô điều kiện nên phải có test chặn.
3. **Ước lượng RAM đi theo trạng thái tìm kiếm, KHÔNG theo "số góc".** Hệ quả kiểm được:
   ``rotationConstraint`` khác nhau (``free`` / ``discrete`` bốn góc / ``fixed`` /
   ``ranges``) mà mọi thứ khác giống nhau thì ước lượng phải **y hệt**.
4. **Vượt ngân sách thì fail sớm**, và mô hình ước lượng phải parity với Rust.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any

import pytest

from app.core import mixed_nesting_service as svc
from app.core.heavy_job_scheduler import HeavyJobMemoryUnavailable
from app.core.system_memory import plan_worker_count

_REPO_ROOT = Path(__file__).resolve().parents[2]
_CONTROL_RS = (
    _REPO_ROOT / "imposition_core" / "src" / "mixed_nesting" / "control.rs"
)


# ─────────────────────────────────────────────────────────────────────────────
#  Tiện ích
# ─────────────────────────────────────────────────────────────────────────────


def _rect(w: float, h: float) -> list[list[float]]:
    return [[0.0, 0.0], [w, 0.0], [w, h], [0.0, h]]


def _request(
    *,
    profile: str = "balanced",
    quantity: int = 8,
    part_count: int = 1,
    rotation: dict[str, Any] | None = None,
    max_sheets: int = 20,
) -> dict[str, Any]:
    constraint = rotation if rotation is not None else {"mode": "free"}
    return {
        "protocolVersion": 1,
        "seed": 20260826,
        "profile": profile,
        "sheet": {
            "widthMm": 700.0,
            "heightMm": 1000.0,
            "marginMm": {"left": 10.0, "right": 10.0, "top": 10.0, "bottom": 10.0},
            "maxSheets": max_sheets,
        },
        "gapMm": 3.0,
        "orientationPolicy": {
            "defaultRotation": {"mode": "free"},
            "reflection": "forbidden",
        },
        "parts": [
            {
                "partId": f"part-{index}",
                "quantity": quantity,
                "outer": _rect(90.0, 60.0),
                "holes": [],
                "rotationConstraint": constraint,
            }
            for index in range(part_count)
        ],
    }


@pytest.fixture(autouse=True)
def _khong_co_env_override(monkeypatch):
    """Xoá override vận hành để test đo đúng chính sách mặc định."""
    monkeypatch.delenv(svc.WORKER_COUNT_ENV, raising=False)


def _gia_lap_ram(monkeypatch, total_mb: float | None, available_mb: float | None = None):
    if available_mb is None and total_mb is not None:
        available_mb = total_mb / 2
    monkeypatch.setattr(
        "app.core.system_memory.read_memory_status_mb",
        lambda: (total_mb, available_mb),
    )


# ─────────────────────────────────────────────────────────────────────────────
#  1. Planner là nguồn chân lý
# ─────────────────────────────────────────────────────────────────────────────


def test_worker_count_lay_dung_tu_planner(monkeypatch):
    """Không so với bảng chép tay: gọi chính `plan_worker_count` rồi so kết quả."""
    _gia_lap_ram(monkeypatch, 32 * 1024.0)
    request = _request()

    plan = svc.plan_hardware(request, cpu_count=16)
    mong_doi, _reason = plan_worker_count(
        kind=svc.MIXED_NESTING_KIND,
        per_worker_mb=plan.per_worker_mb,
        cpu_count=16,
        env_override=svc.WORKER_COUNT_ENV,
    )
    assert plan.workers == mong_doi


@pytest.mark.parametrize(
    ("total_gb", "cpu_count"),
    [(6, 8), (12, 8), (32, 16), (128, 32)],
)
def test_moi_tier_ram_khop_planner(monkeypatch, total_gb, cpu_count):
    _gia_lap_ram(monkeypatch, total_gb * 1024.0)
    plan = svc.plan_hardware(_request(), cpu_count=cpu_count)
    mong_doi, _reason = plan_worker_count(
        kind=svc.MIXED_NESTING_KIND,
        per_worker_mb=plan.per_worker_mb,
        cpu_count=cpu_count,
        env_override=svc.WORKER_COUNT_ENV,
    )
    assert plan.workers == mong_doi


def test_may_manh_khong_bi_hard_cap(monkeypatch):
    """Rule #1 AGENTS.md: `≥16 GB` giữ `cpu-1`, không bị kẹp bởi hằng số nào."""
    _gia_lap_ram(monkeypatch, 32 * 1024.0, available_mb=4 * 1024.0)
    plan = svc.plan_hardware(_request(), cpu_count=16)
    assert plan.workers == 15, (
        "máy 32 GB / 16 lõi bị hạ worker — đây đúng loại hồi quy đã trả giá một lần "
        f"(reason: {plan.reason})"
    )

    _gia_lap_ram(monkeypatch, 128 * 1024.0, available_mb=8 * 1024.0)
    plan_lon = svc.plan_hardware(_request(), cpu_count=32)
    assert plan_lon.workers == 31


def test_may_yeu_moi_bi_giam(monkeypatch):
    _gia_lap_ram(monkeypatch, 6 * 1024.0)
    assert svc.plan_hardware(_request(), cpu_count=8).workers == 1

    _gia_lap_ram(monkeypatch, 12 * 1024.0)
    assert svc.plan_hardware(_request(), cpu_count=8).workers == 2


def test_khong_doc_duoc_ram_thi_dung_tran_cpu(monkeypatch):
    """§14: "Không đọc được RAM: dùng trần CPU, không tự bịa cap bảo thủ."."""
    _gia_lap_ram(monkeypatch, None, None)
    assert svc.plan_hardware(_request(), cpu_count=8).workers == 7


def test_env_override_thang_ca_hai_chieu(monkeypatch):
    _gia_lap_ram(monkeypatch, 6 * 1024.0)
    monkeypatch.setenv(svc.WORKER_COUNT_ENV, "9")
    assert svc.plan_hardware(_request(), cpu_count=4).workers == 9

    monkeypatch.setenv(svc.WORKER_COUNT_ENV, "1")
    _gia_lap_ram(monkeypatch, 64 * 1024.0)
    assert svc.plan_hardware(_request(), cpu_count=16).workers == 1

    monkeypatch.setenv(svc.WORKER_COUNT_ENV, "khong-phai-so")
    assert svc.plan_hardware(_request(), cpu_count=16).workers == 15


def test_ten_bien_override_dung_ke_hoach():
    assert svc.WORKER_COUNT_ENV == "PRYNX_MIXED_NEST_WORKERS"
    assert svc.MIXED_NESTING_KIND == "mixed-nesting"


# ─────────────────────────────────────────────────────────────────────────────
#  2. Ước lượng RAM theo trạng thái tìm kiếm, KHÔNG theo "số góc"
# ─────────────────────────────────────────────────────────────────────────────


ROTATION_MODES: list[dict[str, Any]] = [
    {"mode": "free"},
    {"mode": "inherit"},
    {"mode": "fixed", "angleDeg": 37.5},
    {"mode": "discrete", "anglesDeg": [0.0, 90.0, 180.0, 270.0]},
    {"mode": "discrete", "anglesDeg": [0.0, 12.5, 41.25, 118.75, 263.5]},
    # Tên khoá `arcs` là hợp đồng thật của Rust
    # (`model.rs::RotationConstraint::Ranges { arcs }`), không phải `rangesDeg`.
    {"mode": "ranges", "arcs": [{"startDeg": 0.0, "sweepDeg": 45.0}]},
    {
        "mode": "ranges",
        "arcs": [
            {"startDeg": 0.0, "sweepDeg": 10.0},
            {"startDeg": 180.0, "sweepDeg": 10.0},
        ],
    },
]


@pytest.mark.parametrize("rotation", ROTATION_MODES)
def test_uoc_luong_khong_phu_thuoc_rotation_constraint(monkeypatch, rotation):
    """Free-angle không có "số góc" để đếm; ước lượng phải bỏ qua miền xoay hoàn toàn.

    Nếu có ai đưa cardinality của rotation domain vào công thức thì `free` sẽ thành
    vô hạn — và test này đỏ ngay.
    """
    _gia_lap_ram(monkeypatch, 32 * 1024.0)
    goc = svc.plan_hardware(_request(rotation={"mode": "free"}), cpu_count=16)
    khac = svc.plan_hardware(_request(rotation=rotation), cpu_count=16)

    assert khac.per_worker_mb == goc.per_worker_mb
    assert khac.shared_mb == goc.shared_mb
    assert khac.estimated_peak_mb == goc.estimated_peak_mb
    assert khac.workers == goc.workers


def test_workload_shape_khong_co_truong_dem_goc():
    """Chặn ở mức hợp đồng dữ liệu, không chỉ ở mức số học."""
    ten_truong = set(svc.WorkloadShape.__dataclass_fields__)
    assert ten_truong == {
        "part_count",
        "instance_count",
        "source_vertex_count",
        "max_sheets",
    }
    for ten in ten_truong:
        assert "angle" not in ten and "rotation" not in ten and "goc" not in ten


def test_uoc_luong_tang_theo_effort_cua_profile(monkeypatch):
    """`fast` < `balanced` < `tight`: effort cao giữ nhiều proposal/beam/refine hơn."""
    _gia_lap_ram(monkeypatch, 32 * 1024.0)
    per_worker = [
        svc.plan_hardware(_request(profile=name), cpu_count=16).per_worker_mb
        for name in ("fast", "balanced", "tight")
    ]
    assert per_worker[0] < per_worker[1] < per_worker[2]


def test_uoc_luong_tang_theo_hinh_hoc(monkeypatch):
    _gia_lap_ram(monkeypatch, 32 * 1024.0)
    it_part = svc.plan_hardware(_request(part_count=1), cpu_count=16)
    nhieu_part = svc.plan_hardware(_request(part_count=6), cpu_count=16)
    assert nhieu_part.shared_mb > it_part.shared_mb

    it_con = svc.plan_hardware(_request(quantity=4), cpu_count=16)
    nhieu_con = svc.plan_hardware(_request(quantity=400), cpu_count=16)
    assert nhieu_con.estimated_peak_mb > it_con.estimated_peak_mb


def test_nfp_cache_bi_chan_theo_byte(monkeypatch):
    """§14 cấm cache vô hạn: tăng số part không được cho cache lớn quá trần LRU."""
    _gia_lap_ram(monkeypatch, 32 * 1024.0)
    shape_lon = svc.WorkloadShape(
        part_count=4000,
        instance_count=0,
        source_vertex_count=4000 * 64,
        max_sheets=1,
    )
    effort = svc.SEARCH_EFFORT_BY_PROFILE["tight"]
    shared_mb = svc.estimate_shared_mb(shape_lon, effort)

    hinh_hoc_mb = shape_lon.source_vertex_count * 3 * 48 / (1024.0 * 1024.0)
    thumbnail_mb = shape_lon.part_count * 0.75
    phan_nfp = shared_mb - hinh_hoc_mb - thumbnail_mb
    assert phan_nfp <= svc.NFP_CACHE_MAX_MB + 1e-9, (
        f"NFP cache ước lượng {phan_nfp:.1f} MB vượt trần LRU {svc.NFP_CACHE_MAX_MB} MB"
    )


def test_describe_workload_doc_dung_hinh_dang():
    request = _request(part_count=3, quantity=7, max_sheets=12)
    request["parts"][0]["holes"] = [_rect(10.0, 10.0), _rect(5.0, 5.0)]
    shape = svc.describe_workload(request)

    assert shape.part_count == 3
    assert shape.instance_count == 21
    # 3 part × 4 đỉnh outer + 2 lỗ × 4 đỉnh.
    assert shape.source_vertex_count == 3 * 4 + 8
    assert shape.max_sheets == 12
    assert shape.avg_vertices_per_part == pytest.approx((3 * 4 + 8) / 3)


@pytest.mark.parametrize(
    "request_xau",
    [
        {},
        {"parts": None},
        {"parts": []},
        {"parts": [{}]},
        {"parts": [{"quantity": 0, "outer": None, "holes": None}]},
        {"parts": [{"quantity": -5, "outer": "khong-phai-list"}]},
        {"parts": ["khong-phai-dict"]},
        {"parts": [{"quantity": 2, "outer": [[1.0], [2.0, 3.0]]}], "sheet": "xau"},
    ],
)
def test_describe_workload_khong_no_voi_du_lieu_xau(request_xau):
    """Admission chạy TRƯỚC validator của engine nên phải chịu được dữ liệu chưa sạch."""
    shape = svc.describe_workload(request_xau)
    assert shape.part_count >= 0
    assert shape.instance_count >= 0
    assert shape.source_vertex_count >= 0
    assert shape.max_sheets >= 1


def test_profile_la_khong_hop_le_thi_ve_balanced(monkeypatch):
    _gia_lap_ram(monkeypatch, 32 * 1024.0)
    assert svc.normalize_profile("TIGHT") == "tight"
    assert svc.normalize_profile("  fast ") == "fast"
    assert svc.normalize_profile("turbo") == "balanced"
    assert svc.normalize_profile(None) == "balanced"
    assert svc.normalize_profile(7) == "balanced"

    mac_dinh = svc.plan_hardware(_request(profile="turbo"), cpu_count=16)
    balanced = svc.plan_hardware(_request(profile="balanced"), cpu_count=16)
    assert mac_dinh.effort == balanced.effort


# ─────────────────────────────────────────────────────────────────────────────
#  3. Fail sớm khi vượt ngân sách
# ─────────────────────────────────────────────────────────────────────────────


def test_vuot_ngan_sach_thi_fail_som_co_huong_dan(monkeypatch):
    _gia_lap_ram(monkeypatch, 32 * 1024.0)
    plan = svc.plan_hardware(_request(quantity=200, part_count=8), cpu_count=16)
    with pytest.raises(HeavyJobMemoryUnavailable) as excinfo:
        svc.assert_fits_memory(plan, budget_mb=1.0)
    message = str(excinfo.value)
    assert "GB" in message
    assert excinfo.value.required_mb == pytest.approx(plan.estimated_peak_mb)


def test_vua_ngan_sach_thi_di_qua(monkeypatch):
    _gia_lap_ram(monkeypatch, 32 * 1024.0)
    plan = svc.plan_hardware(_request(), cpu_count=16)
    svc.assert_fits_memory(plan, budget_mb=plan.estimated_peak_mb + 1.0)


def test_khong_doc_duoc_ram_thi_khong_chan(monkeypatch):
    """Fail-open có chủ đích: chốt whole-machine slot vẫn còn hiệu lực."""
    _gia_lap_ram(monkeypatch, None, None)
    assert svc.memory_budget_mb() is None
    plan = svc.plan_hardware(_request(quantity=500, part_count=20), cpu_count=16)
    svc.assert_fits_memory(plan)  # không được raise


def test_ngan_sach_ram_chua_75_phan_tram_kha_dung(monkeypatch):
    _gia_lap_ram(monkeypatch, 32 * 1024.0, available_mb=10_000.0)
    assert svc.memory_budget_mb() == pytest.approx(7_500.0)


# ─────────────────────────────────────────────────────────────────────────────
#  4. Parity mô hình effort với Rust
# ─────────────────────────────────────────────────────────────────────────────


def _parse_effort_tu_rust() -> dict[str, svc.SearchEffort]:
    """Đọc `SearchEffort::for_profile` từ chính file Rust.

    Sidecar cần các con số này trước khi gọi engine (để ước lượng RAM), nên bản sao là
    bắt buộc. Test này biến bản sao thành bản sao **có kiểm**: lệch một số là đỏ.
    """
    source = _CONTROL_RS.read_text(encoding="utf-8")
    body = source[source.index("pub const fn for_profile") :]
    body = body[: body.index("\n    }\n")]

    ket_qua: dict[str, svc.SearchEffort] = {}
    for ten_rust, ten_python in (
        ("Fast", "fast"),
        ("Balanced", "balanced"),
        ("Tight", "tight"),
    ):
        khoi = body[body.index(f"Profile::{ten_rust} => Self {{") :]
        khoi = khoi[: khoi.index("},")]

        def _so(field: str, khoi: str = khoi) -> int:
            match = re.search(rf"{field}\s*:\s*([0-9_]+)", khoi)
            assert match is not None, f"không thấy '{field}' trong nhánh {ten_rust}"
            return int(match.group(1).replace("_", ""))

        ket_qua[ten_python] = svc.SearchEffort(
            trial_count=_so("trial_count"),
            orientation_proposals_per_part=_so("orientation_proposals_per_part"),
            beam_width=_so("beam_width"),
            refinement_rounds=_so("refinement_rounds"),
            multi_start_restarts=_so("multi_start_restarts"),
            evaluation_budget=_so("evaluation_budget"),
        )
    return ket_qua


def test_effort_python_parity_voi_rust():
    assert _CONTROL_RS.exists(), f"không thấy {_CONTROL_RS}"
    assert svc.SEARCH_EFFORT_BY_PROFILE == _parse_effort_tu_rust()


def test_ba_profile_dung_bang_capabilities_cua_engine():
    """Danh sách profile không được lệch giữa Rust, sidecar và protocol."""
    assert set(svc.SEARCH_EFFORT_BY_PROFILE) == {"fast", "balanced", "tight"}
    effort = svc.SEARCH_EFFORT_BY_PROFILE
    assert (
        effort["fast"].evaluation_budget
        < effort["balanced"].evaluation_budget
        < effort["tight"].evaluation_budget
    )


def test_model_version_duoc_ghi_vao_reason(monkeypatch):
    """Đổi hệ số ước lượng phải tăng version, để report benchmark không so lệch."""
    _gia_lap_ram(monkeypatch, 32 * 1024.0)
    plan = svc.plan_hardware(_request(), cpu_count=16)
    assert f"model=v{svc.ADMISSION_MODEL_VERSION}" in plan.reason
    assert svc.MIXED_NESTING_KIND in plan.reason


# ─────────────────────────────────────────────────────────────────────────────
#  5. Ranh giới phase: chưa có HTTP route
# ─────────────────────────────────────────────────────────────────────────────


def test_p6b_chua_co_route_reachable():
    route_path = _REPO_ROOT / "backend" / "app" / "api" / "routes" / "mixed_nesting.py"
    if route_path.exists():
        pytest.skip("route đã được thêm ở P7a — kiểm tra ở test của phase đó")
    main_source = (_REPO_ROOT / "backend" / "app" / "main.py").read_text(encoding="utf-8")
    assert "mixed_nesting" not in main_source


def test_admission_khong_nap_native():
    """Ước lượng phải chạy được KHI CHƯA có native: nó là bước gác trước engine."""
    svc.reset_engine_cache()
    plan = svc.plan_hardware(_request(), cpu_count=os.cpu_count() or 4)
    assert plan.workers >= 1
    assert plan.estimated_peak_mb > 0
