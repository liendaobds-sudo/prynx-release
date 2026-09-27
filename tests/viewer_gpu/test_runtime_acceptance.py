"""Test validator bằng evidence tổng hợp; không phải phép nghiệm thu renderer."""
import importlib.util
import json
from pathlib import Path
import pytest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('runtime_acceptance', ROOT / 'scripts/viewer_gpu/validate_acceptance.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def test_missing_evidence_does_not_pass(tmp_path):
    result = module.evaluate(tmp_path)
    assert result['verdict'] is False
    assert result['status'] == 'UNOBSERVED'


@pytest.mark.parametrize('kind', ['synthetic_graph', 'python_model', 'win32_spike'])
def test_probe_cannot_replace_runtime(tmp_path, kind):
    (tmp_path / 'runtime-evidence.json').write_text(json.dumps({'evidence_kind': kind, 'verdict': True, 'milestone_g4_status': 'PASSED'}))
    result = module.evaluate(tmp_path)
    assert result['verdict'] is False
    assert any('Tauri' in f for f in result['failures'])


@pytest.mark.parametrize('samples', [[], [float('nan')], [float('inf')], [-1], [False]])
def test_invalid_samples_are_unobserved(tmp_path, samples):
    evidence = {'evidence_kind': 'tauri_native_pdf', 'host': 'Tauri/WebView2', 'criteria': {'P01': {'status': 'observed', 'samples': samples, 'unit': 'ms'}}}
    (tmp_path / 'runtime-evidence.json').write_text(json.dumps(evidence))
    result = module.evaluate(tmp_path)
    assert not result['verdict']
    assert result['criteria']['P01']['status'] == 'UNOBSERVED'


def test_fast_synthetic_number_does_not_pass_other_gates(tmp_path):
    evidence = {'criteria': {'P01': {'status': 'observed', 'samples': [1.6], 'unit': 'ms'}}}
    (tmp_path / 'runtime-evidence.json').write_text(json.dumps(evidence))
    result = module.evaluate(tmp_path)
    assert result['criteria']['P01']['status'] == 'PASSED'
    assert result['criteria']['P02']['status'] == 'UNOBSERVED'
    assert not result['verdict']


def test_artifact_path_escape_rejected(tmp_path):
    (tmp_path / 'runtime-evidence.json').write_text(json.dumps({'artifacts': {'native_trace': {'path': '../outside.json', 'sha256': '0' * 64}}}))
    assert any('native_trace' in f for f in module.evaluate(tmp_path)['failures'])
