import asyncio
import logging
import time

import pikepdf
import pytest

from app.api.routes import imposition
from app.core import detect_shape_service
from app.workers.die_detection import DetectionConfig


def test_same_detection_key_shares_one_inflight_task():
    async def scenario():
        imposition._DETECT_INFLIGHT.clear()
        started = asyncio.Event()
        release = asyncio.Event()
        calls = 0

        async def work():
            nonlocal calls
            calls += 1
            started.set()
            await release.wait()
            return {"success": True}

        first = asyncio.create_task(imposition._run_shared_detection(("same",), work))
        await started.wait()
        second = asyncio.create_task(imposition._run_shared_detection(("same",), work))
        await asyncio.sleep(0)

        assert calls == 1
        release.set()
        assert await first == {"success": True}
        assert await second == {"success": True}
        await asyncio.sleep(0)
        assert ("same",) not in imposition._DETECT_INFLIGHT

    asyncio.run(scenario())


def test_cancelled_client_does_not_cancel_shared_detection():
    async def scenario():
        imposition._DETECT_INFLIGHT.clear()
        started = asyncio.Event()
        release = asyncio.Event()

        async def work():
            started.set()
            await release.wait()
            return "done"

        stale_client = asyncio.create_task(imposition._run_shared_detection(("pdf",), work))
        await started.wait()
        stale_client.cancel()
        try:
            await stale_client
            raise AssertionError("stale client should be cancelled")
        except asyncio.CancelledError:
            pass

        current_client = asyncio.create_task(imposition._run_shared_detection(("pdf",), work))
        release.set()
        assert await current_client == "done"

    asyncio.run(scenario())


def test_vector_and_raster_cpu_phases_keep_event_loop_responsive(monkeypatch):
    async def await_with_heartbeat(awaitable):
        task = asyncio.create_task(awaitable)
        ticks = 0
        while not task.done():
            ticks += 1
            await asyncio.sleep(0.01)
        return await task, ticks

    def blocking_vector(*_args):
        time.sleep(0.12)
        return "result", {"max_tries": 0}, {}

    def blocking_raster(*_args):
        time.sleep(0.12)
        return "shape", "CutContour"

    monkeypatch.setattr(
        detect_shape_service, "_run_vector_detection_sync", blocking_vector
    )
    monkeypatch.setattr(
        detect_shape_service,
        "_classify_raster_separations_sync",
        blocking_raster,
    )

    async def scenario():
        vector_result, vector_ticks = await await_with_heartbeat(
            detect_shape_service.run_vector_detection(
                "fixture.pdf",
                object(),
                0.0,
                "fixture.pdf",
                lambda *_args, **_kwargs: None,
                lambda *_args, **_kwargs: None,
            )
        )
        raster_result, raster_ticks = await await_with_heartbeat(
            detect_shape_service.classify_raster_separations(
                {}, 0, object(), object()
            )
        )

        assert vector_result[0] == "result"
        assert raster_result == ("shape", "CutContour")
        assert vector_ticks >= 3
        assert raster_ticks >= 3

    asyncio.run(scenario())


def test_raster_fallback_di_tron_luong_ppe_that(tmp_path):
    """Khóa detect-shape → tách kẽm PPE → OpenCV classifier trên artifact thật.

    Đây là consumer PPE nằm ngoài Output Preview. Chỉ test budget/classifier rời
    không bắt được hồi quy tên spot, byte mặt phẳng mực hoặc kích thước raster.
    """
    # PPE-SCOPE (audit 2026-08-10 §PPE.SCOPE.3): không skip cả module vì các test
    # coalescing thuần vẫn phải chạy trên môi trường chưa build native.
    try:
        import pdfcompare_native
    except ImportError:
        pytest.skip("cần native PPE để kiểm trọn raster fallback")
    if not hasattr(pdfcompare_native, "ppe_separations"):
        pytest.skip("native hiện tại chưa có ppe_separations")

    from app.core.separations import SeparationEngine

    pdf = pikepdf.Pdf.new()
    tint = pikepdf.Dictionary(
        FunctionType=2,
        Domain=[0, 1],
        C0=[0, 0, 0, 0],
        C1=[0, 1, 0, 0],
        N=1,
        Range=[0, 1, 0, 1, 0, 1, 0, 1],
    )
    separation = pikepdf.Array(
        [
            pikepdf.Name("/Separation"),
            pikepdf.Name("/CutContour"),
            pikepdf.Name("/DeviceCMYK"),
            pdf.make_indirect(tint),
        ]
    )
    page = pikepdf.Dictionary(
        Type=pikepdf.Name("/Page"),
        MediaBox=[0, 0, 200, 120],
        Resources=pikepdf.Dictionary(
            ColorSpace=pikepdf.Dictionary(CS0=pdf.make_indirect(separation))
        ),
        Contents=pdf.make_indirect(
            pikepdf.Stream(pdf, b"/CS0 cs 1 scn 20 30 120 60 re f\n")
        ),
    )
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    source = tmp_path / "spot-rectangle.pdf"
    pdf.save(str(source))
    pdf.close()

    shape = asyncio.run(
        imposition._raster_fallback_shape(
            SeparationEngine(),
            str(source),
            0,
            DetectionConfig(),
            logging.getLogger("test_ppe_raster_fallback"),
        )
    )

    assert shape is not None
    assert shape.source == "raster_fallback"
    assert shape.type.name == "RECTANGLE"
    # Classifier đo bbox theo chênh lệch chỉ số pixel nên nhỏ hơn hình 120×60 pt
    # đúng nửa pixel ở 144 DPI; dung sai 0,6 pt khóa cả DPI lẫn quy đổi px→pt.
    assert shape.trim.w == pytest.approx(119.5, abs=0.6)
    assert shape.trim.h == pytest.approx(59.5, abs=0.6)


