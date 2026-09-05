from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]
STORE_SCRIPT = ROOT / "scripts" / "release_secret_store.ps1"
SETUP_SCRIPT = ROOT / "scripts" / "setup_release_secrets.ps1"
EXAMPLE_SCRIPT = ROOT / "scripts" / "set_release_env.example.ps1"
BUILD_SCRIPT = ROOT / "build_production.ps1"
SIGNING_GUARD_SCRIPT = ROOT / "scripts" / "release_signing_key_guard.ps1"
EXECUTABLE_GUARD_SCRIPT = ROOT / "scripts" / "release_executable_guard.ps1"
RUST_TOOLCHAIN_LOCK = ROOT / "scripts" / "rust_toolchain.lock.json"
RELEASE_QA_SCRIPT = ROOT / "scripts" / "run_release_qa.ps1"
RELEASE_UI_SCRIPT = ROOT / "quanly_phathanh.ps1"
PUBLISH_SCRIPT = ROOT / "release_update.ps1"
ONE_CLICK_SCRIPT = ROOT / "PHAT_HANH.bat"


def test_release_semver_authority_uses_ascii_digits_and_exact_tag_routes() -> None:
    """§SEC.24-R6: SemVer/URI authority không nhận digit hay escape Unicode."""
    ascii_semver = (
        r"^[0-9]+\.[0-9]+\.[0-9]+"
        r"(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?"
        r"(?:\+[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?\z"
    )
    for path in (BUILD_SCRIPT, RELEASE_UI_SCRIPT, PUBLISH_SCRIPT):
        source = path.read_text(encoding="utf-8-sig")
        assert source.count(ascii_semver) == 1, path.name

    guard = EXECUTABLE_GUARD_SCRIPT.read_text(encoding="utf-8-sig")
    assert "'^v[0-9]+\\.[0-9]+\\.[0-9]+'" in guard
    assert "'(?:%2B[0-9A-Za-z]+(?:\\.[0-9A-Za-z]+)*)?'" in guard
    assert "%[0-9A-Fa-f]{2}" not in guard


def test_tracked_release_secret_scripts_never_request_plaintext_files() -> None:
    store_text = STORE_SCRIPT.read_text(encoding="utf-8")
    setup_text = SETUP_SCRIPT.read_text(encoding="utf-8")
    example_text = EXAMPLE_SCRIPT.read_text(encoding="utf-8")

    assert "Export-Clixml" in store_text
    assert "Read-Host \"Supabase secret key\" -AsSecureString" in setup_text
    assert "service_role" not in example_text.lower()
    assert "<DÁN" not in example_text
    assert "PRYNX_SUPABASE_SERVICE_KEY =" not in example_text
    assert "Assert-PrynXReleasePrivateStorePath" in store_text
    assert "khong duoc nam trong repo/staging/output" in store_text
    assert "FileAttributes]::ReparsePoint" in store_text


