"""Unit tests for B6 metadata read/write — isolated from optimize strip."""
from __future__ import annotations

import pikepdf
import pytest

from app.workers.pdf_tools_engine import (
    read_pdf_metadata,
    save_pdf_compat,
    write_pdf_metadata,
)


def _blank_with_meta(path: str, **meta) -> None:
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(200, 300))
    for k, v in meta.items():
        pdf.docinfo[pikepdf.Name(f"/{k}")] = str(v)
    save_pdf_compat(pdf, path)


def test_read_write_roundtrip(tmp_path):
    plain = str(tmp_path / "a.pdf")
    _blank_with_meta(plain, Title="Hello", Author="PrynX")
    meta = read_pdf_metadata(plain)
    assert meta["Title"] == "Hello"
    assert meta["Author"] == "PrynX"

    out = str(tmp_path / "b.pdf")
    write_pdf_metadata(
        plain,
        out,
        fields={"Title": "Updated", "Author": "Team", "Subject": "Test", "Keywords": "", "Creator": "", "Producer": ""},
    )
    m2 = read_pdf_metadata(out)
    assert m2["Title"] == "Updated"
    assert m2["Author"] == "Team"
    assert m2["Subject"] == "Test"


def test_clear_all(tmp_path):
    plain = str(tmp_path / "a.pdf")
    _blank_with_meta(plain, Title="X", Author="Y")
    out = str(tmp_path / "cleared.pdf")
    write_pdf_metadata(plain, out, clear_all=True)
    m = read_pdf_metadata(out)
    assert m["Title"] == ""
    assert m["Author"] == ""


def test_page_count_preserved(tmp_path):
    plain = str(tmp_path / "multi.pdf")
    pdf = pikepdf.Pdf.new()
    for _ in range(3):
        pdf.add_blank_page(page_size=(100, 100))
    pdf.docinfo[pikepdf.Name("/Title")] = "T"
    save_pdf_compat(pdf, plain)
    out = str(tmp_path / "out.pdf")
    write_pdf_metadata(plain, out, fields={"Title": "T2", "Author": "", "Subject": "", "Keywords": "", "Creator": "", "Producer": ""})
    with pikepdf.Pdf.open(out) as p:
        assert len(p.pages) == 3


def test_metadata_write_preserves_outlines(tmp_path):
    """A1 fix: metadata edit must keep /Outlines (in-place, not page clone)."""
    plain = str(tmp_path / "outlined.pdf")
    out = str(tmp_path / "meta.pdf")
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(200, 200))
    pdf.docinfo[pikepdf.Name("/Title")] = "Old"
    with pdf.open_outline() as ol:
        ol.root.append(pikepdf.OutlineItem("Bookmark", 0))
    save_pdf_compat(pdf, plain)

    write_pdf_metadata(
        plain,
        out,
        fields={
            "Title": "NewTitle",
            "Author": "A",
            "Subject": "",
            "Keywords": "",
            "Creator": "",
            "Producer": "",
        },
    )
    with pikepdf.Pdf.open(out) as p:
        assert "/Outlines" in p.Root
        assert str(p.docinfo.get("/Title", "")) == "NewTitle"
        assert len(p.pages) == 1
