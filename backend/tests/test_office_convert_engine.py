"""Unit tests for office/google → PDF helpers (no real Office required)."""
from __future__ import annotations

import pytest

from app.workers.office_convert_engine import (
    OFFICE_EXTENSIONS,
    google_export_pdf_url,
    parse_google_url,
    probe_converters,
)


def test_parse_google_docs():
    kind, fid = parse_google_url(
        "https://docs.google.com/document/d/1AbC_xYz-99/edit?usp=sharing"
    )
    assert kind == "document"
    assert fid == "1AbC_xYz-99"


def test_parse_google_sheets():
    kind, fid = parse_google_url(
        "https://docs.google.com/spreadsheets/d/SheetId99/edit#gid=0"
    )
    assert kind == "spreadsheets"
    assert fid == "SheetId99"


def test_parse_google_slides():
    kind, fid = parse_google_url(
        "https://docs.google.com/presentation/d/Pres99/edit"
    )
    assert kind == "presentation"
    assert fid == "Pres99"


def test_parse_invalid():
    with pytest.raises(ValueError):
        parse_google_url("https://example.com/not-google")


def test_export_urls():
    assert "export?format=pdf" in google_export_pdf_url("document", "x")
    assert "spreadsheets" in google_export_pdf_url("spreadsheets", "x")
    assert "export/pdf" in google_export_pdf_url("presentation", "x")


def test_probe_shape():
    p = probe_converters()
    assert "can_convert_office" in p
    assert p.get("google_export") is True
    assert ".docx" in OFFICE_EXTENSIONS
