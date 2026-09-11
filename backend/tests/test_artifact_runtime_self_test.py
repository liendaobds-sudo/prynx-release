from __future__ import annotations

import asyncio
import base64
import gzip
import hashlib
import hmac
import io
import json
import os
import re
import shutil
import subprocess
import sys
import types
import zipfile
from pathlib import Path

import numpy as np
import pikepdf
import pytest
from fastapi import BackgroundTasks, HTTPException

from app import main as app_main
from app.core import artifact_runtime_self_test as runtime_self_test
from app.core import feature_entitlements
from app.core import license_guard
from app.workers import isnet_engine, realesrgan_engine


class _FakeInput:
    name = "input"

    def __init__(self, shape):
        self.shape = shape


class _FakeSession:
    created: list[tuple[str, tuple[str, ...]]] = []

    def __init__(self, path, providers):
        self.path = str(path)
        self.providers = tuple(providers)
        self.created.append((self.path, self.providers))

    def get_inputs(self):
        if self.path.endswith("isnet.onnx"):
            return [_FakeInput([1, 3, 1024, 1024])]
        return [_FakeInput(["batch", 3, "height", "width"])]

    def run(self, _outputs, inputs):
        assert list(inputs) == ["input"]
        assert inputs["input"].dtype == np.float32
        return [np.ones((1, 1, 2, 2), dtype=np.float32)]


def _fake_native_merger(request_json, output_path, *_args):
    request = json.loads(request_json)
    source = request["sources"][0]
    document = pikepdf.Pdf.new()
    page = document.add_blank_page()
    page.MediaBox = pikepdf.Array(
        [0, 0, float(source["width_pt"]), float(source["height_pt"])]
    )
    icc = document.make_stream(b"fake-rgb-icc")
    icc["/N"] = 3
    icc["/Alternate"] = pikepdf.Name("/DeviceRGB")
    smask = document.make_stream(bytes([160] * 6))
    smask["/Type"] = pikepdf.Name("/XObject")
    smask["/Subtype"] = pikepdf.Name("/Image")
    smask["/Width"] = 2
    smask["/Height"] = 3
    smask["/BitsPerComponent"] = 8
    smask["/ColorSpace"] = pikepdf.Name("/DeviceGray")
    image = document.make_stream(bytes([20, 40, 60] * 6))
    image["/Type"] = pikepdf.Name("/XObject")
    image["/Subtype"] = pikepdf.Name("/Image")
    image["/Width"] = 2
    image["/Height"] = 3
    image["/BitsPerComponent"] = 8
    image["/ColorSpace"] = pikepdf.Array([pikepdf.Name("/ICCBased"), icc])
    image["/SMask"] = smask
    page.Resources = pikepdf.Dictionary(
        {"/XObject": pikepdf.Dictionary({"/Im0": image})}
    )
    page.Contents = document.make_stream(b"q 0.48 0 0 0.72 0 0 cm /Im0 Do Q")
    document.save(output_path)
    return str(output_path)


def _install_fake_runtime(monkeypatch, providers, native_merger=_fake_native_merger):
    fake_ort = types.ModuleType("onnxruntime")
    fake_ort.get_available_providers = lambda: list(providers)
    fake_ort.InferenceSession = _FakeSession
    monkeypatch.setitem(sys.modules, "onnxruntime", fake_ort)
    fake_native = types.ModuleType("pdfcompare_native")
    if native_merger is not None:
        fake_native.combine_image_manifest_native = native_merger
    monkeypatch.setitem(sys.modules, "pdfcompare_native", fake_native)


def _prepare_models(monkeypatch, tmp_path: Path):
    names = {
        "isnet.onnx": "hash-isnet",
        "general.onnx": "hash-general",
        "quality.onnx": "hash-quality",
    }
    for name in names:
        (tmp_path / name).write_bytes(name.encode("ascii"))

    monkeypatch.setattr(isnet_engine, "_BUNDLED_MODELS", str(tmp_path))
    monkeypatch.setattr(isnet_engine, "MODEL_PATH", str(tmp_path / "isnet.onnx"))
    monkeypatch.setattr(isnet_engine, "MODEL_SHA256", names["isnet.onnx"])
    monkeypatch.setattr(realesrgan_engine, "_BUNDLED_DIR", str(tmp_path))
    monkeypatch.setattr(
        realesrgan_engine,
        "MODELS",
        {"general": "general.onnx", "quality": "quality.onnx"},
    )
    monkeypatch.setattr(
        realesrgan_engine,
        "MODEL_SHA256",
        {"general": names["general.onnx"], "quality": names["quality.onnx"]},
    )
    monkeypatch.setattr(runtime_self_test, "_sha256_file", lambda path: names[path.name])
    monkeypatch.setattr(feature_entitlements, "FEATURE_GATING_ENABLED", True)


def test_frozen_runtime_self_test_runs_all_three_bundled_models(monkeypatch, tmp_path):
    _FakeSession.created.clear()
    _install_fake_runtime(monkeypatch, ["DmlExecutionProvider", "CPUExecutionProvider"])
    _prepare_models(monkeypatch, tmp_path)

    report = runtime_self_test.run_artifact_runtime_self_test()

    assert report["status"] == "ok"
    assert set(report["models"]) == {
        "isnet",
        "realesrgan-general",
        "realesrgan-quality",
    }
    assert report["models"]["isnet"]["input_shape"] == [1, 3, 1024, 1024]
    assert report["models"]["realesrgan-general"]["input_shape"] == [1, 3, 16, 16]
    assert report["feature_gate"] == {
        "enabled": True,
        "free_allowed": "pdf.merge",
        "free_denied": "prepress.preflight",
    }
    assert report["native_merger"] is True
    behavior = report["native_merger_behavior"]
    assert {key: behavior[key] for key in ("pages", "alpha", "icc_components")} == {
        "pages": 1,
        "alpha": True,
        "icc_components": 3,
    }
    assert behavior["width_pt"] == pytest.approx(0.48, abs=0.01)
    assert behavior["height_pt"] == pytest.approx(0.72, abs=0.01)
    assert len(_FakeSession.created) == 3
    assert all(providers == ("CPUExecutionProvider",) for _path, providers in _FakeSession.created)


def test_frozen_runtime_self_test_requires_directml_provider(monkeypatch, tmp_path):
    _install_fake_runtime(monkeypatch, ["CPUExecutionProvider"])
    _prepare_models(monkeypatch, tmp_path)

    with pytest.raises(RuntimeError, match="provider"):
        runtime_self_test.run_artifact_runtime_self_test()


def test_frozen_runtime_self_test_rejects_bundle_hash_drift(monkeypatch, tmp_path):
    _install_fake_runtime(monkeypatch, ["DmlExecutionProvider", "CPUExecutionProvider"])
    _prepare_models(monkeypatch, tmp_path)
    monkeypatch.setattr(runtime_self_test, "_sha256_file", lambda _path: "wrong")

    with pytest.raises(RuntimeError, match="hash"):
        runtime_self_test.run_artifact_runtime_self_test()


def test_frozen_runtime_self_test_rejects_disabled_feature_gate(monkeypatch):
    monkeypatch.setattr(feature_entitlements, "FEATURE_GATING_ENABLED", False)

    with pytest.raises(RuntimeError, match="Feature gate"):
        runtime_self_test.run_artifact_runtime_self_test()


def test_frozen_runtime_self_test_rejects_missing_native_merger(monkeypatch, tmp_path):
    _install_fake_runtime(
        monkeypatch,
        ["DmlExecutionProvider", "CPUExecutionProvider"],
        native_merger=None,
    )
    _prepare_models(monkeypatch, tmp_path)

    with pytest.raises(RuntimeError, match="thieu symbol"):
        runtime_self_test.run_artifact_runtime_self_test()


def test_frozen_runtime_self_test_rejects_broken_native_merger(monkeypatch, tmp_path):
    def _broken(*_args, **_kwargs):
        raise OSError("broken ABI")

    _install_fake_runtime(
        monkeypatch,
        ["DmlExecutionProvider", "CPUExecutionProvider"],
        native_merger=_broken,
    )
    _prepare_models(monkeypatch, tmp_path)

    with pytest.raises(RuntimeError, match="behavior smoke"):
        runtime_self_test.run_artifact_runtime_self_test()


def test_frozen_runtime_self_test_rejects_pdf_without_alpha_or_icc(monkeypatch, tmp_path):
    def _wrong_artifact(request_json, output_path, *_args):
        request = json.loads(request_json)
        source = request["sources"][0]
        document = pikepdf.Pdf.new()
        page = document.add_blank_page()
        page.MediaBox = pikepdf.Array(
            [0, 0, float(source["width_pt"]), float(source["height_pt"])]
        )
        document.save(output_path)

    _install_fake_runtime(
        monkeypatch,
        ["DmlExecutionProvider", "CPUExecutionProvider"],
        native_merger=_wrong_artifact,
    )
    _prepare_models(monkeypatch, tmp_path)

    with pytest.raises(RuntimeError, match="behavior smoke"):
        runtime_self_test.run_artifact_runtime_self_test()


def test_main_exposes_hidden_self_test_before_app_and_server_imports():
    source = (Path(__file__).parents[1] / "app" / "main.py").read_text(encoding="utf-8")
    branch_offset = source.index(
        'if __name__ == "__main__" and "--artifact-self-test" in sys.argv[1:]:'
    )
    fastapi_offset = source.index("from fastapi import ")
    bind_offset = source.index("_bind_ok = False")
    assert branch_offset < fastapi_offset < bind_offset
    assert "run_artifact_runtime_self_test" in source
    assert "SELF_TEST_MARKER" in source


def test_release_qa_uses_staged_native_and_models_without_dirtying_source():
    repo = Path(__file__).parents[2]
    source = (repo / "build_production.ps1").read_text(encoding="utf-8")
    wheel_install = source.index("pip install --no-deps --target $nativeSiteDir")
    staged_site = source.index("$env:PRYNX_RELEASE_NATIVE_SITE = $nativeSiteDir")
    qa_call = source.index('-File "$ROOT\\scripts\\run_release_qa.ps1"', staged_site)
    nuitka_call = source.index("& $VENV_PYTHON -m nuitka", qa_call)
    assert wheel_install < staged_site < qa_call < nuitka_call
    assert '$PACKAGED_MODELS_DIR = Join-Path $nativeStageFull "models"' in source
    assert "-Destination $SOURCE_ISNET_ONNX" not in source
    capture_commit = source.index("Assert-ReleaseSourceState -CaptureCommit")
    source_guard_start = source.index("function Assert-ReleaseSourceState")
    source_guard_end = source.index(
        "\nfunction Assert-ReleaseSigningAuthority", source_guard_start
    )
    git_authority = source.index(
        "Assert-PrynXGitRepositoryAuthority", source_guard_start, source_guard_end
    )
    first_git_consumer = source.index(
        "Invoke-PrynXGitReadOnlyCommand", source_guard_start, source_guard_end
    )
    tauri_call = source.index(
        "& $script:PrynXNodePath $tauriCliPath build --config $tauriConfig"
    )
    post_tauri_source_check = source.index("Assert-ReleaseSourceState", tauri_call)
    manifest_write = source.index("$manifestLines = @(", post_tauri_source_check)
    assert git_authority < first_git_consumer
    assert capture_commit < wheel_install < tauri_call < post_tauri_source_check < manifest_write
    assert '"GIT_COMMIT     = $manifestGitCommit"' in source
    assert "$script:ReleaseSourceCommit" in source


def test_release_native_gate_phu_du_moi_consumer_ppe():
    """Wheel staging phải bị chặn nếu chỉ có một phần ABI PPE mới."""
    source = (Path(__file__).parents[2] / "build_production.ps1").read_text(
        encoding="utf-8"
    )
    gate_start = source.index("$ppeCapabilityGate = @(")
    gate_end = source.index("$nativeExit = $LASTEXITCODE", gate_start)
    gate = source[gate_start:gate_end]

    for symbol in (
        "PpeRenderSession",
        "ppe_separations",
        "ppe_compose_separation_subset",
        "ppe_softproof",
        "ppe_export_cmyk",
        "ppe_text_outlines",
        "ppe_capabilities",
        "combine_image_manifest_native",
    ):
        assert symbol in gate

    for capability in (
        "separation_subset_composite",
        "softproof_paper_color",
        "softproof_black_ink",
        "softproof_page_background",
        "softproof_viewport_clip",
        "optional_content_configs",
        "output_preview_filters",
    ):
        assert capability in gate

    for output_filter in (
        "all",
        "device-cmyk",
        "device-rgb",
        "device-gray",
        "spot",
        "text",
        "images",
        "line-art",
        "smooth-shades",
    ):
        assert f"''{output_filter}''" in gate

    assert "hasattr(n, name)" in gate
    assert "caps.get(name) is not True" in gate
    assert "if any(problems.values()):" in gate


def test_installed_verifier_requires_native_merger_behavior_marker():
    source = (
        Path(__file__).parents[2] / "scripts" / "verify_installed_artifact.ps1"
    ).read_text(encoding="utf-8")
    start = source.index("function Assert-SidecarAiRuntimeOutput")
    end = source.index("function Invoke-SidecarAiRuntimeSmoke", start)
    gate = source[start:end]

    for field in (
        "native_merger",
        "native_merger_behavior.pages",
        "native_merger_behavior.alpha",
        "native_merger_behavior.icc_components",
        "native_merger_behavior.width_pt",
        "native_merger_behavior.height_pt",
    ):
        assert field in gate
    assert "native merger behavior smoke khong dat" in gate


def test_build_manifest_attests_gate_abi_mode_and_fresh_sidecar():
    source = (Path(__file__).parents[2] / "build_production.ps1").read_text(
        encoding="utf-8"
    )

    required_fields = {
        "BUILD_MODE": "$manifestBuildMode",
        "BUILD_PROVENANCE": "$manifestBuildProvenance",
        "SIDECAR_PROVENANCE": "compiled-this-run",
        "PYTHON_ABI": "$PYTHON_MM",
        "FRONTEND_FEATURE_GATE": "enabled",
        "BACKEND_FEATURE_GATE": "enabled",
        "LOGO_REBUILD": "hold",
    }
    for name, value in required_fields.items():
        assert f'"{name}' in source
        assert value in source

    retired_guard = source.index("if ($SkipNuitka)")
    first_build_step = source.index("# ---- Step 0:")
    assert retired_guard < first_build_step
    assert "every installer must compile the sidecar from current sources" in source

    gate_set = source.index('$env:VITE_FEATURE_GATING_ENABLED = "true"')
    logo_frontend_hold = source.index('$env:VITE_LOGO_REBUILD_ENABLED = "false"', gate_set)
    logo_backend_hold = source.index('$env:PRYNX_LOGO_REBUILD_ENABLED = "false"', gate_set)
    frontend_section = source.index("[4/5] Building frontend", gate_set)
    frontend_build = source.index(
        "& $script:PrynXNodePath $script:PrynXNpmCliPath run build\n",
        frontend_section,
    )
    gate_assertion = source.rfind("Production frontend/backend feature gates", 0, frontend_build)
    manifest_gate_assertion = source.index(
        "Feature gate state changed before manifest creation.", frontend_build
    )
    manifest_write = source.index("$manifestLines = @(", manifest_gate_assertion)
    assert gate_set < logo_frontend_hold < frontend_section
    assert gate_set < logo_backend_hold < frontend_section
    assert gate_set < gate_assertion < frontend_build < manifest_gate_assertion < manifest_write

    rust_host = (
        Path(__file__).parents[2] / "desktop" / "src-tauri" / "src" / "lib.rs"
    ).read_text(encoding="utf-8")
    rust_build = (
        Path(__file__).parents[2] / "desktop" / "src-tauri" / "build.rs"
    ).read_text(encoding="utf-8")
    assert 'option_env!("PRYNX_LOGO_REBUILD_ENABLED").unwrap_or("false")' in rust_host
    assert 'cargo:rerun-if-env-changed=PRYNX_LOGO_REBUILD_ENABLED' in rust_build


def test_build_manifest_trims_single_git_output_as_string_not_char():
    """Manifest nội bộ phải xử lý đúng khi Git chỉ trả về một commit."""
    source = (Path(__file__).parents[2] / "build_production.ps1").read_text(
        encoding="utf-8"
    )

    assert "$manifestGitCommit = ([string](@($manifestGitOutput)[0])).Trim()" in source
    assert "$manifestGitCommit = [string]$manifestGitOutput[0].Trim()" not in source


