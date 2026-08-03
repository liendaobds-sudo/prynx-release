from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]
STORE_SCRIPT = ROOT / "scripts" / "release_secret_store.ps1"
SETUP_SCRIPT = ROOT / "scripts" / "setup_release_secrets.ps1"
EXAMPLE_SCRIPT = ROOT / "scripts" / "set_release_env.example.ps1"
BUILD_SCRIPT = ROOT / "build_production.ps1"
RELEASE_UI_SCRIPT = ROOT / "quanly_phathanh.ps1"
PUBLISH_SCRIPT = ROOT / "release_update.ps1"
ONE_CLICK_SCRIPT = ROOT / "PHAT_HANH.bat"


def test_tracked_release_secret_scripts_never_request_plaintext_files() -> None:
    store_text = STORE_SCRIPT.read_text(encoding="utf-8")
    setup_text = SETUP_SCRIPT.read_text(encoding="utf-8")
    example_text = EXAMPLE_SCRIPT.read_text(encoding="utf-8")

    assert "Export-Clixml" in store_text
    assert "Read-Host \"Supabase secret key\" -AsSecureString" in setup_text
    assert "service_role" not in example_text.lower()
    assert "<DÁN" not in example_text
    assert "PRYNX_SUPABASE_SERVICE_KEY =" not in example_text


def test_release_build_consumes_new_secret_and_clears_it_before_tool_children() -> None:
    build_text = BUILD_SCRIPT.read_text(encoding="utf-8")
    ui_text = RELEASE_UI_SCRIPT.read_text(encoding="utf-8-sig")

    assert "Release refuses legacy PRYNX_SUPABASE_SERVICE_KEY" in build_text
    assert "$keyHeaders = @{ apikey = $releaseSupabaseSecret }" in build_text
    assert 'Authorization = "Bearer $legacySupabaseServiceKey"' in build_text
    assert "$expectedReleaseSupabaseUrl = [string]$script:PrynXReleaseSupabaseUrl" in build_text
    assert "$releaseSupabaseUrl = $expectedReleaseSupabaseUrl" in build_text
    assert "$releaseSupabaseUrl = $releaseSupabaseUrlCandidate" in build_text
    url_candidate_at = build_text.index("$releaseSupabaseUrlCandidate =")
    release_only_guard_at = build_text.index("if ($Release) {", url_candidate_at)
    url_guard_at = build_text.index("URL Supabase phat hanh phai khop project DPAPI")
    api_key_header_at = build_text.index("$keyHeaders = @{ apikey = $releaseSupabaseSecret }")
    assert release_only_guard_at < url_guard_at < api_key_header_at
    assert build_text.count("-UserAgent $releaseBuilderUserAgent") == 2
    assert 'PrynX-Release-Builder/1.0' in build_text
    assert "pip show nuitka" not in build_text
    assert "pip show maturin" not in build_text
    assert "pip show onnxruntime-directml" not in build_text
    assert build_text.count("Test-PythonDistribution -Name") == 4
    assert "if (Test-PythonDistribution -Name \"onnxruntime\")" in build_text
    assert '"/O1 /wd9025"' not in build_text
    clear_at = build_text.index("Remove-Item Env:PRYNX_SUPABASE_SECRET_KEY")
    first_tool_gate_at = build_text.index("Assert-BuildToolchain\n")
    assert clear_at < first_tool_gate_at
    assert "Import-PrynXReleaseEnvironment" not in ui_text
    assert "Resolve-PrynXReleaseSecretStorePath" in ui_text


def test_updater_signing_secret_is_scoped_to_tauri_and_cleared_before_publish() -> None:
    build_text = BUILD_SCRIPT.read_text(encoding="utf-8")
    publish_text = PUBLISH_SCRIPT.read_text(encoding="utf-8-sig")

    capture_at = build_text.index("$script:CapturedTauriSigningPrivateKey =")
    early_clear_at = build_text.index("Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY")
    first_tool_gate_at = build_text.index("Assert-BuildToolchain\n")
    expose_at = build_text.index(
        "$env:TAURI_SIGNING_PRIVATE_KEY = $tauriSigningPrivateKey"
    )
    read_key_at = build_text.index(
        "$tauriSigningPrivateKey = [string](Get-Content", first_tool_gate_at
    )
    tauri_at = build_text.index("npx @tauri-apps/cli build", expose_at)
    clear_after_tauri_at = build_text.index(
        "Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY", tauri_at
    )
    assert capture_at < early_clear_at < first_tool_gate_at < read_key_at
    assert read_key_at < expose_at < tauri_at < clear_after_tauri_at

    publisher_password_clear_at = publish_text.index(
        "Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD"
    )
    github_preflight_at = publish_text.index("& gh auth status")
    build_call_at = publish_text.index('& "$ROOT\\build_production.ps1" @buildArgs')
    key_path_at = publish_text.index("$env:PRYNX_TAURI_SIGNING_KEY_FILE = $KEY_FILE")
    publisher_clear_after_build_at = publish_text.index(
        "Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY", build_call_at
    )
    github_upload_at = publish_text.index("& gh release upload")
    assert publisher_password_clear_at < github_preflight_at
    assert "Get-Content -LiteralPath $KEY_FILE -Raw" not in publish_text
    assert key_path_at < build_call_at < publisher_clear_after_build_at < github_upload_at


