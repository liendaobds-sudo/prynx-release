#!/usr/bin/env bash
# Preflight QA — một lệnh (Linux / macOS / GitHub Actions)
set -euo pipefail
cd "$(dirname "$0")/.."

PYTHON="${PYTHON:-python3}"
if [[ -x "./venv/bin/python" ]]; then
  PYTHON="./venv/bin/python"
fi

echo "==> [1/2] Generate fixture PDFs..."
"$PYTHON" tests/preflight_fixtures/generate_fixtures.py

echo "==> [2/2] Run Preflight pytest..."
"$PYTHON" -m pytest \
  tests/preflight_golden \
  tests/test_preflight_engine.py \
  tests/test_image_dpi_props.py \
  tests/test_placed_size_props.py \
  tests/test_tac_threshold_props.py \
  tests/test_tac_props.py \
  tests/test_tac_bbox_props.py \
  -v --tb=short

echo ""
echo "Preflight QA: PASSED"