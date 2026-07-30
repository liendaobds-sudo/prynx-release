r"""Kiểm tra native pdfcompare_native đã có symbol ppe_export_cmyk chưa.

Chạy từ thư mục backend:  venv\Scripts\python scripts\check_cmyk_native.py
"""
import os
import sys

# Thêm thư mục backend/ vào path để import được package app
_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from app.core.print_engine.facade import _native

native = _native()
has = hasattr(native, "ppe_export_cmyk")
print("ppe_export_cmyk co san:", has)
if not has:
    print(">>> Can rebuild native: maturin develop --release --manifest-path native/Cargo.toml")
