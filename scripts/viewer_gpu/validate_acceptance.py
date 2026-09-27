"""Cổng nghiệm thu runtime; microbenchmark và unit model không phải bằng chứng G0–G4.

PERF (audit 2026-09-25 §R25.GPU.10). Không có evidence => chưa đạt, không điền 0.
Đầu vào runtime-evidence.json phải do harness Tauri/PDF tạo, kèm artifact đã băm.
Validator kiểm hợp đồng/số đo; không tự tạo hoặc chứng thực số đo còn thiếu.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def quantile(values, q):
    values = sorted(values)
    pos = (len(values) - 1) * q
    lo = int(pos)
    return values[lo] + (values[min(lo + 1, len(values) - 1)] - values[lo]) * (pos - lo)


def evaluate(run_dir: Path, criteria=None, fixture_hash=None):
    criteria = criteria or json.loads((ROOT / 'tests/viewer_gpu/acceptance-v1.json').read_text(encoding='utf-8-sig'))
    if fixture_hash is None:
        fixtures = json.loads((ROOT / 'tests/viewer_gpu/fixtures.json').read_text(encoding='utf-8-sig'))
        fixture_hash = next(f['expected_sha256'] for f in fixtures['fixtures'] if f['id'] == 'R01')
    failures = []
    evaluated = {}
    path = run_dir / 'runtime-evidence.json'
    if not path.is_file():
        return {'verdict': False, 'status': 'UNOBSERVED', 'failures': ['Thiếu runtime-evidence.json của Tauri/PDF thật'], 'criteria': {}}
    try:
        evidence = json.loads(path.read_text(encoding='utf-8-sig'))
        if evidence.get('evidence_kind') != 'tauri_native_pdf' or evidence.get('host') != 'Tauri/WebView2':
            failures.append('Không phải evidence từ native PDF trong Tauri/WebView2')
        provenance = evidence.get('provenance', {})
        for key in ('binary_sha256', 'source_manifest_sha256', 'pdf_sha256', 'profile_sha256'):
            value = provenance.get(key, '')
            if not isinstance(value, str) or len(value) != 64 or any(c not in '0123456789abcdef' for c in value):
                failures.append(f'Provenance thiếu/sai {key}')
        if provenance.get('pdf_sha256') != fixture_hash or provenance.get('page_number') != 1:
            failures.append('Không phải R01 trang 1 đã khóa hash')
        artifacts = evidence.get('artifacts', {})
        # Các artifact đo thực tế phải có nội dung và khớp digest; không chỉ một status string.
        for name in ('native_trace', 'rendered_image', 'acrobat_reference', 'color_comparison', 'soak_trace', 'source_manifest'):
            item = artifacts.get(name, {})
            rel = item.get('path', '')
            target = (run_dir / rel).resolve()
            if not rel or not target.is_relative_to(run_dir.resolve()) or not target.is_file():
                failures.append(f'Thiếu artifact {name}')
                continue
            data = target.read_bytes()
            if not data or hashlib.sha256(data).hexdigest() != item.get('sha256'):
                failures.append(f'Artifact sai hash/rỗng: {name}')
        observations = evidence.get('criteria', {})
        for key, spec in criteria['criteria'].items():
            obs = observations.get(key, {})
            values = obs.get('samples', [])
            if obs.get('status') != 'observed' or obs.get('unit') != spec['unit'] or not values or any(type(v) not in (int, float) or not math.isfinite(v) or v < 0 for v in values):
                evaluated[key] = {'status': 'UNOBSERVED'}
                failures.append(f'{key}: thiếu mẫu đo hợp lệ')
                continue
            metric = spec['metric']
            value = quantile(values, .95) if metric == 'p95_ms' else (min(values) if spec['operator'] == '>=' else max(values))
            passed = {'<=': value <= spec['threshold'], '>=': value >= spec['threshold'], '==': value == spec['threshold']}[spec['operator']]
            if key == 'P06':
                passed = passed and obs.get('covered_area_fraction', 0) >= .95 and obs.get('final_density_ratio', 0) >= spec['final_density_threshold']
            if key == 'P07':
                passed = passed and all(type(obs.get(k)) is int and obs[k] == 0 for k in ('white_seams', 'wrong_revision', 'engine_switches', 'color_switches'))
            if key == 'P08':
                passed = passed and obs.get('baseline_same_hardware_profile') is True
            if key == 'P09':
                passed = passed and obs.get('median_overhead_percentage', math.inf) <= spec['threshold']
            evaluated[key] = {'status': 'PASSED' if passed else 'FAILED', 'value': value, 'sample_count': len(values)}
            if not passed:
                failures.append(f'{key}: chưa đạt ngưỡng')
        checks = evidence.get('runtime_checks', {})
        for key in ('embedding', 'popup_airspace', 'focus_ime', 'multiwindow_ownership', 'dpi_monitor_change', 'device_loss_recovery', 'zero_full_frame_gpu_readback', 'overprint_opm1', 'spot_separation'):
            if checks.get(key) is not True:
                failures.append(f'Chưa chứng minh runtime check {key}')
        color = evidence.get('color_comparison', {})
        for key in ('delta_e00_p95', 'delta_e00_max', 'edge_displacement_max_px'):
            value = color.get(key)
            if type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value <= criteria['color_and_geometry'][key]:
                failures.append(f'Chưa đạt đối chiếu màu/hình học {key}')
        soak = evidence.get('soak', {})
        if soak.get('duration_seconds', 0) < 1800 or soak.get('handle_growth') != 0 or soak.get('sustained_vram_growth_bytes') != 0:
            failures.append('Chưa có soak 30 phút đo HWND/VRAM ổn định')
    except (ValueError, TypeError, AttributeError, KeyError, OSError) as error:
        failures.append(f'Evidence không hợp lệ: {error}')
    return {'verdict': not failures, 'status': 'PASSED' if not failures else 'FAILED', 'failures': failures, 'criteria': evaluated}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('run_dir', type=Path)
    args = parser.parse_args()
    result = evaluate(args.run_dir)
    args.run_dir.mkdir(parents=True, exist_ok=True)
    (args.run_dir / 'runtime-acceptance.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(result, ensure_ascii=True, indent=2))
    raise SystemExit(0 if result['verdict'] else 50)