def test_build_payload_manifest_exact_set_rechecks_live_staging():
    """Exact-set phải quét lại cây thật, không tự so với snapshot tạo manifest."""
    source = (Path(__file__).parents[2] / "build_production.ps1").read_text(
        encoding="utf-8"
    )
    manifest_write = source.index(
        "[System.IO.File]::WriteAllText($manifestPath", source.index("$manifestObj =")
    )
    exact_start = source.index("# Exact-set sanity: quét lại cây thật", manifest_write)
    exact_end = source.index("# ---- Step 3: Compute SHA-256", exact_start)
    exact_block = source[exact_start:exact_end]
    guard_start = source.index("function Assert-PayloadManifestMatchesStaging")
    guard_end = source.index("\nInitialize-PrynXReleaseToolAuthority", guard_start)
    guard = source[guard_start:guard_end]

    lock_read = source.index("Read-PrynXTesseractPayloadLock")
    pinned_copy = source.index("Copy-PrynXTesseractPayload")
    assert lock_read < pinned_copy < manifest_write
    assert "$manifestEntries = @($script:TesseractPayloadLock.Entries" in source
    assert "version = 2" in source
    assert "component_id = 'tesseract'" in source
    assert "source_lock_sha256 = [string]$script:TesseractPayloadLock.LockSha256" in source
    assert "không tự băm chính nó" in exact_block
    assert "$manifestSourceFiles" not in source
    assert "$allItems = @(Get-ChildItem" in guard
    assert "$stagingFull = (Assert-NoReparsePointInPathComponents -Path $StagingRoot)" in guard
    assert "$manifestFull = Assert-NoReparsePointInPathComponents" in guard
    assert "-Recurse -Force -ErrorAction Stop" in guard
    assert "Get-FileHash -LiteralPath $file.FullName" in guard
    assert "hash/size mismatch for staging file" in guard
    assert "Assert-PrynXTesseractManifestMatchesLock" in guard
    assert "[Parameter(Mandatory = $true)]$TrustedTesseractLock" in guard
    assert source.count("Assert-PayloadManifestMatchesStaging `") == 2
    assert source.index("Assert-PayloadManifestMatchesStaging `", manifest_write) < exact_end
    pre_bundle = source.rindex("Assert-PayloadManifestMatchesStaging `")
    assert source.index("Assert-ReleaseSourceState", manifest_write) < pre_bundle
    assert pre_bundle < source.index(
        "& $script:PrynXNodePath $tauriCliPath build --config $tauriConfig",
        pre_bundle,
    )


def test_build_holds_payload_identity_leases_across_tauri_bundle():
    """Gate hash phải giữ handle bất biến cho tới khi Tauri đọc xong resource."""
    source = (Path(__file__).parents[2] / "build_production.ps1").read_text(
        encoding="utf-8"
    )
    pre_bundle = source.rindex("Assert-PayloadManifestMatchesStaging `")
    tesseract_lease = source.index(
        "$script:TauriTesseractLease = Open-PrynXPayloadLeaseSet", pre_bundle
    )
    manifest_lease = source.index(
        "$script:TauriPayloadManifestLease = Open-PrynXPayloadFileLease", pre_bundle
    )
    sidecar_lease = source.index(
        "$script:TauriSidecarLease = Open-PrynXPayloadFileLease", pre_bundle
    )
    tauri_call = source.index(
        "& $script:PrynXNodePath $tauriCliPath build --config $tauriConfig",
        sidecar_lease,
    )
    tauri_finally = source.index("} finally {", tauri_call)
    tesseract_close = source.index(
        "Close-PrynXPayloadLease -Lease $script:TauriTesseractLease",
        tauri_finally,
    )
    assert pre_bundle < tesseract_lease < manifest_lease < sidecar_lease < tauri_call
    assert tauri_call < tauri_finally < tesseract_close

    outer_finally = source.rindex("} finally {")
    assert source.index(
        "Close-PrynXPayloadLease -Lease $script:TesseractPayloadLock.LockLease",
        outer_finally,
    ) > outer_finally


def test_tauri_config_is_exact_set_validated_and_leased_across_bundle():
    """Config ngầm/overlay thừa phải bị chặn và config đã duyệt phải được giữ lease."""
    source = (Path(__file__).parents[2] / "build_production.ps1").read_text(
        encoding="utf-8"
    )
    first_child_gate = source.index("Assert-PrynXNoAmbientTauriConfig", source.index("try {"))
    toolchain = source.index("Assert-BuildToolchain", first_child_gate)
    config_directory_lease = source.index(
        "$script:TauriConfigDirectoryLease = Open-PrynXPayloadDirectoryBoundaryLease"
    )
    base_lease = source.index(
        "$script:TauriBaseConfigLease = Open-PrynXPayloadFileLease",
        config_directory_lease,
    )
    overlay_lease = source.index(
        "$script:TauriOverlayConfigLease = Open-PrynXPayloadFileLease", base_lease
    )
    config_read = source.index("Read-PrynXJsonDocumentFromLease", overlay_lease)
    exact_validation = source.index("Assert-PrynXJsonObjectExactKeys", config_read)
    tauri_call = source.index(
        "& $script:PrynXNodePath $tauriCliPath build --config $tauriConfig",
        exact_validation,
    )
    immediate_env_gate = source.rindex(
        "Assert-PrynXNoAmbientTauriConfig", exact_validation, tauri_call
    )
    immediate_platform_gate = source.rindex(
        "Assert-PrynXNoTauriPlatformConfig", exact_validation, tauri_call
    )
    tauri_finally = source.index("} finally {", tauri_call)
    post_tauri_platform_gate = source.index(
        "Assert-PrynXNoTauriPlatformConfig", tauri_call, tauri_finally
    )
    post_tauri_exact_set = source.index(
        "Assert-PrynXPayloadRootExactSet", tauri_call, tauri_finally
    )
    config_close = source.index(
        "Close-PrynXPayloadLease -Lease $script:TauriConfigDirectoryLease",
        tauri_finally,
    )

    assert first_child_gate < toolchain
    assert config_directory_lease < base_lease < overlay_lease < config_read
    assert config_read < exact_validation < immediate_env_gate < immediate_platform_gate
    assert immediate_platform_gate < tauri_call
    assert tauri_call < post_tauri_platform_gate < post_tauri_exact_set < tauri_finally
    assert tauri_finally < config_close
    assert "Remove-Item Env:TAURI_CONFIG -ErrorAction SilentlyContinue" in source
    for forbidden_name in (
        "tauri.windows.conf.json",
        "tauri.windows.conf.json5",
        "Tauri.windows.toml",
    ):
        assert forbidden_name in source
    for exact_key_contract in (
        "@('frontendDist', 'devUrl', 'beforeDevCommand', 'beforeBuildCommand')",
        "@('active', 'targets', 'resources', 'icon', 'fileAssociations', 'windows')",
        "@('installerIcon', 'installerHooks')",
        "@('build', 'bundle')",
    ):
        assert exact_key_contract in source[config_read:tauri_call]
    assert source.count(
        "Close-PrynXPayloadLease -Lease $script:TauriConfigDirectoryLease"
    ) >= 2


