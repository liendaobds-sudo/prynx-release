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
