"""Soundness thuần Python cho harness benchmark contention PPE."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
import threading

import pikepdf
import pytest

from app.config import settings
from app.core.action_engine import ActionEngine, ActionResult
from app.core.pdfx_export import PdfxExportEngine
from benchmarks import benchmark_ppe_concurrency as bench


def test_percentile_nearest_rank_and_empty_guard():
    values = [50.0, 10.0, 30.0, 20.0, 40.0]
    assert bench.percentile(values, 0.50) == 30.0
    assert bench.percentile(values, 0.95) == 50.0
    with pytest.raises(ValueError, match="danh sách rỗng"):
        bench.percentile([], 0.95)


def test_parse_all_preserves_declared_order_and_rejects_unknown():
    allowed = {"low": {}, "medium": {}, "high": {}}
    assert bench._parse_csv("all", allowed, "tier") == [
        "low",
        "medium",
        "high",
    ]
    assert bench._parse_csv("high,low", allowed, "tier") == ["high", "low"]
    with pytest.raises(ValueError, match="không hợp lệ"):
        bench._parse_csv("low,unknown", allowed, "tier")


def test_three_tiers_use_production_memory_policies():
    low = bench._policy_for_tier("low")
    medium = bench._policy_for_tier("medium")
    high = bench._policy_for_tier("high")

    assert low["render_budget_mb"] == 640
    assert medium["render_budget_mb"] == 1024
    assert high["render_budget_mb"] == 5120
    assert low["session_cache_mb"] == 96
    assert medium["session_cache_mb"] == 256
    assert high["session_cache_mb"] == 640
    assert high["render_budget_mb"] > medium["render_budget_mb"]


def test_cli_keeps_budget_override_explicit_and_outside_product_policy(tmp_path):
    args = bench.build_parser().parse_args(
        [
            "--pdf",
            str(tmp_path / "fixture.pdf"),
            "--workload",
            "production",
            "--render-budget-mb",
            "512",
            "--continue-on-error",
        ]
    )
    assert args.workload == "production"
    assert args.render_budget_mb == 512
    assert args.continue_on_error is True
    assert bench.WORKLOAD_SPECS["production"]["export_dpi"] == 300
    assert bench._policy_for_tier("low")["render_budget_mb"] == 640


def _group(task_payloads, *, makespan=100.0, peak_rss=200.0):
    return {
        "makespan_ms": makespan,
        "peak_rss_mb": peak_rss,
        "peak_rss_delta_mb": peak_rss / 2,
        "cpu_core_equivalents": 1.5,
        "cpu_pct_of_host": 9.375,
        "leftover_files": [],
        "results": {
            task: {
                "wall_ms": payload["operation_ms"],
                "payload": payload,
            }
            for task, payload in task_payloads.items()
        },
    }


def test_pair_summary_compares_p95_and_locks_artifact_identity():
    artifact_a = {"rgb_sha256": "AAA"}
    artifact_b = {"cmyk_sha256": "BBB"}
    isolated = {
        "viewer_zoom_stop": [
            _group(
                {
                    "viewer_zoom_stop": {
                        "operation_ms": value,
                        "artifact": artifact_a,
                    }
                }
            )
            for value in (10.0, 20.0)
        ],
        "export_cmyk": [
            _group(
                {
                    "export_cmyk": {
                        "operation_ms": value,
                        "artifact": artifact_b,
                    }
                }
            )
            for value in (30.0, 40.0)
        ],
    }
    concurrent = [
        _group(
            {
                "viewer_zoom_stop": {
                    "operation_ms": value_a,
                    "artifact": artifact_a,
                },
                "export_cmyk": {
                    "operation_ms": value_b,
                    "artifact": artifact_b,
                },
            },
            makespan=80.0,
            peak_rss=250.0,
        )
        for value_a, value_b in ((20.0, 60.0), (40.0, 80.0))
    ]

    summary = bench._summarize_pair(
        "viewer_export",
        ("viewer_zoom_stop", "export_cmyk"),
        isolated,
        concurrent,
    )

    assert summary["tasks"]["viewer_zoom_stop"]["p95_slowdown_ratio"] == 2.0
    assert summary["tasks"]["export_cmyk"]["p95_slowdown_ratio"] == 2.0
    assert summary["tasks"]["viewer_zoom_stop"]["artifact_consistent"] is True
    assert summary["concurrent_peak_rss_mb"]["p95"] == 250.0


def test_pair_summary_exposes_artifact_drift():
    isolated = {
        "a": [_group({"a": {"operation_ms": 1.0, "artifact": {"sha": "old"}}})],
        "b": [_group({"b": {"operation_ms": 1.0, "artifact": {"sha": "same"}}})],
    }
    concurrent = [
        _group(
            {
                "a": {"operation_ms": 1.0, "artifact": {"sha": "new"}},
                "b": {"operation_ms": 1.0, "artifact": {"sha": "same"}},
            }
        )
    ]
    summary = bench._summarize_pair("pair", ("a", "b"), isolated, concurrent)
    assert summary["tasks"]["a"]["artifact_consistent"] is False
    assert len(summary["tasks"]["a"]["artifact_signatures"]) == 2


def test_fixture_builder_keeps_one_customer_page_and_real_test_assets(tmp_path):
    source = tmp_path / "source.pdf"
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(200, 100))
    pdf.add_blank_page(page_size=(300, 150))
    pdf.save(source)
    pdf.close()

    fixtures = bench._prepare_fixtures(source, tmp_path)

    with pikepdf.open(fixtures["customer"]) as customer:
        assert len(customer.pages) == 1
    with pikepdf.open(fixtures["spot"]) as spot:
        assert len(spot.pages) == 1
        assert "CutContour" in str(spot.pages[0].get("/Resources"))
    with pikepdf.open(fixtures["outline"]) as outline:
        assert len(outline.pages) == 1
        assert "/Font" in (outline.pages[0].get("/Resources") or {})

    # Chốt report có thể serialize artifact/signature tiếng Việt ổn định.
    json.dumps(fixtures, ensure_ascii=False)


def _one_page_pdf(path: Path) -> None:
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(200, 100))
    pdf.save(path)
    pdf.close()


@pytest.mark.asyncio
async def test_action_cancel_waits_for_worker_and_removes_partial_output(
    tmp_path, monkeypatch
):
    """CancelledError ở caller chỉ được trả sau khi thread đã dừng thật."""
    monkeypatch.setattr(settings, "RESULTS_DIR", str(tmp_path / "results"))
    source = tmp_path / "source.pdf"
    _one_page_pdf(source)
    engine = ActionEngine()
    started = threading.Event()
    stopped = threading.Event()

    def worker(staged_path: str, cancel_event: threading.Event) -> None:
        Path(staged_path).write_bytes(b"%PDF-1.7\npartial")
        started.set()
        try:
            while not cancel_event.wait(0.005):
                pass
            raise InterruptedError("đã nhận tín hiệu hủy")
        finally:
            stopped.set()

    async def cancellable_handler(_input, staged_path, params):
        await asyncio.to_thread(
            worker,
            staged_path,
            params["_prynx_cancel_event"],
        )
        return True

    monkeypatch.setattr(
        engine,
        "_action_flatten_transparency",
        cancellable_handler,
    )
    task = asyncio.create_task(
        engine.execute(str(source), "FLATTEN_TRANSPARENCY")
    )
    assert await asyncio.to_thread(started.wait, 1.0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, 2.0)

    assert stopped.is_set(), "execute trả hủy khi worker vẫn còn chạy"
    assert list(engine.output_dir.iterdir()) == []


@pytest.mark.asyncio
async def test_action_publishes_only_validated_pdf_with_atomic_replace(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(settings, "RESULTS_DIR", str(tmp_path / "results"))
    source = tmp_path / "source.pdf"
    _one_page_pdf(source)
    engine = ActionEngine()
    staged_paths: list[Path] = []

    async def valid_handler(_input, staged_path, _params):
        staged_paths.append(Path(staged_path))
        _one_page_pdf(Path(staged_path))
        return True

    monkeypatch.setattr(engine, "_action_fix_metadata", valid_handler)
    result = await engine.execute(str(source), "FIX_METADATA")

    assert result.success is True
    assert result.output_path is not None
    assert Path(result.output_path).is_file()
    assert all(not path.exists() for path in staged_paths)
    with pikepdf.open(result.output_path) as published:
        assert len(published.pages) == 1


@pytest.mark.asyncio
async def test_pipeline_cancel_removes_previous_intermediate(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "RESULTS_DIR", str(tmp_path / "results"))
    source = tmp_path / "source.pdf"
    intermediate = tmp_path / "results" / "preflight_output" / "step-1.pdf"
    _one_page_pdf(source)
    engine = ActionEngine()
    calls = 0

    async def fake_execute(*_args, **_kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            _one_page_pdf(intermediate)
            return ActionResult(success=True, output_path=str(intermediate))
        raise asyncio.CancelledError

    monkeypatch.setattr(engine, "execute", fake_execute)
    with pytest.raises(asyncio.CancelledError):
        await engine.execute_batch(
            str(source),
            [{"id": "FIX_METADATA"}, {"id": "FIX_HAIRLINES"}],
        )

    assert not intermediate.exists()


@pytest.mark.asyncio
async def test_pdfx_cancel_stops_worker_and_never_publishes_partial(
    tmp_path, monkeypatch
):
    source = tmp_path / "source.pdf"
    _one_page_pdf(source)
    engine = PdfxExportEngine()
    engine.output_dir = tmp_path / "pdfx"
    engine.output_dir.mkdir()
    started = threading.Event()
    stopped = threading.Event()

    def cancellable_export(_input, staged_path, *, cancel_check=None):
        Path(staged_path).write_bytes(b"%PDF-1.7\npartial")
        started.set()
        try:
            assert cancel_check is not None
            while not cancel_check():
                threading.Event().wait(0.005)
            raise InterruptedError("đã nhận tín hiệu hủy")
        finally:
            stopped.set()

    monkeypatch.setattr(engine, "_export_x4_native", cancellable_export)
    task = asyncio.create_task(engine.export_pdfx(str(source), "x4"))
    assert await asyncio.to_thread(started.wait, 1.0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, 2.0)

    assert stopped.is_set(), "PDF/X trả hủy khi worker vẫn còn chạy"
    assert list(engine.output_dir.iterdir()) == []
