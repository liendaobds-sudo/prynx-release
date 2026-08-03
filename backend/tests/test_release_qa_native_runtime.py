"""Hợp đồng chống hồi quy cho môi trường QA Rust/PyO3."""

from pathlib import Path


REPO = Path(__file__).resolve().parents[2]
RELEASE_QA = REPO / "scripts" / "run_release_qa.ps1"


def test_native_gate_invalidates_stale_pyo3_python_linkage():
    """Gate native phải dựng lại khi đổi phiên bản Python phụ."""
    source = RELEASE_QA.read_text(encoding="utf-8")

    capture = source.index(
        "$previousPyo3EnvironmentSignature = $env:PYO3_ENVIRONMENT_SIGNATURE"
    )
    pin = source.index(
        '$env:PYO3_ENVIRONMENT_SIGNATURE = $PYTHON + "|" + $nativePythonVersion'
    )
    native_test = source.index('Invoke-Checked "Native PDF tests"')
    restore = source.index(
        "$env:PYO3_ENVIRONMENT_SIGNATURE = $previousPyo3EnvironmentSignature"
    )

    assert capture < pin < native_test < restore
    assert "Remove-Item Env:PYO3_ENVIRONMENT_SIGNATURE" in source
    assert "sys.version_info[:3]" in source