def test_detect_cache_key_changes_with_detection_config(tmp_path):
    pdf = tmp_path / "shape.pdf"
    pdf.write_bytes(b"%PDF-placeholder")
    default = DetectionConfig()
    custom = DetectionConfig(die_channel_names=("MyCut",))

    default_key = imposition._make_detect_cache_key(str(pdf), default)
    custom_key = imposition._make_detect_cache_key(str(pdf), custom)

    assert default_key is not None
    assert custom_key is not None
    assert default_key != custom_key


class _FakeShape:
    def __init__(self, source: str):
        self.source = source


class _FakeStatus:
    def __init__(self, ok: bool = True):
        self.ok = ok


def test_raster_budget_probe_only_when_vector_master_exists():
    """tron.pdf pattern: 1 separation + 27 custom → chỉ probe 1 GS, không 27 lần."""
    shapes = [_FakeShape("separation")] + [_FakeShape("custom")] * 27
    statuses = [_FakeStatus(True)] * 28
    b = imposition._raster_fallback_budget(shapes, statuses, max_tries=3)
    assert b["reason"] == "probe_only_has_vector_master"
    assert b["max_tries"] == 1
    assert b["vector_ok"] == 1
    assert b["custom_n"] == 27
    assert len(b["all_custom_indices"]) == 27


def test_raster_budget_all_custom_capped():
    shapes = [_FakeShape("custom")] * 20
    statuses = [_FakeStatus(True)] * 20
    b = imposition._raster_fallback_budget(shapes, statuses, max_tries=3)
    assert b["reason"] == "all_custom_capped"
    assert b["max_tries"] == 3
    assert b["vector_ok"] == 0


def test_raster_budget_disabled_with_zero_max():
    shapes = [_FakeShape("custom")] * 5
    statuses = [_FakeStatus(True)] * 5
    b = imposition._raster_fallback_budget(shapes, statuses, max_tries=0)
    assert b["max_tries"] == 0
    assert b["reason"] == "none_or_disabled"
    assert b.get("indices") == []


def test_master_die_inheritance_propagates_circle():
    """1 trang separation CIRCLE + N custom → mọi trang CIRCLE (kế thừa khuôn)."""
    from app.workers.die_detection import (
        DetectionResult, DetectedShape, Trim, PageDetectionStatus,
        apply_master_die_inheritance, make_custom_shape,
    )
    from app.workers.shape_types import ShapeType

    master = DetectedShape(
        page=0, type=ShapeType.CIRCLE_ELLIPSE, props={"area_ratio": 0.78},
        trim=Trim(50.0, 50.0), poly=((0, 0), (50, 0), (50, 50), (0, 50)),
        source="separation", confidence=1.0,
    )
    shapes = [master] + [make_custom_shape(i, 100.0, 100.0) for i in range(1, 5)]
    statuses = [PageDetectionStatus(i, True, shapes[i].source) for i in range(5)]
    result = DetectionResult(
        shapes=shapes, statuses=statuses, total_pages=5,
        success_pages=5, failed_pages=(),
    )
    out = apply_master_die_inheritance(result)
    assert all(s.type is ShapeType.CIRCLE_ELLIPSE for s in out.shapes)
    assert out.shapes[0].source == "separation"
    assert out.shapes[2].props.get("inheritedFromPage") == 0
    assert out.shapes[2].trim.w == 50.0


