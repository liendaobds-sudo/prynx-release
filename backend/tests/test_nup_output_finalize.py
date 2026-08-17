"""Test tập trung cho đường render/hoàn tất đã tách khỏi ``nup_engine``."""

from __future__ import annotations

from pathlib import Path

import pytest

from app.workers.nup_output_finalize import NupOutputContext, finalize_nup_output


class _PerfStages:
    def __init__(self) -> None:
        self.names: list[str] = []

    def mark(self, name: str) -> None:
        self.names.append(name)


def _context(tmp_path: Path, **overrides) -> NupOutputContext:
    values = {
        "args_list": [("chunk",)],
        "planned_worker_count": 1,
        "output_path": str(tmp_path / "output.pdf"),
        "prog_file": str(tmp_path / "progress.txt"),
        "perf_stages": _PerfStages(),
        "is_die_cut": False,
        "page_sheet_mode": False,
        "homogeneous_master_idx": None,
        "single_mold_master_idx": None,
        "layout_type": "repeat",
        "settings": {"reportDisplay": {"enabled": False}},
        "reports_by_sheet": {},
        "report_rows": [],
        "total_sheets": 1,
        "page_count": 1,
        "capacity": 1,
        "precalculated_placements": None,
        "page_sheet_report_fields": lambda _identifier="": {},
        "progress_callback": None,
        "ratio_stack_template_count": 1,
        "ratio_stack_export_unique": True,
        "ratio_stack_duplex": False,
        "ratio_stack_warnings": [],
        "layout": {},
        "strategy": "manual",
        "total_capacity": 1,
    }
    values.update(overrides)
    return NupOutputContext(**values)


def test_single_chunk_cleanup_progress_perf_va_ratio_message(tmp_path):
    chunk = tmp_path / "chunk.pdf"
    chunk.write_bytes(b"pdf-chunk-placeholder")
    callbacks = []
    perf = _PerfStages()
    context = _context(
        tmp_path,
        perf_stages=perf,
        page_count=7,
        layout_type="ratio_stack",
        report_rows=[
            {
                "label": "Mẫu A",
                "items_per_sheet": 4,
                "requested_qty": 20,
                "sheet_count": 2,
            },
            {
                "label": "Mẫu B",
                "items_per_sheet": 2,
                "requested_qty": 30,
                "sheet_count": 3,
            },
        ],
        ratio_stack_template_count=3,
        ratio_stack_duplex=True,
        ratio_stack_warnings=["⚠ Cảnh báo kiểm thử"],
        progress_callback=lambda *args: callbacks.append(args),
    )

    message = finalize_nup_output(
        context,
        chunk_processor=lambda _args: str(chunk),
    )

    assert Path(context.output_path).read_bytes() == b"pdf-chunk-placeholder"
    assert not chunk.exists()
    assert Path(context.prog_file).read_text(encoding="utf-8") == "7/7"
    assert perf.names == [
        "plan_s",
        "render_chunks_s",
        "merge_save_s",
        "postprocess_s",
    ]
    assert callbacks == [(7, 7, "Hoàn tất")]
    assert "File gồm 3 CẶP tờ mẫu" in message
    assert "tổng 5 lượt duplex" in message
    assert "⚠ Cảnh báo kiểm thử" in message


@pytest.mark.parametrize("is_die_cut", [True, False], ids=["pikepdf", "pdfium"])
def test_multi_chunk_dung_executor_va_ghep_pikepdf_pdfium(
    tmp_path, is_die_cut
):
    pikepdf = pytest.importorskip("pikepdf")
    chunk_paths = []
    for index in range(2):
        path = tmp_path / f"chunk-{index}.pdf"
        pdf = pikepdf.Pdf.new()
        pdf.add_blank_page(page_size=(100, 100))
        pdf.save(path)
        pdf.close()
        chunk_paths.append(path)

    calls = {}

    class _Executor:
        def __init__(self, max_workers):
            calls["workers"] = max_workers

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def map(self, processor, args_list):
            calls["args"] = list(args_list)
            return [processor(args) for args in calls["args"]]

    context = _context(
        tmp_path,
        args_list=[(0,), (1,)],
        planned_worker_count=8,
        is_die_cut=is_die_cut,
        total_sheets=2,
        page_count=2,
    )
    message = finalize_nup_output(
        context,
        chunk_processor=lambda args: str(chunk_paths[args[0]]),
        executor_factory=_Executor,
    )

    assert calls == {"workers": 2, "args": [(0,), (1,)]}
    assert all(not path.exists() for path in chunk_paths)
    with pikepdf.Pdf.open(context.output_path) as output:
        assert len(output.pages) == 2
    assert message.startswith("✅ Hoàn tất!")


def test_render_inline_loi_thi_don_chunk_da_tao(tmp_path):
    first_chunk = tmp_path / "first.pdf"
    first_chunk.write_bytes(b"partial")
    context = _context(
        tmp_path,
        args_list=[(0,), (1,)],
        planned_worker_count=1,
    )

    def _processor(args):
        if args == (0,):
            return str(first_chunk)
        raise RuntimeError("chunk thứ hai lỗi")

    with pytest.raises(RuntimeError, match="chunk thứ hai lỗi"):
        finalize_nup_output(context, chunk_processor=_processor)

    assert not first_chunk.exists()
    assert context.perf_stages.names == ["plan_s"]


def test_xuat_pdf_loai_metadata_link_ngoai_cua_illustrator(tmp_path):
    """PDF mang PieceInfo/OPI/GoToR không được đòi lại file nup khi đổi máy."""
    pikepdf = pytest.importorskip("pikepdf")
    chunk = tmp_path / "chunk-with-link.pdf"
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(100, 100))
    page.obj["/PieceInfo"] = pikepdf.Dictionary({
        "/Illustrator": pikepdf.Dictionary({
            "/Private": pikepdf.Dictionary({
                "/AIPDFPrivateData1": pdf.make_stream(b"nup_b4f634ce.pdf"),
            }),
        }),
    })
    page.obj["/Resources"] = pikepdf.Dictionary({
        "/XObject": pikepdf.Dictionary({
            "/Im0": pikepdf.Stream(
                pdf,
                b"",
                Type=pikepdf.Name("/XObject"),
                Subtype=pikepdf.Name("/Image"),
                OPI=pikepdf.Dictionary({"/F": "nup_b4f634ce.pdf"}),
            ),
        }),
    })
    page.obj["/Annots"] = pikepdf.Array([
        pikepdf.Dictionary({
            "/Type": pikepdf.Name("/Annot"),
            "/Subtype": pikepdf.Name("/Link"),
            "/A": pikepdf.Dictionary({
                "/S": pikepdf.Name("/GoToR"),
                "/F": "nup_b4f634ce.pdf",
            }),
        }),
    ])
    pdf.save(chunk)
    pdf.close()

    context = _context(tmp_path, is_die_cut=True)
    finalize_nup_output(context, chunk_processor=lambda _args: str(chunk))

    with pikepdf.Pdf.open(context.output_path) as output:
        for obj in output.objects:
            if isinstance(obj, pikepdf.Dictionary):
                assert "/PieceInfo" not in obj
                assert "/OPI" not in obj
        assert "/OPI" not in output.pages[0].obj["/Resources"]["/XObject"]["/Im0"]
        assert all(
            not (
                isinstance(annot, pikepdf.Dictionary)
                and isinstance(annot.get("/A"), pikepdf.Dictionary)
                and str(annot["/A"].get("/S", "")) in ("/GoToR", "/Launch")
            )
            for page in output.pages
            for annot in (page.obj.get("/Annots") or [])
        )
