import asyncio

from app.api.routes import imposition
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
