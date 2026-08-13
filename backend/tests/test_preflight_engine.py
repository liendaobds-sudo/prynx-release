"""Integration & regression tests for Preflight engine and rule modules."""
import asyncio
import re
import tempfile
import threading
import time
from pathlib import Path

import pikepdf
import pytest

from app.core.preflight_engine import PreflightEngine, _content_stream_worker
from app.core.preflight_models import ALL_RULES
from app.core.preflight_rules.fonts import (
    _font_names_match,
    _normalize_font_token,
)
from app.core.preflight_rules.images import (
    ImageRulesMixin,
    _resolve_pdf_int,
    compute_effective_dpi,
)


# ── Helpers ──────────────────────────────────────────────────────────────────

def _make_blank_pdf(path: Path, pages: int = 1) -> Path:
    pdf = pikepdf.Pdf.new()
    for _ in range(pages):
        pdf.add_blank_page(page_size=(612, 792))
    pdf.save(path)
    pdf.close()
    return path


def _make_rgb_colorspace_pdf(path: Path) -> Path:
    """Single page with DeviceRGB ColorSpace in Resources."""
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(612, 792))
    page["/Resources"] = pikepdf.Dictionary({
        "/ColorSpace": pikepdf.Dictionary({"/CS1": pikepdf.Name("/DeviceRGB")}),
    })
    pdf.save(path)
    pdf.close()
    return path


def _make_indirect_width_image_pdf(path: Path) -> Path:
    """Image XObject with /Width and /Height as indirect integer objects."""
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(612, 792))

    width_obj = pdf.make_indirect(1200)
    height_obj = pdf.make_indirect(800)
    bpc_obj = pdf.make_indirect(8)

    img = pikepdf.Stream(pdf, b"\x00" * 16)
    img["/Type"] = pikepdf.Name("/XObject")
    img["/Subtype"] = pikepdf.Name("/Image")
    img["/Width"] = width_obj
    img["/Height"] = height_obj
    img["/BitsPerComponent"] = bpc_obj
    img["/ColorSpace"] = pikepdf.Name("/DeviceRGB")
    img["/Filter"] = pikepdf.Name("/FlateDecode")

    page["/Resources"] = pikepdf.Dictionary({
        "/XObject": pikepdf.Dictionary({"/Im1": pdf.make_indirect(img)}),
    })
    pdf.save(path)
    pdf.close()
    return path


def _make_xmp_linked_pdf(path: Path) -> Path:
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(612, 792))
    xmp_bytes = (
        b'<?xpacket begin="" id="W">'
        b'<x:xmpmeta xmlns:x="adobe:ns:meta/">'
        b'<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
        b'<stEvt:action>linked</stEvt:action>'
        b'</rdf:RDF></x:xmpmeta><?xpacket end="w"?>'
    )
    meta = pikepdf.Stream(pdf, xmp_bytes)
    meta["/Type"] = pikepdf.Name("/Metadata")
    meta["/Subtype"] = pikepdf.Name("/XML")
    pdf.Root["/Metadata"] = pdf.make_indirect(meta)
    pdf.save(path)
    pdf.close()
    return path


def _make_mismatched_page_sizes_pdf(path: Path) -> Path:
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(612, 792))
    pdf.add_blank_page(page_size=(500, 700))
    pdf.save(path)
    pdf.close()
    return path


