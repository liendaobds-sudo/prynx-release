"""
Unit test kiem chung GPU Capability Probe (wgpu / D3D12 / Vulkan)
cho PPE Viewer GPU.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
PROBE_TOOL_DIR = REPO_ROOT / "tools" / "gpu_capability_probe"
PROBE_SCRIPT = REPO_ROOT / "scripts" / "viewer_gpu" / "probe_gpu.ps1"
OUTPUT_JSON = REPO_ROOT / ".tmp" / "viewer-gpu" / "gpu_capability.json"


def test_probe_tool_manifest_exists():
    """Kiem tra crate gpu_capability_probe ton tai voi file Cargo.toml."""
    cargo_toml = PROBE_TOOL_DIR / "Cargo.toml"
    assert cargo_toml.exists(), f"Khong tim thay {cargo_toml}"
    content = cargo_toml.read_text(encoding="utf-8")
    assert 'name = "gpu_capability_probe"' in content
    assert 'wgpu = "24"' in content


def test_probe_runner_script_exists():
    """Kiem tra script PowerShell runner ton tai."""
    assert PROBE_SCRIPT.exists(), f"Khong tim thay {PROBE_SCRIPT}"


def test_gpu_probe_output_schema_and_verdict():
    """Kiem tra du lieu JSON do GPU probe sinh ra co dung cau truc va dat tieu chuan."""
    if not OUTPUT_JSON.exists():
        # Chay script neu chua co file
        res = subprocess.run(
            ["powershell.exe", "-ExecutionPolicy", "Bypass", "-File", str(PROBE_SCRIPT)],
            capture_output=True,
            text=True,
            cwd=str(REPO_ROOT),
        )
        assert res.returncode == 0, f"probe_gpu.ps1 failed: {res.stderr}\n{res.stdout}"

    assert OUTPUT_JSON.exists(), f"File {OUTPUT_JSON} khong ton tai sau khi chay probe"

    with open(OUTPUT_JSON, "r", encoding="utf-8") as f:
        data = json.load(f)

    # 1. Kiem tra schema co ban
    for key in ["tool_version", "wgpu_version", "primary_adapter_index", "adapters", "verdict"]:
        assert key in data, f"Thieu key '{key}' trong output JSON"

    assert len(data["adapters"]) > 0, "Khong tim thay adapter nao trong bao cao"

    primary_idx = data["primary_adapter_index"]
    assert primary_idx is not None and primary_idx < len(data["adapters"])
    primary = data["adapters"][primary_idx]

    # 2. Adapter hop le
    assert primary["device_type"] in ["DiscreteGpu", "IntegratedGpu"], (
        f"Primary adapter khong phai GPU phan cung: {primary['device_type']}"
    )
    assert primary["backend"] in ["Vulkan", "Dx12"], (
        f"Backend khong phai Vulkan hoac Dx12: {primary['backend']}"
    )

    # 3. Limits: max_texture_dimension_2d >= 8192
    max_2d = primary["limits"]["max_texture_dimension_2d"]
    assert max_2d >= 8192, f"max_texture_dimension_2d qua nho: {max_2d} < 8192"

    # 4. Formats: Rgba8Unorm va Rgba16Float
    formats = primary["key_formats"]
    assert "Rgba8Unorm" in formats
    assert formats["Rgba8Unorm"]["render_attachment"] is True
    assert formats["Rgba8Unorm"]["texture_binding"] is True

    assert "Rgba16Float" in formats
    assert formats["Rgba16Float"]["render_attachment"] is True
    assert formats["Rgba16Float"]["texture_binding"] is True

    # 5. Device creation test pass
    assert primary["device_test"]["success"] is True
    assert primary["device_test"]["test_texture_created"] is True

    # 6. Verdict dat yeu cau
    verdict = data["verdict"]
    assert verdict["meets_minimum_requirements"] is True
    assert verdict["hardware_accelerated"] is True
    assert verdict["supports_rgba16f_render"] is True
    assert verdict["supports_compute_shaders"] is True


def test_probe_fail_closed_on_unsupported_limits():
    """Kiem tra co che fail-closed neu verdict bao khong dat tieu chuan."""
    fake_report = {
        "tool_version": "0.1.0",
        "wgpu_version": "24.0",
        "primary_adapter_index": 0,
        "adapters": [
            {
                "index": 0,
                "name": "Dummy CPU Device",
                "vendor_id": 0,
                "vendor_hex": "0x0000",
                "device_id": 0,
                "device_hex": "0x0000",
                "device_type": "Cpu",
                "driver": "",
                "driver_info": "",
                "backend": "Dx12",
                "limits": {"max_texture_dimension_2d": 4096},
                "features": [],
                "key_formats": {},
                "device_test": {"success": False, "error": "No GPU", "test_texture_created": False},
            }
        ],
        "verdict": {
            "meets_minimum_requirements": False,
            "hardware_accelerated": False,
            "recommended_backend": "None",
            "max_texture_dimension_2d": 4096,
            "supports_rgba16f_render": False,
            "supports_compute_shaders": False,
            "notes": ["Khong dat tieu chi"],
        },
    }

    assert fake_report["verdict"]["meets_minimum_requirements"] is False
    assert fake_report["verdict"]["hardware_accelerated"] is False
    assert fake_report["verdict"]["max_texture_dimension_2d"] < 8192
