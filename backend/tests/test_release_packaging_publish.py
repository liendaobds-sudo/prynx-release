"""Chốt bàn giao installer/manifest; chỉ chạy helper trên file giả trong Temp.

BUILD (audit 2026-09-09 §SEC.LIC20.03): tuyệt đối không dot-source toàn bộ
build_production.ps1. AST chỉ lấy hai hàm thuần filesystem để không vô tình
chạy preflight, compiler, signer hoặc đụng artifact phát hành đang có.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import subprocess
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]
BUILD = ROOT / "build_production.ps1"
INSTALLER_NAME = "PrynX_2.0.0_x64-setup.exe"
CURRENT_MANIFEST = "release-manifest.txt"
NEW_BYTES = b"installer-gia-cua-luot-build-moi"
OLD_BYTES = b"installer-gia-da-ban-giao-truoc-do"


def _manifest_lines(payload: bytes, **overrides: str) -> list[str]:
    fields = {
        "APP_VERSION": "2.0.0",
        "INSTALLER": INSTALLER_NAME,
        "INSTALLER_SHA256": hashlib.sha256(payload).hexdigest(),
        "RUNTIME_VERIFIED": "no",
    }
    fields.update(overrides)
    return ["PrynX release manifest", *(f"{key} = {value}" for key, value in fields.items())]


def _old_pair(publish: Path) -> tuple[Path, Path, bytes]:
    publish.mkdir()
    installer = publish / INSTALLER_NAME
    manifest = publish / CURRENT_MANIFEST
    installer.write_bytes(OLD_BYTES)
    manifest_bytes = ("\n".join(_manifest_lines(OLD_BYTES)) + "\n").encode("ascii")
    manifest.write_bytes(manifest_bytes)
    return installer, manifest, manifest_bytes


def _run_publish(
    source: Path,
    publish: Path,
    manifest_lines: list[str],
    *,
    lock_target: str = "",
) -> dict:
    if os.name != "nt":
        pytest.skip("Ca bàn giao file cần Windows PowerShell 5.1 và filesystem Windows.")
    windows_root = Path(os.environ.get("SystemRoot", r"C:\Windows"))
    powershell = windows_root / "System32/WindowsPowerShell/v1.0/powershell.exe"
    if not powershell.is_file():
        pytest.skip("Không tìm thấy Windows PowerShell 5.1 trong System32.")
    script = r'''
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) {
    throw "Fixture can dung Windows PowerShell 5.1."
}
$parseTokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(
    $env:PRYNX_TEST_BUILD_SOURCE, [ref]$parseTokens, [ref]$parseErrors
)
if (@($parseErrors).Count -ne 0) { throw "Build script khong parse duoc." }
foreach ($name in @("Assert-NoReparsePointInPathComponents", "Publish-PrynXInstallerManifest")) {
    $functions = @($ast.FindAll({
        param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
    }, $true))
    if ($functions.Count -ne 1) { throw "Can dung mot helper AST: $name." }
    . ([scriptblock]::Create($functions[0].Extent.Text))
}
# PS5.1 giữ mảng JSON thành một output object; không bọc thêm @() vì sẽ
# thành mảng lồng và ép toàn bộ manifest thành một chuỗi khi bind parameter.
[string[]]$manifestLines = ConvertFrom-Json -InputObject $env:PRYNX_TEST_MANIFEST_LINES
$lock = $null
$script:lateManifestLock = $null
try {
    if ($env:PRYNX_TEST_LOCK_TARGET -in @("pending_manifest", "published_hash")) {
        # Chỉ fixture: gây lỗi sau khi installer đã promote, trước công bố manifest.
        function Get-FileHash {
            [CmdletBinding()]
            param([string[]]$LiteralPath, [IO.Stream]$InputStream, [string]$Algorithm)
            if ($null -ne $InputStream) {
                if ($env:PRYNX_TEST_LOCK_TARGET -eq "published_hash") {
                    return [pscustomobject]@{ Hash = ('0' * 64) }
                }
                $pendingPath = Join-Path $stageRoot "manifest.pending"
                $script:lateManifestLock = [IO.File]::Open($pendingPath,
                    [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
            }
            Microsoft.PowerShell.Utility\Get-FileHash @PSBoundParameters
        }
    } elseif (-not [string]::IsNullOrEmpty($env:PRYNX_TEST_LOCK_TARGET)) {
        $lockPath = switch ($env:PRYNX_TEST_LOCK_TARGET) {
            "installer" { Join-Path $env:PRYNX_TEST_PUBLISH_DIR $env:PRYNX_TEST_INSTALLER_NAME }
            "manifest" { Join-Path $env:PRYNX_TEST_PUBLISH_DIR "release-manifest.txt" }
            "publisher" { Join-Path $env:PRYNX_TEST_PUBLISH_DIR ".release-publish.lock" }
            default { throw "Loai lock fixture khong hop le." }
        }
        $lock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate,
            [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    }
    try {
        $result = Publish-PrynXInstallerManifest `
            -SourceInstaller $env:PRYNX_TEST_SOURCE_INSTALLER `
            -PublishDirectory $env:PRYNX_TEST_PUBLISH_DIR `
            -ManifestLines $manifestLines
        $response = @{ Ok = $true; Result = $result }
    } catch {
        $response = @{ Ok = $false; Error = $_.Exception.Message }
    }
} finally {
    if ($null -ne $lock) { $lock.Dispose() }
    if ($null -ne $script:lateManifestLock) { $script:lateManifestLock.Dispose() }
}
"PUBLISH_RESULT=" + ($response | ConvertTo-Json -Depth 5 -Compress)
'''
    environment = os.environ.copy()
    # os.environ trên Windows chuẩn hóa tên thành chữ hoa; không để đường module
    # của PowerShell 7 từ runner lấn module chuẩn của Windows PowerShell 5.1.
    for variable in list(environment):
        if variable.upper() == "PSMODULEPATH":
            environment.pop(variable)
    environment.update(
        {
            "PRYNX_TEST_BUILD_SOURCE": str(BUILD),
            "PRYNX_TEST_SOURCE_INSTALLER": str(source),
            "PRYNX_TEST_PUBLISH_DIR": str(publish),
            "PRYNX_TEST_MANIFEST_LINES": json.dumps(manifest_lines),
            "PRYNX_TEST_LOCK_TARGET": lock_target,
            "PRYNX_TEST_INSTALLER_NAME": INSTALLER_NAME,
        }
    )
    completed = subprocess.run(
        [
            str(powershell),
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
            base64.b64encode(script.encode("utf-16-le")).decode("ascii"),
        ],
        cwd=ROOT,
        env=environment,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        timeout=30,
        check=False,
    )
    assert completed.returncode == 0, completed.stdout + completed.stderr
    markers = [line.removeprefix("PUBLISH_RESULT=") for line in completed.stdout.splitlines()
               if line.startswith("PUBLISH_RESULT=")]
    assert len(markers) == 1, completed.stdout + completed.stderr
    return json.loads(markers[0])


def _source_installer(tmp_path: Path) -> Path:
    source_parent = tmp_path / "bundle"
    source_parent.mkdir()
    source = source_parent / INSTALLER_NAME
    source.write_bytes(NEW_BYTES)
    return source


def _assert_current_pair_matches(publish: Path) -> None:
    """Thiếu manifest là HOLD; nếu có thì nó bắt buộc thuộc đúng byte installer."""
    manifest = publish / CURRENT_MANIFEST
    if not manifest.is_file():
        return
    fields = dict(
        (key.strip(), value.strip())
        for line in manifest.read_text(encoding="ascii").splitlines()
        if "=" in line
        for key, value in [line.split("=", 1)]
    )
    installer = publish / fields["INSTALLER"]
    assert fields["INSTALLER_SHA256"] == hashlib.sha256(installer.read_bytes()).hexdigest()
    assert fields["RUNTIME_VERIFIED"] == "no"


def test_publish_fresh_pair_and_keep_runtime_unverified(tmp_path: Path) -> None:
    source = _source_installer(tmp_path)
    publish = tmp_path / "publish"
    response = _run_publish(source, publish, _manifest_lines(NEW_BYTES))
    assert response["Ok"], response
    result = response["Result"]
    assert Path(result["InstallerPath"]) == publish / INSTALLER_NAME
    assert Path(result["ManifestPath"]) == publish / CURRENT_MANIFEST
    assert (publish / INSTALLER_NAME).read_bytes() == NEW_BYTES
    assert source.read_bytes() == NEW_BYTES
    _assert_current_pair_matches(publish)


def test_same_version_publish_keeps_previous_installer_and_manifest(tmp_path: Path) -> None:
    source = _source_installer(tmp_path)
    publish = tmp_path / "publish"
    _, _, old_manifest_bytes = _old_pair(publish)
    response = _run_publish(source, publish, _manifest_lines(NEW_BYTES))
    assert response["Ok"], response
    backup = Path(response["Result"]["BackupDirectory"])
    assert backup.parent == publish
    assert (backup / "installer.previous").read_bytes() == OLD_BYTES
    assert (backup / "manifest.previous").read_bytes() == old_manifest_bytes
    assert (publish / INSTALLER_NAME).read_bytes() == NEW_BYTES
    _assert_current_pair_matches(publish)


@pytest.mark.parametrize(
    "case",
    [
        "bad_sha", "short_sha", "uppercase_sha", "wrong_version", "invalid_version",
        "wrong_leaf", "unsafe_leaf", "duplicate_hash", "duplicate_version",
        "duplicate_hash_case", "missing_hash", "missing_installer", "missing_version",
        "missing_runtime", "runtime_verified",
    ],
)
def test_bad_manifest_never_changes_previous_pair(tmp_path: Path, case: str) -> None:
    source = _source_installer(tmp_path)
    publish = tmp_path / "publish"
    installer, manifest, old_manifest_bytes = _old_pair(publish)
    changes = {
        "bad_sha": {"INSTALLER_SHA256": "00" * 32},
        "short_sha": {"INSTALLER_SHA256": "a" * 63},
        "uppercase_sha": {"INSTALLER_SHA256": hashlib.sha256(NEW_BYTES).hexdigest().upper()},
        "wrong_version": {"APP_VERSION": "2.0.1"},
        "invalid_version": {"APP_VERSION": "2.0"},
        "wrong_leaf": {"INSTALLER": "Other_2.0.0_x64-setup.exe"},
        "unsafe_leaf": {"INSTALLER": "../" + INSTALLER_NAME},
        "runtime_verified": {"RUNTIME_VERIFIED": "yes"},
    }
    lines = _manifest_lines(NEW_BYTES, **changes.get(case, {}))
    duplicate_fields = {
        "duplicate_hash": "INSTALLER_SHA256",
        "duplicate_version": "APP_VERSION",
        "duplicate_hash_case": "INSTALLER_SHA256",
    }
    if case in duplicate_fields:
        duplicate = next(line for line in lines if line.startswith(duplicate_fields[case] + " ="))
        if case == "duplicate_hash_case":
            duplicate = duplicate.replace("INSTALLER_SHA256", "installer_sha256", 1)
        lines.append(duplicate)
    missing_fields = {
        "missing_hash": "INSTALLER_SHA256", "missing_installer": "INSTALLER",
        "missing_version": "APP_VERSION", "missing_runtime": "RUNTIME_VERIFIED",
    }
    if case in missing_fields:
        lines = [line for line in lines if not line.startswith(missing_fields[case] + " =")]
    response = _run_publish(source, publish, lines)
    assert not response["Ok"], (case, response)
    assert response["Error"].startswith("SEC:"), response
    assert installer.read_bytes() == OLD_BYTES
    assert manifest.read_bytes() == old_manifest_bytes
    _assert_current_pair_matches(publish)


def test_source_hash_drift_leaves_previous_pair_untouched(tmp_path: Path) -> None:
    source = _source_installer(tmp_path)
    publish = tmp_path / "publish"
    installer, manifest, old_manifest_bytes = _old_pair(publish)
    manifest_lines = _manifest_lines(NEW_BYTES)
    source.write_bytes(b"source-da-bi-thay-sau-khi-tinh-hash")
    response = _run_publish(source, publish, manifest_lines)
    assert not response["Ok"], response
    assert "SHA-256" in response["Error"], response
    assert installer.read_bytes() == OLD_BYTES
    assert manifest.read_bytes() == old_manifest_bytes


@pytest.mark.parametrize("lock_target", ["installer", "manifest", "publisher"])
def test_locked_publish_target_fails_without_mismatched_pair(
    tmp_path: Path, lock_target: str,
) -> None:
    source = _source_installer(tmp_path)
    publish = tmp_path / "publish"
    installer, manifest, old_manifest_bytes = _old_pair(publish)
    response = _run_publish(source, publish, _manifest_lines(NEW_BYTES), lock_target=lock_target)
    assert not response["Ok"], response
    assert installer.read_bytes() == OLD_BYTES
    _assert_current_pair_matches(publish)
    previous_manifests = list(publish.glob(".publish-*/manifest.previous"))
    recoverable = [manifest] if manifest.exists() else previous_manifests
    assert recoverable, "Manifest cũ phải còn nguyên tại current hoặc backup, không được mất."
    assert any(path.read_bytes() == old_manifest_bytes for path in recoverable)
    if lock_target in {"manifest", "publisher"}:
        assert manifest.read_bytes() == old_manifest_bytes
    assert source.read_bytes() == NEW_BYTES


@pytest.mark.parametrize("failure", ["pending_manifest", "published_hash"])
def test_failure_after_installer_promote_keeps_backup_without_false_manifest(
    tmp_path: Path, failure: str,
) -> None:
    source = _source_installer(tmp_path)
    publish = tmp_path / "publish"
    installer, manifest, old_manifest_bytes = _old_pair(publish)
    response = _run_publish(source, publish, _manifest_lines(NEW_BYTES), lock_target=failure)
    assert not response["Ok"], response
    assert installer.read_bytes() == NEW_BYTES, "Fault phải xảy ra sau bước promote installer."
    assert not manifest.exists(), "Không công bố manifest cũ hoặc chưa được hậu kiểm."
    backups = list(publish.glob(".publish-*"))
    assert len(backups) == 1
    assert (backups[0] / "installer.previous").read_bytes() == OLD_BYTES
    assert (backups[0] / "manifest.previous").read_bytes() == old_manifest_bytes
    assert (backups[0] / "manifest.pending").is_file()
    if failure == "published_hash":
        assert "khong cong bo manifest" in response["Error"], response


def test_pipeline_finishes_provenance_before_publish_and_success_handoff() -> None:
    """Không copy sớm hoặc báo BUILD COMPLETE khi finalize còn có thể từ chối."""
    source = BUILD.read_text(encoding="utf-8-sig")
    assert re.search(r"(?m)^function Publish-PrynXInstallerManifest\s*\{", source)
    tauri_call = source.index("& $script:PrynXNodePath $tauriCliPath build --config $tauriConfig")
    source_guard = source.index("Assert-ReleaseSourceState", tauri_call)
    gate_guard = source.index("Feature gate state changed before manifest creation.", source_guard)
    native_guard = source.index("Native provenance is incomplete; refusing to write release manifest.", gate_guard)
    locked_guard = source.index("Release artifact is not dieline-locked.", source_guard)
    probe_guard = source.index("Release artifact did not pass the dieline activation probe.", source_guard)
    manifest_lines = source.index("$manifestLines = @(", native_guard)
    publish_call = source.index("Publish-PrynXInstallerManifest", manifest_lines)
    success_message = source.index("BUILD COMPLETE", tauri_call)
    explorer_call = source.index("Start-Process explorer.exe", tauri_call)
    assert tauri_call < source_guard < gate_guard < native_guard < manifest_lines
    assert locked_guard < manifest_lines and probe_guard < manifest_lines
    assert manifest_lines < publish_call < success_message < explorer_call
    assert "Copy-Item -Force $installer.FullName" not in source[tauri_call:]