def _make_repeated_unembedded_font_pdf(path: Path, pages: int = 100) -> Path:
    """Một font TrueType không nhúng được dùng lại trên nhiều trang."""
    pdf = pikepdf.Pdf.new()
    font_descriptor = pikepdf.Dictionary({
        "/Type": "/FontDescriptor",
        "/FontName": "/FakeFontQA",
        "/Flags": 32,
        "/ItalicAngle": 0,
        "/Ascent": 800,
        "/Descent": -200,
        "/CapHeight": 700,
        "/StemV": 80,
    })
    font = pikepdf.Dictionary({
        "/Type": "/Font",
        "/Subtype": "/TrueType",
        "/BaseFont": "/ABCDEF+FakeFontQA-Regular",
        "/FirstChar": 32,
        "/LastChar": 126,
        "/Widths": pikepdf.Array([500] * 95),
        "/FontDescriptor": pdf.make_indirect(font_descriptor),
    })
    font_ref = pdf.make_indirect(font)
    for page_number in range(1, pages + 1):
        page = pdf.add_blank_page(page_size=(612, 792))
        page["/Resources"] = pikepdf.Dictionary({
            "/Font": pikepdf.Dictionary({"/F1": font_ref}),
        })
        page["/Contents"] = pdf.make_stream(
            f"BT /F1 12 Tf 72 700 Td (Page {page_number}) Tj ET".encode("ascii")
        )
    pdf.save(path)
    pdf.close()
    return path


def _make_same_family_mixed_embedding_pdf(path: Path) -> Path:
    """Hai subset cùng họ trên một trang, chỉ một subset được nhúng."""
    pdf = pikepdf.Pdf.new()

    def make_font(base_font: str, embedded: bool):
        descriptor = pikepdf.Dictionary({
            "/Type": "/FontDescriptor",
            "/FontName": f"/{base_font.split('+', 1)[-1]}",
            "/Flags": 32,
            "/ItalicAngle": 0,
            "/Ascent": 800,
            "/Descent": -200,
            "/CapHeight": 700,
            "/StemV": 80,
        })
        if embedded:
            descriptor["/FontFile2"] = pdf.make_stream(b"fake-font-data")
        return pdf.make_indirect(pikepdf.Dictionary({
            "/Type": "/Font",
            "/Subtype": "/TrueType",
            "/BaseFont": f"/{base_font}",
            "/FirstChar": 32,
            "/LastChar": 126,
            "/Widths": pikepdf.Array([500] * 95),
            "/FontDescriptor": pdf.make_indirect(descriptor),
        }))

    page = pdf.add_blank_page(page_size=(612, 792))
    page["/Resources"] = pikepdf.Dictionary({
        "/Font": pikepdf.Dictionary({
            "/F1": make_font("ABCDEF+SameFamily-Regular", True),
            "/F2": make_font("GHIJKL+SameFamily-Regular", False),
        }),
    })
    pdf.save(path)
    pdf.close()
    return path


# ── Unit tests ───────────────────────────────────────────────────────────────

class TestResolvePdfInt:
    def test_direct_int(self):
        d = pikepdf.Dictionary({"/Width": 100})
        assert _resolve_pdf_int(d, "/Width") == 100

    def test_indirect_int(self):
        pdf = pikepdf.Pdf.new()
        obj = pikepdf.Dictionary({"/Width": pdf.make_indirect(2400)})
        assert _resolve_pdf_int(obj, "/Width") == 2400
        pdf.close()

    def test_missing_key_returns_default(self):
        assert _resolve_pdf_int(pikepdf.Dictionary(), "/Width", 0) == 0


class TestFontNameMatching:
    def test_subset_prefix_stripped(self):
        assert _normalize_font_token("ABCDEF+Helvetica-Bold") == "helvetica"

    def test_exact_base_font_match(self):
        ref = "Font /F1 (Helvetica-Bold)"
        assert _font_names_match("ABCDEF+Helvetica", ref) is True

    def test_no_substring_false_positive(self):
        ref = "Font /F1 (HelveticaNeue-Bold)"
        assert _font_names_match("Helvetica", ref) is False

    def test_mismatch_returns_false(self):
        assert _font_names_match("Times-Roman", "Font /F1 (Helvetica)") is False


