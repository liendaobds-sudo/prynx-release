"""Hợp đồng của script benchmark và corpus — phase P7b.

Kế hoạch: ``docs/KE_HOACH_MIXED_TRUE_SHAPE_NESTING_DOC_LAP_2026-08-26.md`` §17.

Vì sao cần test cho một script benchmark: báo cáo benchmark là **bằng chứng** trong quy
trình duyệt release. Một script đo sai, hoặc lặng lẽ đo một solver khác, sẽ tạo bằng chứng
giả mà không ai phát hiện. Bộ test này chốt bốn thứ:

1. Script gọi **đúng bridge thật** (``app.core.mixed_nesting_service``). Không có nhánh
   giả lập, không tự dựng solver, không import solver bình bài cũ.
2. **Baseline cardinal chỉ thu hẹp miền góc**, không đổi ``profile`` — đổi profile là đúng
   thứ kế hoạch cấm, và sẽ biến "so sánh" thành so hai lượng công khác nhau.
3. **Corpus có đủ ba ca bắt buộc** ``ANGLE_ONLY``/``CONTINUOUS_XY``/``CONSTRAINTS``, và
   mọi request trong corpus **hợp lệ với schema công khai**.
4. **Report ghi đủ máy + số đo tìm kiếm**, và ``materialUtilization`` được **tính lại**
   từ contour thay vì lấy số solver tự báo.

Không ca nào ở đây chạy engine thật: đó là việc của
``test_mixed_nesting_lifecycle.py``. File này chỉ đảm bảo cái *thước đo* đúng.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from typing import Any

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[2]
_SCRIPT = _REPO_ROOT / "scripts" / "benchmark_mixed_nesting.py"
_CORPUS = _REPO_ROOT / "backend" / "tests" / "fixtures" / "mixed_nesting" / "corpus.json"


def _load_script():
    """Nạp script như module để test hàm thuần, không phải chạy CLI."""
    spec = importlib.util.spec_from_file_location("benchmark_mixed_nesting", _SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["benchmark_mixed_nesting"] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def bench():
    return _load_script()


@pytest.fixture(scope="module")
def corpus() -> dict[str, Any]:
    with open(_CORPUS, "r", encoding="utf-8") as handle:
        return json.load(handle)


# ─────────────────────────────────────────────────────────────────────────────
#  1. Gọi đúng bridge thật
# ─────────────────────────────────────────────────────────────────────────────


def test_script_goi_bridge_that_va_khong_co_nhanh_gia_lap():
    source = _SCRIPT.read_text(encoding="utf-8")
    assert "from app.core.mixed_nesting_service import create_run" in source
    assert "engine_capabilities" in source
    assert "plan_hardware" in source, "số worker phải lấy từ planner, không bịa"

    for cam in (
        "FakeRun",
        "mock",
        "Mock",
        "monkeypatch",
        "from app.core.imposition",
        "import imposition",
        "sticker",
        "print_engine",
    ):
        assert cam not in source, f"script benchmark không được chứa {cam!r}"


def test_thieu_native_thi_bao_ro_va_thoat(bench, monkeypatch):
    """Không có native thì phải dừng, không "chạy tạm" rồi ra số vô nghĩa."""
    import app.core.mixed_nesting_service as service

    def khong_co_native():
        raise service.EngineUnavailableError("Chưa cài phần lõi tính toán.")

    monkeypatch.setattr(service, "engine_capabilities", khong_co_native)
    with pytest.raises(SystemExit) as excinfo:
        bench.benchmark(case_ids=None, profiles=["fast"], runs=1, deadline_ms=None)
    assert "native" in str(excinfo.value).lower() or "lõi tính toán" in str(excinfo.value)


def test_solve_once_di_qua_create_run(bench, monkeypatch):
    """Chứng minh bằng hành vi, không chỉ bằng đọc text: solve_once dùng create_run."""
    import app.core.mixed_nesting_service as service

    da_goi: list[str] = []

    class FakeHandle:
        def solve(self, request):
            da_goi.append("solve")
            return {"stats": {"sheetCount": 1}, "placements": []}

    monkeypatch.setattr(service, "create_run", lambda: FakeHandle())
    manifest, elapsed = bench.solve_once({"seed": 1})
    assert da_goi == ["solve"]
    assert elapsed >= 0.0
    assert manifest["stats"]["sheetCount"] == 1


# ─────────────────────────────────────────────────────────────────────────────
#  2. Baseline cardinal chỉ thu hẹp miền góc
# ─────────────────────────────────────────────────────────────────────────────


def test_baseline_chi_doi_rotation_khong_doi_profile(bench, corpus):
    goc = corpus["cases"][0]["request"]
    baseline = bench.cardinal_baseline_request(goc)

    assert baseline["profile"] == goc["profile"], "baseline KHÔNG được đổi profile"
    assert baseline["seed"] == goc["seed"]
    assert baseline["sheet"] == goc["sheet"]
    assert baseline["gapMm"] == goc["gapMm"]
    assert [p["outer"] for p in baseline["parts"]] == [p["outer"] for p in goc["parts"]]
    assert [p["quantity"] for p in baseline["parts"]] == [p["quantity"] for p in goc["parts"]]

    cardinal = {"mode": "discrete", "anglesDeg": [0.0, 90.0, 180.0, 270.0]}
    assert baseline["orientationPolicy"]["defaultRotation"] == cardinal
    for part in baseline["parts"]:
        assert part["rotationConstraint"] == cardinal


def test_baseline_khong_sua_request_goc(bench, corpus):
    """Deep copy: benchmark chạy nhiều ca liên tiếp, sửa tại chỗ sẽ nhiễm ca sau."""
    goc = json.loads(json.dumps(corpus["cases"][2]["request"]))
    truoc = json.loads(json.dumps(goc))
    bench.cardinal_baseline_request(goc)
    assert goc == truoc


def test_nhan_san_an_toan_luon_co_trong_bao_cao(bench):
    assert "SÀN AN TOÀN" in bench.BASELINE_DISCLAIMER
    assert "KHÔNG phải legal domain" in bench.BASELINE_DISCLAIMER
    source = _SCRIPT.read_text(encoding="utf-8")
    assert '"baselineDisclaimer": BASELINE_DISCLAIMER' in source
    assert "report['baselineDisclaimer']" in source


# ─────────────────────────────────────────────────────────────────────────────
#  3. Corpus
# ─────────────────────────────────────────────────────────────────────────────


def test_corpus_co_du_ba_ca_bat_buoc(bench, corpus):
    ids = [case["id"] for case in corpus["cases"]]
    for required in bench.REQUIRED_CASE_IDS:
        assert required in ids, f"corpus thiếu {required}"
    assert bench.REQUIRED_CASE_IDS == ("ANGLE_ONLY", "CONTINUOUS_XY", "CONSTRAINTS")
    assert len(ids) == len(set(ids)), "mã ca bị trùng"


def test_moi_request_trong_corpus_hop_le_voi_schema_cong_khai(corpus):
    """Corpus phải đi qua đúng biên giới công khai, không phải đường vòng nội bộ."""
    from app.schemas.mixed_nesting import CreateJobRequest

    for case in corpus["cases"]:
        body = CreateJobRequest.model_validate(case["request"])
        payload = body.to_engine_request(job_id="test")
        assert payload["jobId"] == "test"
        assert payload["protocolVersion"] == 1


def test_corpus_khong_chua_truong_server_owned(corpus):
    for case in corpus["cases"]:
        request = case["request"]
        for cam in ("jobId", "geometryHash", "sourceRevision", "translationStepMm"):
            assert cam not in request, f"{case['id']} chứa {cam}"
        for part in request["parts"]:
            for cam in ("referencePointMm", "geometryHash", "sourceRevision"):
                assert cam not in part, f"{case['id']}/{part['partId']} chứa {cam}"


def test_ca_angle_only_thuc_su_khong_giai_duoc_bang_bon_goc_cardinal(corpus):
    """Kiểm bằng HÌNH HỌC, không cần chạy engine: nếu ca này giải được bằng cardinal thì
    nó không chứng minh gì và phải sửa fixture."""
    case = next(c for c in corpus["cases"] if c["id"] == "ANGLE_ONLY")
    request = case["request"]
    sheet = request["sheet"]
    usable_w = sheet["widthMm"] - sheet["marginMm"]["left"] - sheet["marginMm"]["right"]
    usable_h = sheet["heightMm"] - sheet["marginMm"]["top"] - sheet["marginMm"]["bottom"]

    part = request["parts"][0]
    xs = [point[0] for point in part["outer"]]
    ys = [point[1] for point in part["outer"]]
    w = max(xs) - min(xs)
    h = max(ys) - min(ys)

    # Bốn góc cardinal chỉ cho hai hình bao: (w,h) và (h,w). Cả hai phải TRƯỢT.
    assert not (w <= usable_w and h <= usable_h), "0°/180° vừa tờ — ca mất ý nghĩa"
    assert not (h <= usable_w and w <= usable_h), "90°/270° vừa tờ — ca mất ý nghĩa"

    # …còn 45° phải VỪA, nếu không thì ca vô nghiệm và test lifecycle sẽ đỏ oan.
    import math

    cos45 = math.cos(math.radians(45.0))
    sin45 = math.sin(math.radians(45.0))
    bao_w = w * cos45 + h * sin45
    bao_h = w * sin45 + h * cos45
    assert bao_w <= usable_w and bao_h <= usable_h, (
        f"45° cho bao {bao_w:.2f}×{bao_h:.2f} mm, vùng dùng được "
        f"{usable_w:.2f}×{usable_h:.2f} mm — ca vô nghiệm"
    )


def test_ca_continuous_xy_co_kich_thuoc_phan_le(corpus):
    """Nếu mọi số đều nguyên thì ca không thể chứng minh continuous X/Y."""
    case = next(c for c in corpus["cases"] if c["id"] == "CONTINUOUS_XY")
    sheet = case["request"]["sheet"]
    so = [
        sheet["widthMm"],
        sheet["heightMm"],
        *sheet["marginMm"].values(),
        case["request"]["gapMm"],
    ]
    assert any(abs(value - round(value)) > 1e-9 for value in so), (
        "ca CONTINUOUS_XY phải có kích thước phần lẻ mm"
    )


def test_ca_constraints_trộn_du_nam_mode(corpus):
    case = next(c for c in corpus["cases"] if c["id"] == "CONSTRAINTS")
    modes = {part["rotationConstraint"]["mode"] for part in case["request"]["parts"]}
    assert modes == {"free", "fixed", "discrete", "ranges", "inherit"}, modes

    # `fixed` phải là góc KHÔNG-cardinal, nếu không thì không kiểm được việc làm tròn.
    fixed = next(
        part
        for part in case["request"]["parts"]
        if part["rotationConstraint"]["mode"] == "fixed"
    )
    angle = fixed["rotationConstraint"]["angleDeg"]
    assert abs(angle - round(angle)) > 1e-9, "góc fixed phải có phần lẻ"
    assert angle % 90.0 != 0.0


def test_corpus_co_version_va_ky_vong_da_ghi():
    """Sửa kỳ vọng phải tăng ``corpusVersion`` — test này chốt là hai thứ cùng tồn tại."""
    with open(_CORPUS, "r", encoding="utf-8") as handle:
        corpus = json.load(handle)
    assert isinstance(corpus["corpusVersion"], int) and corpus["corpusVersion"] >= 1
    assert corpus["protocolVersion"] == 1
    assert "SÀN AN TOÀN" in corpus["cardinalBaselineNote"]
    for case in corpus["cases"]:
        assert case["expect"], f"{case['id']} thiếu kỳ vọng"
        assert case["rationale"], f"{case['id']} thiếu lý do tồn tại"
        assert case["expect"]["minPlaced"] >= 1
        assert case["expect"]["maxSheets"] >= 1


# ─────────────────────────────────────────────────────────────────────────────
#  4. Report: máy + số đo tìm kiếm, utilization tính lại
# ─────────────────────────────────────────────────────────────────────────────


def test_describe_machine_ghi_du_truong(bench, corpus):
    machine = bench.describe_machine(corpus["cases"][0]["request"])
    for field in (
        "platform",
        "python",
        "cpuCount",
        "ramTotalMb",
        "ramTier",
        "workers",
        "perWorkerMb",
        "estimatedPeakMb",
        "plannerReason",
    ):
        assert field in machine, f"report thiếu {field}"
    assert machine["workers"] >= 1
    assert machine["ramTier"] in {"unknown", "<8GB", "<16GB", ">=16GB", ">=64GB"}


def test_ram_tier_phan_loai_dung(bench):
    assert bench._ram_tier(None) == "unknown"
    assert bench._ram_tier(6 * 1024) == "<8GB"
    assert bench._ram_tier(12 * 1024) == "<16GB"
    assert bench._ram_tier(32 * 1024) == ">=16GB"
    assert bench._ram_tier(128 * 1024) == ">=64GB"


def test_run_case_ghi_du_so_do_tim_kiem(bench, monkeypatch, corpus):
    """Report phải mang orientationEvaluations/poseRefinements/terminationReason."""
    import app.core.mixed_nesting_service as service

    class FakeHandle:
        def solve(self, request):
            return {
                "status": "completed",
                "placements": [
                    {
                        "instanceId": "p#1",
                        "partId": request["parts"][0]["partId"],
                        "sheetIndex": 0,
                        "pose": {
                            "rotationDeg": 13.372849,
                            "translateXmm": 12.5,
                            "translateYmm": 7.25,
                        },
                    }
                ],
                "unplaced": [],
                "stats": {
                    "sheetCount": 1,
                    "placedCount": 1,
                    "unplacedCount": 0,
                    "materialUtilization": 0.5,
                    "elapsedMs": 12,
                    "attempts": 4,
                    "orientationEvaluations": 40,
                    "poseRefinements": 400,
                    "terminationReason": "all_placed",
                },
                "validation": {"valid": True, "validatorVersion": 1},
            }

    monkeypatch.setattr(service, "create_run", lambda: FakeHandle())
    row = bench.run_case(
        corpus["cases"][0]["request"], profile="fast", runs=3, time_budget_ms=None
    )

    for field in (
        "p50Ms",
        "p95Ms",
        "peakRssMb",
        "deterministic",
        "sheetCount",
        "placedCount",
        "unplacedCount",
        "reportedUtilization",
        "recomputedUtilization",
        "orientationEvaluations",
        "poseRefinements",
        "terminationReason",
        "validation",
        "nonCardinalAngleCount",
        "fractionalTranslationCount",
    ):
        assert field in row, f"thiếu {field}"
    assert row["mode"] == "fixed_work_plan"
    assert row["deterministic"] is True
    assert row["orientationEvaluations"] == 40
    assert row["poseRefinements"] == 400
    assert row["nonCardinalAngleCount"] == 1
    assert row["fractionalTranslationCount"] == 1


def test_deadline_mode_khong_doi_deterministic(bench, monkeypatch, corpus):
    """Chế độ deadline KHÔNG cam kết bit-identical → `deterministic` phải là None."""
    import app.core.mixed_nesting_service as service

    dem = {"lan": 0}

    class FakeHandle:
        def solve(self, request):
            dem["lan"] += 1
            assert request.get("timeBudgetMs") == 500
            return {
                "status": "completed",
                "placements": [],
                "unplaced": [],
                "stats": {"sheetCount": 1, "terminationReason": "deadline"},
                "validation": {"valid": True},
            }

    monkeypatch.setattr(service, "create_run", lambda: FakeHandle())
    row = bench.run_case(
        corpus["cases"][0]["request"], profile="tight", runs=2, time_budget_ms=500
    )
    assert row["mode"] == "deadline"
    assert row["deterministic"] is None
    assert row["timeBudgetMs"] == 500
    assert dem["lan"] == 2


def test_utilization_duoc_tinh_lai_tu_contour(bench):
    """Không lấy số solver tự báo: tự tính diện tích contour bằng công thức shoelace."""
    request = {
        "sheet": {"widthMm": 100.0, "heightMm": 100.0},
        "parts": [{"partId": "a", "outer": [[0, 0], [10, 0], [10, 10], [0, 10]]}],
    }
    manifest = {
        "stats": {"sheetCount": 1, "materialUtilization": 0.99},
        "placements": [{"partId": "a"}, {"partId": "a"}],
    }
    tinh_lai = bench.recompute_utilization(request, manifest)
    assert tinh_lai == pytest.approx(2 * 100.0 / 10_000.0)
    assert tinh_lai != manifest["stats"]["materialUtilization"], (
        "phải độc lập với số solver báo"
    )


def test_dien_tich_ring_dung_voi_tam_giac_va_thu_tu_dinh(bench):
    tam_giac = [[0.0, 0.0], [10.0, 0.0], [0.0, 10.0]]
    assert bench._ring_area_mm2(tam_giac) == pytest.approx(50.0)
    # Đảo hướng vòng không đổi diện tích (dùng trị tuyệt đối).
    assert bench._ring_area_mm2(list(reversed(tam_giac))) == pytest.approx(50.0)


def test_nhan_dien_goc_cardinal(bench):
    for angle in (0.0, 90.0, 180.0, 270.0, 360.0, -90.0):
        assert bench._is_cardinal(angle), angle
    for angle in (13.372849, 45.0, 89.999, 359.5):
        assert not bench._is_cardinal(angle), angle


def test_utilization_tra_none_khi_khong_co_to(bench):
    request = {"sheet": {"widthMm": 100.0, "heightMm": 100.0}, "parts": []}
    assert bench.recompute_utilization(request, {"stats": {"sheetCount": 0}}) is None


def test_profile_khong_hop_le_bi_tu_choi_o_cli(bench):
    with pytest.raises(SystemExit):
        bench.main(["--profiles", "turbo"])