def test_one_click_release_loads_updater_key_without_leaving_it_in_noexit_shell() -> None:
    text = ONE_CLICK_SCRIPT.read_text(encoding="utf-8")

    try_at = text.index("try {")
    missing_key_guard_at = text.index("if (-not (Test-Path", try_at)
    load_at = text.index("$env:PRYNX_TAURI_SIGNING_KEY_FILE = $signingKeyFile")
    build_at = text.index("^& .\\build_production.ps1 -Release")
    clear_at = text.index("Remove-Item Env:PRYNX_TAURI_SIGNING_KEY_FILE", build_at)
    assert ".tauri\\prynx.key" in text
    assert "Get-Content -LiteralPath $signingKeyFile -Raw" not in text
    assert try_at < missing_key_guard_at < load_at < build_at < clear_at

    lines = text.splitlines()
    command_start = next(
        index
        for index, line in enumerate(lines)
        if line.startswith(
            "powershell -NoProfile -ExecutionPolicy Bypass -NoExit -Command"
        )
    )
    payload_lines = []
    for line in lines[command_start + 1 :]:
        continued = line.rstrip().endswith("^")
        payload_lines.append(line.strip().removesuffix("^").rstrip())
        if not continued:
            break
    payload = " ".join(payload_lines)
    assert payload.startswith('"') and payload.endswith('"')
    payload = payload[1:-1].replace("^&", "&")
    parse_env = os.environ.copy()
    parse_env["PRYNX_TEST_BATCH_COMMAND"] = payload
    completed = subprocess.run(
        [
            "powershell.exe",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$e=$null; [Management.Automation.Language.Parser]::ParseInput("
            "$env:PRYNX_TEST_BATCH_COMMAND,[ref]$null,[ref]$e) | Out-Null; "
            "if ($e) { $e[0].Message; exit 1 }",
        ],
        cwd=ROOT,
        env=parse_env,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    assert completed.returncode == 0, completed.stdout or completed.stderr


@pytest.mark.skipif(os.name != "nt", reason="DPAPI CurrentUser chi co tren Windows")
def test_dpapi_store_roundtrip_does_not_write_plaintext(tmp_path: Path) -> None:
    secret = "sb_secret_test_" + ("A" * 40)
    store_path = tmp_path / "release-secrets" / "secrets.clixml"
    env = os.environ.copy()
    env["PRYNX_TEST_SECRET"] = secret
    env["PRYNX_TEST_STORE"] = str(store_path)
    env["PRYNX_TEST_SCRIPT"] = str(STORE_SCRIPT)
    command = (
        ". $env:PRYNX_TEST_SCRIPT; "
        "$storeDir = Split-Path -Parent $env:PRYNX_TEST_STORE; "
        "$secure = $null; "
        "try { "
        "$secure = ConvertTo-SecureString $env:PRYNX_TEST_SECRET -AsPlainText -Force; "
        "[void](Save-PrynXReleaseSecrets -SupabaseSecret $secure -StorePath $env:PRYNX_TEST_STORE); "
        "$raw = Get-Content -LiteralPath $env:PRYNX_TEST_STORE -Raw; "
        "if ($raw.Contains($env:PRYNX_TEST_SECRET)) { throw 'Kho DPAPI da ghi lo plaintext.' }; "
        "$rawBytes = [System.IO.File]::ReadAllBytes($env:PRYNX_TEST_STORE); "
        "$rawUtf8 = [System.Text.Encoding]::UTF8.GetString($rawBytes); "
        "$rawUtf16 = [System.Text.Encoding]::Unicode.GetString($rawBytes); "
        "if ($rawUtf8.Contains($env:PRYNX_TEST_SECRET) -or "
        "$rawUtf16.Contains($env:PRYNX_TEST_SECRET)) { throw 'Kho DPAPI da ghi lo plaintext.' }; "
        "Import-PrynXReleaseEnvironment -StorePath $env:PRYNX_TEST_STORE; "
        "if ($env:PRYNX_SUPABASE_SECRET_KEY -ne $env:PRYNX_TEST_SECRET) { "
        "throw 'Kho DPAPI khong round-trip dung secret.' "
        "} "
        "} finally { "
        "Clear-PrynXReleaseEnvironment; "
        "if ($secure) { $secure.Dispose() }; "
        "if (Test-Path -LiteralPath $storeDir) { "
        "Remove-Item -LiteralPath $storeDir -Recurse -Force -ErrorAction Stop "
        "} "
        "}"
    )
    completed = subprocess.run(
        [
            "powershell.exe",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            command,
        ],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr
    assert not store_path.parent.exists()