class TestImageRulesMixin:
    def test_progressive_jpeg_marker_detected_in_memory(self):
        """Scanner SOF2 trên stream DCTDecode thuần (không ASCII85)."""
        jpeg = bytes([
            0xFF, 0xD8, 0xFF, 0xC2, 0x00, 0x11,
            0x08, 0x01, 0x00, 0x01, 0x00, 0x01,
            0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
            0xFF, 0xD9,
        ])
        pdf = pikepdf.Pdf.new()
        page = pdf.add_blank_page(page_size=(612, 792))
        img = pikepdf.Stream(pdf, jpeg)
        img["/Type"] = pikepdf.Name("/XObject")
        img["/Subtype"] = pikepdf.Name("/Image")
        img["/Width"] = 256
        img["/Height"] = 256
        img["/BitsPerComponent"] = 8
        img["/ColorSpace"] = pikepdf.Name("/DeviceRGB")
        page["/Resources"] = pikepdf.Dictionary({
            "/XObject": pikepdf.Dictionary({"/ImPJ": pdf.make_indirect(img)}),
        })
        page["/Contents"] = pdf.make_stream(b"q 72 0 0 72 200 400 cm /ImPJ Do Q")
        mixin = ImageRulesMixin()
        pdf._path = "/tmp/progressive_test.pdf"
        issues = mixin._check_progressive_jpeg(pdf)
        pdf.close()
        assert any(i.rule_id == "PROGRESSIVE_JPEG" for i in issues)

    def test_get_page_images_resolves_indirect_dimensions(self):
        """In-memory PDF avoids save/open round-trip altering objects."""
        pdf = pikepdf.Pdf.new()
        page = pdf.add_blank_page(page_size=(612, 792))
        img = pikepdf.Stream(pdf, b"\x00" * 16)
        img["/Type"] = pikepdf.Name("/XObject")
        img["/Subtype"] = pikepdf.Name("/Image")
        img["/Width"] = pdf.make_indirect(1200)
        img["/Height"] = pdf.make_indirect(800)
        img["/BitsPerComponent"] = pdf.make_indirect(8)
        img["/ColorSpace"] = pikepdf.Name("/DeviceRGB")
        page["/Resources"] = pikepdf.Dictionary({
            "/XObject": pikepdf.Dictionary({"/Im1": pdf.make_indirect(img)}),
        })
        mixin = ImageRulesMixin()
        images = mixin._get_page_images(page)
        pdf.close()
        assert len(images) == 1
        assert images[0]["width"] == 1200
        assert images[0]["height"] == 800
        assert images[0]["bpc"] == 8


class TestComputeEffectiveDpi:
    def test_known_dpi(self):
        # 1000px over 72pt (1 inch) → ~1000 DPI
        res = compute_effective_dpi(1000, 1000, 72.0, 72.0)
        assert res is not None
        assert abs(res[2] - 1000.0) < 1.0


# ── Engine integration ───────────────────────────────────────────────────────