@pytest.mark.skipif(os.name != "nt", reason="Path/reparse contract chi ap dung cho Windows")
def test_release_store_path_policy_blocks_whole_repo_and_allows_sibling() -> None:
    powershell = shutil.which("powershell.exe") or shutil.which("powershell")
    if not powershell:
        pytest.skip("Windows PowerShell khong co trong PATH")

    # Chi resolve path gia, khong tao hay doc file secret. Sibling nam ngoai repo
    # phai tiep tuc hop le de giu compatibility cho custom store path cu.
    sibling = ROOT.parent / "PrynXReleaseSecrets-path-policy-test" / "secrets.clixml"
    verbatim_repo_path = "\\\\?\\" + str(ROOT / "docs" / "secrets.clixml")
    env = os.environ.copy()
    env.pop("PSMODULEPATH", None)
    env.update(
        {
            "PRYNX_TEST_SCRIPT": str(STORE_SCRIPT),
            "PRYNX_TEST_REPO_ROOT": str(ROOT / "secrets.clixml"),
            "PRYNX_TEST_REPO_DOCS": str(ROOT / "docs" / "secrets.clixml"),
            "PRYNX_TEST_REPO_OUTPUT": str(
                ROOT / "Ban_Phat_Hanh" / "secrets.clixml"
            ),
            "PRYNX_TEST_REPO_SIBLING": str(sibling),
            "PRYNX_TEST_REPO_VERBATIM": verbatim_repo_path,
            "PRYNX_TEST_UNC_STORE": r"\\localhost\PrynXReleaseSecrets\secrets.clixml",
        }
    )
    command = (
        ". $env:PRYNX_TEST_SCRIPT; "
        "$resolvers = @('Resolve-PrynXReleaseSecretStorePath', "
        "'Resolve-PrynXReleaseProbeStorePath'); "
        "foreach ($resolver in $resolvers) { "
        "foreach ($candidate in @($env:PRYNX_TEST_REPO_ROOT, "
        "$env:PRYNX_TEST_REPO_DOCS, $env:PRYNX_TEST_REPO_OUTPUT)) { "
        "$rejected = $false; "
        "try { & $resolver -StorePath $candidate | Out-Null } "
        "catch { "
        "if ($_.Exception.Message -notmatch 'repo/staging/output') { throw }; "
        "$rejected = $true "
        "}; "
        "if (-not $rejected) { throw ('Repo path duoc chap nhan boi ' + $resolver) } "
        "}; "
        "foreach ($candidate in @($env:PRYNX_TEST_REPO_VERBATIM, "
        "$env:PRYNX_TEST_UNC_STORE)) { "
        "$rejected = $false; "
        "try { & $resolver -StorePath $candidate | Out-Null } "
        "catch { "
        "if ($_.Exception.Message -notmatch 'UNC/device') { throw }; "
        "$rejected = $true "
        "}; "
        "if (-not $rejected) { throw ('Namespace path duoc chap nhan boi ' + $resolver) } "
        "}; "
        "$actual = & $resolver -StorePath $env:PRYNX_TEST_REPO_SIBLING; "
        "$expected = [IO.Path]::GetFullPath($env:PRYNX_TEST_REPO_SIBLING); "
        "if ($actual -ne $expected) { throw ('Sibling path bi thay doi boi ' + $resolver) } "
        "}; "
        "'PATH_POLICY_OK'"
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
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    assert completed.returncode == 0, completed.stdout + completed.stderr
    assert "PATH_POLICY_OK" in completed.stdout


@pytest.mark.skipif(os.name != "nt", reason="Path/reparse contract chi ap dung cho Windows")
def test_release_store_path_policy_rejects_reparse_component(tmp_path: Path) -> None:
    powershell = shutil.which("powershell.exe") or shutil.which("powershell")
    if not powershell:
        pytest.skip("Windows PowerShell khong co trong PATH")

    target = tmp_path / "real-store-parent"
    reparse_parent = tmp_path / "reparse-store-parent"
    target.mkdir()
    try:
        os.symlink(target, reparse_parent, target_is_directory=True)
    except (NotImplementedError, OSError) as error:
        pytest.skip(f"Runner khong cho tao directory symlink: {error}")

    env = os.environ.copy()
    env.pop("PSMODULEPATH", None)
    env["PRYNX_TEST_SCRIPT"] = str(STORE_SCRIPT)
    env["PRYNX_TEST_REPARSE_STORE"] = str(reparse_parent / "secrets.clixml")
    command = (
        ". $env:PRYNX_TEST_SCRIPT; "
        "$resolvers = @('Resolve-PrynXReleaseSecretStorePath', "
        "'Resolve-PrynXReleaseProbeStorePath'); "
        "foreach ($resolver in $resolvers) { "
        "$rejected = $false; "
        "try { & $resolver -StorePath $env:PRYNX_TEST_REPARSE_STORE | Out-Null } "
        "catch { "
        "if ($_.Exception.Message -notmatch 'reparse point') { throw }; "
        "$rejected = $true "
        "}; "
        "if (-not $rejected) { throw ('Reparse path duoc chap nhan boi ' + $resolver) } "
        "}; "
        "'REPARSE_POLICY_OK'"
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
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    assert completed.returncode == 0, completed.stdout + completed.stderr
    assert "REPARSE_POLICY_OK" in completed.stdout


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
    bootstrap_loop_at = build_text.index("foreach ($bootstrapName in @(")
    clear_at = build_text.index(
        "[Environment]::SetEnvironmentVariable(", bootstrap_loop_at
    )
    first_guard_load_at = build_text.index(
        '. "$ROOT\\scripts\\windows_payload_guard.ps1"'
    )
    first_tool_gate_at = build_text.index("Assert-BuildToolchain\n")
    assert clear_at < first_guard_load_at < first_tool_gate_at
    assert "Import-PrynXReleaseEnvironment" not in ui_text
    assert "Resolve-PrynXReleaseSecretStorePath" in ui_text
    assert "Assert-NoReleaseSecretInPayloadFile" in build_text
    assert ".clixml" in build_text
    assert "sb_secret_[A-Za-z0-9_-]{20,}" in build_text


def test_updater_signing_secret_is_scoped_to_signer_and_cleared_before_publish() -> None:
    build_text = BUILD_SCRIPT.read_text(encoding="utf-8")
    signing_guard_text = SIGNING_GUARD_SCRIPT.read_text(encoding="utf-8")
    publish_text = PUBLISH_SCRIPT.read_text(encoding="utf-8-sig")

    capture_at = build_text.index("$script:CapturedTauriSigningPrivateKey =")
    capture_path_at = build_text.index("$script:CapturedTauriSigningKeyFile =")
    bootstrap_loop_at = build_text.index("foreach ($bootstrapName in @(")
    early_clear_at = build_text.index(
        "[Environment]::SetEnvironmentVariable(", bootstrap_loop_at
    )
    first_guard_load_at = build_text.index(
        '. "$ROOT\\scripts\\windows_payload_guard.ps1"'
    )
    first_tool_gate_at = build_text.index("Assert-BuildToolchain\n")
    tauri_at = build_text.index(
        "& $script:PrynXNodePath $tauriCliPath build --config $tauriConfig",
        first_tool_gate_at,
    )
    lease_at = build_text.index(
        "Assert-ReleaseSigningAuthority -AcquireLease", tauri_at
    )
    key_arg_at = build_text.index(
        '$tauriSignerArgs += @("-f", [string]$script:TauriSigningKeyLease.Path)',
        lease_at,
    )
    password_expose_at = build_text.index(
        "$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD =", key_arg_at
    )
    signer_at = build_text.index(
        "& $script:PrynXNodePath $tauriCliPath @tauriSignerArgs",
        password_expose_at,
    )
    lease_close_at = build_text.index(
        "Close-PrynXPayloadLease -Lease $script:TauriSigningKeyLease", signer_at
    )
    clear_after_signer_at = build_text.index(
        "Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD", signer_at
    )
    assert capture_at < early_clear_at < first_guard_load_at < first_tool_gate_at < tauri_at
    assert capture_path_at < early_clear_at < first_guard_load_at
    assert tauri_at < lease_at < key_arg_at < password_expose_at < signer_at
    assert signer_at < lease_close_at < clear_after_signer_at
    assert "npx @tauri" not in build_text
    assert "NAPI_RS_NATIVE_LIBRARY_PATH = $tauriNativePath" in build_text
    assert "$env:TAURI_SIGNING_PRIVATE_KEY =" not in build_text
    assert "Get-Content -LiteralPath $script:CapturedTauriSigningKeyFile -Raw" not in build_text
    assert '. (Join-Path $PSScriptRoot "windows_payload_guard.ps1")' in signing_guard_text
    assert "Open-PrynXPayloadFileLease" in signing_guard_text
    assert "PrynXUpdaterSigningDirectoryIdentity" in signing_guard_text
    assert "FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT" in signing_guard_text
    assert "FileShare.Read | FileShare.Write" in signing_guard_text
    assert "FileShare.Delete" not in signing_guard_text
    assert "DirectoryLeases = $directoryLeases.ToArray()" in signing_guard_text
    assert "Get-Content" not in signing_guard_text

    outer_finally_at = build_text.rindex("} finally {")
    restore_environment_at = build_text.index(
        "Restore-BuildOwnedEnvironment", outer_finally_at
    )
    for environment_name in (
        "TAURI_SIGNING_PRIVATE_KEY",
        "PRYNX_TAURI_SIGNING_KEY_FILE",
        "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
    ):
        clear_in_outer_finally_at = build_text.index(
            f"Remove-Item Env:{environment_name}", outer_finally_at
        )
        assert outer_finally_at < clear_in_outer_finally_at < restore_environment_at

    publisher_bootstrap_loop_at = publish_text.index("foreach ($bootstrapName in @(")
    publisher_password_clear_at = publish_text.index(
        "[Environment]::SetEnvironmentVariable(", publisher_bootstrap_loop_at
    )
    publisher_guard_load_at = publish_text.index(
        '. "$ROOT\\scripts\\release_executable_guard.ps1"'
    )
    github_preflight_at = publish_text.index(
        "$authResult = Invoke-PrynXGitHubCliCommand"
    )
    build_call_at = publish_text.index('& "$ROOT\\build_production.ps1" @buildArgs')
    key_path_at = publish_text.index("$env:PRYNX_TAURI_SIGNING_KEY_FILE = $KEY_FILE")
    publisher_clear_after_build_at = publish_text.index(
        "Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY", build_call_at
    )
    github_upload_at = publish_text.index(
        "$uploadResult = Invoke-PrynXGitHubCliCommand"
    )
    assert publisher_password_clear_at < publisher_guard_load_at < github_preflight_at
    assert "Get-Content -LiteralPath $KEY_FILE -Raw" not in publish_text
    assert key_path_at < build_call_at < publisher_clear_after_build_at < github_upload_at


def test_publisher_pins_vendor_signed_github_cli_instead_of_path_lookup() -> None:
    text = PUBLISH_SCRIPT.read_text(encoding="utf-8")
    resolver = EXECUTABLE_GUARD_SCRIPT.read_text(encoding="utf-8-sig")

    auth_at = text.index("$authResult = Invoke-PrynXGitHubCliCommand")
    upload_at = text.index("$uploadResult = Invoke-PrynXGitHubCliCommand", auth_at)
    create_at = text.index("$createResult = Invoke-PrynXGitHubCliCommand", auth_at)
    close_at = text.rindex("Close-PrynXReleaseExecutableLease -Lease $githubCliLease")

    assert '. "$ROOT\\scripts\\release_executable_guard.ps1"' in text
    assert "[Environment+SpecialFolder]::ProgramFiles" in resolver
    assert "GitHub CLI\\gh.exe" in resolver
    assert (
        "Microsoft.PowerShell.Security\\Get-AuthenticodeSignature -LiteralPath $Path"
        in resolver
    )
    assert "GitHub, Inc" in resolver
    assert "Open-PrynXPayloadFileLease" in resolver
    assert "function Invoke-PrynXGitHubCliCommand" in resolver
    assert "Assert-PrynXGitHubCliCredentialStorageAuthority" in resolver
    assert "Get-Command gh" not in text
    assert "& gh" not in text
    assert auth_at < upload_at < close_at
    assert auth_at < create_at < close_at


def test_release_authority_never_invokes_security_tools_through_path(
    tmp_path: Path,
) -> None:
    """§SEC.24: PATH không được chọn process build/publish hoặc process nhận secret."""
    build = BUILD_SCRIPT.read_text(encoding="utf-8")
    qa = (ROOT / "scripts" / "run_release_qa.ps1").read_text(encoding="utf-8")
    gui = RELEASE_UI_SCRIPT.read_text(encoding="utf-8-sig")
    controller = (ROOT / "scripts" / "release_controller.ps1").read_text(
        encoding="utf-8-sig"
    )
    publish = PUBLISH_SCRIPT.read_text(encoding="utf-8-sig")
    launcher = (ROOT / "PRYNX.bat").read_text(encoding="utf-8")
    one_click = ONE_CLICK_SCRIPT.read_text(encoding="utf-8")
    guard = EXECUTABLE_GUARD_SCRIPT.read_text(encoding="utf-8-sig")

    forbidden_release_tools = (
        "git",
        "git.exe",
        "powershell",
        "powershell.exe",
        "pwsh",
        "pwsh.exe",
        "cmd",
        "cmd.exe",
        "gh",
        "gh.exe",
        "node",
        "node.exe",
        "npm",
        "npm.cmd",
        "npx",
        "npx.cmd",
        "cargo",
        "cargo.exe",
        "rustc",
        "rustc.exe",
        "robocopy",
        "robocopy.exe",
        "notepad",
        "notepad.exe",
        "Get-AuthenticodeSignature",
    )

    def find_bare_release_tool_calls(script_path: Path) -> list[str]:
        powershell = (
            shutil.which("powershell.exe")
            or shutil.which("powershell")
            or shutil.which("pwsh")
        )
        if powershell:
            env = os.environ.copy()
            env.pop("PSMODULEPATH", None)
            env["PRYNX_TEST_RELEASE_AST"] = str(script_path)
            ast_probe = r'''
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(
    $env:PRYNX_TEST_RELEASE_AST,
    [ref]$tokens,
    [ref]$parseErrors
)
if (@($parseErrors).Count -ne 0) {
    $parseErrors | ForEach-Object { [Console]::Error.WriteLine($_.Message) }
    exit 2
}
$forbidden = @(
    "git", "git.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe",
    "cmd", "cmd.exe", "gh", "gh.exe", "node", "node.exe", "npm", "npm.cmd",
    "npx", "npx.cmd", "cargo", "cargo.exe", "rustc", "rustc.exe",
    "robocopy", "robocopy.exe", "notepad", "notepad.exe",
    "Get-AuthenticodeSignature"
)
function Test-BareReleaseToolName {
    param([AllowNull()][string]$Candidate)
    if ([string]::IsNullOrWhiteSpace($Candidate) -or $Candidate -match '[\\/]') {
        return $false
    }
    return ($forbidden -contains $Candidate)
}
$hits = New-Object System.Collections.Generic.List[string]
$commands = @($ast.FindAll({
    param($node)
    $node -is [Management.Automation.Language.CommandAst]
}, $true))
foreach ($command in $commands) {
    $commandName = [string]$command.GetCommandName()
    if (Test-BareReleaseToolName -Candidate $commandName) {
        $hits.Add(("{0}:{1}" -f $command.Extent.StartLineNumber, $commandName)) | Out-Null
        continue
    }

    if ($commandName -ieq "Get-Command") {
        foreach ($element in @($command.CommandElements | Select-Object -Skip 1)) {
            if ($element -is [Management.Automation.Language.StringConstantExpressionAst] -and
                (Test-BareReleaseToolName -Candidate ([string]$element.Value))) {
                $hits.Add(("{0}:Get-Command {1}" -f $command.Extent.StartLineNumber, $element.Value)) | Out-Null
            }
        }
        continue
    }

    if ($commandName -ieq "Start-Process") {
        $elements = @($command.CommandElements)
        $candidate = $null
        for ($index = 1; $index -lt $elements.Count; $index++) {
            $element = $elements[$index]
            if ($element -is [Management.Automation.Language.CommandParameterAst] -and
                $element.ParameterName -ieq "FilePath" -and
                ($index + 1) -lt $elements.Count -and
                $elements[$index + 1] -is [Management.Automation.Language.StringConstantExpressionAst]) {
                $candidate = [string]$elements[$index + 1].Value
                break
            }
            if ($index -eq 1 -and
                $element -is [Management.Automation.Language.StringConstantExpressionAst]) {
                $candidate = [string]$element.Value
                break
            }
        }
        if (Test-BareReleaseToolName -Candidate $candidate) {
            $hits.Add(("{0}:Start-Process {1}" -f $command.Extent.StartLineNumber, $candidate)) | Out-Null
        }
    }
}
$hits | Sort-Object -Unique
'''
            completed = subprocess.run(
                [
                    powershell,
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-Command",
                    ast_probe,
                ],
                cwd=ROOT,
                env=env,
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
            )
            assert completed.returncode == 0, completed.stdout + completed.stderr
            return [line.strip() for line in completed.stdout.splitlines() if line.strip()]

        # Fallback cho runner không có PowerShell: vẫn giữ ratchet cho direct/call-operator.
        source = script_path.read_text(encoding="utf-8-sig")
        tool_pattern = "|".join(
            sorted(
                (re.escape(tool) for tool in forbidden_release_tools),
                key=len,
                reverse=True,
            )
        )
        patterns = (
            re.compile(
                rf"(?im)&\s*['\"]?(?P<tool>{tool_pattern})['\"]?(?=\s|[;|)]|$)"
            ),
            re.compile(
                rf"(?im)(?:^|[;{{(|])\s*(?P<tool>{tool_pattern})(?=\s|[;|)]|$)"
            ),
        )
        return [
            f"{source.count(chr(10), 0, match.start()) + 1}:{match.group('tool')}"
            for pattern in patterns
            for match in pattern.finditer(source)
        ]

    for text in (build, qa):
        for forbidden in (
            "& git -C",
            "& powershell.exe",
            "& robocopy",
            "npm.cmd ",
            "npx @",
            "{ cargo ",
            "Get-Command node",
            "Get-Command rustc",
        ):
            assert forbidden not in text
    assert "Initialize-PrynXReleaseToolAuthority" in build
    assert "Initialize-PrynXQaToolAuthority" in qa
    assert "Open-PrynXTrustedReleaseExecutableLease" in guard
    for kind in ("Node", "Git", "Robocopy", "Notepad"):
        assert f"'{kind}'" in guard
    assert "Open-PrynXTrustedRustToolchainLease" in guard
    assert "Assert-PrynXRustToolchainIdentity" in guard
    assert "Assert-PrynXRustToolchainExactSet" in guard
    assert ".cargo\\bin" not in guard
    assert "RustupProxy" not in guard
    assert (
        "Microsoft.PowerShell.Security\\Get-AuthenticodeSignature -LiteralPath $Path"
        in guard
    )
    assert "$securityModulePath = Join-Path $PSHOME" in guard
    assert "Import-Module -Name $securityModulePath" in guard
    assert "LockSha256 = $lockLease.Sha256" in guard

    assert 'start "" powershell' not in launcher.lower()
    assert "\npowershell -noprofile" not in one_click.lower()
    trusted_batch_powershell = (
        "%__APPDIR__%WindowsPowerShell\\v1.0\\powershell.exe"
    )
    assert trusted_batch_powershell in launcher
    assert trusted_batch_powershell in one_click
    assert "%SystemRoot%" not in launcher
    assert "%SystemRoot%" not in one_click
    assert "Get-Command gh" not in publish
    assert "& gh" not in publish
    assert find_bare_release_tool_calls(PUBLISH_SCRIPT) == []
    assert find_bare_release_tool_calls(RELEASE_UI_SCRIPT) == []

    git_open_at = publish.index(
        '$gitLease = Open-PrynXTrustedReleaseExecutableLease -Kind "Git"'
    )
    git_path_at = publish.index("$script:PrynXGit = $gitLease.Path", git_open_at)
    trusted_git_calls = [
        match.start()
        for match in re.finditer("Invoke-PrynXGitReadOnlyCommand", publish)
    ]
    first_git_consumer_at = publish.index(
        "Assert-CommittedReleaseVersion -ExpectedVersion $Version", git_path_at
    )
    direct_git_call_at = publish.index(
        "$sourceHeadResult = Invoke-PrynXGitReadOnlyCommand", first_git_consumer_at
    )
    last_git_consumer_at = publish.rindex(
        "Assert-ManifestSourceState -ManifestPath"
    )
    git_close_at = publish.rindex(
        "Close-PrynXReleaseExecutableLease -Lease $gitLease"
    )
    git_finally_at = publish.rfind("} finally {", last_git_consumer_at, git_close_at)
    git_clear_at = publish.index("$script:PrynXGit = $null", git_close_at)
    assert len(trusted_git_calls) == 4
    assert git_open_at < git_path_at < first_git_consumer_at < direct_git_call_at
    assert direct_git_call_at < last_git_consumer_at < git_finally_at
    assert git_finally_at < git_close_at < git_clear_at

    # Sensitivity: một consumer bỏ wrapper và quay về PATH phải bị AST bắt.
    mutated_publish = publish.replace(
        "Invoke-PrynXGitReadOnlyCommand", "& git", 1
    )
    assert mutated_publish != publish
    mutation_path = tmp_path / "release_update-path-mutation.ps1"
    mutation_path.write_text(mutated_publish, encoding="utf-8")
    mutation_hits = find_bare_release_tool_calls(mutation_path)
    assert len([hit for hit in mutation_hits if hit.lower().endswith(":git")]) == 1

    trusted_gh_calls = list(
        re.finditer("Invoke-PrynXGitHubCliCommand", publish)
    )
    assert len(trusted_gh_calls) == 8
    mutated_publish = publish.replace("Invoke-PrynXGitHubCliCommand", "& gh", 1)
    assert mutated_publish != publish
    gh_mutation_path = tmp_path / "release-update-gh-path-mutation.ps1"
    gh_mutation_path.write_text(mutated_publish, encoding="utf-8")
    gh_mutation_hits = find_bare_release_tool_calls(gh_mutation_path)
    assert len(
        [hit for hit in gh_mutation_hits if hit.lower().endswith(":gh")]
    ) == 1

    assert "GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM" in guard
    assert guard.count("-c core.fsmonitor=false") == 5
    assert guard.count("-c core.hooksPath=NUL") == 5
    assert guard.count("-c $trustedAttributesConfig") == 5
    assert guard.count("-c $trustedExcludeConfig") == 5
    assert "core.attributesFile=' + $infoAttributesLease.Path" in guard
    assert "core.excludesFile=' + $infoExcludeLease.Path" in guard
    assert "core.excludesFile=NUL" not in guard
    assert "--absolute-git-dir" in guard
    assert "--git-common-dir" in guard
    assert "function Invoke-PrynXGitHubCliCommand" in guard
    assert "config list --host github.com" in guard
    assert "'api_host'" in guard
    assert "'BROWSER'" in guard
    assert "[Environment+SpecialFolder]::ApplicationData" in guard

    qualified_authenticode = (
        "Microsoft.PowerShell.Security\\Get-AuthenticodeSignature"
    )
    mutated_guard, authenticode_mutation_count = guard.replace(
        qualified_authenticode, "& Get-AuthenticodeSignature"
    ), guard.count(qualified_authenticode)
    assert authenticode_mutation_count == 1
    authenticode_mutation_path = tmp_path / "guard-authenticode-mutation.ps1"
    authenticode_mutation_path.write_text(mutated_guard, encoding="utf-8")
    authenticode_hits = find_bare_release_tool_calls(authenticode_mutation_path)
    assert len(
        [
            hit
            for hit in authenticode_hits
            if hit.lower().endswith(":get-authenticodesignature")
        ]
    ) == 1

    assert "$startInfo.FileName = $script:PrynXControllerPowerShellPath" in controller
    assert 'Get-PrynXGuiExecutablePath -Kind "WindowsPowerShell"' in gui
    assert 'Get-PrynXGuiExecutablePath -Kind "Notepad"' in gui
    assert "Start-Process notepad.exe" not in gui
    assert "$env:USERPROFILE" not in gui
    assert "$env:USERPROFILE" not in publish
    assert gui.count("Resolve-PrynXUpdaterSigningKeyPath") == 1
    assert publish.count("Resolve-PrynXUpdaterSigningKeyPath") == 1
    assert "[Environment+SpecialFolder]::UserProfile" in guard
    assert 'auth login --hostname github.com --git-protocol https' in gui
    assert ' --web --skip-ssh-key"' in gui
    assert "--clipboard" not in gui
    assert (
        '"GH_PROMPT_DISABLED",\n            "1",\n'
        in gui.replace("\r\n", "\n")
    )
    assert "--insecure-storage" not in gui


@pytest.mark.skipif(os.name != "nt", reason="Known Folder chi ap dung cho Windows")
def test_updater_signing_key_path_ignores_ambient_userprofile() -> None:
    """§SEC.24-R6: USERPROFILE gia/UNC khong duoc doi authority khoa updater."""
    # SEC (audit 2026-09-04 §SEC.24-R6): chay tren ca Windows PowerShell 5.1
    # va pwsh neu co; moi process con chi resolve metadata, khong doc khoa ky.
    runtimes: list[Path] = []
    system_root = os.environ.get("SystemRoot")
    if system_root:
        windows_powershell = (
            Path(system_root)
            / "System32"
            / "WindowsPowerShell"
            / "v1.0"
            / "powershell.exe"
        )
        if windows_powershell.is_file():
            runtimes.append(windows_powershell)
    pwsh = shutil.which("pwsh.exe") or shutil.which("pwsh")
    if pwsh:
        pwsh_path = Path(pwsh).resolve()
        if all(
            str(runtime).casefold() != str(pwsh_path).casefold()
            for runtime in runtimes
        ):
            runtimes.append(pwsh_path)
    if not runtimes:
        pytest.skip("Khong co PowerShell runtime de kiem Known Folder")

    command = r'''
. $env:PRYNX_TEST_EXECUTABLE_GUARD
$actual = Resolve-PrynXUpdaterSigningKeyPath
$knownProfile = [Environment]::GetFolderPath(
    [Environment+SpecialFolder]::UserProfile
)
$expected = [IO.Path]::GetFullPath(
    (Join-Path (Join-Path $knownProfile '.tauri') 'prynx.key')
)
if ($actual.StartsWith('\\')) {
    throw "Resolver chap nhan UNC: $actual"
}
if (-not [string]::Equals(
        $actual,
        $expected,
        [StringComparison]::OrdinalIgnoreCase
    )) {
    throw "Resolver lech Known Folder: $actual <> $expected"
}
if ([string]::Equals(
        $actual,
        [IO.Path]::GetFullPath(
            (Join-Path (Join-Path $env:USERPROFILE '.tauri') 'prynx.key')
        ),
        [StringComparison]::OrdinalIgnoreCase
    )) {
    throw "Resolver tin ambient USERPROFILE: $actual"
}
'UPDATER_KEY_AUTHORITY_OK'
'''
    fake_profiles = (
        str(ROOT / ".tmp-security-audit" / "fake-user-profile"),
        r"\\attacker.invalid\share\fake-user-profile",
    )
    for runtime in runtimes:
        for fake_profile in fake_profiles:
            env = os.environ.copy()
            env.pop("PSMODULEPATH", None)
            env["USERPROFILE"] = fake_profile
            env["PRYNX_TEST_EXECUTABLE_GUARD"] = str(
                EXECUTABLE_GUARD_SCRIPT
            )
            completed = subprocess.run(
                [
                    str(runtime),
                    "-NoProfile",
                    "-NonInteractive",
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
            assert completed.returncode == 0, (
                f"{runtime} voi USERPROFILE={fake_profile}\n"
                f"{completed.stdout}{completed.stderr}"
            )
            assert "UPDATER_KEY_AUTHORITY_OK" in completed.stdout


@pytest.mark.skipif(os.name != "nt", reason="cmd __APPDIR__ chi co tren Windows")
def test_release_batch_launchers_ignore_ambient_systemroot() -> None:
    """§SEC.24-R7: batch neo PowerShell vao cmd.exe dang chay, khong vao env."""
    system_root = os.environ.get("SystemRoot")
    if not system_root:
        pytest.skip("Khong co SystemRoot de resolve cmd.exe he thong")
    cmd_path = Path(system_root) / "System32" / "cmd.exe"
    if not cmd_path.is_file():
        pytest.skip("Khong co cmd.exe he thong")

    expected_directory = os.path.normcase(os.path.normpath(cmd_path.parent))
    for extension_mode in ("/e:on", "/e:off"):
        env = os.environ.copy()
        env["SystemRoot"] = r"D:\attacker-controlled-system-root"
        env["__APPDIR__"] = "D:\\attacker-controlled-app-dir\\"
        completed = subprocess.run(
            [
                str(cmd_path),
                "/d",
                extension_mode,
                "/c",
                "echo(%__APPDIR__%",
            ],
            cwd=ROOT,
            env=env,
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        assert completed.returncode == 0, completed.stdout + completed.stderr
        actual_directory = os.path.normcase(
            os.path.normpath(completed.stdout.strip())
        )
        assert actual_directory == expected_directory


def test_rust_toolchain_lock_and_release_flow_are_content_addressed() -> None:
    """§SEC.24-R4: release dùng direct toolchain và bind provenance vào manifest."""
    document = json.loads(RUST_TOOLCHAIN_LOCK.read_text(encoding="utf-8"))
    build = BUILD_SCRIPT.read_text(encoding="utf-8")
    qa = RELEASE_QA_SCRIPT.read_text(encoding="utf-8")
    guard = EXECUTABLE_GUARD_SCRIPT.read_text(encoding="utf-8-sig")

    assert document["schema_version"] == 1
    assert document["component_id"] == "prynx-rust-toolchain"
    assert document["toolchain_id"] == "1.94.0-x86_64-pc-windows-msvc"
    assert document["release"] == "1.94.0"
    assert document["host"] == "x86_64-pc-windows-msvc"
    assert document["root_count"] == 4
    assert document["file_count"] == 82
    assert document["provenance"]["channel_manifest"] == {
        "url": "https://static.rust-lang.org/dist/2026-03-05/channel-rust-1.94.0.toml",
        "signature_url": "https://static.rust-lang.org/dist/2026-03-05/channel-rust-1.94.0.toml.asc",
        "size": 845032,
        "sha256": "aaa177def36e01d539bee6bde95295230b9ce378f81057845db8d0ebe97898ee",
    }
    assert {
        item["component"]: item["sha256"]
        for item in document["provenance"]["archives"]
    } == {
        "cargo": "6cf7113e1d5633721739a3bd6fee7148d6394bbab748fbede941210100374741",
        "rustc": "e0f59503778b563d3ee6d4edecd52b44056779ffe456181bad1fb4dc069802e6",
        "rust-std": "f8e2b43e52957e8224d97de68d6ec5da01613eb98bce4199de80071678b5fda0",
        "clippy": "e4dcc5a796857589e364064493abb3afb469e0e36e90155e7b0a2c5ce4bb7503",
        "rustfmt": "7b32d8b0dd99f9bf6ddaa4866d39b7b96e8c2db46644d8527096f7f34b4fbe26",
    }

    roots = {root["path"]: root for root in document["payload_roots"]}
    assert {path: root["file_count"] for path, root in roots.items()} == {
        "bin": 23,
        "lib/rustlib/x86_64-pc-windows-msvc/bin": 12,
        "lib/rustlib/x86_64-pc-windows-msvc/lib": 45,
        "libexec": 2,
    }
    assert sum(root["file_count"] for root in roots.values()) == document["file_count"]
    for root in roots.values():
        assert root["exact_set"] is True
        paths = [entry["path"] for entry in root["files"]]
        assert len({path.casefold() for path in paths}) == len(paths)
        assert root["file_count"] == len(paths)
        for entry in root["files"]:
            assert entry["size"] > 0
            assert re.fullmatch(r"[0-9a-f]{64}", entry["sha256"])

    assert ".cargo\\bin" not in guard
    assert "RustupProxy" not in guard
    assert "Open-PrynXTrustedRustToolchainLease" in build
    assert "Open-PrynXTrustedRustToolchainLease" in qa
    assert "Assert-PrynXCargoConfigurationAuthority" in build
    assert "Assert-PrynXCargoConfigurationAuthority" in qa
    initialize_at = build.index("Initialize-PrynXReleaseToolAuthority")
    clean_gate_at = build.index("Assert-ReleaseSourceState -CaptureCommit", initialize_at)
    identity_at = build.index("Assert-BuildToolchain", clean_gate_at)
    assert initialize_at < clean_gate_at < identity_at
    assert build.count("Assert-PrynXRustToolchainExactSet") >= 5
    assert "Invoke-CheckedCargo" in qa
    for field in (
        "RUST_TOOLCHAIN_ID",
        "RUST_TOOLCHAIN_LOCK_SHA256",
        "RUSTC_COMMIT",
        "CARGO_COMMIT",
    ):
        assert f'"{field}' in build


@pytest.mark.skipif(os.name != "nt", reason="Rust toolchain lease chi chay tren Windows")
def test_rust_toolchain_lock_matches_installed_bytes_and_rejects_mutation(
    tmp_path: Path,
) -> None:
    """Lock thật mở được; đổi hash/provenance bị chặn trước compiler consumer."""
    powershell = shutil.which("powershell.exe") or shutil.which("powershell")
    if not powershell:
        pytest.skip("Windows PowerShell khong co trong PATH")

    document = json.loads(RUST_TOOLCHAIN_LOCK.read_text(encoding="utf-8"))
    toolchain_root = Path.home() / ".rustup" / "toolchains" / document["toolchain_id"]
    if not toolchain_root.is_dir():
        pytest.skip(f"Khong co exact toolchain fixture: {toolchain_root}")

    for root in document["payload_roots"]:
        actual_root = toolchain_root / Path(root["path"])
        expected = {entry["path"]: entry for entry in root["files"]}
        actual = {
            path.relative_to(actual_root).as_posix(): path
            for path in actual_root.rglob("*")
            if path.is_file()
        }
        assert actual.keys() == expected.keys()
        for relative_path, path in actual.items():
            assert path.stat().st_size == expected[relative_path]["size"]
            with path.open("rb") as stream:
                actual_hash = hashlib.file_digest(stream, "sha256").hexdigest()
            assert actual_hash == expected[relative_path]["sha256"]

    hash_mutation = json.loads(json.dumps(document))
    cargo_entry = next(
        entry
        for entry in hash_mutation["payload_roots"][0]["files"]
        if entry["path"] == "cargo.exe"
    )
    cargo_entry["sha256"] = "0" * 64
    hash_mutation_path = tmp_path / "rust-toolchain-hash-mutation.json"
    hash_mutation_path.write_text(json.dumps(hash_mutation), encoding="utf-8")

    provenance_mutation = json.loads(json.dumps(document))
    provenance_mutation["provenance"]["channel_manifest"]["url"] = (
        "https://example.invalid/channel-rust.toml"
    )
    provenance_mutation_path = tmp_path / "rust-toolchain-provenance-mutation.json"
    provenance_mutation_path.write_text(json.dumps(provenance_mutation), encoding="utf-8")

    env = os.environ.copy()
    env.pop("PSMODULEPATH", None)
    for name in list(env):
        if re.fullmatch(
            r"(?:CARGO|CARGO_HOME|RUSTC|RUSTDOC|RUSTC_WRAPPER|RUSTC_WORKSPACE_WRAPPER|"
            r"RUSTFLAGS|RUSTDOCFLAGS|RUSTC_BOOTSTRAP|RUSTUP_HOME|RUSTUP_TOOLCHAIN|"
            r"CARGO_(?:BUILD|ENCODED|NET|TARGET).*)",
            name,
            flags=re.IGNORECASE,
        ):
            env.pop(name, None)
    env.update(
        {
            "PRYNX_TEST_GUARD": str(EXECUTABLE_GUARD_SCRIPT),
            "PRYNX_TEST_LOCK": str(RUST_TOOLCHAIN_LOCK),
            "PRYNX_TEST_BAD_HASH_LOCK": str(hash_mutation_path),
            "PRYNX_TEST_BAD_PROVENANCE_LOCK": str(provenance_mutation_path),
        }
    )
    command = r'''
$ErrorActionPreference = 'Stop'
. $env:PRYNX_TEST_GUARD
$null = Clear-PrynXAmbientRustToolOverrides
$lease = Open-PrynXTrustedRustToolchainLease -LockPath $env:PRYNX_TEST_LOCK
try {
    $env:CARGO = $lease.CargoPath
    $env:CARGO_HOME = $lease.CargoHome
    $env:RUSTC = $lease.RustcPath
    $env:RUSTDOC = $lease.RustdocPath
    [Environment]::SetEnvironmentVariable('RUSTC_WRAPPER', '', 'Process')
    [Environment]::SetEnvironmentVariable('RUSTC_WORKSPACE_WRAPPER', '', 'Process')
    Assert-PrynXRustToolEnvironment `
        -CargoPath $lease.CargoPath -RustcPath $lease.RustcPath `
        -RustdocPath $lease.RustdocPath -CargoHome $lease.CargoHome
    Assert-PrynXCargoConfigurationAuthority `
        -CargoHome $lease.CargoHome -WorkingDirectories @($PWD.Path)
    Assert-PrynXRustToolchainIdentity -Lease $lease
    $writeOpenBlocked = $false
    $writeProbe = $null
    try {
        $writeProbe = [IO.File]::Open(
            $lease.CargoPath, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite
        )
    } catch { $writeOpenBlocked = $true } finally { if ($writeProbe) { $writeProbe.Dispose() } }
    if (-not $writeOpenBlocked) { throw 'Cargo lease did not block a write handle.' }
} finally {
    Close-PrynXReleaseExecutableLease -Lease $lease
}

foreach ($badLock in @($env:PRYNX_TEST_BAD_HASH_LOCK, $env:PRYNX_TEST_BAD_PROVENANCE_LOCK)) {
    $badLease = $null
    $rejected = $false
    try { $badLease = Open-PrynXTrustedRustToolchainLease -LockPath $badLock }
    catch { $rejected = $true }
    finally { Close-PrynXReleaseExecutableLease -Lease $badLease }
    if (-not $rejected) { throw "Mutated Rust lock was accepted: $badLock" }
}
'RUST_TOOLCHAIN_LOCK_OK'
'''
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
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=300,
        check=False,
    )
    assert completed.returncode == 0, completed.stdout + completed.stderr
    assert "RUST_TOOLCHAIN_LOCK_OK" in completed.stdout


@pytest.mark.skipif(os.name != "nt", reason="Rust env guard chi chay tren Windows")
def test_rust_tool_environment_clears_and_rejects_executable_overrides(
    tmp_path: Path,
) -> None:
    """Ambient wrapper/linker/flags không được sống tới Cargo consumer."""
    powershell = shutil.which("powershell.exe") or shutil.which("powershell")
    if not powershell:
        pytest.skip("Windows PowerShell khong co trong PATH")

    document = json.loads(RUST_TOOLCHAIN_LOCK.read_text(encoding="utf-8"))
    toolchain_root = Path.home() / ".rustup" / "toolchains" / document["toolchain_id"]
    if not toolchain_root.is_dir():
        pytest.skip(f"Khong co exact toolchain fixture: {toolchain_root}")

    cargo_config_parent = tmp_path / "cargo-config-parent"
    cargo_working_directory = cargo_config_parent / "workspace" / "crate"
    cargo_working_directory.mkdir(parents=True)
    cargo_config_directory = cargo_config_parent / ".cargo"
    cargo_config_directory.mkdir()
    (cargo_config_directory / "config.toml").write_text(
        '[build]\nrustc-wrapper = "evil-wrapper.exe"\n', encoding="utf-8"
    )

    env = os.environ.copy()
    env.pop("PSMODULEPATH", None)
    env.update(
        {
            "PRYNX_TEST_GUARD": str(EXECUTABLE_GUARD_SCRIPT),
            "PRYNX_TEST_CARGO": str(toolchain_root / "bin" / "cargo.exe"),
            "PRYNX_TEST_CARGO_HOME": str(Path.home() / ".cargo"),
            "PRYNX_TEST_RUSTC": str(toolchain_root / "bin" / "rustc.exe"),
            "PRYNX_TEST_RUSTDOC": str(toolchain_root / "bin" / "rustdoc.exe"),
            "PRYNX_TEST_CARGO_CONFIG_WORK": str(cargo_working_directory),
        }
    )
    command = r'''
$ErrorActionPreference = 'Stop'
. $env:PRYNX_TEST_GUARD
$env:CARGO_BUILD_RUSTC = 'evil-rustc.exe'
$env:CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER = 'evil-link.exe'
$env:RUSTFLAGS = '-Zinject'
$names = @(Get-PrynXRustToolOverrideVariableNames)
foreach ($required in @('CARGO_BUILD_RUSTC', 'CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER', 'RUSTFLAGS')) {
    if ($names -notcontains $required) { throw "Override inventory missed $required" }
}
$null = Clear-PrynXAmbientRustToolOverrides
$env:CARGO = $env:PRYNX_TEST_CARGO
$env:CARGO_HOME = $env:PRYNX_TEST_CARGO_HOME
$env:RUSTC = $env:PRYNX_TEST_RUSTC
$env:RUSTDOC = $env:PRYNX_TEST_RUSTDOC
Assert-PrynXRustToolEnvironment `
    -CargoPath $env:PRYNX_TEST_CARGO -RustcPath $env:PRYNX_TEST_RUSTC `
    -RustdocPath $env:PRYNX_TEST_RUSTDOC -CargoHome $env:PRYNX_TEST_CARGO_HOME

$env:RUSTC_WRAPPER = 'evil-wrapper.exe'
$rejected = $false
try {
    Assert-PrynXRustToolEnvironment `
        -CargoPath $env:PRYNX_TEST_CARGO -RustcPath $env:PRYNX_TEST_RUSTC `
        -RustdocPath $env:PRYNX_TEST_RUSTDOC -CargoHome $env:PRYNX_TEST_CARGO_HOME
} catch { $rejected = $true }
if (-not $rejected) { throw 'Non-empty RUSTC_WRAPPER was accepted.' }

$configRejected = $false
try {
    Assert-PrynXCargoConfigurationAuthority `
        -CargoHome $env:PRYNX_TEST_CARGO_HOME `
        -WorkingDirectories @($env:PRYNX_TEST_CARGO_CONFIG_WORK)
} catch { $configRejected = $true }
if (-not $configRejected) { throw 'Ancestor Cargo config was accepted.' }
'RUST_TOOL_ENV_OK'
'''
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
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    assert completed.returncode == 0, completed.stdout + completed.stderr
    assert "RUST_TOOL_ENV_OK" in completed.stdout


def test_one_click_release_loads_updater_key_without_leaving_it_in_noexit_shell() -> None:
    text = ONE_CLICK_SCRIPT.read_text(encoding="utf-8")

    try_at = text.index("try {")
    missing_key_guard_at = text.index("if (-not (Test-Path", try_at)
    load_at = text.index("$env:PRYNX_TAURI_SIGNING_KEY_FILE = $signingKeyFile")
    build_at = text.index("^& .\\build_production.ps1 -Release")
    clear_at = text.index("Remove-Item Env:PRYNX_TAURI_SIGNING_KEY_FILE", build_at)
    assert "'.tauri'" in text and "'prynx.key'" in text
    assert "$env:USERPROFILE" not in text
    assert "[Environment+SpecialFolder]::UserProfile" in text
    assert "[System.IO.FileAttributes]::ReparsePoint" in text
    assert "Get-Content -LiteralPath $signingKeyFile -Raw" not in text
    assert try_at < missing_key_guard_at < load_at < build_at < clear_at

    lines = text.splitlines()
    command_start = next(
        index
        for index, line in enumerate(lines)
        if line.startswith(
            '"%PRYNX_SYSTEM_POWERSHELL%" -NoProfile '
            "-ExecutionPolicy Bypass -NoExit -Command"
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
    # Runner có thể là pwsh 7; để Windows PowerShell 5.1 tự dựng module path
    # tương thích, không cho module Security bản Core che bản Desktop inbox.
    env.pop("PSMODULEPATH", None)
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


@pytest.mark.skipif(os.name != "nt", reason="Git authority chi chay tren Windows")
def test_git_authority_rejects_ambient_routing_and_wrong_root(
    tmp_path: Path,
) -> None:
    """§SEC.24-R6: config/sentinel/git-dir ngoài authority phải bị chặn."""
    powershell = shutil.which("powershell.exe") or shutil.which("powershell")
    git_path = shutil.which("git.exe") or shutil.which("git")
    if not powershell or not git_path:
        pytest.skip("PowerShell/Git khong co trong PATH cua test runner")

    env = os.environ.copy()
    env.pop("PSMODULEPATH", None)
    for name in list(env):
        upper_name = name.upper()
        if upper_name.startswith(("GIT_", "GH_")) or upper_name in {
            "GITHUB_TOKEN",
            "GITHUB_ENTERPRISE_TOKEN",
            "XDG_CONFIG_HOME",
        }:
            env.pop(name, None)
    env.update(
        {
            "PRYNX_TEST_GUARD": str(EXECUTABLE_GUARD_SCRIPT),
            "PRYNX_TEST_GIT": git_path,
            "PRYNX_TEST_ROOT": str(ROOT),
            "PRYNX_TEST_TEMP": str(tmp_path),
        }
    )
    command = r'''
$ErrorActionPreference = 'Stop'
. $env:PRYNX_TEST_GUARD
$cases = @(
    @{ GIT_DIR = 'attacker.git'; GIT_WORK_TREE = 'attacker-tree' },
    @{ GIT_CONFIG_COUNT = '1'; GIT_CONFIG_KEY_0 = 'core.worktree'; GIT_CONFIG_VALUE_0 = 'attacker' },
    @{ GIT_CONFIG_GLOBAL = 'attacker-global'; GIT_CONFIG_SYSTEM = 'attacker-system' },
    @{ GIT_EXEC_PATH = 'attacker-bin'; GIT_INDEX_FILE = 'attacker-index' },
    @{ GIT_OBJECT_DIRECTORY = 'attacker-objects'; GIT_FUTURE_ROUTER = 'attacker-future' },
    @{ GH_HOST = 'attacker.invalid' },
    @{ GH_REPO = 'attacker/repo' },
    @{ GH_CONFIG_DIR = 'attacker-gh-config' },
    @{ GH_PATH = 'attacker-gh.exe' },
    @{ GH_TOKEN = 'test-only-not-a-secret' },
    @{ GH_FUTURE_ROUTER = 'attacker-future' },
    @{ GITHUB_TOKEN = 'test-only-not-a-secret' },
    @{ GH_ENTERPRISE_TOKEN = 'test-only-not-a-secret' },
    @{ GITHUB_ENTERPRISE_TOKEN = 'test-only-not-a-secret' },
    @{ XDG_CONFIG_HOME = 'attacker-xdg-config' }
)
foreach ($case in $cases) {
    foreach ($entry in $case.GetEnumerator()) {
        [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process')
    }
    $inventory = @(Get-PrynXGitAuthorityOverrideVariableNames)
    foreach ($entry in $case.GetEnumerator()) {
        if ($inventory -notcontains $entry.Key) {
            throw "Git authority inventory missed $($entry.Key)."
        }
    }
    $rejected = $false
    try { Assert-PrynXGitEnvironmentAuthority }
    catch {
        if ($_.Exception.Message -notlike 'SEC: Git/GitHub environment override bi cam:*') {
            throw
        }
        $rejected = $true
    }
    if (-not $rejected) { throw 'Ambient Git/GitHub routing was accepted.' }
    foreach ($entry in $case.GetEnumerator()) {
        if ($null -ne [Environment]::GetEnvironmentVariable($entry.Key, 'Process')) {
            throw "Rejected variable survived cleanup: $($entry.Key)."
        }
    }
}

$fixtureRoot = Join-Path $env:PRYNX_TEST_TEMP 'fsmonitor-repo'
$sentinelPath = Join-Path $fixtureRoot 'fsmonitor-sentinel.sh'
$markerPath = Join-Path $fixtureRoot 'fsmonitor-ran.txt'
$sentinelText = "#!/bin/sh`nprintf 'FS_MONITOR_EXECUTED\n' > fsmonitor-ran.txt`nprintf '\n'`nexit 0`n"

try {
    $previousEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & $env:PRYNX_TEST_GIT -c core.fsmonitor=false -c core.hooksPath=NUL `
        init --quiet $fixtureRoot
    if ($LASTEXITCODE -ne 0) { throw 'Khong tao duoc Git fsmonitor fixture.' }
    [System.IO.File]::WriteAllBytes((Join-Path $fixtureRoot '.git\info\exclude'), @())
    [System.IO.File]::WriteAllBytes((Join-Path $fixtureRoot '.git\info\attributes'), @())
    [System.IO.File]::WriteAllText(
        $sentinelPath,
        $sentinelText,
        [System.Text.Encoding]::ASCII
    )
    [System.IO.File]::WriteAllText(
        (Join-Path $fixtureRoot 'tracked.txt'),
        'fixture',
        [System.Text.Encoding]::ASCII
    )
    & $env:PRYNX_TEST_GIT -c core.fsmonitor=false -c core.hooksPath=NUL `
        -C $fixtureRoot add -- tracked.txt
    if ($LASTEXITCODE -ne 0) { throw 'Khong tao duoc Git index fixture.' }

    Assert-PrynXGitRepositoryAuthority `
        -GitPath $env:PRYNX_TEST_GIT `
        -ExpectedRoot $fixtureRoot
    $cleanStatus = Invoke-PrynXGitReadOnlyCommand `
        -GitPath $env:PRYNX_TEST_GIT `
        -ExpectedRoot $fixtureRoot `
        -Command 'status' `
        -Arguments @('--porcelain=v1', '--untracked-files=all')
    if ($cleanStatus.ExitCode -ne 0) {
        throw 'Protected Git status failed on a valid fixture.'
    }
    [void][System.IO.Directory]::CreateDirectory((Join-Path $fixtureRoot 'nested'))
    $wrongRootRejected = $false
    try {
        Assert-PrynXGitRepositoryAuthority `
            -GitPath $env:PRYNX_TEST_GIT `
            -ExpectedRoot (Join-Path $fixtureRoot 'nested')
    }
    catch {
        if ($_.Exception.Message -notlike 'SEC: Git metadata phai la directory ROOT\.git:*' -and
            $_.Exception.Message -notlike 'SEC: Git top-level lech repo goc da audit:*') {
            throw
        }
        $wrongRootRejected = $true
    }
    if (-not $wrongRootRejected) { throw 'Nested working directory was accepted as Git root.' }

    & $env:PRYNX_TEST_GIT -c core.fsmonitor=false -c core.hooksPath=NUL `
        -C $fixtureRoot config --local core.fsmonitor './fsmonitor-sentinel.sh'
    if ($LASTEXITCODE -ne 0) { throw 'Khong dat duoc fsmonitor sentinel.' }
}
finally {
    $ErrorActionPreference = $previousEap
    [Environment]::SetEnvironmentVariable('GIT_CONFIG_GLOBAL', $null, 'Process')
    [Environment]::SetEnvironmentVariable('GIT_CONFIG_NOSYSTEM', $null, 'Process')
}

$protectedRejected = $false
try {
    $null = Invoke-PrynXGitReadOnlyCommand `
        -GitPath $env:PRYNX_TEST_GIT `
        -ExpectedRoot $fixtureRoot `
        -Command 'status' `
        -Arguments @('--porcelain=v1', '--untracked-files=all')
}
catch {
    if ($_.Exception.Message -notlike 'SEC:*') { throw }
    $protectedRejected = $true
}
if (-not $protectedRejected) { throw 'Local fsmonitor config was accepted.' }
if (Test-Path -LiteralPath $markerPath) {
    throw 'Protected Git status executed core.fsmonitor sentinel.'
}

$commonDirMarker = Join-Path $fixtureRoot '.git\commondir'
[System.IO.File]::WriteAllText(
    $commonDirMarker,
    '..\external-common-dir',
    [System.Text.Encoding]::ASCII
)
$commonDirRejected = $false
try {
    Assert-PrynXGitRepositoryAuthority `
        -GitPath $env:PRYNX_TEST_GIT `
        -ExpectedRoot $fixtureRoot
}
catch {
    if ($_.Exception.Message -notlike 'SEC: Git common-dir tach roi*') { throw }
    $commonDirRejected = $true
}
if (-not $commonDirRejected) { throw 'External Git common-dir marker was accepted.' }
Remove-Item -LiteralPath $commonDirMarker -Force

$separateRoot = Join-Path $env:PRYNX_TEST_TEMP 'separate-worktree'
$separateMetadata = Join-Path $env:PRYNX_TEST_TEMP 'separate-metadata'
try {
    [Environment]::SetEnvironmentVariable('GIT_CONFIG_GLOBAL', 'NUL', 'Process')
    [Environment]::SetEnvironmentVariable('GIT_CONFIG_NOSYSTEM', '1', 'Process')
    $separateArgument = '--separate-git-dir=' + $separateMetadata
    & $env:PRYNX_TEST_GIT -c core.fsmonitor=false -c core.hooksPath=NUL `
        init --quiet $separateArgument $separateRoot
    if ($LASTEXITCODE -ne 0) { throw 'Khong tao duoc separate git-dir fixture.' }
}
finally {
    [Environment]::SetEnvironmentVariable('GIT_CONFIG_GLOBAL', $null, 'Process')
    [Environment]::SetEnvironmentVariable('GIT_CONFIG_NOSYSTEM', $null, 'Process')
}
$gitFileRejected = $false
try {
    Assert-PrynXGitRepositoryAuthority `
        -GitPath $env:PRYNX_TEST_GIT `
        -ExpectedRoot $separateRoot
}
catch {
    if ($_.Exception.Message -notlike 'SEC: Git metadata phai la directory ROOT\.git:*') {
        throw
    }
    $gitFileRejected = $true
}
if (-not $gitFileRejected) { throw 'Gitfile/separate git-dir was accepted.' }
'GIT_AUTHORITY_OK'
'''
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
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    assert completed.returncode == 0, completed.stdout + completed.stderr
    assert "GIT_AUTHORITY_OK" in completed.stdout


@pytest.mark.skipif(os.name != "nt", reason="Git fsmonitor control chi chay tren Windows")
def test_git_fsmonitor_sentinel_control_executes_without_r6_override(
    tmp_path: Path,
) -> None:
    """Control âm chứng minh sentinel thật sự reachable khi bỏ override R6."""
    powershell = (
        Path(os.environ.get("SystemRoot", r"C:\Windows"))
        / "System32"
        / "WindowsPowerShell"
        / "v1.0"
        / "powershell.exe"
    )
    git_path_text = shutil.which("git.exe") or shutil.which("git")
    git_path = Path(git_path_text) if git_path_text else None
    if not powershell.is_file() or git_path is None or not git_path.is_file():
        pytest.skip("Khong co Windows PowerShell/Git for Windows authority")

    env = os.environ.copy()
    env.pop("PSMODULEPATH", None)
    for name in list(env):
        if name.upper().startswith("GIT_"):
            env.pop(name, None)
    env.update(
        {
            "PRYNX_TEST_GIT": str(git_path),
            "PRYNX_TEST_TEMP": str(tmp_path),
        }
    )
    command = r'''
$ErrorActionPreference = 'Continue'
$fixtureRoot = Join-Path $env:PRYNX_TEST_TEMP 'fsmonitor-control-repo'
$sentinelPath = Join-Path $fixtureRoot 'fsmonitor-control.sh'
$markerPath = Join-Path $fixtureRoot 'fsmonitor-control-ran.txt'
$sentinelText = "#!/bin/sh`nprintf 'CONTROL_EXECUTED\n' > fsmonitor-control-ran.txt`nprintf '\n'`nexit 0`n"
[Environment]::SetEnvironmentVariable('GIT_CONFIG_GLOBAL', 'NUL', 'Process')
[Environment]::SetEnvironmentVariable('GIT_CONFIG_NOSYSTEM', '1', 'Process')
try {
    & $env:PRYNX_TEST_GIT -c core.fsmonitor=false -c core.hooksPath=NUL `
        init --quiet $fixtureRoot
    if ($LASTEXITCODE -ne 0) { throw 'Khong tao duoc control repo.' }
    [System.IO.File]::WriteAllText(
        $sentinelPath,
        $sentinelText,
        [System.Text.Encoding]::ASCII
    )
    [System.IO.File]::WriteAllText(
        (Join-Path $fixtureRoot 'tracked.txt'),
        'fixture',
        [System.Text.Encoding]::ASCII
    )
    & $env:PRYNX_TEST_GIT -c core.fsmonitor=false -c core.hooksPath=NUL `
        -C $fixtureRoot add -- tracked.txt
    if ($LASTEXITCODE -ne 0) { throw 'Khong tao duoc control index.' }
    & $env:PRYNX_TEST_GIT -c core.fsmonitor=false -c core.hooksPath=NUL `
        -C $fixtureRoot config --local core.fsmonitor './fsmonitor-control.sh'
    if ($LASTEXITCODE -ne 0) { throw 'Khong dat duoc control fsmonitor.' }
    & $env:PRYNX_TEST_GIT --no-optional-locks `
        --git-dir (Join-Path $fixtureRoot '.git') `
        --work-tree $fixtureRoot -C $fixtureRoot status --porcelain=v1 *> $null
    if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) {
        throw 'Fsmonitor control sentinel was not executed.'
    }
    'GIT_FSMONITOR_CONTROL_OK'
}
finally {
    [Environment]::SetEnvironmentVariable('GIT_CONFIG_GLOBAL', $null, 'Process')
    [Environment]::SetEnvironmentVariable('GIT_CONFIG_NOSYSTEM', $null, 'Process')
}
'''
    completed = subprocess.run(
        [
            str(powershell),
            "-NoProfile",
            "-NonInteractive",
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
    assert completed.returncode == 0, completed.stdout + completed.stderr
    assert "GIT_FSMONITOR_CONTROL_OK" in completed.stdout


@pytest.mark.skipif(os.name != "nt", reason="Git config/index authority chi chay tren Windows")
def test_git_authority_rejects_filter_execution_and_hidden_index_flags(
    tmp_path: Path,
) -> None:
    """§SEC.24-R6: local filter và cờ ẩn index không được qua clean gate."""
    powershell = shutil.which("powershell.exe") or shutil.which("powershell")
    git_path = shutil.which("git.exe") or shutil.which("git")
    if not powershell or not git_path:
        pytest.skip("PowerShell/Git khong co trong PATH cua test runner")

    env = os.environ.copy()
    env.pop("PSMODULEPATH", None)
    for name in list(env):
        upper_name = name.upper()
        if upper_name.startswith(("GIT_", "GH_")) or upper_name in {
            "GITHUB_TOKEN",
            "GITHUB_ENTERPRISE_TOKEN",
            "XDG_CONFIG_HOME",
        }:
            env.pop(name, None)
    env.update(
        {
            "PRYNX_TEST_GUARD": str(EXECUTABLE_GUARD_SCRIPT),
            "PRYNX_TEST_GIT": git_path,
            "PRYNX_TEST_TEMP": str(tmp_path),
        }
    )
    command = r'''
$ErrorActionPreference = 'Stop'
. $env:PRYNX_TEST_GUARD

function New-TestRepository {
    param([Parameter(Mandatory = $true)][string]$Name)
    $root = Join-Path $env:PRYNX_TEST_TEMP $Name
    & $env:PRYNX_TEST_GIT -c core.fsmonitor=false -c core.hooksPath=NUL init --quiet $root
    if ($LASTEXITCODE -ne 0) { throw "Khong init duoc fixture $Name." }
    [System.IO.File]::WriteAllBytes((Join-Path $root '.git\info\exclude'), @())
    [System.IO.File]::WriteAllBytes((Join-Path $root '.git\info\attributes'), @())
    [System.IO.File]::WriteAllText(
        (Join-Path $root 'tracked.txt'),
        'baseline',
        [System.Text.Encoding]::ASCII
    )
    & $env:PRYNX_TEST_GIT -c core.fsmonitor=false -c core.hooksPath=NUL `
        -C $root add -- tracked.txt
    if ($LASTEXITCODE -ne 0) { throw "Khong add duoc fixture $Name." }
    & $env:PRYNX_TEST_GIT -c user.name=PrynX-Test -c user.email=prynx-test.invalid `
        -c core.fsmonitor=false -c core.hooksPath=NUL `
        -C $root commit --quiet -m baseline
    if ($LASTEXITCODE -ne 0) { throw "Khong commit duoc fixture $Name." }
    return $root
}

function Assert-ProtectedGitRejected {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$Purpose
    )
    $rejected = $false
    try {
        $null = Invoke-PrynXGitReadOnlyCommand `
            -GitPath $env:PRYNX_TEST_GIT `
            -ExpectedRoot $Root `
            -Command 'status' `
            -Arguments @('--porcelain=v1', '--untracked-files=all')
    }
    catch {
        if ($_.Exception.Message -notlike 'SEC:*') { throw }
        $rejected = $true
    }
    if (-not $rejected) { throw "Protected Git accepted $Purpose." }
}

$filterRoot = New-TestRepository -Name 'filter-repo'
$filterMarker = Join-Path $filterRoot 'filter-ran.txt'
$filterScript = Join-Path $filterRoot 'filter-sentinel.sh'
[System.IO.File]::WriteAllText(
    $filterScript,
    "#!/bin/sh`nprintf 'FILTER_EXECUTED\n' > filter-ran.txt`ncat`n",
    [System.Text.Encoding]::ASCII
)
[System.IO.File]::WriteAllText(
    (Join-Path $filterRoot '.git\info\attributes'),
    "tracked.txt filter=r6`n",
    [System.Text.Encoding]::ASCII
)
& $env:PRYNX_TEST_GIT -C $filterRoot config --local filter.r6.clean './filter-sentinel.sh'
if ($LASTEXITCODE -ne 0) { throw 'Khong dat duoc filter sentinel.' }
[System.IO.File]::WriteAllText(
    (Join-Path $filterRoot 'tracked.txt'),
    'change!!',
    [System.Text.Encoding]::ASCII
)
Assert-ProtectedGitRejected -Root $filterRoot -Purpose 'local clean filter'
if (Test-Path -LiteralPath $filterMarker) {
    throw 'Protected Git executed local clean filter.'
}
& $env:PRYNX_TEST_GIT --no-optional-locks -C $filterRoot status --porcelain=v1 *> $null
if (-not (Test-Path -LiteralPath $filterMarker -PathType Leaf)) {
    throw 'Filter control did not prove executable reachability.'
}

$includeRoot = New-TestRepository -Name 'include-repo'
$includedConfig = Join-Path $env:PRYNX_TEST_TEMP 'included-git-config'
[System.IO.File]::WriteAllText(
    $includedConfig,
    ('[filter "included"]' + "`n    clean = ./attacker.sh`n"),
    [System.Text.Encoding]::ASCII
)
& $env:PRYNX_TEST_GIT -C $includeRoot config --local include.path $includedConfig
if ($LASTEXITCODE -ne 0) { throw 'Khong dat duoc include config fixture.' }
Assert-ProtectedGitRejected -Root $includeRoot -Purpose 'local include config'

foreach ($mode in @('skip-worktree', 'assume-unchanged')) {
    $indexRoot = New-TestRepository -Name ($mode + '-repo')
    $indexFlag = '--' + $mode
    & $env:PRYNX_TEST_GIT -C $indexRoot update-index $indexFlag -- tracked.txt
    if ($LASTEXITCODE -ne 0) { throw "Khong dat duoc index flag $mode." }
    [System.IO.File]::WriteAllText(
        (Join-Path $indexRoot 'tracked.txt'),
        'hidden-change',
        [System.Text.Encoding]::ASCII
    )
    $unprotected = @(& $env:PRYNX_TEST_GIT -C $indexRoot status --porcelain=v1)
    if ($LASTEXITCODE -ne 0 -or $unprotected.Count -ne 0) {
        throw "Control $mode khong che duoc thay doi nhu du kien."
    }
    Assert-ProtectedGitRejected -Root $indexRoot -Purpose $mode
}

'GIT_CONFIG_INDEX_AUTHORITY_OK'
'''
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
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=45,
        check=False,
    )
    assert completed.returncode == 0, completed.stdout + completed.stderr
    assert "GIT_CONFIG_INDEX_AUTHORITY_OK" in completed.stdout


@pytest.mark.skipif(os.name != "nt", reason="GitHub CLI authority chi chay tren Windows")
def test_github_cli_wrapper_pins_known_config_and_rejects_unix_socket(
    tmp_path: Path,
) -> None:
    """§SEC.24-R6: config dir cố định và socket transport phải fail-closed."""
    powershell = (
        Path(os.environ.get("SystemRoot", r"C:\Windows"))
        / "System32"
        / "WindowsPowerShell"
        / "v1.0"
        / "powershell.exe"
    )
    if not powershell.is_file():
        pytest.skip("Khong co Windows PowerShell 5.1")

    marker = tmp_path / "gh-command-ran.txt"
    config_dir = tmp_path / "gh-config"
    config_dir.mkdir()
    (config_dir / "config.yml").write_bytes(b"")
    (config_dir / "hosts.yml").write_bytes(b"")
    assets = [tmp_path / name for name in ("setup.exe", "setup.sig", "latest.json")]
    for asset in assets:
        asset.write_bytes(b"fixture")

    safe_config = (
        "  echo git_protocol=https\r\n"
        "  echo editor=\r\n"
        "  echo prompt=enabled\r\n"
        "  echo prefer_editor_prompt=disabled\r\n"
        "  echo pager=\r\n"
        "  echo http_unix_socket=\r\n"
        "  echo browser=\r\n"
        "  echo color_labels=disabled\r\n"
        "  echo accessible_colors=disabled\r\n"
        "  echo accessible_prompter=disabled\r\n"
        "  echo spinner=enabled\r\n"
        "  echo telemetry=enabled\r\n"
    )

    def write_fake_cli(path: Path, config_body: str) -> None:
        path.write_text(
            "@echo off\r\n"
            "if /I \"%1 %2 %3 %4\"==\"config list --host github.com\" (\r\n"
            f"{config_body}"
            "  exit /b 0\r\n"
            ")\r\n"
            ">>\"%PRYNX_TEST_GH_MARKER%\" echo %GH_CONFIG_DIR%\r\n"
            "exit /b 0\r\n",
            encoding="ascii",
        )

    passing_cli = tmp_path / "fake-gh-pass.cmd"
    write_fake_cli(passing_cli, safe_config)

    api_host_cli = tmp_path / "fake-gh-api-host.cmd"
    write_fake_cli(api_host_cli, safe_config + "  echo api_host=attacker.invalid\r\n")

    browser_cli = tmp_path / "fake-gh-browser.cmd"
    write_fake_cli(
        browser_cli,
        safe_config.replace("  echo browser=\r\n", "  echo browser=attacker.exe\r\n"),
    )

    socket_cli = tmp_path / "fake-gh-socket.cmd"
    write_fake_cli(
        socket_cli,
        safe_config.replace(
            "  echo http_unix_socket=\r\n",
            "  echo http_unix_socket=attacker.sock\r\n",
        ),
    )

    lease_cli = tmp_path / "fake-gh-lease.cmd"
    lease_cli.write_text(
        "@echo off\r\n"
        "if /I \"%1 %2 %3 %4\"==\"config list --host github.com\" (\r\n"
        "  copy /y \"%PRYNX_TEST_ASSET_0%\" \"%GH_CONFIG_DIR%\\config.yml\" >nul 2>&1\r\n"
        "  if not errorlevel 1 (\r\n"
        "    >\"%PRYNX_TEST_GH_MARKER%\" echo CONFIG_WRITE_SUCCEEDED\r\n"
        "    exit /b 21\r\n"
        "  )\r\n"
        "  >\"%PRYNX_TEST_GH_MARKER%\" echo CONFIG_WRITE_BLOCKED\r\n"
        "  copy /y \"%PRYNX_TEST_ASSET_0%\" \"%GH_CONFIG_DIR%\\hosts.yml\" >nul 2>&1\r\n"
        "  if not errorlevel 1 (\r\n"
        "    >>\"%PRYNX_TEST_GH_MARKER%\" echo HOSTS_WRITE_SUCCEEDED\r\n"
        "    exit /b 22\r\n"
        "  )\r\n"
        "  >>\"%PRYNX_TEST_GH_MARKER%\" echo HOSTS_WRITE_BLOCKED\r\n"
        f"{safe_config}"
        "  exit /b 0\r\n"
        ")\r\n"
        ">>\"%PRYNX_TEST_GH_MARKER%\" echo COMMAND_EXECUTED\r\n"
        "exit /b 0\r\n",
        encoding="ascii",
    )

    env = os.environ.copy()
    env.pop("PSMODULEPATH", None)
    for name in list(env):
        upper_name = name.upper()
        if upper_name.startswith(("GIT_", "GH_")) or upper_name in {
            "GITHUB_TOKEN",
            "GITHUB_ENTERPRISE_TOKEN",
            "XDG_CONFIG_HOME",
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "NO_PROXY",
            "SSL_CERT_FILE",
            "SSL_CERT_DIR",
            "CURL_CA_BUNDLE",
            "REQUESTS_CA_BUNDLE",
        }:
            env.pop(name, None)
    env.update(
        {
            "PRYNX_TEST_GUARD": str(EXECUTABLE_GUARD_SCRIPT),
            "PRYNX_TEST_GH_PASS": str(passing_cli),
            "PRYNX_TEST_GH_API_HOST": str(api_host_cli),
            "PRYNX_TEST_GH_BROWSER": str(browser_cli),
            "PRYNX_TEST_GH_SOCKET": str(socket_cli),
            "PRYNX_TEST_GH_LEASE": str(lease_cli),
            "PRYNX_TEST_GH_MARKER": str(marker),
            "PRYNX_TEST_GH_CONFIG": str(config_dir),
            "PRYNX_TEST_ASSET_0": str(assets[0]),
            "PRYNX_TEST_ASSET_1": str(assets[1]),
            "PRYNX_TEST_ASSET_2": str(assets[2]),
        }
    )
    command = r'''
$ErrorActionPreference = 'Stop'
. $env:PRYNX_TEST_GUARD
function Get-PrynXGitHubCliConfigurationDirectory {
    return [System.IO.Path]::GetFullPath($env:PRYNX_TEST_GH_CONFIG)
}
$expectedConfig = Get-PrynXGitHubCliConfigurationDirectory
$commit = 'a' * 40
$positiveReleaseTag = 'v1.2.3-beta.1+win.x64'
$positiveCases = @(
    @{
        Command = 'api'
        Arguments = [string[]]@(
            '--hostname', 'github.com', "repos/owner/repo/commits/$commit"
        )
    },
    @{
        Command = 'auth'
        Arguments = [string[]]@('status', '--hostname', 'github.com')
    },
    @{
        Command = 'release'
        Arguments = [string[]]@('list', '--repo', 'github.com/owner/repo')
    },
    @{
        Command = 'release'
        Arguments = [string[]]@(
            'upload', $positiveReleaseTag, '--repo', 'github.com/owner/repo', '--clobber',
            $env:PRYNX_TEST_ASSET_0,
            $env:PRYNX_TEST_ASSET_1,
            $env:PRYNX_TEST_ASSET_2
        )
    },
    @{
        Command = 'release'
        Arguments = [string[]]@(
            'create', $positiveReleaseTag, '--repo', 'github.com/owner/repo',
            '--target', $commit, '--title', 'PrynX 1.2.3-beta.1+win.x64', '--notes',
            'release notes',
            $env:PRYNX_TEST_ASSET_0,
            $env:PRYNX_TEST_ASSET_1,
            $env:PRYNX_TEST_ASSET_2
        )
    }
)
foreach ($case in $positiveCases) {
    $result = Invoke-PrynXGitHubCliCommand `
        -GitHubCliPath $env:PRYNX_TEST_GH_PASS `
        -Command $case.Command `
        -Arguments $case.Arguments
    if ($result.ExitCode -ne 0) { throw 'Benign GitHub CLI fixture failed.' }
}
$configMarkers = @([System.IO.File]::ReadAllLines($env:PRYNX_TEST_GH_MARKER))
if ($configMarkers.Count -ne $positiveCases.Count) {
    throw 'Positive GitHub CLI matrix did not execute every command.'
}
foreach ($actualConfig in $configMarkers) {
    if (-not [string]::Equals(
            $actualConfig,
            $expectedConfig,
            [System.StringComparison]::OrdinalIgnoreCase
        )) {
        throw "GitHub CLI did not receive fixture config: $actualConfig"
    }
}
Remove-Item -LiteralPath $env:PRYNX_TEST_GH_MARKER -Force

$hostsPath = Join-Path $expectedConfig 'hosts.yml'
$canonicalSecureHosts = (
    "github.com:`n" +
    "    git_protocol: https`n" +
    "    users:`n" +
    "        fixture-user:`n" +
    "    user: fixture-user`n"
)
[System.IO.File]::WriteAllText(
    $hostsPath,
    $canonicalSecureHosts,
    [System.Text.UTF8Encoding]::new($false)
)
$secureConfigResult = Invoke-PrynXGitHubCliCommand `
    -GitHubCliPath $env:PRYNX_TEST_GH_PASS `
    -Command 'auth' `
    -Arguments @('status', '--hostname', 'github.com')
if ($secureConfigResult.ExitCode -ne 0) {
    throw 'Canonical secure-store GitHub config was rejected.'
}
if (-not (Test-Path -LiteralPath $env:PRYNX_TEST_GH_MARKER -PathType Leaf)) {
    throw 'Canonical secure-store GitHub config did not reach the CLI fixture.'
}
Remove-Item -LiteralPath $env:PRYNX_TEST_GH_MARKER -Force

$plaintextPayloads = @(
    "github.com:`n  user: fixture`n  oauth_token: fixture-secret`n",
    "github.com:`n  oauth_token`t: fixture-secret`n",
    "github.com:`n  `"oauth_token`": fixture-secret`n",
    '{"github.com":{"oauth_token":"fixture-secret"}}',
    "github.com:`n  `"oauth\u005ftoken`": fixture-secret`n"
)
foreach ($plaintextPayload in $plaintextPayloads) {
    [System.IO.File]::WriteAllText(
        $hostsPath,
        $plaintextPayload,
        [System.Text.UTF8Encoding]::new($false)
    )
    $plaintextCredentialRejected = $false
    try {
        $null = Invoke-PrynXGitHubCliCommand `
            -GitHubCliPath $env:PRYNX_TEST_GH_PASS `
            -Command 'auth' `
            -Arguments @('status', '--hostname', 'github.com')
    }
    catch {
        if ($_.Exception.Message -notlike 'SEC: GitHub CLI hosts.yml*') {
            throw
        }
        $plaintextCredentialRejected = $true
    }
    if (-not $plaintextCredentialRejected) {
        throw 'Plaintext GitHub credential syntax was accepted.'
    }
    if (Test-Path -LiteralPath $env:PRYNX_TEST_GH_MARKER) {
        throw 'GitHub CLI ran after plaintext credential rejection.'
    }
}
[System.IO.File]::WriteAllBytes($hostsPath, [byte[]]@())

$relativeRejected = $false
try {
    $null = Invoke-PrynXGitHubCliCommand `
        -GitHubCliPath '.\fake-gh-pass.cmd' `
        -Command 'auth' `
        -Arguments @('status', '--hostname', 'github.com')
}
catch {
    if ($_.Exception.Message -notlike 'SEC: GitHub CLI authority phai la executable tuyet doi*') {
        throw
    }
    $relativeRejected = $true
}
if (-not $relativeRejected) { throw 'Relative GitHub CLI path was accepted.' }

foreach ($lineEnding in @("`n", "`r`n")) {
    if (Test-PrynXGitHubRepositoryArgument -Value (
            'github.com/owner/repo' + $lineEnding
        )) {
        throw 'GitHub repository accepted a trailing line ending.'
    }
    if (Test-PrynXGitHubApiRoute -Route (
            "repos/owner/repo/commits/$commit" + $lineEnding
        )) {
        throw 'GitHub API route accepted a trailing line ending.'
    }
    if (Test-PrynXReleaseTagArgument -Value ('v1.2.3' + $lineEnding)) {
        throw 'Release tag accepted a trailing line ending.'
    }
}

$canonicalRawTag = 'v1.2.3-beta.1+win.x64'
$canonicalEscapedTag = [Uri]::EscapeDataString($canonicalRawTag)
if ($canonicalEscapedTag -cne 'v1.2.3-beta.1%2Bwin.x64') {
    throw "EscapeDataString SemVer drifted: $canonicalEscapedTag"
}
foreach ($digit in @([char]0x0661, [char]0xFF11)) {
    if (Test-PrynXReleaseTagArgument -Value ('v' + $digit + '.2.3')) {
        throw 'Release tag accepted a Unicode decimal digit.'
    }
}
foreach ($route in @(
        ('repos/owner/repo/git/ref/tags/' + $canonicalRawTag),
        ('repos/owner/repo/releases/tags/' + $canonicalEscapedTag),
        ('repos/owner/repo/git/matching-refs/tags/' + $canonicalEscapedTag)
    )) {
    if (-not (Test-PrynXGitHubApiRoute -Route $route)) {
        throw "Canonical SemVer API route was rejected: $route"
    }
}
foreach ($escape in @('%0A', '%0D', '%2F', '%2E%2E', '%3F', '%23', '%2b')) {
    if (Test-PrynXGitHubApiRoute -Route (
            'repos/owner/repo/releases/tags/v1.2.3' + $escape
        )) {
        throw "Non-canonical percent escape was accepted: $escape"
    }
}

$negativeCases = @(
    @{
        Command = 'api'
        Arguments = [string[]]@(
            '--hostname', 'attacker.invalid', "repos/owner/repo/commits/$commit"
        )
    },
    @{
        Command = 'api'
        Arguments = [string[]]@(
            '--hostname=github.com', "repos/owner/repo/commits/$commit"
        )
    },
    @{
        Command = 'api'
        Arguments = [string[]]@('--hostname', 'github.com', 'user')
    },
    @{
        Command = 'auth'
        Arguments = [string[]]@('status', '--hostname', 'github.com', '--show-token')
    },
    @{
        Command = 'release'
        Arguments = [string[]]@('list', '-R', 'github.com/owner/repo')
    },
    @{
        Command = 'release'
        Arguments = [string[]]@('list', '--repo=github.com/owner/repo')
    },
    @{
        Command = 'release'
        Arguments = [string[]]@(
            'upload', 'v1.2.3', '--repo', 'github.com/owner/repo', '--clobber',
            $env:PRYNX_TEST_ASSET_0,
            $env:PRYNX_TEST_ASSET_1,
            $env:PRYNX_TEST_ASSET_2,
            '--draft'
        )
    },
    @{
        Command = 'release'
        Arguments = [string[]]@('delete', 'v1.2.3', '--repo', 'github.com/owner/repo')
    },
    @{
        Command = 'release'
        Arguments = [string[]]@(
            'create', 'v1.2.3', '--repo', 'github.com/owner/repo',
            '--target', ($commit + "`n"), '--title', 'PrynX 1.2.3', '--notes',
            'release notes',
            $env:PRYNX_TEST_ASSET_0,
            $env:PRYNX_TEST_ASSET_1,
            $env:PRYNX_TEST_ASSET_2
        )
    }
)
foreach ($case in $negativeCases) {
    $rejected = $false
    try {
        $null = Invoke-PrynXGitHubCliCommand `
            -GitHubCliPath $env:PRYNX_TEST_GH_PASS `
            -Command $case.Command `
            -Arguments $case.Arguments
    }
    catch {
        if ($_.Exception.Message -notlike 'SEC:*') { throw }
        $rejected = $true
    }
    if (-not $rejected) { throw 'GitHub CLI grammar bypass was accepted.' }
    if (Test-Path -LiteralPath $env:PRYNX_TEST_GH_MARKER) {
        throw 'GitHub CLI ran after grammar rejection.'
    }
}

foreach ($cliPath in @(
        $env:PRYNX_TEST_GH_API_HOST,
        $env:PRYNX_TEST_GH_BROWSER,
        $env:PRYNX_TEST_GH_SOCKET
    )) {
    $configRejected = $false
    try {
        $null = Invoke-PrynXGitHubCliCommand `
            -GitHubCliPath $cliPath `
            -Command 'auth' `
            -Arguments @('status', '--hostname', 'github.com')
    }
    catch {
        if ($_.Exception.Message -notlike 'SEC:*') { throw }
        $configRejected = $true
    }
    if (-not $configRejected) { throw 'Dangerous GitHub CLI config was accepted.' }
    if (Test-Path -LiteralPath $env:PRYNX_TEST_GH_MARKER) {
        throw 'GitHub CLI network command ran after config rejection.'
    }
}

foreach ($transportName in @('HTTP_PROXY', 'SSL_CERT_FILE', 'BROWSER')) {
    [Environment]::SetEnvironmentVariable(
        $transportName,
        'attacker-controlled',
        [EnvironmentVariableTarget]::Process
    )
    $transportRejected = $false
    try {
        $null = Invoke-PrynXGitHubCliCommand `
            -GitHubCliPath $env:PRYNX_TEST_GH_PASS `
            -Command 'auth' `
            -Arguments @('status', '--hostname', 'github.com')
    }
    catch {
        if ($_.Exception.Message -notlike 'SEC: GitHub transport environment override bi cam:*') {
            throw
        }
        $transportRejected = $true
    }
    if (-not $transportRejected) { throw "Transport override survived: $transportName" }
    if ($null -ne [Environment]::GetEnvironmentVariable($transportName, 'Process')) {
        throw "Rejected transport variable survived cleanup: $transportName"
    }
    if (Test-Path -LiteralPath $env:PRYNX_TEST_GH_MARKER) {
        throw 'GitHub CLI ran after transport rejection.'
    }
}

$leaseResult = Invoke-PrynXGitHubCliCommand `
    -GitHubCliPath $env:PRYNX_TEST_GH_LEASE `
    -Command 'auth' `
    -Arguments @('status', '--hostname', 'github.com')
if ($leaseResult.ExitCode -ne 0) { throw 'GitHub config lease fixture failed.' }
$leaseMarkers = @([System.IO.File]::ReadAllLines($env:PRYNX_TEST_GH_MARKER))
foreach ($requiredMarker in @(
        'CONFIG_WRITE_BLOCKED',
        'HOSTS_WRITE_BLOCKED',
        'COMMAND_EXECUTED'
    )) {
    if ($leaseMarkers -cnotcontains $requiredMarker) {
        throw "GitHub config lease did not prove: $requiredMarker"
    }
}
foreach ($configName in @('config.yml', 'hosts.yml')) {
    $configPath = Join-Path $expectedConfig $configName
    if ([System.IO.File]::ReadAllBytes($configPath).Length -ne 0) {
        throw "GitHub config lease allowed mutation: $configName"
    }
}
'GITHUB_CONFIG_AUTHORITY_OK'
'''
    completed = subprocess.run(
        [
            str(powershell),
            "-NoProfile",
            "-NonInteractive",
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
    assert completed.returncode == 0, completed.stdout + completed.stderr
    assert "GITHUB_CONFIG_AUTHORITY_OK" in completed.stdout


@pytest.mark.skipif(os.name != "nt", reason="Release entry gate chi chay tren Windows")
def test_direct_release_entries_reject_ambient_git_github_routing() -> None:
    """Direct build/publisher phải fail trước compiler, GitHub hay ghi artifact."""
    powershell = shutil.which("powershell.exe") or shutil.which("powershell")
    if not powershell:
        pytest.skip("Windows PowerShell khong co trong PATH")

    clean_env = os.environ.copy()
    clean_env.pop("PSMODULEPATH", None)
    for name in list(clean_env):
        upper_name = name.upper()
        if upper_name.startswith(("GIT_", "GH_")) or upper_name in {
            "GITHUB_TOKEN",
            "GITHUB_ENTERPRISE_TOKEN",
            "XDG_CONFIG_HOME",
        }:
            clean_env.pop(name, None)

    for variable, value in (
        ("GIT_DIR", str(ROOT / ".git")),
        ("GH_FUTURE_ROUTER", "attacker-future"),
        ("GITHUB_TOKEN", "test-only-not-a-secret"),
    ):
        build_env = clean_env.copy()
        build_env[variable] = value
        build_result = subprocess.run(
            [
                powershell,
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(BUILD_SCRIPT),
                "-Release",
                "-NoOpenExplorer",
            ],
            cwd=ROOT,
            env=build_env,
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        output = build_result.stdout + build_result.stderr
        assert build_result.returncode != 0
        assert (
            f"Production build tu choi ambient Git/GitHub override: {variable}"
            in output
        )
        assert value not in output
        assert "[1/5]" not in build_result.stdout

    nonrelease_env = clean_env.copy()
    nonrelease_env["GH_TOKEN"] = "test-only-not-a-secret"
    nonrelease_result = subprocess.run(
        [
            powershell,
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(BUILD_SCRIPT),
            "-NoOpenExplorer",
        ],
        cwd=ROOT,
        env=nonrelease_env,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    nonrelease_output = nonrelease_result.stdout + nonrelease_result.stderr
    assert nonrelease_result.returncode != 0
    assert (
        "Production build tu choi ambient Git/GitHub override: GH_TOKEN"
        in nonrelease_output
    )
    assert "test-only-not-a-secret" not in nonrelease_output
    assert "[1/5]" not in nonrelease_result.stdout

    for variable, value in (
        ("GH_HOST", "attacker.invalid"),
        ("GH_CONFIG_DIR", "attacker-gh-config"),
        ("GH_TOKEN", "test-only-not-a-secret"),
        ("GH_FUTURE_ROUTER", "attacker-future"),
    ):
        publisher_env = clean_env.copy()
        publisher_env[variable] = value
        publisher_result = subprocess.run(
            [
                powershell,
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(PUBLISH_SCRIPT),
                "-Version",
                "2.0.0",
            ],
            cwd=ROOT,
            env=publisher_env,
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        output = publisher_result.stdout + publisher_result.stderr
        assert publisher_result.returncode != 0
        assert (
            f"Publisher tu choi ambient Git/GitHub override: {variable}" in output
        )
        assert value not in output
        assert "GitHub preflight" not in publisher_result.stdout


def test_release_entries_clear_sensitive_environment_before_loading_guards() -> None:
    """§SEC.24-R6: Add-Type/csc không được thấy token hay khóa ambient."""
    checks = (
        (BUILD_SCRIPT, '. "$ROOT\\scripts\\windows_payload_guard.ps1"'),
        (PUBLISH_SCRIPT, '. "$ROOT\\scripts\\release_executable_guard.ps1"'),
    )
    required = (
        "GetEnvironmentVariables",
        "SetEnvironmentVariable",
        "PRYNX_SUPABASE_SECRET_KEY",
        "TAURI_SIGNING_PRIVATE_KEY",
        "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
        "'^(?i:GIT_|GH_)'",
        "GITHUB_TOKEN",
        "GITHUB_ENTERPRISE_TOKEN",
    )

    for path, first_guard_load in checks:
        source = path.read_text(encoding="utf-8-sig")
        guard_offset = source.index(first_guard_load)
        bootstrap = source[:guard_offset]
        for token in required:
            assert token in bootstrap, f"{path.name} clear muộn token {token}"

        # Không cho mutation dời block clear xuống sau lần dot-source đầu tiên.
        assert bootstrap.rfind("SetEnvironmentVariable") > bootstrap.index(
            "GetEnvironmentVariables"
        )


def test_git_github_and_authenticode_ast_mutation_ratchets(tmp_path: Path) -> None:
    """AST ratchet phải bắt host/repo drift và Authenticode mất authority."""
    if os.name != "nt":
        pytest.skip("AST release ratchet pin Windows PowerShell 5.1")
    powershell_path = (
        Path(os.environ.get("SystemRoot", r"C:\Windows"))
        / "System32"
        / "WindowsPowerShell"
        / "v1.0"
        / "powershell.exe"
    )
    if not powershell_path.is_file():
        pytest.skip("Khong co Windows PowerShell 5.1 cho AST ratchet")
    powershell = str(powershell_path)

    def ast_probe(script_path: Path, probe: str) -> subprocess.CompletedProcess[str]:
        env = os.environ.copy()
        env.pop("PSMODULEPATH", None)
        env["PRYNX_TEST_AST_TARGET"] = str(script_path)
        return subprocess.run(
            [
                powershell,
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                probe,
            ],
            cwd=ROOT,
            env=env,
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )

    github_probe = r'''
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(
    $env:PRYNX_TEST_AST_TARGET, [ref]$tokens, [ref]$parseErrors
)
if (@($parseErrors).Count -ne 0) { exit 2 }
$directCalls = @($ast.FindAll({
    param($node)
    $node -is [Management.Automation.Language.CommandAst] -and
    $node.CommandElements.Count -gt 0 -and
    $node.CommandElements[0] -is [Management.Automation.Language.VariableExpressionAst] -and
    $node.CommandElements[0].VariablePath.UserPath -ieq 'script:PrynXGitHubCli'
}, $true))
if ($directCalls.Count -ne 0) { exit 3 }
$calls = @($ast.FindAll({
    param($node)
    $node -is [Management.Automation.Language.CommandAst] -and
    $node.GetCommandName() -ceq 'Invoke-PrynXGitHubCliCommand'
}, $true))
if ($calls.Count -ne 8) { exit 4 }
$apiCount = 0
$authCount = 0
$releaseCount = 0
foreach ($call in $calls) {
    $text = [regex]::Replace($call.Extent.Text, '\s+', ' ')
    if ($text -match "-Command\s+'api'") {
        $apiCount++
        if ($text -notmatch "-Arguments\s+@\(\s*'--hostname'\s*,\s*'github\.com'\s*,") {
            exit 5
        }
    }
    elseif ($text -match "-Command\s+'auth'") {
        $authCount++
        if ($text -notmatch "-Arguments\s+@\(\s*'status'\s*,\s*'--hostname'\s*,\s*'github\.com'\s*\)") {
            exit 6
        }
    }
    elseif ($text -match "-Command\s+'release'") {
        $releaseCount++
        if ($text -notmatch "'--repo'\s*,\s*`"github\.com/\`$ReleaseRepo`"") {
            exit 7
        }
        if ($text -notmatch "'(upload|create)'\s*,") { exit 8 }
    }
    else { exit 9 }
}
if ($apiCount -ne 5 -or $authCount -ne 1 -or $releaseCount -ne 2) { exit 10 }
'GITHUB_AST_OK'
'''

    source_control_guard_probe = r'''
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(
    $env:PRYNX_TEST_AST_TARGET, [ref]$tokens, [ref]$parseErrors
)
if (@($parseErrors).Count -ne 0) { exit 2 }
$source = [System.IO.File]::ReadAllText($env:PRYNX_TEST_AST_TARGET)
foreach ($required in @(
    "'GH_CONFIG_DIR'", "'^(?i:GIT_|GH_)'", "'GITHUB_TOKEN'",
    "'GITHUB_ENTERPRISE_TOKEN'", "'XDG_CONFIG_HOME'",
    "'GIT_CONFIG_GLOBAL'", "'GIT_CONFIG_NOSYSTEM'", '--absolute-git-dir',
    '--git-common-dir', '[Environment+SpecialFolder]::ApplicationData',
    'config list --host github.com', "'api_host'", "'BROWSER'"
)) {
    if (-not $source.Contains($required)) { exit 3 }
}
if ([regex]::Matches($source, '--git-common-dir').Count -ne 2) {
    exit 3
}
$grammarFunctions = @($ast.FindAll({
    param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -ceq 'Assert-PrynXGitReadOnlyGrammar'
}, $true))
if ($grammarFunctions.Count -ne 1) { exit 4 }
$grammarCalls = @($grammarFunctions[0].Body.FindAll({
    param($node)
    $node -is [Management.Automation.Language.CommandAst] -and
    $node.GetCommandName() -ceq 'Test-PrynXExactArgumentList'
}, $true))
$absoluteGrammarCalls = @($grammarCalls | Where-Object {
    $callText = [regex]::Replace($_.Extent.Text, '(?:`\r?\n|\s)+', ' ')
    $callText.Contains("-Expected @('--absolute-git-dir')")
})
if ($absoluteGrammarCalls.Count -ne 1) { exit 5 }
$authorityFunctions = @($ast.FindAll({
    param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -ceq 'Assert-PrynXGitRepositoryAuthority'
}, $true))
if ($authorityFunctions.Count -ne 1) { exit 6 }
$authorityCalls = @($authorityFunctions[0].Body.FindAll({
    param($node)
    $node -is [Management.Automation.Language.CommandAst] -and
    $node.GetCommandName() -ceq 'Invoke-PrynXGitReadOnlyCommand'
}, $true))
$absoluteAuthorityCalls = @($authorityCalls | Where-Object {
    $callText = [regex]::Replace($_.Extent.Text, '(?:`\r?\n|\s)+', ' ')
    $callText.Contains(
        "-Command 'rev-parse' -Arguments @('--absolute-git-dir')"
    )
})
if ($absoluteAuthorityCalls.Count -ne 1) { exit 7 }
$gitFunctions = @($ast.FindAll({
    param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -ceq 'Invoke-PrynXGitReadOnlyCommand'
}, $true))
if ($gitFunctions.Count -ne 1) { exit 4 }
$gitCalls = @($gitFunctions[0].Body.FindAll({
    param($node)
    $node -is [Management.Automation.Language.CommandAst] -and
    $node.CommandElements.Count -gt 0 -and
    $node.CommandElements[0] -is [Management.Automation.Language.VariableExpressionAst] -and
    $node.CommandElements[0].VariablePath.UserPath -ceq 'gitPathFull'
}, $true))
if ($gitCalls.Count -ne 5) { exit 5 }
$gitBody = $gitFunctions[0].Body.Extent.Text
if ([regex]::Matches($gitBody, '-c\s+core\.fsmonitor=false').Count -ne 5 -or
    [regex]::Matches($gitBody, '-c\s+core\.hooksPath=NUL').Count -ne 5 -or
    [regex]::Matches($gitBody, '--no-optional-locks').Count -ne 5 -or
    [regex]::Matches($gitBody, '--git-dir\s+\$expectedGitDir').Count -ne 4 -or
    [regex]::Matches($gitBody, '--work-tree\s+\$expectedFull').Count -ne 4) {
    exit 6
}
$ghFunctions = @($ast.FindAll({
    param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -ceq 'Invoke-PrynXGitHubCliCommand'
}, $true))
if ($ghFunctions.Count -ne 1) { exit 7 }
$ghCalls = @($ghFunctions[0].Body.FindAll({
    param($node)
    $node -is [Management.Automation.Language.CommandAst] -and
    $node.CommandElements.Count -gt 0 -and
    $node.CommandElements[0] -is [Management.Automation.Language.VariableExpressionAst] -and
    $node.CommandElements[0].VariablePath.UserPath -ceq 'gitHubCliFull'
}, $true))
if ($ghCalls.Count -ne 2) { exit 8 }
$ghBody = $ghFunctions[0].Body.Extent.Text
if ($ghBody -notmatch 'config\s+list\s+--host\s+github\.com' -or
    $ghBody -notmatch '\$Command\s+@Arguments') {
    exit 9
}
'SOURCE_CONTROL_GUARD_AST_OK'
'''

    github_login_probe = r'''
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(
    $env:PRYNX_TEST_AST_TARGET, [ref]$tokens, [ref]$parseErrors
)
if (@($parseErrors).Count -ne 0) { exit 2 }
$functions = @($ast.FindAll({
    param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -ceq 'Start-PrynXGitHubLogin'
}, $true))
if ($functions.Count -ne 1) { exit 3 }
$body = $functions[0].Body.Extent.Text
$normalized = [regex]::Replace($body, '(?:`\r?\n|\s)+', ' ')
foreach ($required in @(
    'Invoke-PrynXGitHubCliCommand',
    '"GH_PROMPT_DISABLED", "1", [EnvironmentVariableTarget]::Process',
    'auth login --hostname github.com --git-protocol https',
    '--web --skip-ssh-key',
    '-FilePath $CmdPath -ArgumentList @("/d", "/s", "/k", $loginCommand) -PassThru',
    'foreach ($name in $controlledNames)'
)) {
    if (-not $normalized.Contains($required)) { exit 4 }
}
foreach ($forbidden in @(
    '--clipboard', '--with-token', '--insecure-storage', '--git-protocol ssh'
)) {
    if ($body.Contains($forbidden)) { exit 5 }
}
$promptAt = $normalized.IndexOf(
    '"GH_PROMPT_DISABLED", "1", [EnvironmentVariableTarget]::Process'
)
$spawnAt = $normalized.IndexOf('return Start-Process ')
$restoreAt = $normalized.LastIndexOf('foreach ($name in $controlledNames)')
if ($promptAt -lt 0 -or $spawnAt -le $promptAt -or $restoreAt -le $spawnAt) {
    exit 6
}
'GITHUB_LOGIN_AST_OK'
'''

    authenticode_probe = r'''
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(
    $env:PRYNX_TEST_AST_TARGET, [ref]$tokens, [ref]$parseErrors
)
if (@($parseErrors).Count -ne 0) { exit 2 }
$functions = @($ast.FindAll({
    param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -ceq 'Assert-PrynXReleaseExecutableSignature'
}, $true))
if ($functions.Count -ne 1) { exit 3 }
$body = $functions[0].Body
$assignments = @($body.FindAll({
    param($node)
    $node -is [Management.Automation.Language.AssignmentStatementAst] -and
    $node.Left.Extent.Text -ceq '$securityModulePath'
}, $true))
if ($assignments.Count -ne 1) { exit 4 }
$variables = @($assignments[0].Right.FindAll({
    param($node) $node -is [Management.Automation.Language.VariableExpressionAst]
}, $true))
if ($variables.Count -ne 1 -or $variables[0].VariablePath.UserPath -cne 'PSHOME') {
    exit 5
}
$moduleRelative = 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1'
$strings = @($assignments[0].Right.FindAll({
    param($node) $node -is [Management.Automation.Language.StringConstantExpressionAst]
}, $true) | ForEach-Object { [string]$_.Value })
if ($strings -notcontains $moduleRelative) { exit 6 }
$commands = @($body.FindAll({
    param($node) $node -is [Management.Automation.Language.CommandAst]
}, $true))
$imports = @($commands | Where-Object { $_.GetCommandName() -ceq 'Import-Module' })
if ($imports.Count -ne 1 -or $imports[0].CommandElements.Count -lt 3 -or
    $imports[0].CommandElements[1].Extent.Text -cne '-Name' -or
    $imports[0].CommandElements[2].Extent.Text -cne '$securityModulePath') {
    exit 7
}
$qualified = @($commands | Where-Object {
    $_.GetCommandName() -ceq 'Microsoft.PowerShell.Security\Get-AuthenticodeSignature'
})
$bare = @($commands | Where-Object {
    $_.GetCommandName() -ceq 'Get-AuthenticodeSignature'
})
if ($qualified.Count -ne 1 -or $bare.Count -ne 0) { exit 8 }
'AUTHENTICODE_AST_OK'
'''

    publisher = PUBLISH_SCRIPT.read_text(encoding="utf-8-sig")
    guard = EXECUTABLE_GUARD_SCRIPT.read_text(encoding="utf-8-sig")
    gui = RELEASE_UI_SCRIPT.read_text(encoding="utf-8-sig")
    github_result = ast_probe(PUBLISH_SCRIPT, github_probe)
    assert github_result.returncode == 0, github_result.stdout + github_result.stderr
    source_control_result = ast_probe(
        EXECUTABLE_GUARD_SCRIPT, source_control_guard_probe
    )
    assert source_control_result.returncode == 0, (
        source_control_result.stdout + source_control_result.stderr
    )
    github_login_result = ast_probe(RELEASE_UI_SCRIPT, github_login_probe)
    assert github_login_result.returncode == 0, (
        github_login_result.stdout + github_login_result.stderr
    )
    authenticode_result = ast_probe(EXECUTABLE_GUARD_SCRIPT, authenticode_probe)
    assert authenticode_result.returncode == 0, (
        authenticode_result.stdout + authenticode_result.stderr
    )

    publisher_mutations = (
        publisher.replace(
            "@('--hostname', 'github.com',",
            "@('--hostname', 'attacker.invalid',",
            1,
        ),
        publisher.replace(
            "@('status', '--hostname', 'github.com')",
            "@('status', '--hostname', 'attacker.invalid')",
            1,
        ),
        publisher.replace(
            "'--repo',\n                \"github.com/$ReleaseRepo\",",
            "'--repo',\n                $ReleaseRepo,",
            1,
        ),
    )
    for index, mutation in enumerate(publisher_mutations):
        assert mutation != publisher
        mutation_path = tmp_path / f"publisher-authority-mutation-{index}.ps1"
        mutation_path.write_text(mutation, encoding="utf-8")
        assert ast_probe(mutation_path, github_probe).returncode != 0

    source_control_mutations = (
        guard.replace("core.fsmonitor=false", "core.fsmonitor=true", 1),
        guard.replace(
            "-Expected @('--absolute-git-dir'))",
            "-Expected @('--git-dir'))",
            1,
        ),
        guard.replace(
            "-Arguments @('--absolute-git-dir')",
            "-Arguments @('--git-dir')",
            1,
        ),
        guard.replace(
            "config list --host github.com",
            "config list --host attacker.invalid",
            1,
        ),
        guard.replace("'^(?i:GIT_|GH_)'", "'^(?i:GIT_)'", 1),
    )
    for index, mutation in enumerate(source_control_mutations):
        assert mutation != guard
        mutation_path = tmp_path / f"source-control-authority-mutation-{index}.ps1"
        mutation_path.write_text(mutation, encoding="utf-8")
        assert (
            ast_probe(mutation_path, source_control_guard_probe).returncode != 0
        )

    github_login_mutations = (
        gui.replace(
            "auth login --hostname github.com",
            "auth login --hostname attacker.invalid",
            1,
        ),
        gui.replace("--git-protocol https", "--git-protocol ssh", 1),
        gui.replace(" --web --skip-ssh-key", " --skip-ssh-key", 1),
        gui.replace(" --web --skip-ssh-key", " --web", 1),
        gui.replace(
            '"GH_PROMPT_DISABLED",\n            "1",',
            '"GH_PROMPT_DISABLED",\n            "0",',
            1,
        ),
        gui.replace(
            '@("/d", "/s", "/k", $loginCommand)',
            '@("/c", "/s", "/k", $loginCommand)',
            1,
        ),
        gui.replace(
            " --web --skip-ssh-key",
            " --web --clipboard --skip-ssh-key",
            1,
        ),
    )
    for index, mutation in enumerate(github_login_mutations):
        assert mutation != gui
        mutation_path = tmp_path / f"github-login-mutation-{index}.ps1"
        mutation_path.write_text(mutation, encoding="utf-8")
        assert ast_probe(mutation_path, github_login_probe).returncode != 0

    guard_mutations = (
        guard.replace(
            "Microsoft.PowerShell.Security\\Get-AuthenticodeSignature",
            "Get-AuthenticodeSignature",
            1,
        ),
        guard.replace("$PSHOME", "$env:PSMODULEPATH", 1),
    )
    for index, mutation in enumerate(guard_mutations):
        assert mutation != guard
        mutation_path = tmp_path / f"authenticode-authority-mutation-{index}.ps1"
        mutation_path.write_text(mutation, encoding="utf-8")
        assert ast_probe(mutation_path, authenticode_probe).returncode != 0
