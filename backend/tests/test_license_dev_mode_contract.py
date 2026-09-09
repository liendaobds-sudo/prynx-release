"""Launcher kiểm license không giả lập quyền và không sửa credential thật."""
from pathlib import Path


def test_license_test_mode_enforces_both_layers_before_launch():
    source = (Path(__file__).parents[2] / "run_dev.bat").read_text(encoding="utf-8")
    marker = source.index(':: SEC (audit 2026-09-09 LICUX.TEST)')
    launch = source.index('start "PDF Inspector - Backend"')
    block = source[marker:launch]
    assert 'if /I "%PRYNX_LICENSE_TEST_MODE%"=="true" (' in block
    for flag in ['PRYNX_ENFORCE_LICENSE_TOKEN=true', 'PRYNX_ENFORCE_CLOCK_ANCHOR=true', 'DEV_MODE=false']:
        assert f'set "{flag}"' in block
    assert 'if /I "%~1"=="--license-test"' in source
    assert 'if /I "%~2"=="--license-test"' in source
    assert 'if /I "%PRYNX_LICENSE_TEST_MODE%"=="true" set "PRYNX_DEV_GATED_MODE=true"' in source
    assert 'set "PRYNX_ENFORCE_LICENSE_TOKEN=false"' in source
    assert 'set "PRYNX_ENFORCE_CLOCK_ANCHOR=false"' in source
    assert 'set "VITE_FEATURE_GATING_ENABLED=true"' in source[:marker]
    assert 'set "PRYNX_FEATURE_GATING_ENABLED=true"' in source[:marker]
    assert 'KEY THU' in block