class TestPreflightEngine:
    def test_all_rules_registered_and_wired(self):
        engine_src = (Path(__file__).resolve().parents[1] / "app/core/preflight_engine.py").read_text(encoding="utf-8")
        for rule in ALL_RULES:
            assert f'"{rule}"' in engine_src or rule in engine_src

    def test_run_minimal_pdf_no_crash(self, tmp_path):
        pdf_path = _make_blank_pdf(tmp_path / "blank.pdf")
        report = PreflightEngine().run(str(pdf_path), rules=["BLEED_MISSING"])
        assert report.total_pages == 1
        assert isinstance(report.issues, list)

    def test_rgb_colorspace_detected(self, tmp_path):
        pdf_path = _make_rgb_colorspace_pdf(tmp_path / "rgb.pdf")
        report = PreflightEngine().run(str(pdf_path), rules=["COLOR_RGB_DETECTED"])
        rule_ids = {i.rule_id for i in report.issues}
        assert "COLOR_RGB_DETECTED" in rule_ids

    def test_xmp_linked_triggers_image_not_embedded(self):
        pdf = pikepdf.Pdf.new()
        pdf.add_blank_page(page_size=(612, 792))
        xmp_bytes = b'<x:xmpmeta><rdf:RDF><stEvt:action>linked</stEvt:action></rdf:RDF></x:xmpmeta>'
        meta = pikepdf.Stream(pdf, xmp_bytes)
        meta["/Type"] = pikepdf.Name("/Metadata")
        meta["/Subtype"] = pikepdf.Name("/XML")
        pdf.Root["/Metadata"] = pdf.make_indirect(meta)
        issues = ImageRulesMixin()._check_illustrator_hidden_links(pdf)
        pdf.close()
        assert any(i.rule_id == "IMAGE_NOT_EMBEDDED" for i in issues)

    def test_page_size_mismatch_detected(self, tmp_path):
        pdf_path = _make_mismatched_page_sizes_pdf(tmp_path / "sizes.pdf")
        report = PreflightEngine().run(str(pdf_path), rules=["PAGE_SIZE_MISMATCH"])
        assert any(i.rule_id == "PAGE_SIZE_MISMATCH" for i in report.issues)

    def test_font_summary_separates_unique_font_from_page_occurrences(self, tmp_path):
        pdf_path = _make_repeated_unembedded_font_pdf(
            tmp_path / "one-font-many-pages.pdf",
            pages=100,
        )

        report = PreflightEngine().run(str(pdf_path), rules=["FONT_NOT_EMBEDDED"])

        assert report.font_summary["total"] == 100
        assert report.font_summary["not_embedded"] == 100
        assert report.font_summary["unique_total"] == 1
        assert report.font_summary["unique_not_embedded"] == 1
        assert report.font_summary["fonts"] == [{
            "name": "FakeFontQA-Regular",
            "embedded": False,
            "pages": list(range(1, 101)),
            "not_embedded_pages": list(range(1, 101)),
            "occurrences": 100,
        }]
        # Vẫn giữ issue từng trang/bbox để Preflight và Viewer highlight chính xác.
        assert len(report.issues) == 100

    def test_font_family_grouping_does_not_hide_mixed_subset_embedding(self, tmp_path):
        pdf_path = _make_same_family_mixed_embedding_pdf(tmp_path / "mixed-subsets.pdf")

        report = PreflightEngine().run(str(pdf_path), rules=["FONT_NOT_EMBEDDED"])

        assert report.font_summary["total"] == 2
        assert report.font_summary["unique_total"] == 1
        assert report.font_summary["unique_not_embedded"] == 1
        assert report.font_summary["fonts"][0]["not_embedded_pages"] == [1]
        assert len(report.issues) == 1

    def test_page_nums_filters_content_stream_checks(self, tmp_path):
        pdf_path = _make_mismatched_page_sizes_pdf(tmp_path / "chunk.pdf")
        engine = PreflightEngine()
        with pikepdf.open(pdf_path) as doc:
            doc._path = str(pdf_path)
            all_issues = engine._check_objects_off_page(doc, page_nums=None)
            page2_only = engine._check_objects_off_page(doc, page_nums=[2])
        # Filtering should not increase issue count for blank pages
        assert len(page2_only) <= len(all_issues)

    def test_multiprocessing_worker_matches_sequential(self, tmp_path, monkeypatch):
        """Large PDF: worker chunks must not crash and return valid structure."""
        monkeypatch.setattr("app.core.preflight_engine.PreflightEngine.run", PreflightEngine.run)
        pdf_path = _make_blank_pdf(tmp_path / "multi.pdf", pages=15)

        seq_report = PreflightEngine().run(
            str(pdf_path), rules=["BLEED_MISSING", "OBJECT_OFF_PAGE"]
        )
        assert seq_report.total_pages == 15

        # Direct worker smoke test
        issues, stats = _content_stream_worker(
            str(pdf_path), [1, 2, 3], {"OBJECT_OFF_PAGE"}, 300
        )
        assert isinstance(issues, list)
        assert isinstance(stats, dict)
        assert "image_total" in stats

    @pytest.mark.parametrize(
        "rules",
        [
            ["FONT_NOT_EMBEDDED", "TEXT_DETECTED"],
            ["FONT_NOT_EMBEDDED"],
            ["TEXT_DETECTED"],
        ],
    )
    def test_font_only_scan_does_not_spawn_process_pool(self, tmp_path, monkeypatch, rules):
        """Công cụ Chữ & Font không dựng pool chỉ vì PDF có hơn 10 trang."""
        pdf_path = _make_blank_pdf(tmp_path / "font-only.pdf", pages=15)

        def fail_if_pool_created(*_args, **_kwargs):
            raise AssertionError("font-only preflight không được tạo ProcessPool")

        monkeypatch.setattr("concurrent.futures.ProcessPoolExecutor", fail_if_pool_created)
        report = PreflightEngine().run(str(pdf_path), rules=rules)

        assert report.total_pages == 15


