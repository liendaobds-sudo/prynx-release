"""Unit tests for B1/B2 encrypt/decrypt — isolated from merge/split/optimize."""
from __future__ import annotations

import os
import tempfile

import pikepdf
import pytest

from app.workers.pdf_tools_engine import (
    decrypt_pdf,
    encrypt_pdf,
    pdf_is_encrypted,
    save_pdf_compat,
)


def _blank_pdf(path: str, pages: int = 1) -> None:
    pdf = pikepdf.Pdf.new()
    for _ in range(pages):
        pdf.add_blank_page(page_size=(200, 300))
    save_pdf_compat(pdf, path)


@pytest.fixture()
def plain_pdf(tmp_path):
    path = str(tmp_path / "plain.pdf")
    _blank_pdf(path, pages=2)
    return path


def test_encrypt_sets_encrypted_flag(plain_pdf, tmp_path):
    out = str(tmp_path / "locked.pdf")
    encrypt_pdf(plain_pdf, out, user_password="u1", owner_password="o1")
    assert pdf_is_encrypted(out) is True
    assert pdf_is_encrypted(plain_pdf) is False


def test_decrypt_roundtrip(plain_pdf, tmp_path):
    locked = str(tmp_path / "locked.pdf")
    unlocked = str(tmp_path / "unlocked.pdf")
    encrypt_pdf(
        plain_pdf,
        locked,
        user_password="secret",
        owner_password="owner",
        allow_print=False,
        allow_copy=False,
    )
    with pytest.raises(ValueError):
        decrypt_pdf(locked, unlocked, password="wrong")
    decrypt_pdf(locked, unlocked, password="secret")
    assert pdf_is_encrypted(unlocked) is False
    with pikepdf.Pdf.open(unlocked) as pdf:
        assert len(pdf.pages) == 2


def test_encrypt_requires_password(plain_pdf, tmp_path):
    out = str(tmp_path / "x.pdf")
    with pytest.raises(ValueError):
        encrypt_pdf(plain_pdf, out, user_password="", owner_password="")


def test_decrypt_plain_still_writes(plain_pdf, tmp_path):
    out = str(tmp_path / "copy.pdf")
    decrypt_pdf(plain_pdf, out, password="")
    assert os.path.isfile(out)
    assert pdf_is_encrypted(out) is False


def _pdf_with_outline(path: str) -> None:
    """Blank PDF + 1 outline entry (bookmark) for structure-preservation checks."""
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(200, 300))
    pdf.add_blank_page(page_size=(200, 300))
    with pdf.open_outline() as ol:
        ol.root.append(pikepdf.OutlineItem("Chapter 1", 0))
    save_pdf_compat(pdf, path)


def test_encrypt_decrypt_preserves_outlines(tmp_path):
    """A1 fix: in-place save must keep /Outlines (not Pdf.new+pages.extend)."""
    plain = str(tmp_path / "outlined.pdf")
    locked = str(tmp_path / "locked.pdf")
    unlocked = str(tmp_path / "unlocked.pdf")
    _pdf_with_outline(plain)

    with pikepdf.Pdf.open(plain) as p:
        assert "/Outlines" in p.Root

    encrypt_pdf(plain, locked, user_password="secret", owner_password="owner")
    with pikepdf.Pdf.open(locked, password="secret") as p:
        assert p.is_encrypted
        assert "/Outlines" in p.Root
        assert len(p.pages) == 2

    decrypt_pdf(locked, unlocked, password="secret")
    with pikepdf.Pdf.open(unlocked) as p:
        assert not p.is_encrypted
        assert "/Outlines" in p.Root
        assert len(p.pages) == 2