def test_tauri_json_helpers_read_leased_config_and_reject_expansion(
    tmp_path: Path,
):
    """Helper phải fail khi attacker thêm resource, frontendDist hoặc NSIS template."""
    root = Path(__file__).parents[2]
    source = (root / "build_production.ps1").read_text(encoding="utf-8")
    helper_start = source.index("function Assert-PrynXJsonObjectExactKeys")
    helper_end = source.index("\nfunction Assert-BuildToolchain", helper_start)
    helper = source[helper_start:helper_end]
    result = _run_windows_powershell(
        root,
        f'''
$ErrorActionPreference = "Stop"
. $env:PRYNX_TEST_PAYLOAD_HELPER
{helper}
function Assert-RejectedExactKeys {{
    param($Object, [string[]]$Keys, [string]$Purpose)
    $rejected = $false
    try {{
        Assert-PrynXJsonObjectExactKeys -Object $Object -Keys $Keys -Purpose $Purpose
    }} catch {{
        if ($_.Exception.Message -like "SEC: * JSON keys drifted.*") {{
            $rejected = $true
        }} else {{
            throw
        }}
    }}
    if (-not $rejected) {{ throw "Expected exact-key rejection for $Purpose." }}
}}

$valid = '{{"build":{{"beforeBuildCommand":""}},"bundle":{{"externalBin":["binaries/pdf-inspector-backend"]}}}}' | ConvertFrom-Json
Assert-PrynXJsonObjectExactKeys -Object $valid -Keys @("build", "bundle") -Purpose "valid root"
Assert-PrynXJsonObjectExactKeys -Object $valid.build -Keys @("beforeBuildCommand") -Purpose "valid build"
Assert-PrynXJsonObjectExactKeys -Object $valid.bundle -Keys @("externalBin") -Purpose "valid bundle"

$bundleExpansion = '{{"externalBin":["binaries/pdf-inspector-backend"],"resources":["secret.env"]}}' | ConvertFrom-Json
Assert-RejectedExactKeys -Object $bundleExpansion -Keys @("externalBin") -Purpose "bundle expansion"
$buildExpansion = '{{"beforeBuildCommand":"","frontendDist":"attacker-dist"}}' | ConvertFrom-Json
Assert-RejectedExactKeys -Object $buildExpansion -Keys @("beforeBuildCommand") -Purpose "build expansion"
$nsisExpansion = '{{"installerIcon":"icons/icon.ico","installerHooks":"installer-hooks.nsh","template":"attacker.nsi"}}' | ConvertFrom-Json
Assert-RejectedExactKeys -Object $nsisExpansion -Keys @("installerIcon", "installerHooks") -Purpose "NSIS expansion"

$configLease = Open-PrynXPayloadFileLease `
    -Path $env:PRYNX_TEST_TAURI_CONFIG `
    -Purpose "leased Tauri config fixture"
try {{
    $leasedConfig = Read-PrynXJsonDocumentFromLease `
        -Lease $configLease `
        -Purpose "leased Tauri config fixture"
    if ([string]$leasedConfig.productName -cne "PrynX") {{
        throw "Leased config reader returned the wrong document."
    }}
}} finally {{
    Close-PrynXPayloadLease -Lease $configLease
}}

Assert-PrynXNoTauriPlatformConfig -ConfigRoot $env:PRYNX_TEST_CONFIG_ROOT
$platformPath = Join-Path $env:PRYNX_TEST_CONFIG_ROOT "tauri.windows.conf.json"
[IO.File]::WriteAllText($platformPath, "{{}}")
$platformRejected = $false
try {{
    Assert-PrynXNoTauriPlatformConfig -ConfigRoot $env:PRYNX_TEST_CONFIG_ROOT
}} catch {{
    if ($_.Exception.Message -like "SEC: Automatic Tauri platform config is forbidden:*") {{
        $platformRejected = $true
    }} else {{
        throw
    }}
}}
if (-not $platformRejected) {{ throw "Platform config was not rejected." }}
"TAURI_EXACT_KEYS_OK"
''',
        {
            "PRYNX_TEST_PAYLOAD_HELPER": str(
                root / "scripts" / "windows_payload_guard.ps1"
            ),
            "PRYNX_TEST_TAURI_CONFIG": str(
                root / "desktop" / "src-tauri" / "tauri.conf.json"
            ),
            "PRYNX_TEST_CONFIG_ROOT": str(tmp_path),
        },
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "TAURI_EXACT_KEYS_OK" in result.stdout


def test_build_clears_and_rejects_ambient_tauri_config_before_early_exit():
    """Ngay cả failure sớm cũng không để TAURI_CONFIG sống trong host PowerShell."""
    root = Path(__file__).parents[2]
    build_script = root / "build_production.ps1"
    quoted_path = str(build_script).replace("'", "''")
    probe = f'''
$ErrorActionPreference = "Stop"
$env:TAURI_CONFIG = '{{"bundle":{{"resources":["secret.env"]}}}}'
$rejected = $false
try {{ . '{quoted_path}' -SkipNuitka -NoOpenExplorer }} catch {{
    if ($_.Exception.Message -like "SEC: Ambient TAURI_CONFIG*") {{
        $rejected = $true
    }} else {{
        throw
    }}
}}
if (-not $rejected) {{ throw "Ambient TAURI_CONFIG was not rejected." }}
if ($null -ne [Environment]::GetEnvironmentVariable('TAURI_CONFIG', [EnvironmentVariableTarget]::Process)) {{
    throw "Ambient TAURI_CONFIG survived cleanup."
}}
"TAURI_CONFIG_REJECTED"
'''
    result = _run_windows_powershell(root, probe, {})
    assert result.returncode == 0, result.stdout + result.stderr
    assert "TAURI_CONFIG_REJECTED" in result.stdout


def test_payload_manifest_guard_detects_live_surplus_and_mutation(tmp_path: Path):
    """Guard PowerShell phải bắt file thêm và byte đổi sau lúc manifest được tạo."""
    root = Path(__file__).parents[2]
    source = (root / "build_production.ps1").read_text(encoding="utf-8")
    helper_start = source.index("function Assert-NoReleaseSecretInPayloadFile")
    helper_end = source.index("\nInitialize-PrynXReleaseToolAuthority", helper_start)
    helpers = source[helper_start:helper_end]

    staging = tmp_path / "staging"
    payload = staging / "tesseract" / "eng.traineddata"
    payload.parent.mkdir(parents=True)
    payload.write_bytes(b"trusted-payload")
    for sidecar_name in (
        "pdf-inspector-backend.exe",
        "pdf-inspector-backend-x86_64-pc-windows-msvc.exe",
    ):
        (staging / sidecar_name).write_bytes(b"sidecar-fixture")
    manifest_path = staging / "payload-manifest.json"
    trusted_hash = hashlib.sha256(payload.read_bytes()).hexdigest()
    trusted_size = payload.stat().st_size
    trusted_lock_hash = "ab" * 32
    manifest_path.write_text(
        json.dumps(
            {
                "version": 2,
                "component_id": "tesseract",
                "component_version": "fixture-1",
                "source_lock_sha256": trusted_lock_hash,
                "file_count": 1,
                "files": [
                    {
                        "path": "tesseract/eng.traineddata",
                        "sha256": trusted_hash,
                        "size": trusted_size,
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    powershell = shutil.which("powershell") or shutil.which("pwsh")
    if not powershell:
        pytest.skip("PowerShell khong co trong PATH")
    env = os.environ.copy()
    # Pytest có thể được khởi chạy từ pwsh 7; không truyền module Core sang
    # Windows PowerShell 5.1, nếu không Get-FileHash có thể autoload nhầm edition.
    env.pop("PSMODULEPATH", None)
    env["PRYNX_TEST_STAGING"] = str(staging)
    env["PRYNX_TEST_MANIFEST"] = str(manifest_path)
    env["PRYNX_TEST_PAYLOAD_HASH"] = trusted_hash
    env["PRYNX_TEST_PAYLOAD_SIZE"] = str(trusted_size)
    env["PRYNX_TEST_LOCK_HASH"] = trusted_lock_hash
    payload_helper = root / "scripts" / "windows_payload_guard.ps1"
    cleanup_probe = f"""
$ErrorActionPreference = "Stop"
. "{payload_helper}"
{helpers}
Assert-StagingSafeToRecreate `
    -StagingRoot $env:PRYNX_TEST_STAGING `
    -AllowedRootFiles @(
        "pdf-inspector-backend.exe",
        "pdf-inspector-backend-x86_64-pc-windows-msvc.exe",
        "payload-manifest.json"
    ) | Out-Null
"STAGING_CLEANUP_GUARD_OK"
"""
    probe = f"""
$ErrorActionPreference = "Stop"
. "{payload_helper}"
{helpers}
$trustedLock = [pscustomobject]@{{
    Version = "fixture-1"
    LockSha256 = $env:PRYNX_TEST_LOCK_HASH
    Entries = @([pscustomobject]@{{
        Path = "eng.traineddata"
        Hash = $env:PRYNX_TEST_PAYLOAD_HASH
        Size = [long]$env:PRYNX_TEST_PAYLOAD_SIZE
    }})
}}
Assert-PayloadManifestMatchesStaging `
    -StagingRoot $env:PRYNX_TEST_STAGING `
    -PayloadManifestPath $env:PRYNX_TEST_MANIFEST `
    -ExcludedRelativePaths @(
        "pdf-inspector-backend.exe",
        "pdf-inspector-backend-x86_64-pc-windows-msvc.exe"
    ) `
    -TrustedTesseractLock $trustedLock
"PAYLOAD_GUARD_OK"
"""

    def run_guard() -> subprocess.CompletedProcess[str]:
        probe_file = tmp_path / "_probe_guard.ps1"
        probe_file.write_text(probe, encoding="utf-8-sig")
        return subprocess.run(
            [
                powershell,
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(probe_file),
            ],
            cwd=root,
            env=env,
            text=True,
            capture_output=True,
            timeout=20,
            check=False,
        )

    def run_cleanup_guard() -> subprocess.CompletedProcess[str]:
        cleanup_file = tmp_path / "_cleanup_guard.ps1"
        cleanup_file.write_text(cleanup_probe, encoding="utf-8-sig")
        return subprocess.run(
            [
                powershell,
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(cleanup_file),
            ],
            cwd=root,
            env=env,
            text=True,
            capture_output=True,
            timeout=20,
            check=False,
        )

    cleanup_accepted = run_cleanup_guard()
    assert cleanup_accepted.returncode == 0, (
        cleanup_accepted.stdout + cleanup_accepted.stderr
    )
    assert "STAGING_CLEANUP_GUARD_OK" in cleanup_accepted.stdout

    unexpected_data = staging / "data" / "pdfcompare.db"
    unexpected_data.parent.mkdir()
    unexpected_data.write_bytes(b"user-data-must-not-be-deleted")
    cleanup_rejected = run_cleanup_guard()
    assert cleanup_rejected.returncode != 0
    assert "refusing recursive cleanup" in cleanup_rejected.stderr
    unexpected_data.unlink()
    unexpected_data.parent.rmdir()

    accepted = run_guard()
    assert accepted.returncode == 0, accepted.stdout + accepted.stderr
    assert "PAYLOAD_GUARD_OK" in accepted.stdout

    residue = payload.parent / "residue.bin"
    residue.write_bytes(b"surplus")
    surplus = run_guard()
    assert surplus.returncode != 0
    assert "surplus staging file" in surplus.stderr
    residue.unlink()

    payload.write_bytes(b"mutated-after-manifest")
    mutated = run_guard()
    assert mutated.returncode != 0
    assert "hash/size mismatch" in mutated.stderr

    # Kẻ tấn công sửa cả payload lẫn manifest sinh kèm vẫn không thể biến byte
    # mới thành trusted: manifest phải tiếp tục khớp lock đã neo từ source sạch.
    tampered_document = json.loads(manifest_path.read_text(encoding="utf-8"))
    tampered_document["files"][0]["sha256"] = hashlib.sha256(
        payload.read_bytes()
    ).hexdigest()
    tampered_document["files"][0]["size"] = payload.stat().st_size
    manifest_path.write_text(json.dumps(tampered_document), encoding="utf-8")
    tampered_together = run_guard()
    assert tampered_together.returncode != 0
    assert "drifted from the trusted lock" in tampered_together.stderr


@pytest.mark.skipif(os.name != "nt", reason="Release payload scanner chi chay tren Windows")
def test_release_secret_scanner_covers_names_large_binary_archives_and_ads(
    tmp_path: Path,
):
    """§SEC.20-S2 không được bỏ qua byte theo kích thước, đuôi hay container."""
    root = Path(__file__).parents[2]
    powershell = shutil.which("powershell.exe") or shutil.which("powershell")
    if not powershell:
        pytest.skip("Windows PowerShell khong co trong PATH")

    scan_root = tmp_path / "payload"
    scan_root.mkdir()
    safe_file = scan_root / "safe.bin"
    safe_file.write_bytes(b"public payload")
    env = os.environ.copy()
    env.pop("PSMODULEPATH", None)
    env["PRYNX_TEST_SCAN_ROOT"] = str(scan_root)
    helper = root / "scripts" / "windows_payload_guard.ps1"
    probe = f'''
$ErrorActionPreference = "Stop"
. "{helper}"
$scan = Assert-PrynXReleasePayloadSecretFree `
    -TreeRoots @($env:PRYNX_TEST_SCAN_ROOT) `
    -Purpose "test-installed-tree"
$evidence = ConvertTo-PrynXReleaseSecretScanEvidence -ScanResult $scan
"SCAN_OK:$evidence"
'''
    encoded = base64.b64encode(probe.encode("utf-16-le")).decode("ascii")

    def run_scan() -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                powershell,
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-EncodedCommand",
                encoded,
            ],
            cwd=root,
            env=env,
            text=True,
            capture_output=True,
            timeout=90,
            check=False,
        )

    accepted = run_scan()
    assert accepted.returncode == 0, accepted.stdout + accepted.stderr
    assert re.search(
        r"SCAN_OK:installed-tree-v1;files=1;directories=1;raw_bytes=14;"
        r"archives=0;archive_entries=0;expanded_bytes=0;sha256=[0-9a-f]{64}",
        accepted.stdout,
    )

    secret_directory = scan_root / "ReleaseSecrets"
    secret_directory.mkdir()
    (secret_directory / "public.bin").write_bytes(b"benign")
    rejected_name = run_scan()
    assert rejected_name.returncode != 0
    assert "secret-like path name" in rejected_name.stderr
    shutil.rmtree(secret_directory)

    large_file = scan_root / "large-resource.dat"
    with large_file.open("wb") as stream:
        stream.seek(16 * 1024 * 1024 + 4096)
        stream.write(b"sb_secret_" + b"L" * 32)
    rejected_large = run_scan()
    assert rejected_large.returncode != 0
    assert "secret marker detected" in rejected_large.stderr
    large_file.unlink()

    binary_file = scan_root / "native-resource.dll"
    binary_file.write_bytes(
        b"\xff\x01" + "TAURI_SIGNING_PRIVATE_KEY".encode("utf-16-le") + b"\xfe"
    )
    rejected_binary = run_scan()
    assert rejected_binary.returncode != 0
    assert "secret marker detected" in rejected_binary.stderr
    binary_file.unlink()

    archive_file = scan_root / "runtime.jar"
    with zipfile.ZipFile(archive_file, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("META-INF/public.bin", b"-----BEGIN PRIVATE KEY-----")
    rejected_archive = run_scan()
    assert rejected_archive.returncode != 0
    assert "runtime.jar::META-INF/public.bin" in rejected_archive.stderr
    archive_file.unlink()

    ads_file = scan_root / "ads-resource.bin"
    ads_file.write_bytes(b"public")
    try:
        with open(str(ads_file) + ":release-secret", "wb") as stream:
            stream.write(b"hidden")
    except OSError as error:
        pytest.skip(f"Filesystem runner khong ho tro NTFS ADS: {error}")
    rejected_ads = run_scan()
    assert rejected_ads.returncode != 0
    assert "Alternate data stream detected" in rejected_ads.stderr


@pytest.mark.skipif(os.name != "nt", reason="Archive magic scanner chi chay tren Windows")
def test_release_secret_scanner_detects_renamed_nested_and_sfx_archives(
    tmp_path: Path,
):
    """Magic, không phải đuôi file, phải quyết định archive nào được inspect."""
    root = Path(__file__).parents[2]
    helper = root / "scripts" / "windows_payload_guard.ps1"

    def run_file_scan(path: Path) -> subprocess.CompletedProcess[str]:
        return _run_windows_powershell(
            root,
            r'''
$ErrorActionPreference = "Stop"
. $env:PRYNX_TEST_HELPER
$scan = Assert-PrynXReleasePayloadSecretFree `
    -Files @($env:PRYNX_TEST_ARCHIVE) `
    -Purpose "archive-magic-fixture"
"ARCHIVE_COUNT=$($scan.ArchiveCount)"
"ARCHIVE_ENTRY_COUNT=$($scan.ArchiveEntryCount)"
''',
            {
                "PRYNX_TEST_HELPER": str(helper),
                "PRYNX_TEST_ARCHIVE": str(path),
            },
        )

    nested_buffer = io.BytesIO()
    with zipfile.ZipFile(
        nested_buffer, "w", compression=zipfile.ZIP_DEFLATED
    ) as nested_zip:
        nested_zip.writestr("payload.txt", b"public nested bytes")
    outer_zip = tmp_path / "outer.zip"
    with zipfile.ZipFile(outer_zip, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("renamed-nested.bin", nested_buffer.getvalue())
    nested_result = run_file_scan(outer_zip)
    assert nested_result.returncode != 0
    assert "Nested archive (zip) is not independently inspectable" in nested_result.stderr
    assert "renamed-nested.bin" in nested_result.stderr

    opaque_magic = {
        "gzip-renamed.bin": gzip.compress(b"public gzip payload"),
        "sevenzip-renamed.bin": b"\x37\x7a\xbc\xaf\x27\x1c" + b"fixture",
        "rar-renamed.bin": b"Rar!\x1a\x07\x01\x00" + b"fixture",
        "cab-renamed.bin": b"MSCF" + b"fixture",
    }
    for name, content in opaque_magic.items():
        path = tmp_path / name
        path.write_bytes(content)
        result = run_file_scan(path)
        assert result.returncode != 0, name
        assert "Opaque archive format" in result.stderr, name

    valid_zip_buffer = io.BytesIO()
    with zipfile.ZipFile(
        valid_zip_buffer, "w", compression=zipfile.ZIP_DEFLATED
    ) as archive:
        archive.writestr("inside.txt", b"TAURI_SIGNING_PRIVATE_KEY_PASSWORD")

    public_zip_buffer = io.BytesIO()
    with zipfile.ZipFile(
        public_zip_buffer, "w", compression=zipfile.ZIP_DEFLATED
    ) as archive:
        archive.writestr("public.txt", b"public SFX payload")
    public_sfx = tmp_path / "public-sfx.exe"
    public_sfx.write_bytes(b"MZ" + b"\x90" * 126 + public_zip_buffer.getvalue())
    public_sfx_result = run_file_scan(public_sfx)
    assert public_sfx_result.returncode == 0, (
        public_sfx_result.stdout + public_sfx_result.stderr
    )
    assert "ARCHIVE_COUNT=1" in public_sfx_result.stdout
    assert "ARCHIVE_ENTRY_COUNT=1" in public_sfx_result.stdout

    valid_sfx = tmp_path / "valid-sfx.exe"
    valid_sfx.write_bytes(b"MZ" + b"\x90" * 126 + valid_zip_buffer.getvalue())
    valid_sfx_result = run_file_scan(valid_sfx)
    assert valid_sfx_result.returncode != 0
    assert "valid-sfx.exe::inside.txt" in valid_sfx_result.stderr
    assert "secret marker detected" in valid_sfx_result.stderr

    malformed_sfx = tmp_path / "malformed-sfx.bin"
    malformed_sfx.write_bytes(
        b"MZ"
        + b"stub"
        + b"PK\x03\x04"
        + b"broken"
        + b"PK\x05\x06"
        + b"\x00" * 18
    )
    malformed_sfx_result = run_file_scan(malformed_sfx)
    assert malformed_sfx_result.returncode != 0
    assert "ZIP SFX release payload cannot be inspected safely" in (
        malformed_sfx_result.stderr
    )

    incidental_pk = tmp_path / "incidental-pk-signatures.bin"
    incidental_pk.write_bytes(
        b"MZ"
        + b"public-prefix"
        + b"PK\x03\x04"
        + b"not-a-zip"
        + b"PK\x05\x06"
        + b"\x00" * 18
        + b"public-trailer"
    )
    incidental_pk_result = run_file_scan(incidental_pk)
    assert incidental_pk_result.returncode == 0, (
        incidental_pk_result.stdout + incidental_pk_result.stderr
    )
    assert "ARCHIVE_COUNT=0" in incidental_pk_result.stdout
    assert "ARCHIVE_ENTRY_COUNT=0" in incidental_pk_result.stdout


def test_installed_verifier_scans_live_nuitka_extraction_and_writes_v2_evidence(
    tmp_path: Path,
):
    """Extraction phải được quét khi app sống và có digest riêng bind installer."""
    root = Path(__file__).parents[2]
    verifier = (root / "scripts" / "verify_installed_artifact.ps1").read_text(
        encoding="utf-8"
    )
    extraction_capture = verifier.index(
        "$appExtraction = Get-ActiveNuitkaExtractionEntry"
    )
    bootstrap_bind = verifier.index(
        "$sidecarBootstrap = Get-TrackedSidecarBootstrapRecord", extraction_capture
    )
    extraction_scan = verifier.index(
        "$nuitkaExtractionSecretScan = Assert-PrynXReleasePayloadSecretFree",
        bootstrap_bind,
    )
    app_liveness = verifier.index(
        "$script:AppProcess.Refresh()", extraction_scan
    )
    app_stop = verifier.index("$shutdownEvidence = Stop-CreatedProcessTree", app_liveness)
    v2_conversion = verifier.index(
        "$releaseSecretScanEvidenceV2 = ConvertTo-PrynXReleaseSecretScanEvidenceV2",
        app_stop,
    )
    v2_write = verifier.index(
        '@{ Name = "RELEASE_SECRET_SCAN_V2"; Value = $releaseSecretScanEvidenceV2 }',
        v2_conversion,
    )
    assert extraction_capture < bootstrap_bind < extraction_scan < app_liveness < app_stop
    assert app_stop < v2_conversion < v2_write
    assert "-TreeRoots @($appExtraction.Path)" in verifier[extraction_scan:app_liveness]
    assert "detection SAU execution" in verifier[bootstrap_bind:app_liveness]
    assert "secret da ma hoa hoac bi chia manh" in verifier[bootstrap_bind:app_liveness]

    extraction = tmp_path / "sidecar-123-123456-AbCdEfGhIjK"
    (extraction / "runtime").mkdir(parents=True)
    (extraction / "runtime" / "marker.bin").write_bytes(
        b"prefix-TAURI_SIGNING_PRIVATE_KEY_PASSWORD-suffix"
    )
    result = _run_windows_powershell(
        root,
        r'''
$ErrorActionPreference = "Stop"
. $env:PRYNX_TEST_HELPER
$appExtraction = [pscustomobject]@{ Path = $env:PRYNX_TEST_EXTRACTION }
$null = Assert-PrynXReleasePayloadSecretFree `
    -TreeRoots @($appExtraction.Path) `
    -Purpose "nuitka-extraction-fixture"
''',
        {
            "PRYNX_TEST_HELPER": str(root / "scripts" / "windows_payload_guard.ps1"),
            "PRYNX_TEST_EXTRACTION": str(extraction),
        },
    )
    assert result.returncode != 0
    assert "nuitka-extraction-fixture" in result.stderr
    assert "secret marker detected" in result.stderr


def test_release_secret_scan_evidence_v2_keeps_two_digests_and_installer_binding():
    """V2 không được gộp digest installed/extraction hoặc bỏ neo installer."""
    root = Path(__file__).parents[2]
    installer_hash = "a1" * 32
    installed_hash = "b2" * 32
    extraction_hash = "c3" * 32
    result = _run_windows_powershell(
        root,
        r'''
$ErrorActionPreference = "Stop"
. $env:PRYNX_TEST_HELPER
$installed = [pscustomobject]@{
    FileCount = 7; DirectoryCount = 3; RawBytes = 700
    ArchiveCount = 1; ArchiveEntryCount = 4; ExpandedBytes = 900
    Sha256 = $env:PRYNX_TEST_INSTALLED_HASH
}
$extraction = [pscustomobject]@{
    FileCount = 11; DirectoryCount = 5; RawBytes = 1100
    ArchiveCount = 2; ArchiveEntryCount = 8; ExpandedBytes = 1500
    Sha256 = $env:PRYNX_TEST_EXTRACTION_HASH
}
$evidence = ConvertTo-PrynXReleaseSecretScanEvidenceV2 `
    -InstallerSha256 $env:PRYNX_TEST_INSTALLER_HASH `
    -InstalledTreeScan $installed `
    -NuitkaExtractionScan $extraction
$parsed = Assert-PrynXReleaseSecretScanEvidenceV2 `
    -Evidence $evidence `
    -ManifestInstallerSha256 $env:PRYNX_TEST_INSTALLER_HASH `
    -SetupSha256 $env:PRYNX_TEST_INSTALLER_HASH
"EVIDENCE=$evidence"
"PARSED_INSTALLER=$($parsed.InstallerSha256)"
"PARSED_INSTALLED=$($parsed.InstalledTreeSha256)"
"PARSED_EXTRACTION=$($parsed.NuitkaExtractionSha256)"
''',
        {
            "PRYNX_TEST_HELPER": str(root / "scripts" / "windows_payload_guard.ps1"),
            "PRYNX_TEST_INSTALLER_HASH": installer_hash,
            "PRYNX_TEST_INSTALLED_HASH": installed_hash,
            "PRYNX_TEST_EXTRACTION_HASH": extraction_hash,
        },
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert f"installer_sha256={installer_hash}" in result.stdout
    assert f"installed_tree_sha256={installed_hash}" in result.stdout
    assert f"nuitka_extraction_sha256={extraction_hash}" in result.stdout
    assert "installed_files=7" in result.stdout
    assert "extraction_files=11" in result.stdout
    assert f"PARSED_INSTALLER={installer_hash}" in result.stdout
    assert f"PARSED_INSTALLED={installed_hash}" in result.stdout
    assert f"PARSED_EXTRACTION={extraction_hash}" in result.stdout


def test_release_secret_scan_evidence_v2_parser_rejects_bypass_shapes():
    """Publisher gate phải từ chối v1, digest lệch, counter tràn và format lỏng."""
    root = Path(__file__).parents[2]
    installer_hash = "a1" * 32
    installed_hash = "b2" * 32
    extraction_hash = "c3" * 32
    evidence = (
        f"release-secret-scan-v2;installer_sha256={installer_hash};"
        "installed_files=7;installed_directories=3;installed_raw_bytes=700;"
        "installed_archives=1;installed_archive_entries=4;"
        f"installed_expanded_bytes=900;installed_tree_sha256={installed_hash};"
        "extraction_files=11;extraction_directories=5;"
        "extraction_raw_bytes=1100;extraction_archives=2;"
        "extraction_archive_entries=8;extraction_expanded_bytes=1500;"
        f"nuitka_extraction_sha256={extraction_hash}"
    )
    invalid_cases = {
        "legacy-v1": (
            f"installed-tree-v1;files=7;directories=3;raw_bytes=700;"
            f"archives=1;archive_entries=4;expanded_bytes=900;sha256={installed_hash}",
            installer_hash,
            installer_hash,
        ),
        "manifest-installer-mismatch": (evidence, "d4" * 32, installer_hash),
        "leased-setup-mismatch": (evidence, installer_hash, "e5" * 32),
        "counter-overflow": (
            evidence.replace("installed_files=7", "installed_files=9223372036854775808"),
            installer_hash,
            installer_hash,
        ),
        "uppercase-digest": (
            evidence.replace(installed_hash, installed_hash.upper()),
            installer_hash,
            installer_hash,
        ),
        "zero-required-counter": (
            evidence.replace("extraction_files=11", "extraction_files=0"),
            installer_hash,
            installer_hash,
        ),
        "noncanonical-leading-zero": (
            evidence.replace("installed_archives=1", "installed_archives=01"),
            installer_hash,
            installer_hash,
        ),
        "inconsistent-archive-counters": (
            evidence.replace("installed_archives=1", "installed_archives=0"),
            installer_hash,
            installer_hash,
        ),
    }
    for name, (candidate, manifest_hash, setup_hash) in invalid_cases.items():
        result = _run_windows_powershell(
            root,
            r'''
$ErrorActionPreference = "Stop"
. $env:PRYNX_TEST_HELPER
$null = Assert-PrynXReleaseSecretScanEvidenceV2 `
    -Evidence $env:PRYNX_TEST_EVIDENCE `
    -ManifestInstallerSha256 $env:PRYNX_TEST_MANIFEST_HASH `
    -SetupSha256 $env:PRYNX_TEST_SETUP_HASH
''',
            {
                "PRYNX_TEST_HELPER": str(
                    root / "scripts" / "windows_payload_guard.ps1"
                ),
                "PRYNX_TEST_EVIDENCE": candidate,
                "PRYNX_TEST_MANIFEST_HASH": manifest_hash,
                "PRYNX_TEST_SETUP_HASH": setup_hash,
            },
        )
        assert result.returncode != 0, name


@pytest.mark.skipif(os.name != "nt", reason="Release payload scanner chi chay tren Windows")
def test_release_secret_scanner_rejects_reparse_directory(tmp_path: Path):
    """Scanner phải dừng ở reparse point, không duyệt sang cây ngoài artifact."""
    root = Path(__file__).parents[2]
    powershell = shutil.which("powershell.exe") or shutil.which("powershell")
    if not powershell:
        pytest.skip("Windows PowerShell khong co trong PATH")

    scan_root = tmp_path / "payload"
    outside = tmp_path / "outside"
    scan_root.mkdir()
    outside.mkdir()
    (scan_root / "safe.bin").write_bytes(b"public")
    (outside / "public.bin").write_bytes(b"public")
    link = scan_root / "linked-payload"
    try:
        os.symlink(outside, link, target_is_directory=True)
    except (NotImplementedError, OSError) as error:
        pytest.skip(f"Runner khong cho tao directory symlink: {error}")

    env = os.environ.copy()
    env.pop("PSMODULEPATH", None)
    env["PRYNX_TEST_SCAN_ROOT"] = str(scan_root)
    env["PRYNX_TEST_HELPER"] = str(root / "scripts" / "windows_payload_guard.ps1")
    command = (
        ". $env:PRYNX_TEST_HELPER; "
        "Assert-PrynXReleasePayloadSecretFree "
        "-TreeRoots @($env:PRYNX_TEST_SCAN_ROOT) -Purpose test | Out-Null"
    )
    completed = subprocess.run(
        [
            powershell,
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            command,
        ],
        cwd=root,
        env=env,
        text=True,
        capture_output=True,
        timeout=30,
        check=False,
    )
    assert completed.returncode != 0
    assert "Reparse point detected" in completed.stderr


def test_sec20_s3_connects_v2_evidence_and_leased_upload_gate():
    """Verifier ghi v2; publisher khóa manifest/asset và recheck trước mỗi gh."""
    root = Path(__file__).parents[2]
    helper = (root / "scripts" / "windows_payload_guard.ps1").read_text(
        encoding="utf-8"
    )
    build = (root / "build_production.ps1").read_text(encoding="utf-8")
    verifier = (root / "scripts" / "verify_installed_artifact.ps1").read_text(
        encoding="utf-8"
    )
    publisher = (root / "release_update.ps1").read_text(encoding="utf-8")

    assert "16MB" not in helper
    assert "ReadAllText" not in helper
    assert "Invoke-PrynXReleaseSecretStreamScan" in helper
    assert "Invoke-PrynXZipReleaseSecretScan" in helper
    assert "Test-PrynXOpaqueArchiveExtension" in helper
    assert "Assert-PrynXNoAlternateDataStream" in helper
    assert "FileAttributes]::ReparsePoint" in helper
    assert "Assert-PrynXReleaseSecretSafeName" in helper

    frontend_build = build.index("$script:PrynXNpmCliPath run build")
    exact_scan = build.index("$tauriSecretScan = Assert-PrynXReleasePayloadSecretFree")
    tauri_bundle = build.index(
        "& $script:PrynXNodePath $tauriCliPath build --config $tauriConfig",
        exact_scan,
    )
    assert frontend_build < exact_scan < tauri_bundle
    for configured_input in (
        "binaries/tesseract/**/*",
        "binaries/payload-manifest.json",
        "bin/pdfium.dll",
        "icons/file-pdf.ico",
        "THIRD_PARTY_NOTICES.md",
        "installer-hooks.nsh",
        "binaries/pdf-inspector-backend",
    ):
        assert configured_input in build
    manifest_creation = build[build.index("$manifestLines = @(") :]
    assert "RELEASE_SECRET_SCAN" not in manifest_creation

    installed_scan = verifier.index(
        "$installedSecretScan = Assert-PrynXReleasePayloadSecretFree"
    )
    runtime_smoke = verifier.index("# -- 4. Runtime smoke", installed_scan)
    manifest_update = verifier.index("# -- 5. Cap nhat manifest", runtime_smoke)
    evidence_write = verifier.index(
        '@{ Name = "RELEASE_SECRET_SCAN_V2"', manifest_update
    )
    assert installed_scan < runtime_smoke < manifest_update < evidence_write

    helper_load = publisher.index('. "$ROOT\\scripts\\release_executable_guard.ps1"')
    evidence_gate = publisher.index("function Assert-ReleaseSecretScanEvidenceV2")
    assert helper_load < evidence_gate
    assert "-Name 'RELEASE_SECRET_SCAN_V2'" in publisher[evidence_gate:]
    assert "-Name 'RELEASE_SECRET_SCAN'" not in publisher
    assert "installed-tree-v1" not in publisher
    verifier_call = publisher.index("-File $verifier", evidence_gate)
    first_gate = publisher.index(
        "Assert-ReleaseSecretScanEvidenceV2 `", verifier_call
    )
    upload = publisher.index("$uploadResult = Invoke-PrynXGitHubCliCommand", first_gate)
    create = publisher.index("$createResult = Invoke-PrynXGitHubCliCommand", first_gate)
    for command, command_at in (("upload", upload), ("create", create)):
        lease_at = publisher.rfind(
            "Open-PrynXReleasePublishLeaseSet `", first_gate, command_at
        )
        source_recheck = publisher.rfind(
            "Assert-ManifestSourceState -ManifestPath $publishLease.Manifest.Path",
            lease_at,
            command_at,
        )
        v2_recheck = publisher.rfind(
            "Assert-ReleaseSecretScanEvidenceV2 `", lease_at, command_at
        )
        setup_handle_hash = publisher.rfind(
            "-SetupSha256 $publishLease.Setup.Sha256", lease_at, command_at
        )
        if command == "upload":
            tag_recheck = publisher.rfind(
                "Assert-GitHubTagTargetsCommit `", lease_at, command_at
            )
        else:
            tag_recheck = publisher.rfind(
                "Assert-GitHubReleaseTagState `", lease_at, command_at
            )
        routing_gate = publisher.rfind(
            "Assert-PrynXGitEnvironmentAuthority", tag_recheck, command_at
        )
        assert lease_at < source_recheck < v2_recheck < tag_recheck
        assert tag_recheck < routing_gate < command_at
        assert v2_recheck < setup_handle_hash < tag_recheck
        result_name = "uploadResult" if command == "upload" else "createResult"
        command_end = publisher.index(
            f"if (${result_name}.ExitCode", command_at
        )
        command_block = publisher[lease_at:command_end]
        for leased_path in (
            "$publishLease.Setup.Path",
            "$publishLease.Signature.Path",
            "$publishLease.Latest.Path",
        ):
            assert leased_path in command_block
        finally_at = publisher.index("} finally {", command_at)
        close_at = publisher.index(
            "Close-PrynXPayloadLease -Lease $publishLease", finally_at
        )
        assert command_at < finally_at < close_at


def test_build_payload_manifest_matches_tauri_resource_root_not_external_bin():
    """Resource manifest không được trộn sidecar externalBin ở app root."""
    source = (Path(__file__).parents[2] / "build_production.ps1").read_text(
        encoding="utf-8"
    )
    manifest_start = source.index("# SEC (audit 2026-09-03 §SEC.23): tạo SHA-256 payload manifest")
    manifest_end = source.index("# ---- Step 3: Compute SHA-256", manifest_start)
    block = source[manifest_start:manifest_end]

    assert "$externalSidecarPaths = @(" in block
    assert '"$SIDECAR_NAME.exe"' in block
    assert '"$SIDECAR_NAME-$TARGET_TRIPLE.exe"' in block
    assert "$payloadManifestExcludedPaths = @($externalSidecarPaths | Sort-Object -Unique)" in block
    assert "-ExcludedRelativePaths $payloadManifestExcludedPaths" in block
    assert "$manifestEntries = @($script:TesseractPayloadLock.Entries" in block
    assert "path = 'tesseract/' + [string]$_.Path" in block
    assert "$stagingFiles" not in block
    assert "Assert-PayloadManifestMatchesStaging `" in block


def test_tesseract_payload_lock_pins_reviewed_provenance():
    """Lock committed phải đóng đúng version, nguồn và exact allowlist đã review."""
    root = Path(__file__).parents[2]
    lock_path = root / "scripts" / "tesseract_payload.lock.json"
    assert hashlib.sha256(lock_path.read_bytes()).hexdigest() == (
        "c177a65470e06ae95d3fba9c712827cc84392151dc4e4fcc4f895625a99ffc4c"
    )
    document = json.loads(lock_path.read_text(encoding="utf-8"))

    assert document["schema_version"] == 1
    assert document["component_id"] == "tesseract"
    assert document["component_version"] == "5.4.0.20240606"
    installer = document["provenance"]["installer"]
    assert installer == {
        "package_id": "UB-Mannheim.TesseractOCR",
        "url": (
            "https://github.com/UB-Mannheim/tesseract/releases/download/"
            "v5.4.0.20240606/tesseract-ocr-w64-setup-5.4.0.20240606.exe"
        ),
        "sha256": "c885fff6998e0608ba4bb8ab51436e1c6775c2bafc2559a19b423e18678b60c9",
        "verified_by": "WinGet manifest",
    }
    supplements = document["provenance"]["supplements"]
    assert supplements == [
        {
            "path": "tessdata/vie.traineddata",
            "repository": "https://github.com/tesseract-ocr/tessdata",
            "commit": "fb1266d52b0a93ef27dbff54ecd422809c9c4f68",
            "url": (
                "https://raw.githubusercontent.com/tesseract-ocr/tessdata/"
                "fb1266d52b0a93ef27dbff54ecd422809c9c4f68/vie.traineddata"
            ),
            "sha256": "164d9bed7e5a6444586d39434cc1adf4df976cfe23cffd6468e444c94703640a",
        }
    ]

    entries = document["files"]
    assert document["file_count"] == len(entries) == 115
    paths = [entry["path"] for entry in entries]
    assert len({path.casefold() for path in paths}) == 115
    assert {"tesseract.exe", "tessdata/eng.traineddata", "tessdata/vie.traineddata"} <= set(paths)
    assert all(re.fullmatch(r"[0-9a-f]{64}", entry["sha256"]) for entry in entries)
    assert all(isinstance(entry["size"], int) and entry["size"] >= 0 for entry in entries)
    assert all(
        entry["origin"] in {"ub-mannheim-installer", "tesseract-tessdata-commit"}
        for entry in entries
    )


def _run_windows_powershell(
    root: Path,
    script: str,
    environment: dict[str, str],
) -> subprocess.CompletedProcess[str]:
    if os.name != "nt":
        pytest.skip("Windows PowerShell 5.1 chi co tren Windows")
    system_root = Path(os.environ.get("SystemRoot", r"C:\Windows"))
    powershell = (
        system_root
        / "System32"
        / "WindowsPowerShell"
        / "v1.0"
        / "powershell.exe"
    )
    if not powershell.is_file():
        pytest.skip("Khong tim thay Windows PowerShell 5.1 trong System32")
    env = os.environ.copy()
    env.pop("PSMODULEPATH", None)
    env.update(environment)
    encoded = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
    return subprocess.run(
        [
            str(powershell),
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
            encoded,
        ],
        cwd=root,
        env=env,
        text=True,
        capture_output=True,
        timeout=30,
        check=False,
    )


def test_tesseract_payload_lock_is_accepted_by_windows_guard():
    """Parser fail-closed dùng trong build/verifier phải đọc được lock thật trên PS5.1."""
    root = Path(__file__).parents[2]
    result = _run_windows_powershell(
        root,
        r'''
$ErrorActionPreference = "Stop"
. $env:PRYNX_TEST_HELPER
$lock = Read-PrynXTesseractPayloadLock -Path $env:PRYNX_TEST_LOCK
try {
    if (@($lock.Entries).Count -ne 115) { throw "Unexpected entry count." }
    if ($lock.LockSha256 -ne $env:PRYNX_TEST_LOCK_HASH) { throw "Unexpected lock hash." }
    "TESSERACT_LOCK_GUARD_OK"
} finally {
    Close-PrynXPayloadLease -Lease $lock.LockLease
}
''',
        {
            "PRYNX_TEST_HELPER": str(root / "scripts" / "windows_payload_guard.ps1"),
            "PRYNX_TEST_LOCK": str(root / "scripts" / "tesseract_payload.lock.json"),
            "PRYNX_TEST_LOCK_HASH": (
                "c177a65470e06ae95d3fba9c712827cc84392151dc4e4fcc4f895625a99ffc4c"
            ),
        },
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "TESSERACT_LOCK_GUARD_OK" in result.stdout


def test_tesseract_copy_uses_exact_allowlist_and_rejects_missing_or_hash_drift(
    tmp_path: Path,
):
    """Copy phải đọc qua lease: nguồn thừa bị bỏ, thiếu/đổi byte thì fail-closed."""
    root = Path(__file__).parents[2]
    helper = root / "scripts" / "windows_payload_guard.ps1"
    source_root = tmp_path / "source"
    (source_root / "tessdata").mkdir(parents=True)
    expected_bytes = {
        "tesseract.exe": b"fixture-executable",
        "tessdata/eng.traineddata": b"fixture-language-data",
    }
    for relative_path, content in expected_bytes.items():
        path = source_root / Path(relative_path)
        path.write_bytes(content)
    (source_root / "debug-only.exe").write_bytes(b"must-not-be-copied")

    entries = [
        {
            "Path": relative_path,
            "Hash": hashlib.sha256(content).hexdigest(),
            "Size": len(content),
        }
        for relative_path, content in expected_bytes.items()
    ]
    probe = r'''
$ErrorActionPreference = "Stop"
. $env:PRYNX_TEST_HELPER
$entryDocument = $env:PRYNX_TEST_ENTRIES | ConvertFrom-Json
$entries = @($entryDocument.files)
$lock = [pscustomobject]@{ Entries = $entries }
try {
    $null = Copy-PrynXTesseractPayload `
        -Lock $lock `
        -SourceRoot $env:PRYNX_TEST_SOURCE `
        -DestinationRoot $env:PRYNX_TEST_DESTINATION
} catch {
    "COPY_REJECTED=$($_.Exception.Message)"
    exit 23
}
"COPY_ALLOWLIST_OK"
'''

    def run_copy(destination: Path) -> subprocess.CompletedProcess[str]:
        return _run_windows_powershell(
            root,
            probe,
            {
                "PRYNX_TEST_HELPER": str(helper),
                "PRYNX_TEST_ENTRIES": json.dumps({"files": entries}),
                "PRYNX_TEST_SOURCE": str(source_root),
                "PRYNX_TEST_DESTINATION": str(destination),
            },
        )

    destination = tmp_path / "copied"
    accepted = run_copy(destination)
    assert accepted.returncode == 0, accepted.stdout + accepted.stderr
    assert "COPY_ALLOWLIST_OK" in accepted.stdout
    copied_paths = {
        path.relative_to(destination).as_posix()
        for path in destination.rglob("*")
        if path.is_file()
    }
    assert copied_paths == set(expected_bytes)
    assert not (destination / "debug-only.exe").exists()

    language_file = source_root / "tessdata" / "eng.traineddata"
    language_file.unlink()
    missing = run_copy(tmp_path / "missing-destination")
    assert missing.returncode != 0
    assert "COPY_REJECTED=SEC: Missing Tesseract source" in missing.stdout

    language_file.write_bytes(b"X" * len(expected_bytes["tessdata/eng.traineddata"]))
    tampered = run_copy(tmp_path / "tampered-destination")
    assert tampered.returncode != 0
    assert "COPY_REJECTED=SEC: SHA-256 mismatch" in tampered.stdout


def test_payload_file_lease_rejects_real_hardlink_and_blocks_mutation(tmp_path: Path):
    """Lease phải bắt link-count thật và khóa write/delete đến lúc Dispose."""
    root = Path(__file__).parents[2]
    helper = root / "scripts" / "windows_payload_guard.ps1"
    hardlink_target = tmp_path / "hardlink-target.bin"
    hardlink_alias = tmp_path / "hardlink-alias.bin"
    hardlink_target.write_bytes(b"hardlink-fixture")
    try:
        os.link(hardlink_target, hardlink_alias)
    except OSError as error:
        pytest.skip(f"Filesystem khong ho tro hardlink fixture: {error}")

    hardlink_probe = r'''
$ErrorActionPreference = "Stop"
. $env:PRYNX_TEST_HELPER
$null = Open-PrynXPayloadFileLease `
    -Path $env:PRYNX_TEST_FILE `
    -ExpectedSha256 $env:PRYNX_TEST_HASH `
    -Purpose "hardlink fixture"
'''
    hardlink_result = _run_windows_powershell(
        root,
        hardlink_probe,
        {
            "PRYNX_TEST_HELPER": str(helper),
            "PRYNX_TEST_FILE": str(hardlink_target),
            "PRYNX_TEST_HASH": hashlib.sha256(hardlink_target.read_bytes()).hexdigest(),
        },
    )
    assert hardlink_result.returncode != 0
    assert "link-count=2" in hardlink_result.stderr
    hardlink_alias.unlink()

    leased_file = tmp_path / "leased.bin"
    leased_file.write_bytes(b"immutable-while-open")
    lease_probe = r'''
$ErrorActionPreference = "Stop"
. $env:PRYNX_TEST_HELPER
$lease = Open-PrynXPayloadFileLease `
    -Path $env:PRYNX_TEST_FILE `
    -ExpectedSha256 $env:PRYNX_TEST_HASH `
    -Purpose "lease fixture"
try {
    $writeBlocked = $false
    try { [System.IO.File]::WriteAllText($env:PRYNX_TEST_FILE, "blocked") } catch { $writeBlocked = $true }
    $deleteBlocked = $false
    try { Remove-Item -LiteralPath $env:PRYNX_TEST_FILE -Force -ErrorAction Stop } catch { $deleteBlocked = $true }
    if (-not $writeBlocked -or -not $deleteBlocked) {
        throw "Payload lease did not block write/delete."
    }
} finally {
    Close-PrynXPayloadLease -Lease $lease
}
[System.IO.File]::WriteAllText($env:PRYNX_TEST_FILE, "allowed-after-dispose")
Remove-Item -LiteralPath $env:PRYNX_TEST_FILE -Force -ErrorAction Stop
if (Test-Path -LiteralPath $env:PRYNX_TEST_FILE) { throw "Payload remained after Dispose." }
"PAYLOAD_LEASE_OK"
'''
    lease_result = _run_windows_powershell(
        root,
        lease_probe,
        {
            "PRYNX_TEST_HELPER": str(helper),
            "PRYNX_TEST_FILE": str(leased_file),
            "PRYNX_TEST_HASH": hashlib.sha256(leased_file.read_bytes()).hexdigest(),
        },
    )
    assert lease_result.returncode == 0, lease_result.stdout + lease_result.stderr
    assert "PAYLOAD_LEASE_OK" in lease_result.stdout
    assert not leased_file.exists()


def test_installer_identity_lease_survives_delayed_consumer_and_blocks_swap(
    tmp_path: Path,
):
    """Consumer đọc trễ vẫn thấy byte đã hash; writer/rename bị chặn tới Dispose."""
    root = Path(__file__).parents[2]
    container = tmp_path / "installer-parent"
    container.mkdir()
    installer = container / "PrynX_setup.bin"
    installer.write_bytes(b"trusted-installer-bytes")
    result = _run_windows_powershell(
        root,
        r'''
$ErrorActionPreference = "Stop"
. $env:PRYNX_TEST_HELPER
$directoryLease = Open-PrynXPayloadDirectoryChainLease `
    -DirectoryPath (Split-Path -Parent $env:PRYNX_TEST_INSTALLER) `
    -Purpose "delayed installer ancestor"
$fileLease = Open-PrynXPayloadFileLease `
    -Path $env:PRYNX_TEST_INSTALLER `
    -ExpectedSha256 $env:PRYNX_TEST_INSTALLER_HASH `
    -Purpose "delayed installer"
try {
    $childScript = @'
Start-Sleep -Milliseconds 500
$bytes = [IO.File]::ReadAllBytes($env:PRYNX_TEST_INSTALLER)
$hash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($bytes)).Replace('-', '').ToLowerInvariant()
if ($hash -ne $env:PRYNX_TEST_INSTALLER_HASH) { throw "Delayed consumer read swapped bytes." }
"DELAYED_READ_OK"
'@
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($childScript))
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
    $startInfo.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $encoded"
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $consumer = [Diagnostics.Process]::Start($startInfo)
    Start-Sleep -Milliseconds 100

    $writeBlocked = $false
    try { [IO.File]::WriteAllText($env:PRYNX_TEST_INSTALLER, "swapped") } catch { $writeBlocked = $true }
    $renameBlocked = $false
    try { [IO.Directory]::Move($env:PRYNX_TEST_PARENT, $env:PRYNX_TEST_PARENT_RENAMED) } catch { $renameBlocked = $true }
    if (-not $writeBlocked -or -not $renameBlocked) {
        throw "Installer identity lease did not block swap/ancestor rename."
    }
    if (-not $consumer.WaitForExit(5000)) { $consumer.Kill(); throw "Delayed consumer timed out." }
    $consumerOutput = $consumer.StandardOutput.ReadToEnd()
    if ($consumer.ExitCode -ne 0 -or $consumerOutput -notmatch "DELAYED_READ_OK") {
        throw "Delayed consumer failed with exit code $($consumer.ExitCode)."
    }
} finally {
    if ($null -ne $consumer) { $consumer.Dispose() }
    Close-PrynXPayloadLease -Lease $fileLease
    Close-PrynXPayloadLease -Lease $directoryLease
}
[IO.File]::WriteAllText($env:PRYNX_TEST_INSTALLER, "allowed-after-dispose")
"INSTALLER_DELAYED_LEASE_OK"
''',
        {
            "PRYNX_TEST_HELPER": str(root / "scripts" / "windows_payload_guard.ps1"),
            "PRYNX_TEST_INSTALLER": str(installer),
            "PRYNX_TEST_INSTALLER_HASH": hashlib.sha256(
                installer.read_bytes()
            ).hexdigest(),
            "PRYNX_TEST_PARENT": str(container),
            "PRYNX_TEST_PARENT_RENAMED": str(tmp_path / "installer-parent-renamed"),
        },
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "INSTALLER_DELAYED_LEASE_OK" in result.stdout
    assert installer.read_text() == "allowed-after-dispose"


@pytest.mark.skipif(os.name != "nt", reason="Publish lease chi chay tren Windows")
def test_publish_lease_survives_delayed_consumer_and_blocks_all_path_swaps(
    tmp_path: Path,
):
    """Ba asset + manifest giữ đúng byte/path đến khi child consumer đọc xong."""
    root = Path(__file__).parents[2]
    publish_parent = tmp_path / "publish-parent"
    stage = publish_parent / "stage"
    stage.mkdir(parents=True)
    manifest_parent = tmp_path / "manifest-parent"
    manifest_parent.mkdir()

    setup = stage / "PrynX_setup.exe"
    signature = stage / "PrynX_setup.exe.sig"
    latest = stage / "latest.json"
    replacement = stage / "latest-replacement.tmp"
    manifest = manifest_parent / "release-manifest.txt"
    setup.write_bytes(b"leased-setup-bytes")
    signature.write_bytes(b"leased-signature-bytes")
    latest.write_bytes(b"leased-latest-bytes")
    replacement.write_bytes(b"replacement-latest")
    manifest.write_bytes(b"leased-manifest-bytes")

    def sha256(path: Path) -> str:
        return hashlib.sha256(path.read_bytes()).hexdigest()

    renamed_parent = tmp_path / "publish-parent-renamed"
    result = _run_windows_powershell(
        root,
        r'''
$ErrorActionPreference = "Stop"
. $env:PRYNX_TEST_HELPER
$publishLease = $null
$consumer = $null
try {
    $publishLease = Open-PrynXReleasePublishLeaseSet `
        -StageRoot $env:PRYNX_TEST_STAGE `
        -SetupPath $env:PRYNX_TEST_SETUP `
        -SetupSha256 $env:PRYNX_TEST_SETUP_HASH `
        -SignaturePath $env:PRYNX_TEST_SIGNATURE `
        -SignatureSha256 $env:PRYNX_TEST_SIGNATURE_HASH `
        -LatestPath $env:PRYNX_TEST_LATEST `
        -LatestSha256 $env:PRYNX_TEST_LATEST_HASH `
        -ManifestPath $env:PRYNX_TEST_MANIFEST

    $childScript = @'
Start-Sleep -Milliseconds 700
$records = @(
    @{ Path = $env:PRYNX_TEST_SETUP; Hash = $env:PRYNX_TEST_SETUP_HASH },
    @{ Path = $env:PRYNX_TEST_SIGNATURE; Hash = $env:PRYNX_TEST_SIGNATURE_HASH },
    @{ Path = $env:PRYNX_TEST_LATEST; Hash = $env:PRYNX_TEST_LATEST_HASH },
    @{ Path = $env:PRYNX_TEST_MANIFEST; Hash = $env:PRYNX_TEST_MANIFEST_HASH }
)
foreach ($record in $records) {
    $actual = (Get-FileHash -LiteralPath $record.Path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $record.Hash) { throw "Delayed publisher consumer read swapped bytes." }
}
"PUBLISH_DELAYED_READ_OK"
'@
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($childScript))
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
    $startInfo.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $encoded"
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $consumer = [Diagnostics.Process]::Start($startInfo)
    Start-Sleep -Milliseconds 100

    $writeBlocked = $false
    try { [IO.File]::WriteAllText($env:PRYNX_TEST_SETUP, "swapped") } catch { $writeBlocked = $true }
    $deleteBlocked = $false
    try { [IO.File]::Delete($env:PRYNX_TEST_SIGNATURE) } catch { $deleteBlocked = $true }
    $replaceBlocked = $false
    try { [IO.File]::Replace($env:PRYNX_TEST_REPLACEMENT, $env:PRYNX_TEST_LATEST, $env:PRYNX_TEST_BACKUP) } catch { $replaceBlocked = $true }
    $fileRenameBlocked = $false
    try { [IO.File]::Move($env:PRYNX_TEST_SETUP, $env:PRYNX_TEST_SETUP_RENAMED) } catch { $fileRenameBlocked = $true }
    $manifestWriteBlocked = $false
    try { [IO.File]::WriteAllText($env:PRYNX_TEST_MANIFEST, "swapped") } catch { $manifestWriteBlocked = $true }
    $parentRenameBlocked = $false
    try { [IO.Directory]::Move($env:PRYNX_TEST_PARENT, $env:PRYNX_TEST_PARENT_RENAMED) } catch { $parentRenameBlocked = $true }

    if (-not $writeBlocked -or -not $deleteBlocked -or -not $replaceBlocked -or
        -not $fileRenameBlocked -or -not $manifestWriteBlocked -or
        -not $parentRenameBlocked) {
        throw "Publish lease did not block every byte/path swap primitive."
    }
    if (-not (Test-Path -LiteralPath $env:PRYNX_TEST_SETUP -PathType Leaf) -or
        -not (Test-Path -LiteralPath $env:PRYNX_TEST_SIGNATURE -PathType Leaf) -or
        -not (Test-Path -LiteralPath $env:PRYNX_TEST_LATEST -PathType Leaf) -or
        -not (Test-Path -LiteralPath $env:PRYNX_TEST_MANIFEST -PathType Leaf) -or
        -not (Test-Path -LiteralPath $env:PRYNX_TEST_REPLACEMENT -PathType Leaf) -or
        (Test-Path -LiteralPath $env:PRYNX_TEST_BACKUP) -or
        (Test-Path -LiteralPath $env:PRYNX_TEST_SETUP_RENAMED) -or
        -not (Test-Path -LiteralPath $env:PRYNX_TEST_PARENT -PathType Container) -or
        (Test-Path -LiteralPath $env:PRYNX_TEST_PARENT_RENAMED)) {
        throw "A blocked publish mutation still changed the fixture."
    }

    if (-not $consumer.WaitForExit(5000)) {
        $consumer.Kill()
        throw "Delayed publisher consumer timed out."
    }
    $consumerOutput = $consumer.StandardOutput.ReadToEnd()
    $consumerError = $consumer.StandardError.ReadToEnd()
    if ($consumer.ExitCode -ne 0 -or $consumerOutput -notmatch "PUBLISH_DELAYED_READ_OK") {
        throw "Delayed publisher consumer failed: $consumerError"
    }
} finally {
    if ($null -ne $consumer) {
        try {
            if (-not $consumer.HasExited -and -not $consumer.WaitForExit(5000)) {
                $consumer.Kill()
                $consumer.WaitForExit()
            }
        } catch {}
        $consumer.Dispose()
    }
    Close-PrynXPayloadLease -Lease $publishLease
}

[IO.File]::WriteAllText($env:PRYNX_TEST_SETUP, "allowed-after-dispose")
[IO.File]::Move($env:PRYNX_TEST_SETUP, $env:PRYNX_TEST_SETUP_RENAMED)
[IO.File]::Move($env:PRYNX_TEST_SETUP_RENAMED, $env:PRYNX_TEST_SETUP)
[IO.File]::Replace($env:PRYNX_TEST_REPLACEMENT, $env:PRYNX_TEST_LATEST, $env:PRYNX_TEST_BACKUP)
[IO.File]::Delete($env:PRYNX_TEST_BACKUP)
[IO.File]::Delete($env:PRYNX_TEST_SIGNATURE)
[IO.File]::WriteAllText($env:PRYNX_TEST_MANIFEST, "manifest-after-dispose")
[IO.Directory]::Move($env:PRYNX_TEST_PARENT, $env:PRYNX_TEST_PARENT_RENAMED)
"PUBLISH_LEASE_ALL_MUTATIONS_OK"
''',
        {
            "PRYNX_TEST_HELPER": str(root / "scripts" / "windows_payload_guard.ps1"),
            "PRYNX_TEST_STAGE": str(stage),
            "PRYNX_TEST_SETUP": str(setup),
            "PRYNX_TEST_SETUP_HASH": sha256(setup),
            "PRYNX_TEST_SETUP_RENAMED": str(stage / "PrynX_setup-renamed.exe"),
            "PRYNX_TEST_SIGNATURE": str(signature),
            "PRYNX_TEST_SIGNATURE_HASH": sha256(signature),
            "PRYNX_TEST_LATEST": str(latest),
            "PRYNX_TEST_LATEST_HASH": sha256(latest),
            "PRYNX_TEST_REPLACEMENT": str(replacement),
            "PRYNX_TEST_BACKUP": str(stage / "latest-backup.tmp"),
            "PRYNX_TEST_MANIFEST": str(manifest),
            "PRYNX_TEST_MANIFEST_HASH": sha256(manifest),
            "PRYNX_TEST_PARENT": str(publish_parent),
            "PRYNX_TEST_PARENT_RENAMED": str(renamed_parent),
        },
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "PUBLISH_LEASE_ALL_MUTATIONS_OK" in result.stdout
    moved_stage = renamed_parent / "stage"
    assert not publish_parent.exists()
    assert (moved_stage / setup.name).read_text() == "allowed-after-dispose"
    assert not (moved_stage / signature.name).exists()
    assert (moved_stage / latest.name).read_text() == "replacement-latest"
    assert manifest.read_text() == "manifest-after-dispose"


def test_installed_verifier_holds_installer_identity_across_start_process():
    """Verifier phải launch đúng leased path và chỉ nhả lease trong outer finally."""
    source = (
        Path(__file__).parents[2] / "scripts" / "verify_installed_artifact.ps1"
    ).read_text(encoding="utf-8")
    directory_lease = source.index(
        "$script:InstallerDirectoryLease = Open-PrynXPayloadDirectoryChainLease"
    )
    file_lease = source.index(
        "$script:InstallerFileLease = Open-PrynXPayloadFileLease", directory_lease
    )
    start_process = source.index(
        "Start-Process -FilePath $script:InstallerFileLease.Path", file_lease
    )
    outer_finally = source.rindex("} finally {")
    file_close = source.index(
        "@{ Name = 'Installer file identity lease'; Value = $script:InstallerFileLease }",
        outer_finally,
    )
    directory_close = source.index(
        "@{ Name = 'Installer ancestor identity lease'; Value = $script:InstallerDirectoryLease }",
        file_close,
    )
    assert directory_lease < file_lease < start_process < outer_finally
    assert outer_finally < file_close < directory_close


def test_release_secret_scanner_rejects_real_hardlink(tmp_path: Path):
    """Scanner byte-level cũng phải fail-closed theo link-count của handle."""
    root = Path(__file__).parents[2]
    payload = tmp_path / "scanner-hardlink.bin"
    alias = tmp_path / "scanner-hardlink-alias.bin"
    payload.write_bytes(b"public-but-multi-linked")
    try:
        os.link(payload, alias)
    except OSError as error:
        pytest.skip(f"Filesystem khong ho tro hardlink fixture: {error}")

    result = _run_windows_powershell(
        root,
        r'''
$ErrorActionPreference = "Stop"
. $env:PRYNX_TEST_HELPER
$null = Assert-PrynXReleasePayloadSecretFree `
    -Files @($env:PRYNX_TEST_FILE) `
    -Purpose "scanner-hardlink-fixture"
''',
        {
            "PRYNX_TEST_HELPER": str(root / "scripts" / "windows_payload_guard.ps1"),
            "PRYNX_TEST_FILE": str(payload),
        },
    )
    assert result.returncode != 0
    assert "Hardlink detected in release payload (link-count=2)" in result.stderr


def test_payload_lease_set_pins_tree_identity_and_rechecks_persistent_surplus(
    tmp_path: Path,
):
    """Rename bị khóa; child mới là proof gap nhưng exact-set kế tiếp phải bắt được."""
    root = Path(__file__).parents[2]
    container = tmp_path / "lease-container"
    payload_root = container / "payload"
    descendant = payload_root / "tessdata"
    cargo_target = container / "target" / "release"
    descendant.mkdir(parents=True)
    cargo_target.mkdir(parents=True)
    payload_files = {
        "engine.exe": b"engine-fixture",
        "tessdata/eng.traineddata": b"language-fixture",
    }
    entries = []
    for relative_path, content in payload_files.items():
        path = payload_root / Path(relative_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        entries.append(
            {
                "Path": relative_path,
                "Hash": hashlib.sha256(content).hexdigest(),
                "Size": len(content),
            }
        )

    result = _run_windows_powershell(
        root,
        r'''
$ErrorActionPreference = "Stop"
. $env:PRYNX_TEST_HELPER
$entries = @(($env:PRYNX_TEST_ENTRIES | ConvertFrom-Json).Entries)
$lease = Open-PrynXPayloadLeaseSet `
    -Root $env:PRYNX_TEST_PAYLOAD_ROOT `
    -Entries $entries `
    -Purpose "payload-tree-fixture"
try {
    $childScript = @'
$ErrorActionPreference = "Stop"
$rootCreateSucceeded = $false
try { [IO.File]::WriteAllText($env:PRYNX_TEST_ROOT_SURPLUS, "surplus") ; $rootCreateSucceeded = $true } catch {}
$childCreateSucceeded = $false
try { [IO.File]::WriteAllText($env:PRYNX_TEST_CHILD_SURPLUS, "surplus") ; $childCreateSucceeded = $true } catch {}
$rootRenameBlocked = $false
try { [IO.Directory]::Move($env:PRYNX_TEST_PAYLOAD_ROOT, $env:PRYNX_TEST_PAYLOAD_RENAMED) } catch { $rootRenameBlocked = $true }
$ancestorRenameBlocked = $false
try { [IO.Directory]::Move($env:PRYNX_TEST_CONTAINER, $env:PRYNX_TEST_CONTAINER_RENAMED) } catch { $ancestorRenameBlocked = $true }
$targetWriteSucceeded = $false
try {
    [IO.File]::WriteAllText($env:PRYNX_TEST_TARGET_OUTPUT, "cargo-write-ok")
    $targetWriteSucceeded = $true
} catch {}
if (-not $rootCreateSucceeded -or -not $childCreateSucceeded -or
    -not $rootRenameBlocked -or -not $ancestorRenameBlocked -or
    -not $targetWriteSucceeded) {
    throw "Directory identity contract failed: rootCreate=$rootCreateSucceeded childCreate=$childCreateSucceeded rootRename=$rootRenameBlocked ancestorRename=$ancestorRenameBlocked target=$targetWriteSucceeded"
}
"LEASE_CHILD_OK"
'@
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($childScript))
    $childOutput = @(& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" `
        -NoProfile -ExecutionPolicy Bypass -EncodedCommand $encoded)
    if ($LASTEXITCODE -ne 0 -or $childOutput -notcontains "LEASE_CHILD_OK") {
        throw "Child lease probe failed with exit code $LASTEXITCODE."
    }
    $surplusRejected = $false
    try {
        Assert-PrynXPayloadRootExactSet `
            -Root $env:PRYNX_TEST_PAYLOAD_ROOT `
            -Entries $entries
    } catch {
        if ($_.Exception.Message -like "SEC: Surplus file in payload tree:*") {
            $surplusRejected = $true
        } else {
            throw
        }
    }
    if (-not $surplusRejected) { throw "Persistent surplus escaped exact-set recheck." }
    Remove-Item -LiteralPath $env:PRYNX_TEST_ROOT_SURPLUS -Force
    Remove-Item -LiteralPath $env:PRYNX_TEST_CHILD_SURPLUS -Force
} finally {
    Close-PrynXPayloadLease -Lease $lease
}

[IO.File]::WriteAllText($env:PRYNX_TEST_ROOT_SURPLUS, "allowed")
[IO.File]::WriteAllText($env:PRYNX_TEST_CHILD_SURPLUS, "allowed")
Remove-Item -LiteralPath $env:PRYNX_TEST_ROOT_SURPLUS -Force
Remove-Item -LiteralPath $env:PRYNX_TEST_CHILD_SURPLUS -Force
[IO.Directory]::Move($env:PRYNX_TEST_PAYLOAD_ROOT, $env:PRYNX_TEST_PAYLOAD_RENAMED)
[IO.Directory]::Move($env:PRYNX_TEST_PAYLOAD_RENAMED, $env:PRYNX_TEST_PAYLOAD_ROOT)
[IO.Directory]::Move($env:PRYNX_TEST_CONTAINER, $env:PRYNX_TEST_CONTAINER_RENAMED)
[IO.Directory]::Move($env:PRYNX_TEST_CONTAINER_RENAMED, $env:PRYNX_TEST_CONTAINER)
"PAYLOAD_TREE_LEASE_OK"
''',
        {
            "PRYNX_TEST_HELPER": str(root / "scripts" / "windows_payload_guard.ps1"),
            "PRYNX_TEST_ENTRIES": json.dumps(
                {"Entries": entries}, separators=(",", ":")
            ),
            "PRYNX_TEST_CONTAINER": str(container),
            "PRYNX_TEST_CONTAINER_RENAMED": str(tmp_path / "lease-container-renamed"),
            "PRYNX_TEST_PAYLOAD_ROOT": str(payload_root),
            "PRYNX_TEST_PAYLOAD_RENAMED": str(container / "payload-renamed"),
            "PRYNX_TEST_ROOT_SURPLUS": str(payload_root / "surplus.bin"),
            "PRYNX_TEST_CHILD_SURPLUS": str(descendant / "surplus.bin"),
            "PRYNX_TEST_TARGET_OUTPUT": str(cargo_target / "cargo-output.bin"),
        },
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "PAYLOAD_TREE_LEASE_OK" in result.stdout
    assert (cargo_target / "cargo-output.bin").read_bytes() == b"cargo-write-ok"


def test_directory_boundary_pins_identity_without_claiming_child_creation_seal(
    tmp_path: Path,
):
    """Share-mode khóa rename, cho target ghi, và ghi nhận create-child vẫn mở."""
    root = Path(__file__).parents[2]
    config_root = tmp_path / "src-tauri"
    target_dir = config_root / "target" / "release"
    target_dir.mkdir(parents=True)
    result = _run_windows_powershell(
        root,
        r'''
$ErrorActionPreference = "Stop"
. $env:PRYNX_TEST_HELPER
$lease = Open-PrynXPayloadDirectoryBoundaryLease `
    -Root $env:PRYNX_TEST_CONFIG_ROOT `
    -Purpose "config-boundary-fixture"
try {
$childScript = @'
$ErrorActionPreference = "Stop"
$platformCreateSucceeded = $false
try { [IO.File]::WriteAllText($env:PRYNX_TEST_PLATFORM_CONFIG, "{}") ; $platformCreateSucceeded = $true } catch {}
$configRenameBlocked = $false
try { [IO.Directory]::Move($env:PRYNX_TEST_CONFIG_ROOT, $env:PRYNX_TEST_CONFIG_RENAMED) } catch { $configRenameBlocked = $true }
$targetWriteSucceeded = $false
try {
    [IO.File]::WriteAllText($env:PRYNX_TEST_TARGET_OUTPUT, "target-write-ok")
    $targetWriteSucceeded = $true
} catch {}
if (-not $platformCreateSucceeded -or -not $configRenameBlocked -or -not $targetWriteSucceeded) {
    throw "Config identity contract failed: platformCreate=$platformCreateSucceeded rename=$configRenameBlocked target=$targetWriteSucceeded"
}
"CONFIG_CHILD_OK"
'@
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($childScript))
    $childOutput = @(& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" `
        -NoProfile -ExecutionPolicy Bypass -EncodedCommand $encoded)
    if ($LASTEXITCODE -ne 0 -or $childOutput -notcontains "CONFIG_CHILD_OK") {
        throw "Child config boundary probe failed with exit code $LASTEXITCODE."
    }
} finally {
    Close-PrynXPayloadLease -Lease $lease
}
[IO.Directory]::Move($env:PRYNX_TEST_CONFIG_ROOT, $env:PRYNX_TEST_CONFIG_RENAMED)
[IO.Directory]::Move($env:PRYNX_TEST_CONFIG_RENAMED, $env:PRYNX_TEST_CONFIG_ROOT)
"CONFIG_BOUNDARY_OK"
''',
        {
            "PRYNX_TEST_HELPER": str(root / "scripts" / "windows_payload_guard.ps1"),
            "PRYNX_TEST_CONFIG_ROOT": str(config_root),
            "PRYNX_TEST_CONFIG_RENAMED": str(tmp_path / "src-tauri-renamed"),
            "PRYNX_TEST_PLATFORM_CONFIG": str(
                config_root / "tauri.windows.conf.json"
            ),
            "PRYNX_TEST_TARGET_OUTPUT": str(target_dir / "cargo-output.bin"),
        },
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "CONFIG_BOUNDARY_OK" in result.stdout
    assert (target_dir / "cargo-output.bin").read_bytes() == b"target-write-ok"
    assert (config_root / "tauri.windows.conf.json").read_text() == "{}"


def test_release_sidecar_never_reuses_user_writable_nuitka_payload():
    """Onefile phải giải nén path ngẫu nhiên mỗi lượt, không tin cache CRC32 cũ."""
    root = Path(__file__).parents[2]
    build = (root / "build_production.ps1").read_text(encoding="utf-8")
    verifier = (root / "scripts" / "verify_installed_artifact.ps1").read_text(
        encoding="utf-8"
    )
    tauri_host = (root / "desktop" / "src-tauri" / "src" / "lib.rs").read_text(
        encoding="utf-8"
    )

    assert "--onefile-cache-mode=temporary" in build
    assert (
        '--onefile-tempdir-spec="{TEMP}\\PrynX\\sidecar-{PID}-{TIME_US}-{RANDOM}"'
        in build
    )
    assert "{CACHE_DIR}\\PrynX\\sidecar-{VERSION}" not in build
    assert "Get-ActiveNuitkaExtractionEntry" in verifier
    assert "Get-TrackedSidecarBootstrapRecord" in verifier
    assert "Get-SafeNuitkaPayloadFiles" in verifier
    assert ".Split([char[]]@('\\', '/')," in verifier
    assert (
        "^sidecar-(?<BootstrapPid>[1-9][0-9]{0,9})-"
        "(?<TimeUs>[0-9]{6})-(?<Random>[A-Za-z0-9_-]{11})$"
        in verifier
    )
    assert "Hai luot chay sidecar da tai su dung cung extraction path" in verifier
    assert "sidecar shutdown: graceful" in verifier
    assert "Assert-NoNuitkaExtractionResidue -TempRoot $smokeTemp" in verifier
    assert 'Nuitka temporary cleanup: $($_.Exception.Message)' in verifier
    assert "Get-SidecarCachePath" not in verifier
    assert "Quarantine-NuitkaCache" not in verifier
    assert "start_sidecar_cache_cleanup(sidecar_identity.pid)" in tauri_host
    assert "prune_stale_nuitka_extractions" in tauri_host
    assert tauri_host.count(".env_clear()") == 2
    assert tauri_host.count(".envs(filtered_sidecar_environment())") == 2
    assert "filter_sidecar_environment(std::env::vars_os())" in tauri_host
    for name in (
        "NUITKA_ONEFILE_PARENT",
        "NUITKA_ONEFILE_START",
        "NUITKA_ONEFILE_TIME_US",
        "NUITKA_ONEFILE_RANDOM",
        "NUITKA_ONEFILE_DIRECTORY",
    ):
        assert f'("{name}", "")' not in tauri_host


def test_installed_verifier_binds_nuitka_bootstrap_pid_before_matching_process():
    """Outer và DLL child cùng path; extraction PID phải chọn đúng bootstrap."""
    root = Path(__file__).parents[2]
    verifier_path = root / "scripts" / "verify_installed_artifact.ps1"
    verifier = verifier_path.read_text(encoding="utf-8")

    first_extraction = verifier.index(
        "$appExtraction = Get-ActiveNuitkaExtractionEntry -TempRoot $smokeTemp"
    )
    first_process_match = verifier.index(
        "$sidecarBootstrap = Get-TrackedSidecarBootstrapRecord", first_extraction
    )
    assert first_extraction < first_process_match

    selector_start = verifier.index("function Test-TrackedProcessLineage")
    selector_end = verifier.index("function Get-SafeNuitkaPayloadFiles", selector_start)
    selector = verifier[selector_start:selector_end]
    assert "$record = $script:TrackedProcesses[[string]$BootstrapPid]" in selector
    assert "[int]$record.Id -ne $BootstrapPid" in selector
    assert "Get-TrackedProcessIdentity -Record $record" in selector
    assert "[System.IO.Path]::GetFullPath([string]$record.ExecutablePath)" in selector
    assert "Test-TrackedProcessLineage -Record $record" in selector
    assert "$script:CreatedRoots[[string]$RootProcessId]" in selector
    assert "$visited.ContainsKey($key)" in selector
    assert "$matches.Count -ne 1" not in selector

    powershell = shutil.which("powershell") or shutil.which("pwsh")
    if not powershell:
        pytest.skip("PowerShell khong co trong PATH")

    # Mô phỏng đúng topology Nuitka onefile DLL trên Windows: outer và inner
    # đều chạy từ sidecar EXE đã cài, nhưng tên extraction mang PID của outer.
    probe = f"""
$ErrorActionPreference = "Stop"
{selector}
function Get-TrackedProcessIdentity {{
    param([Parameter(Mandatory = $true)]$Record)
    if ($Record.Live) {{ return [pscustomobject]@{{ Id = [int]$Record.Id }} }}
    return $null
}}
function New-TrackedRecord {{
    param([int]$Id, [int]$ParentId, [long]$CreationTicks, [string]$ExecutablePath)
    return [pscustomobject]@{{
        Id = $Id
        ParentId = $ParentId
        CreationTicks = $CreationTicks
        ExecutablePath = $ExecutablePath
        Live = $true
    }}
}}
$sidecarPath = "C:\\fixture\\pdf-inspector-backend.exe"
$app = New-TrackedRecord -Id 100 -ParentId 0 -CreationTicks 1000 -ExecutablePath "C:\\fixture\\pdf-inspector.exe"
$outer = New-TrackedRecord -Id 200 -ParentId 100 -CreationTicks 2000 -ExecutablePath $sidecarPath
$inner = New-TrackedRecord -Id 201 -ParentId 200 -CreationTicks 2010 -ExecutablePath $sidecarPath
$foreignRoot = New-TrackedRecord -Id 400 -ParentId 0 -CreationTicks 4000 -ExecutablePath "C:\\fixture\\foreign.exe"
$foreign = New-TrackedRecord -Id 300 -ParentId 400 -CreationTicks 3000 -ExecutablePath $sidecarPath
$cycleA = New-TrackedRecord -Id 500 -ParentId 501 -CreationTicks 5000 -ExecutablePath $sidecarPath
$cycleB = New-TrackedRecord -Id 501 -ParentId 500 -CreationTicks 5010 -ExecutablePath $sidecarPath
$wrongId = New-TrackedRecord -Id 601 -ParentId 100 -CreationTicks 6010 -ExecutablePath $sidecarPath
$script:CreatedRoots = @{{ "100" = $app; "400" = $foreignRoot }}
$script:TrackedProcesses = @{{
    "100" = $app
    "200" = $outer
    "201" = $inner
    "300" = $foreign
    "400" = $foreignRoot
    "500" = $cycleA
    "501" = $cycleB
    "600" = $wrongId
}}
$selected = Get-TrackedSidecarBootstrapRecord `
    -SidecarPath $sidecarPath `
    -BootstrapPid 200 `
    -AppRootProcessId 100
if ([int]$selected.Id -ne 200) {{ throw "Khong chon dung outer bootstrap." }}
foreach ($rejectedPid in @(300, 500, 600)) {{
    $rejected = $false
    try {{
        $null = Get-TrackedSidecarBootstrapRecord `
            -SidecarPath $sidecarPath `
            -BootstrapPid $rejectedPid `
            -AppRootProcessId 100
    }} catch {{
        $rejected = $true
    }}
    if (-not $rejected) {{ throw "Chap nhan PID khong thuoc lineage app: $rejectedPid" }}
}}
"NUITKA_PID_BIND_OK"
"""
    encoded = base64.b64encode(probe.encode("utf-16-le")).decode("ascii")
    completed = subprocess.run(
        [
            powershell,
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
            encoded,
        ],
        cwd=root,
        text=True,
        capture_output=True,
        timeout=20,
        check=False,
    )
    assert completed.returncode == 0, completed.stdout + completed.stderr
    assert "NUITKA_PID_BIND_OK" in completed.stdout


def test_updater_cleanup_is_native_and_frontend_fails_closed():
    """Updater không được mở installer nếu cleanup sidecar/worker thất bại."""
    root = Path(__file__).parents[2]
    tauri_host = (root / "desktop" / "src-tauri" / "src" / "lib.rs").read_text(
        encoding="utf-8"
    )
    update_checker = (
        root / "desktop" / "src" / "components" / "UpdateChecker.tsx"
    ).read_text(encoding="utf-8")
    about_modal = (
        root / "desktop" / "src" / "components" / "AboutModal.tsx"
    ).read_text(encoding="utf-8")
    cargo_lock = (root / "desktop" / "src-tauri" / "Cargo.lock").read_text(
        encoding="utf-8"
    )

    # Semantics nguồn đã audit: 2.10.1 gọi cleanup_before_exit ngay trước
    # ShellExecute. Nếu dependency đổi, test buộc re-audit chốt Resource Drop.
    assert 'name = "tauri-plugin-updater"\nversion = "2.10.1"' in cargo_lock
    assert "impl Drop for UpdateExitCleanupResource" in tauri_host
    assert "app.resources_table().add(UpdateExitCleanupResource)" in tauri_host
    assert "RUN_EVENT_EXIT_SEEN.store(true, Ordering::Release)" in tauri_host
    assert "cleanup_children_before_installer()" in tauri_host
    assert "native cleanup failed; installer blocked" in tauri_host

    for caller in (update_checker, about_modal):
        prepare_at = caller.index("await invoke('prepare_for_update')")
        install_at = caller.index("await update.install()", prepare_at)
        between = caller[prepare_at:install_at]
        assert "catch" not in between
        assert prepare_at < install_at
        assert "prepare_for_update failed" not in caller


def test_installed_verifier_requires_one_valid_payload_manifest():
    """Exact-set không được biến thành cảnh báo tuỳ chọn khi manifest thiếu/hỏng."""
    root = Path(__file__).parents[2]
    verifier = (root / "scripts" / "verify_installed_artifact.ps1").read_text(
        encoding="utf-8"
    )

    marker = "# SEC (audit 2026-09-03 §SEC.23): manifest là chốt provenance bắt buộc."
    assert marker in verifier
    marker_at = verifier.index(marker)
    gate_end = verifier.index(
        "Write-Host \"    Verifying exact-set payload inventory...\"",
        marker_at,
    )
    gate = verifier[marker_at:gate_end]
    assert "$payloadManifestPaths.Count -ne 1" in gate
    assert "throw \"SEC: Can dung dung mot payload-manifest.json" in gate
    assert "skipping exact-set check" not in verifier

    # Manifest đã cài không tự làm trust anchor: release manifest neo hash của
    # lock + generated manifest, rồi helper bind schema 2 về allowlist committed.
    assert '. "$PSScriptRoot\\windows_payload_guard.ps1"' in verifier
    assert 'Get-ManifestField -Path $Manifest -Name "TESSERACT_LOCK_SHA256"' in verifier
    assert 'Get-ManifestField -Path $Manifest -Name "PAYLOAD_MANIFEST_SHA256"' in verifier
    assert "$manifestFileMap = Assert-PrynXTesseractManifestMatchesLock" in verifier
    assert "-Lock $script:TesseractPayloadLock" in verifier
    exact_set_end = verifier.index("# -- 4. Runtime smoke", marker_at)
    exact_set = verifier[marker_at:exact_set_end]
    assert "-Recurse -Force -ErrorAction Stop" in exact_set
    assert "-Stream * -ErrorAction Stop" in exact_set
    assert "ErrorAction SilentlyContinue" not in exact_set
    assert "Assert-NoReleaseSecretInInstalledFile" in verifier
    assert "$installedSecretScan = Assert-PrynXReleasePayloadSecretFree" in verifier
    assert "Khong co release secret trong cay cai" in verifier
    assert "Assert-NoReparsePointInPathComponents -Path (Split-Path -Parent" in exact_set
    exact_set_pass = verifier.index(
        'Write-OK "Exact-set payload inventory:', marker_at
    )
    payload_lease = verifier.index(
        "$script:InstalledTesseractLease = Open-PrynXPayloadLeaseSet", marker_at
    )
    tesseract_exec = verifier.index("Invoke-TesseractSmoke", marker_at)
    assert payload_lease < exact_set_pass < tesseract_exec < exact_set_end
    assert "skipping exact-set check" not in verifier

    helper = (root / "scripts" / "windows_payload_guard.ps1").read_text(
        encoding="utf-8"
    )
    assert "GetFileInformationByHandle" in helper
    assert "NumberOfLinks" in helper
    assert "$linkCount -ne 1" in helper
    assert "[System.IO.FileShare]::Read" in helper

    cleanup = verifier[verifier.rindex("} finally {") :]
    keep_install = cleanup.index("if ($KeepInstall)")
    for lease_name in (
        "$script:InstalledTesseractLease",
        "$script:InstalledPayloadManifestLease",
        "$script:InstalledSidecarLease",
        "$script:TesseractPayloadLock.LockLease",
    ):
        assert cleanup.index(lease_name) < keep_install


def _shutdown_headers(secret: str, timestamp: int, nonce: str) -> dict[str, str]:
    timestamp_raw = str(timestamp)
    proof = hmac.new(
        secret.encode(),
        f"shutdown:{timestamp_raw}:{nonce}".encode(),
        hashlib.sha256,
    ).hexdigest()
    return {
        "X-PrynX-Shutdown-Timestamp": timestamp_raw,
        "X-PrynX-Shutdown-Nonce": nonce,
        "X-PrynX-Shutdown-Proof": proof,
    }


def test_shutdown_proof_rejects_bad_hmac_nonce_and_clock_window():
    secret = "test-secret"
    now = 1_700_000_000
    nonce = "00" * 32
    headers = _shutdown_headers(secret, now, nonce)

    assert app_main._verify_shutdown_proof(
        headers["X-PrynX-Shutdown-Timestamp"],
        nonce,
        headers["X-PrynX-Shutdown-Proof"],
        secret,
        now=now,
    )
    assert not app_main._verify_shutdown_proof(
        str(now), nonce, "0" * 64, secret, now=now
    )
    assert not app_main._verify_shutdown_proof(
        str(now), "not-hex", headers["X-PrynX-Shutdown-Proof"], secret, now=now
    )
    for outside_window in (now - 31, now + 31):
        stale = _shutdown_headers(secret, outside_window, nonce)
        assert not app_main._verify_shutdown_proof(
            stale["X-PrynX-Shutdown-Timestamp"],
            nonce,
            stale["X-PrynX-Shutdown-Proof"],
            secret,
            now=now,
        )


def test_shutdown_endpoint_accepts_once_and_requests_uvicorn_exit(monkeypatch):
    secret = "test-secret"
    nonce = "ab" * 32
    headers = _shutdown_headers(secret, int(app_main.time.time()), nonce)

    class _Request:
        def __init__(self, values):
            self.headers = values

    class _Server:
        should_exit = False

    server = _Server()
    background_tasks = BackgroundTasks()
    monkeypatch.setattr(license_guard, "_SIDECAR_TOKEN", secret)
    monkeypatch.setattr(app_main.app.state, "uvicorn_server", server, raising=False)
    app_main._shutdown_nonces.clear()

    async def _accept():
        return await app_main.shutdown_sidecar(_Request(headers), background_tasks)

    assert asyncio.run(_accept()) == {"status": "accepted"}
    assert server.should_exit is False
    asyncio.run(background_tasks())
    assert server.should_exit is True
    with pytest.raises(HTTPException) as replay:
        asyncio.run(app_main.shutdown_sidecar(_Request(headers), BackgroundTasks()))
    assert replay.value.status_code == 409
    app_main._shutdown_nonces.clear()


def test_packaged_entry_uses_controllable_uvicorn_server():
    source = (Path(__file__).parents[1] / "app" / "main.py").read_text(encoding="utf-8")
    assert "uvicorn.Config(" in source
    assert "uvicorn.Server(_config)" in source
    assert "timeout_graceful_shutdown=12" in source
    assert "uvicorn.run(" not in source


def test_build_restores_owned_environment_even_after_failure():
    source = (Path(__file__).parents[2] / "build_production.ps1").read_text(
        encoding="utf-8"
    )
    snapshot = source.index("$script:BuildOwnedEnvironmentSnapshot")
    outer_try = source.index("try {", snapshot)
    first_mutation = source.index("$env:NUITKA_CACHE_DIR")
    final_restore = source.rindex("Restore-BuildOwnedEnvironment")
    assert snapshot < outer_try < first_mutation < final_restore
    outer_finally = source.rfind("} finally {", first_mutation, final_restore)
    assert first_mutation < outer_finally < final_restore
    signing_cleanup = source[outer_finally:final_restore]
    assert "$script:CapturedTauriSigningPrivateKey = $null" in signing_cleanup
    assert "$script:CapturedTauriSigningKeyFile = $null" in signing_cleanup
    assert "$script:CapturedTauriSigningPrivateKeyPassword = $null" in signing_cleanup
    for name in (
        "VITE_FEATURE_GATING_ENABLED",
        "PRYNX_FEATURE_GATING_ENABLED",
        "VITE_LOGO_REBUILD_ENABLED",
        "PRYNX_LOGO_REBUILD_ENABLED",
        "PRYNX_FRONTEND_HASH",
        "PRYNX_SIDECAR_HASH",
        "DEV_MODE",
        "PYTHONIOENCODING",
        "NUITKA_CACHE_DIR",
    ):
        assert f'"{name}"' in source[snapshot:outer_try]


def test_release_qa_forces_utf8_and_does_not_rewrite_preflight_golden():
    """QA phải đồng nhất encoding ProcessPool và không tự ghi đè golden đã track."""
    root = Path(__file__).parents[2]
    release_qa = (root / "scripts" / "run_release_qa.ps1").read_text(
        encoding="utf-8"
    )
    preflight_qa = (root / "backend" / "scripts" / "run_preflight_qa.ps1").read_text(
        encoding="utf-8"
    )

    utf8_set = release_qa.index('$env:PYTHONIOENCODING = "utf-8:replace"')
    backend_suite = release_qa.index('Invoke-Checked "Backend test suite"')
    utf8_restore = release_qa.rindex('"PYTHONIOENCODING"')
    assert utf8_set < backend_suite < utf8_restore
    assert "generate_fixtures.py" not in preflight_qa
    assert "tests\\preflight_golden" in preflight_qa


def test_build_environment_restore_runs_on_early_failure():
    powershell = shutil.which("powershell") or shutil.which("pwsh")
    if not powershell:
        pytest.skip("PowerShell khong co trong PATH")
    build_script = Path(__file__).parents[2] / "build_production.ps1"
    names = (
        "VITE_FEATURE_GATING_ENABLED",
        "PRYNX_FEATURE_GATING_ENABLED",
        "VITE_LOGO_REBUILD_ENABLED",
        "PRYNX_LOGO_REBUILD_ENABLED",
        "PRYNX_FRONTEND_HASH",
        "PRYNX_SIDECAR_HASH",
        "DEV_MODE",
        "PYTHONIOENCODING",
        "NUITKA_CACHE_DIR",
        "PRYNX_DIELINE_VERSION",
    )
    quoted_path = str(build_script).replace("'", "''")
    names_literal = ",".join(f'"{name}"' for name in names)
    probe = f"""
$ErrorActionPreference = "Stop"
$names = @({names_literal})
try {{ . '{quoted_path}' -SkipNuitka -NoOpenExplorer }} catch {{
    if ($_.Exception.Message -notlike "*retired*") {{ throw }}
}}
foreach ($name in $names) {{
    $actual = [Environment]::GetEnvironmentVariable($name, [EnvironmentVariableTarget]::Process)
    if ($actual -ne ("sentinel-" + $name)) {{ throw "Restore failed: $name" }}
}}
"RESTORE_OK"
"""
    encoded = base64.b64encode(probe.encode("utf-16-le")).decode("ascii")
    environment = os.environ.copy()
    for environment_name in list(environment):
        upper_name = environment_name.upper()
        if upper_name.startswith(("GIT_", "GH_")) or upper_name in {
            "GITHUB_TOKEN",
            "GITHUB_ENTERPRISE_TOKEN",
            "XDG_CONFIG_HOME",
        }:
            environment.pop(environment_name, None)
    for name in names:
        environment[name] = f"sentinel-{name}"
    completed = subprocess.run(
        [
            powershell,
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
            encoded,
        ],
        cwd=build_script.parent,
        env=environment,
        text=True,
        capture_output=True,
        timeout=30,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr
    assert "RESTORE_OK" in completed.stdout


def test_publisher_requires_committed_version_instead_of_mutating_source():
    repo = Path(__file__).parents[2]
    source = (repo / "release_update.ps1").read_text(encoding="utf-8")
    publisher = json.loads((repo / "publisher.config.json").read_text(encoding="utf-8-sig"))
    assert "Assert-CommittedReleaseVersion -ExpectedVersion $Version" in source
    assert "publisher.config.json" in source
    assert "Da dat version=$Version" not in source
    assert "SkipNuitka" not in source

    manifest_read = source.index("$manifestPath =")
    first_attestation = source.index("Assert-ReleaseManifestAttestation", manifest_read)
    first_source_check = source.index("Assert-ManifestSourceState", manifest_read)
    verifier_call = source.index("-File $verifier", first_source_check)
    runtime_gate_check = source.index("$runtimeFreeProGate", verifier_call)
    upload_call = source.index("$uploadResult = Invoke-PrynXGitHubCliCommand", runtime_gate_check)
    create_call = source.index("$createResult = Invoke-PrynXGitHubCliCommand", runtime_gate_check)
    assert manifest_read < first_attestation < first_source_check < verifier_call
    assert verifier_call < runtime_gate_check < upload_call
    assert verifier_call < runtime_gate_check < create_call
    assert source.rfind("Assert-ManifestSourceState", 0, upload_call) > runtime_gate_check
    assert source.rfind("Assert-ManifestSourceState", 0, create_call) > runtime_gate_check

    # SEC (audit 2026-08-06 §REL.PUBLISH): source nằm ở repo private, còn repo
    # updater public chỉ chứa asset. Publisher phải xác minh đúng trust boundary;
    # tuyệt đối không buộc/push object source sang repo public để thỏa chốt SHA.
    assert publisher["SourceRepo"] == "liendaobds-sudo/PrynX"
    assert re.fullmatch(r"[0-9a-f]{40}", publisher["ReleaseTargetCommit"])
    remote_commit_check = source.index(
        "Assert-GitHubCommitAvailable -Repo $sourceRepo -Commit $manifestCommit",
        runtime_gate_check,
    )
    existing_tag_check = source.index(
        "Assert-GitHubTagTargetsCommit `",
        remote_commit_check,
    )
    existing_tag_block = source[existing_tag_check:upload_call]
    assert remote_commit_check < existing_tag_check < upload_call
    assert "-Repo $ReleaseRepo `" in existing_tag_block
    assert "-Tag $tag `" in existing_tag_block
    assert "-ExpectedCommit $releaseTargetCommit" in existing_tag_block
    assert "git/ref/tags/$Tag" in source
    assert "git/tags/$objectSha" in source
    assert 'if ($objectType -eq "commit")' in source
    create_block = source[create_call : source.index(
        "if ($createResult.ExitCode", create_call
    )]
    assert "-Command 'release'" in create_block
    assert "'create'," in create_block
    assert "'--repo'," in create_block
    assert '"github.com/$ReleaseRepo"' in create_block
    assert "'--target'," in create_block
    assert "$releaseTargetCommit" in create_block
    assert "Assert-GitHubCommitAvailable -Repo $ReleaseRepo -Commit $manifestCommit" not in source


def test_release_gui_never_offers_stale_sidecar_packaging():
    source = (Path(__file__).parents[2] / "quanly_phathanh.ps1").read_text(
        encoding="utf-8-sig"
    )

    assert "SkipNuitka" not in source
    assert "Build nhanh: bỏ qua biên dịch backend" not in source


def test_release_gui_never_mutates_tracked_publisher_config():
    source = (Path(__file__).parents[2] / "quanly_phathanh.ps1").read_text(
        encoding="utf-8-sig"
    )

    assert "function Save-Config" not in source
    assert "Set-Content -LiteralPath $CONFIG" not in source
    assert "$saved.SourceRepo" not in source
    assert "$saved.ReleaseTargetCommit" not in source
    assert "$txtVer.ReadOnly = $true" in source


def test_installed_verifier_requires_manifest_build_attestation_before_install():
    source = (
        Path(__file__).parents[2] / "scripts" / "verify_installed_artifact.ps1"
    ).read_text(encoding="utf-8")
    attestation_call = source.index(
        "Assert-BuildManifestAttestation -Path $Manifest",
        source.index("$manifestVersion ="),
    )
    installer_lease = source.index(
        "$script:InstallerFileLease = Open-PrynXPayloadFileLease",
        attestation_call,
    )
    installer_start = source.index(
        "Start-Process -FilePath $script:InstallerFileLease.Path",
        installer_lease,
    )
    assert attestation_call < installer_lease < installer_start
    for field in (
        "BUILD_MODE",
        "BUILD_PROVENANCE",
        "SIDECAR_PROVENANCE",
        "PYTHON_ABI",
        "FRONTEND_FEATURE_GATE",
        "BACKEND_FEATURE_GATE",
        "GIT_COMMIT",
    ):
        assert f'"{field}"' in source


def test_dev_gated_mode_sets_both_layers_before_process_launch():
    source = (Path(__file__).parents[2] / "run_dev.bat").read_text(encoding="utf-8")
    mode = source.index('if /I "%~1"=="--gated"')
    frontend_flag = source.index('set "VITE_FEATURE_GATING_ENABLED=true"', mode)
    backend_flag = source.index('set "PRYNX_FEATURE_GATING_ENABLED=true"', mode)
    token_setup = source.index('set "PRYNX_SIDECAR_TOKEN=%%T"', backend_flag)
    backend_launch = source.index('start "PDF Inspector - Backend"', backend_flag)
    frontend_launch = source.index('start "PDF Inspector - Frontend"', backend_flag)
    assert mode < frontend_flag < token_setup < backend_launch
    assert mode < backend_flag < token_setup < frontend_launch
    rust_host = (
        Path(__file__).parents[2] / "desktop" / "src-tauri" / "src" / "lib.rs"
    ).read_text(encoding="utf-8")
    assert 'std::env::var("PRYNX_SIDECAR_TOKEN")' in rust_host


def test_dev_tauri_config_does_not_require_release_payload_manifest():
    repo = Path(__file__).parents[2]
    run_dev = (repo / "run_dev.bat").read_text(encoding="utf-8")
    dev_config_path = repo / "desktop" / "src-tauri" / "tauri.dev.conf.json"
    dev_config = json.loads(dev_config_path.read_text(encoding="utf-8"))

    assert "dev --config src-tauri/tauri.dev.conf.json" in run_dev
    assert dev_config == {
        "build": {"beforeBuildCommand": ""},
        "bundle": {"resources": []},
    }


def test_dev_context_menu_preserves_installer_action_intents():
    repo = Path(__file__).parents[2]
    source = (repo / "run_dev.bat").read_text(encoding="utf-8")
    installer = (
        repo / "desktop" / "src-tauri" / "installer-hooks.nsh"
    ).read_text(encoding="utf-8")

    combine_commands = [
        line.strip()
        for line in source.splitlines()
        if r"\shell\pdf-inspector-combine\command" in line
    ]
    assert len(combine_commands) == 3
    assert all(
        r'/d "\"%EXE_PATH%\" --prynx-action=combine \"%%1\""' in line
        for line in combine_commands
    )

    convert_commands = [
        line.strip()
        for line in source.splitlines()
        if r"\shell\%CONVERB%\command" in line
    ]
    assert len(convert_commands) == 1
    assert (
        r'/d "\"%EXE_PATH%\" --prynx-action=convert \"%%1\""'
        in convert_commands[0]
    )

    # Hai đường đăng ký dev/release phải giữ cùng intent dù quoting khác nhau.
    assert '--prynx-action=combine "%1"' in installer
    assert '--prynx-action=convert "%1"' in installer


def test_tauri_handler_does_not_expose_ungated_dead_business_commands():
    repo = Path(__file__).parents[2]
    source = (repo / "desktop" / "src-tauri" / "src" / "lib.rs").read_text(
        encoding="utf-8"
    )
    handler = source[source.index("tauri::generate_handler![") :]

    assert "strip_diecut_lines" not in handler
    assert "solve_layout" not in handler


def test_updater_endpoint_authority_rejects_host_and_uri_confusion(
    tmp_path: Path,
):
    """§SEC.24-R5: updater chỉ được trỏ đúng một HTTPS endpoint trên github.com."""
    root = Path(__file__).parents[2]
    publisher = (root / "release_update.ps1").read_text(encoding="utf-8-sig")
    helper_start = publisher.index("function Get-EndpointRepo")
    helper_end = publisher.index("\nfunction Get-ReleaseManifestField", helper_start)
    endpoint_helper = publisher[helper_start:helper_end]

    valid_endpoint = (
        "https://github.com/liendaobds-sudo/prynx-release/"
        "releases/latest/download/latest.json"
    )
    fixtures: dict[str, list[str]] = {
        "valid": [valid_endpoint],
        "http": [valid_endpoint.replace("https://", "http://")],
        "evil_host": [valid_endpoint.replace("github.com", "evilgithub.com")],
        "host_suffix": [valid_endpoint.replace("github.com", "github.com.evil")],
        "userinfo_host_confusion": [
            valid_endpoint.replace("github.com", "github.com@evil.test")
        ],
        "userinfo": [valid_endpoint.replace("github.com", "attacker@github.com")],
        "empty_userinfo": [valid_endpoint.replace("github.com", "@github.com")],
        "port": [valid_endpoint.replace("github.com", "github.com:444")],
        "empty_port": [valid_endpoint.replace("github.com", "github.com:")],
        "query": [valid_endpoint + "?repo=attacker"],
        "empty_query": [valid_endpoint + "?"],
        "fragment": [valid_endpoint + "#attacker"],
        "empty_fragment": [valid_endpoint + "#"],
        "extra_path": [valid_endpoint + "/extra"],
        "wrong_file": [valid_endpoint.replace("latest.json", "other.json")],
        "zero": [],
        "two": [valid_endpoint, valid_endpoint],
    }
    environment = {
        "PRYNX_TEST_GUARD": str(root / "scripts" / "release_executable_guard.ps1")
    }
    for name, endpoints in fixtures.items():
        path = tmp_path / f"updater-{name}.json"
        path.write_text(
            json.dumps({"plugins": {"updater": {"endpoints": endpoints}}}),
            encoding="utf-8",
        )
        environment[f"PRYNX_TEST_ENDPOINT_{name.upper()}"] = str(path)

    script = (
        "$ErrorActionPreference = 'Stop'\n"
        ". $env:PRYNX_TEST_GUARD\n"
        + endpoint_helper
        + r'''
$repo = Get-EndpointRepo -ConfPath $env:PRYNX_TEST_ENDPOINT_VALID
if ($repo -cne 'liendaobds-sudo/prynx-release') {
    throw "Valid endpoint returned wrong repo: $repo"
}
$invalidNames = @(
    'HTTP', 'EVIL_HOST', 'HOST_SUFFIX', 'USERINFO_HOST_CONFUSION',
    'USERINFO', 'EMPTY_USERINFO', 'PORT', 'EMPTY_PORT', 'QUERY',
    'EMPTY_QUERY', 'FRAGMENT', 'EMPTY_FRAGMENT', 'EXTRA_PATH',
    'WRONG_FILE', 'ZERO', 'TWO'
)
foreach ($name in $invalidNames) {
    $path = [Environment]::GetEnvironmentVariable(
        "PRYNX_TEST_ENDPOINT_$name", [EnvironmentVariableTarget]::Process
    )
    $rejected = $false
    try { $null = Get-EndpointRepo -ConfPath $path }
    catch { $rejected = $true }
    if (-not $rejected) { throw "Invalid updater endpoint was accepted: $name" }
}
'UPDATER_ENDPOINT_AUTHORITY_OK'
'''
    )
    result = _run_windows_powershell(root, script, environment)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "UPDATER_ENDPOINT_AUTHORITY_OK" in result.stdout


def test_git_repository_authority_precedes_every_release_git_consumer():
    """§SEC.24-R6: mọi Git consumer phải đi sau canonical repo gate."""
    root = Path(__file__).parents[2]
    build = (root / "build_production.ps1").read_text(encoding="utf-8-sig")
    publisher = (root / "release_update.ps1").read_text(encoding="utf-8-sig")

    def function_block(source: str, name: str, next_name: str) -> str:
        start = source.index(f"function {name}")
        end = source.index(f"\nfunction {next_name}", start)
        return source[start:end]

    def assert_build_order(source: str) -> None:
        assert re.search(r"&\s+\$script:PrynXGitPath(?=\s)", source) is None
        source_state = function_block(
            source, "Assert-ReleaseSourceState", "Assert-ReleaseSigningAuthority"
        )
        authority = source_state.index("Assert-PrynXGitRepositoryAuthority")
        git_calls = [
            match.start()
            for match in re.finditer("Invoke-PrynXGitReadOnlyCommand", source_state)
        ]
        assert len(git_calls) == 3
        assert authority < min(git_calls)

        native_commit = source.index("$nativeCommitResult = Invoke-PrynXGitReadOnlyCommand")
        native_status = source.index(
            "$nativeDirtyResult = Invoke-PrynXGitReadOnlyCommand", native_commit
        )
        native_release_gate = source.rfind("if ($Release) {", 0, native_commit)
        native_authority = source.index(
            "Assert-PrynXGitRepositoryAuthority", native_release_gate, native_commit
        )
        assert native_release_gate < native_authority < native_commit < native_status

        ambient_capture = source.index("$script:AmbientGitAuthorityOverrides = @(")
        ambient_clear = source.index(
            "Clear-PrynXAmbientGitAuthorityOverrides", ambient_capture
        )
        tool_init = source.index("\nInitialize-PrynXReleaseToolAuthority", ambient_clear)
        assert ambient_capture < ambient_clear < tool_init

    def assert_publisher_order(source: str) -> None:
        assert re.search(r"&\s+\$script:PrynXGit(?=\s)", source) is None
        assert re.search(r"&\s+\$script:PrynXGitHubCli(?=\s)", source) is None
        committed = function_block(
            source, "Assert-CommittedReleaseVersion", "Get-EndpointRepo"
        )
        committed_authority = committed.index("Assert-PrynXGitRepositoryAuthority")
        committed_git = committed.index("Invoke-PrynXGitReadOnlyCommand")
        assert committed_authority < committed_git

        manifest = function_block(
            source, "Assert-ManifestSourceState", "Assert-GitHubCommitAvailable"
        )
        manifest_authority = manifest.index("Assert-PrynXGitRepositoryAuthority")
        manifest_git_calls = [
            match.start()
            for match in re.finditer("Invoke-PrynXGitReadOnlyCommand", manifest)
        ]
        assert len(manifest_git_calls) == 2
        assert manifest_authority < min(manifest_git_calls)

        ambient_capture = source.index(
            "$ambientGitAuthorityOverrides = @(",
        )
        bootstrap_clear = source.index(
            "foreach ($bootstrapName in @(", ambient_capture
        )
        guard_load = source.index(
            '. "$ROOT\\scripts\\release_executable_guard.ps1"',
            bootstrap_clear,
        )
        ambient_recheck = source.index(
            "$null = Clear-PrynXAmbientGitAuthorityOverrides", guard_load
        )
        git_open = source.index(
            '$gitLease = Open-PrynXTrustedReleaseExecutableLease -Kind "Git"',
            ambient_recheck,
        )
        assert (
            ambient_capture
            < bootstrap_clear
            < guard_load
            < ambient_recheck
            < git_open
        )

        git_path = source.index("$script:PrynXGit = $gitLease.Path", git_open)
        source_head = source.index(
            "$sourceHeadResult = Invoke-PrynXGitReadOnlyCommand", git_path
        )
        preflight_auth = source.index(
            "$authResult = Invoke-PrynXGitHubCliCommand", git_path, source_head
        )
        source_head_authority = source.rfind(
            "Assert-PrynXGitRepositoryAuthority", preflight_auth, source_head
        )
        assert preflight_auth < source_head_authority < source_head

        gh_path = source.index("$script:PrynXGitHubCli = $githubCliLease.Path")
        gh_auth = source.index("$authResult = Invoke-PrynXGitHubCliCommand", gh_path)
        gh_environment = source.rfind(
            "Assert-PrynXGitEnvironmentAuthority", gh_path, gh_auth
        )
        assert gh_path < gh_environment < gh_auth

    assert_build_order(build)
    assert_publisher_order(publisher)

    mutated_build = build.replace(
        "Assert-PrynXGitRepositoryAuthority",
        "Assert-PrynXMissingGitRepositoryAuthority",
        1,
    )
    mutated_publisher = publisher.replace(
        "Assert-PrynXGitRepositoryAuthority",
        "Assert-PrynXMissingGitRepositoryAuthority",
        1,
    )
    with pytest.raises((AssertionError, ValueError)):
        assert_build_order(mutated_build)
    with pytest.raises((AssertionError, ValueError)):
        assert_publisher_order(mutated_publisher)

    native_authority = (
        "    if ($Release) {\n"
        "        Assert-PrynXGitRepositoryAuthority `\n"
        "            -GitPath $script:PrynXGitPath `\n"
        "            -ExpectedRoot $ROOT\n"
        "    }"
    )
    assert build.count(native_authority) == 1
    mutated_native = build.replace(
        native_authority,
        native_authority.replace(
            "Assert-PrynXGitRepositoryAuthority",
            "Assert-PrynXMissingGitRepositoryAuthority",
        ),
        1,
    )
    with pytest.raises((AssertionError, ValueError)):
        assert_build_order(mutated_native)

    mutated_direct = build.replace(
        "Invoke-PrynXGitReadOnlyCommand",
        "& $script:PrynXGitPath",
        1,
    )
    with pytest.raises((AssertionError, ValueError)):
        assert_build_order(mutated_direct)

    top_level_publisher_call = (
        "\nAssert-PrynXGitRepositoryAuthority `\n"
        "    -GitPath $script:PrynXGit `\n"
        "    -ExpectedRoot $ROOT"
    )
    assert publisher.count(top_level_publisher_call) == 1
    mutated_top_level = publisher.replace(
        top_level_publisher_call,
        top_level_publisher_call.replace(
            "Assert-PrynXGitRepositoryAuthority",
            "Assert-PrynXMissingGitRepositoryAuthority",
        ),
        1,
    )
    with pytest.raises((AssertionError, ValueError)):
        assert_publisher_order(mutated_top_level)