@pytest.mark.asyncio
async def test_inspect_route_offloads_engine_run(monkeypatch):
    """Route inspect phải nhường việc PDF đồng bộ cho threadpool."""
    from app.api.routes import preflight as preflight_route
    from app.schemas.preflight import InspectByIdRequest
    from app.core.preflight_models import PreflightReport

    monkeypatch.setattr(
        preflight_route,
        "_get_file_info",
        lambda _file_id: ("font-only.pdf", "font-only.pdf"),
    )
    calls = {}

    class FakeEngine:
        def run(self, pdf_path, **kwargs):
            calls["run"] = (pdf_path, kwargs)
            return PreflightReport(file_name="font-only.pdf", total_pages=1)

    async def fake_run_in_threadpool(func, *args, **kwargs):
        calls["offloaded"] = func
        return func(*args, **kwargs)

    monkeypatch.setattr(preflight_route, "PreflightEngine", FakeEngine)
    monkeypatch.setattr(preflight_route, "run_in_threadpool", fake_run_in_threadpool)

    response = await preflight_route.inspect_pdf(
        InspectByIdRequest(file_id="font-file", rules=["FONT_NOT_EMBEDDED"])
    )

    assert response.total_pages == 1
    assert calls["offloaded"].__name__ == "run"
    assert isinstance(calls["offloaded"].__self__, FakeEngine)
    assert calls["run"] == (
        "font-only.pdf",
        {"rules": ["FONT_NOT_EMBEDDED"], "tac_threshold": 300},
    )


@pytest.mark.asyncio
async def test_inspect_route_keeps_event_loop_responsive(monkeypatch):
    """Quét đồng bộ đang chạy không được làm heartbeat của sidecar đứng."""
    from app.api.routes import preflight as preflight_route
    from app.schemas.preflight import InspectByIdRequest
    from app.core.preflight_models import PreflightReport

    started = threading.Event()
    finished = threading.Event()

    class SlowEngine:
        def run(self, _pdf_path, **_kwargs):
            started.set()
            time.sleep(0.2)
            finished.set()
            return PreflightReport(file_name="slow.pdf", total_pages=1)

    monkeypatch.setattr(
        preflight_route,
        "_get_file_info",
        lambda _file_id: ("slow.pdf", "slow.pdf"),
    )
    monkeypatch.setattr(preflight_route, "PreflightEngine", SlowEngine)

    heartbeat_gaps = []

    async def heartbeat():
        previous = time.perf_counter()
        while not finished.is_set():
            await asyncio.sleep(0.01)
            now = time.perf_counter()
            if started.is_set() and not finished.is_set():
                heartbeat_gaps.append(now - previous)
            previous = now

    heartbeat_task = asyncio.create_task(heartbeat())
    await asyncio.sleep(0)
    await preflight_route.inspect_pdf(InspectByIdRequest(file_id="slow-file"))
    await heartbeat_task

    assert len(heartbeat_gaps) >= 3
    assert max(heartbeat_gaps) < 0.1


