"""
DEPRECATED - Legacy pdfcpu imposition engine.

This module has been removed as part of Imposition Engine Unification (Phase 1).
All imposition logic now routes through imposition_core (Rust) + pikepdf.

Any code still importing this will fail loudly to prevent silent use of old paths.
"""

import warnings

class ImpositionError(Exception):
    """Deprecated error type. Use the modern imposition routes instead."""
    pass

class ImpositionEngine:
    """
    DEPRECATED.
    This class is a stub that always raises to enforce removal of legacy pdfcpu usage.
    See PR Plan: prynx-imposition-unification-v1 - Phase 1 (P1-T01).
    """

    def __init__(self, *args, **kwargs):
        self._raise_deprecated()

    @staticmethod
    def get_binary_path() -> str:
        ImpositionEngine._raise_deprecated()

    @classmethod
    async def validate_pdf(cls, input_pdf: str) -> bool:
        ImpositionEngine._raise_deprecated()

    @classmethod
    async def process_booklet(cls, *args, **kwargs) -> bool:
        ImpositionEngine._raise_deprecated()

    @classmethod
    async def process_nup(cls, *args, **kwargs) -> bool:
        ImpositionEngine._raise_deprecated()

    @staticmethod
    def _raise_deprecated():
        warnings.warn(
            "ImpositionEngine (pdfcpu) is DEPRECATED and has been removed. "
            "Use the modern unified imposition endpoints (/impose-start, /nup-start, etc.) "
            "which go through imposition_core (Rust) + pikepdf. "
            "See docs or PR Plan for migration.",
            DeprecationWarning,
            stacklevel=2
        )
        raise RuntimeError(
            "Legacy pdfcpu imposition path has been removed (Phase 1 of unification). "
            "Please migrate to the Rust-based imposition engine."
        )
