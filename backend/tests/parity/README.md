# Parity tests — Rust ↔ Python

Đối chiếu hai bản triển khai cùng phép toán layout: Rust (`pdfcompare_native`) và Python fallback (`_py_*`).
Thuộc spec `.kiro/specs/imposition-engine-unification` (Task 2, Requirements 8.3/8.4).

## Files
- `test_parity_rust_python.py` — suite chính (pytest). Tự **skip** nếu chưa cài `pdfcompare_native`.
- `run_parity.py` — runner 2 chế độ: Rust ON và ép Python (`IMPOSITION_ALLOW_PY_FALLBACK`).
- `legacy/` — script parity gốc giữ để tham chiếu (không được pytest thu thập).

## Chạy
```
cd backend
python -m pytest tests/parity -q          # chỉ parity
python tests/parity/run_parity.py         # 2 chế độ (golden + parity)
```

## Ghi chú
- Khi môi trường chưa có Rust, parity skip còn golden khóa theo nhánh Python.
- Khi có Rust, parity bảo đảm Rust khớp Python; golden bảo đảm cả hai khớp mốc.
- Cờ `IMPOSITION_ALLOW_PY_FALLBACK` được nối đầy đủ ở Task 14.