def test_batch_single_mold_master_one_type():
    """Master ở giữa file được chọn từ inheritedFromPage, không từ page đầu."""
    pages = [
        {"page_idx": 0, "shape_type": "CIRCLE_ELLIPSE", "item_w": 50, "item_h": 50,
         "shape_props": {"inheritedFromPage": 1}},
        {"page_idx": 1, "shape_type": "CIRCLE_ELLIPSE", "item_w": 50, "item_h": 50,
         "shape_props": {"diameter": 50}},
        {"page_idx": 2, "shape_type": "CIRCLE_ELLIPSE", "item_w": 50.5, "item_h": 50,
         "shape_props": {"inheritedFromPage": 1}},
    ]
    m = imposition._batch_single_mold_master(pages)
    assert m is not None
    assert m["page_idx"] == 1
    assert m["shape_type"] == "CIRCLE_ELLIPSE"


def test_batch_single_mold_master_multi_type_none():
    pages = [
        {"page_idx": 0, "shape_type": "CIRCLE_ELLIPSE", "item_w": 50, "item_h": 50},
        {"page_idx": 1, "shape_type": "HEXAGON", "item_w": 50, "item_h": 50},
    ]
    assert imposition._batch_single_mold_master(pages) is None


def test_batch_single_mold_master_dim_mismatch_none():
    pages = [
        {"page_idx": 0, "shape_type": "CIRCLE_ELLIPSE", "item_w": 50, "item_h": 50,
         "shape_props": {}},
        {"page_idx": 1, "shape_type": "CIRCLE_ELLIPSE", "item_w": 80, "item_h": 50,
         "shape_props": {"inheritedFromPage": 0}},
    ]
    assert imposition._batch_single_mold_master(pages) is None


def test_batch_same_shape_without_inheritance_is_multi_mold():
    pages = [
        {"page_idx": 0, "shape_type": "CIRCLE_ELLIPSE", "item_w": 30, "item_h": 30},
        {"page_idx": 1, "shape_type": "CIRCLE_ELLIPSE", "item_w": 60, "item_h": 60},
    ]
    assert imposition._batch_single_mold_master(pages) is None


def test_master_die_inheritance_skips_when_two_masters():
    from app.workers.die_detection import (
        DetectionResult, DetectedShape, Trim, PageDetectionStatus,
        apply_master_die_inheritance, make_custom_shape,
    )
    from app.workers.shape_types import ShapeType

    m0 = DetectedShape(
        page=0, type=ShapeType.CIRCLE_ELLIPSE, props={},
        trim=Trim(40, 40), poly=(), source="separation", confidence=1.0,
    )
    m1 = DetectedShape(
        page=1, type=ShapeType.HEXAGON, props={},
        trim=Trim(40, 40), poly=(), source="vector", confidence=1.0,
    )
    shapes = [m0, m1, make_custom_shape(2, 80, 80)]
    statuses = [PageDetectionStatus(i, True, shapes[i].source) for i in range(3)]
    result = DetectionResult(shapes=shapes, statuses=statuses, total_pages=3, success_pages=3)
    out = apply_master_die_inheritance(result)
    assert out.shapes[2].type.name == "CUSTOM"


def test_batch_geometry_fingerprint_is_safe_and_reuses_only_equivalents():
    primitive_a = {
        "page_idx": 0, "shape_type": "CIRCLE_ELLIPSE",
        "item_w": 50, "item_h": 50, "shape_props": {"radius": 25},
    }
    primitive_same = {
        "page_idx": 1, "shape_type": "CIRCLE_ELLIPSE",
        "item_w": 50, "item_h": 50,
        "shape_props": {"radius": 25, "inheritedFromPage": 0},
    }
    primitive_other_size = {**primitive_same, "page_idx": 2, "item_w": 60}
    primitive_other_props = {
        **primitive_same, "page_idx": 3, "shape_props": {"radius": 24},
    }

    fp = imposition._batch_geometry_fingerprint
    assert fp(primitive_a) == fp(primitive_same)
    assert fp(primitive_a) != fp(primitive_other_size)
    assert fp(primitive_a) != fp(primitive_other_props)
    assert fp({"page_idx": 4, "shape_type": "CUSTOM", "item_w": 50, "item_h": 50}) != fp(
        {"page_idx": 5, "shape_type": "CUSTOM", "item_w": 50, "item_h": 50}
    )
    assert fp(primitive_a, "one_dao", "page") != fp(primitive_same, "one_dao", "page")

    groups = imposition._group_batch_pages([
        primitive_a, primitive_same, primitive_other_size, primitive_other_props,
    ])
    assert [[page["page_idx"] for page in group] for group in groups] == [[0, 1], [2], [3]]


def test_batch_capacity_endpoint_is_sync_to_avoid_blocking_event_loop():
    import inspect

    assert not inspect.iscoroutinefunction(imposition.preview_layouts_batch)
