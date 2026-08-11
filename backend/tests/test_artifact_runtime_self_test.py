from __future__ import annotations

import base64
import json
import os
import re
import shutil
import subprocess
import sys
import types
from pathlib import Path

import numpy as np
import pikepdf
import pytest

from app.core import artifact_runtime_self_test as runtime_self_test
from app.core import feature_entitlements
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
    fastapi_offset = source.index("from fastapi import FastAPI")
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
    tauri_call = source.index("npx @tauri-apps/cli build")
    post_tauri_source_check = source.index("Assert-ReleaseSourceState", tauri_call)
    manifest_write = source.index("$manifestLines = @(", post_tauri_source_check)
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
    frontend_build = source.index("npm.cmd run build\n", frontend_section)
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


def test_build_restores_owned_environment_even_after_failure():
    source = (Path(__file__).parents[2] / "build_production.ps1").read_text(
        encoding="utf-8"
    )
    snapshot = source.index("$script:BuildOwnedEnvironmentSnapshot")
    outer_try = source.index("try {", snapshot)
    first_mutation = source.index("$env:NUITKA_CACHE_DIR")
    final_restore = source.rindex("Restore-BuildOwnedEnvironment")
    assert snapshot < outer_try < first_mutation < final_restore
    assert source[final_restore - 40 : final_restore].strip().endswith("finally {")
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
    upload_call = source.index("gh release upload", runtime_gate_check)
    create_call = source.index("gh release create", runtime_gate_check)
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
        "Assert-GitHubTagTargetsCommit -Repo $ReleaseRepo -Tag $tag -ExpectedCommit $releaseTargetCommit",
        remote_commit_check,
    )
    assert remote_commit_check < existing_tag_check < upload_call
    assert "git/ref/tags/$Tag" in source
    assert "git/tags/$objectSha" in source
    assert 'if ($objectType -eq "commit")' in source
    assert "gh release create $tag --repo $ReleaseRepo --target $releaseTargetCommit" in source
    assert "Assert-GitHubCommitAvailable -Repo $ReleaseRepo -Commit $manifestCommit" not in source


def test_release_gui_never_offers_stale_sidecar_packaging():
    source = (Path(__file__).parents[2] / "quanly_phathanh.ps1").read_text(
        encoding="utf-8-sig"
    )

    assert "SkipNuitka" not in source
    assert "Build nhanh: bỏ qua biên dịch backend" not in source


def test_installed_verifier_requires_manifest_build_attestation_before_install():
    source = (
        Path(__file__).parents[2] / "scripts" / "verify_installed_artifact.ps1"
    ).read_text(encoding="utf-8")
    attestation_call = source.index(
        "Assert-BuildManifestAttestation -Path $Manifest",
        source.index("$manifestVersion ="),
    )
    installer_start = source.index("Start-Process -FilePath $Installer", attestation_call)
    assert attestation_call < installer_start
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


def test_tauri_handler_does_not_expose_ungated_dead_business_commands():
    repo = Path(__file__).parents[2]
    source = (repo / "desktop" / "src-tauri" / "src" / "lib.rs").read_text(
        encoding="utf-8"
    )
    handler = source[source.index("tauri::generate_handler![") :]

    assert "strip_diecut_lines" not in handler
    assert "solve_layout" not in handler