@pytest.mark.asyncio
async def test_inspect_route_keeps_large_content_scan_working(monkeypatch, tmp_path):
    """ProcessPool của Preflight tổng quát vẫn chạy được từ threadpool trên Windows."""
    from app.api.routes import preflight as preflight_route
    from app.schemas.preflight import InspectByIdRequest

    pdf_path = _make_blank_pdf(tmp_path / "large-content.pdf", pages=15)
    monkeypatch.setattr(
        preflight_route,
        "_get_file_info",
        lambda _file_id: (str(pdf_path), pdf_path.name),
    )

    response = await preflight_route.inspect_pdf(
        InspectByIdRequest(file_id="large-content", rules=["OBJECT_OFF_PAGE"])
    )

    assert response.total_pages == 15
    assert all(issue.rule_id != "INTERNAL_ERROR" for issue in response.issues)


@pytest.mark.asyncio
async def test_fix_route_disconnect_cancels_action_engine(monkeypatch):
    """Nút Hủy frontend phải chạm tới cooperative cancel của ActionEngine."""
    from app.api.routes import preflight as preflight_route
    from app.schemas.preflight import FixRequest

    monkeypatch.setattr(
        preflight_route,
        "_get_file_info",
        lambda _file_id: ("font-only.pdf", "font-only.pdf"),
    )
    monkeypatch.setattr(preflight_route, "enforce_preflight_actions", lambda *_args: None)
    started = asyncio.Event()
    cancelled = asyncio.Event()

    class SlowActionEngine:
        async def execute(self, *_args, **_kwargs):
            started.set()
            try:
                await asyncio.Future()
            except asyncio.CancelledError:
                cancelled.set()
                raise

    class DisconnectedRequest:
        async def is_disconnected(self):
            await started.wait()
            return True

    monkeypatch.setattr(preflight_route, "ActionEngine", SlowActionEngine)

    with pytest.raises(asyncio.CancelledError):
        await preflight_route.fix_pdf(
            FixRequest(file_id="font-file", action_id="OUTLINE_FONTS", params={}),
            DisconnectedRequest(),
            license_info={},
        )

    assert cancelled.is_set()


# ── Coverage parity (backend ALL_RULES vs frontend TS sources) ───────────────

PROJECT_ROOT = Path(__file__).resolve().parents[2]
FRONTEND_RULE_SOURCES = [
    PROJECT_ROOT / "desktop/src/components/preprocess-tools/PreflightTool.tsx",
]


@pytest.mark.parametrize("source", FRONTEND_RULE_SOURCES)
def test_frontend_exposes_all_backend_rules(source):
    text = source.read_text(encoding="utf-8")
    found = set(re.findall(r"id: '([A-Z_]+)'", text))
    # Exclude fix actions (not inspect rules)
    fix_actions = {
        "CONVERT_TO_CMYK", "FLATTEN_TRANSPARENCY", "OUTLINE_FONTS",
        "EMBED_FONTS", "DOWNSCALE_IMAGES", "FIX_METADATA",
    }
    inspect_ids = found - fix_actions
    missing = set(ALL_RULES) - inspect_ids
    assert not missing, f"{source}: missing rules {missing}"


def test_all_rule_methods_support_page_nums():
    """Every _check_* method that iterates pages must accept page_nums."""
    rules_dir = Path(__file__).resolve().parents[1] / "app/core/preflight_rules"
    page_iter_methods = []
    for py_file in rules_dir.glob("*.py"):
        text = py_file.read_text(encoding="utf-8")
        for m in re.finditer(r"def (_check_\w+)\(([^)]*)\)", text):
            name, params = m.group(1), m.group(2)
            if name == "_check_pdf_version":
                continue  # file-level rule
            if "_check_illustrator_hidden_links" in name:
                continue  # file-level XMP
            page_iter_methods.append((py_file.name, name, "page_nums" in params))

    failures = [(f, n) for f, n, ok in page_iter_methods if not ok]
    assert not failures, f"Missing page_nums: {failures}"
