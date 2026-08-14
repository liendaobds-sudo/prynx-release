"""Chính sách phát hành no-GS phải nằm trong test, không nằm trong trí nhớ.

Audit lần 3 (§3.1, §3.3) tìm ra ba thứ mà không test nào bắt được:

1. `build_production.ps1` mặc định **bundle** Ghostscript, và cả bốn entry phát hành
   (`release_update.ps1`, `PHAT_HANH.bat`, `quanly_phathanh.ps1`, GUI) đều không
   truyền cờ no-GS ⇒ thao tác phát hành chuẩn vẫn sinh installer chứa AGPL.
2. Script xác minh artifact hardcode `PrynX.exe`, trong khi binary thật mang tên
   crate (`pdf-inspector.exe`) ⇒ gate hậu kiểm cài xong rồi ném lỗi.
3. Chốt NOTICE dùng `-SimpleMatch` với pattern `A|B|C` ⇒ dấu `|` thành ký tự thường
   và pattern không bao giờ khớp ⇒ NOTICE còn AGPL vẫn được báo "sạch".

Đây đều là lỗi **script phát hành**, loại mà pytest thường không chạm tới — nên
chúng sống sót qua mọi lần Release QA xanh. Test ở đây đọc chính nội dung script và
khoá các bất biến đó lại.
"""

from __future__ import annotations

import json
import re
import runpy
import shutil
import subprocess
import time
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
BUILD = REPO / "build_production.ps1"
VERIFIER = REPO / "scripts" / "verify_installed_artifact.ps1"
TAURI_CONFIG = REPO / "desktop" / "src-tauri" / "tauri.conf.json"
AUDIT = REPO / "scripts" / "gs_dependency_audit.py"
RELEASE_QA = REPO / "scripts" / "run_release_qa.ps1"
RELEASE_UPDATE = REPO / "release_update.ps1"
RELEASE_CONTROLLER = REPO / "scripts" / "release_controller.ps1"
RELEASE_LOG_TERMINAL = REPO / "scripts" / "watch_release_run.ps1"
PRYNX_LAUNCHER = REPO / "PRYNX.bat"
CLEAN_USER_VERIFIER = REPO / "scripts" / "verify_artifact_clean_user.ps1"
NOTICE_GENERATOR = REPO / "scripts" / "gen_third_party_notices.py"
DEV_SETUP = REPO / "setup_dev_env.ps1"
README = REPO / "README.md"
ENV_EXAMPLE = REPO / ".env.example"
GITIGNORE = REPO / ".gitignore"
# Mọi entry mà người phát hành thực sự bấm/chạy.
RELEASE_ENTRIES = [
    REPO / "release_update.ps1",
    REPO / "PHAT_HANH.bat",
    REPO / "quanly_phathanh.ps1",
]


def _read(path: Path) -> str:
    if not path.is_file():
        pytest.skip(f"thiếu {path.name}")
    return path.read_text(encoding="utf-8", errors="replace")


# ─────────────────────────────────────────────────────────────────────────────
#  §3.1 — no-GS là BẤT BIẾN, không có opt-in bật lại
# ─────────────────────────────────────────────────────────────────────────────

def test_build_has_no_ghostscript_staging_branch():
    """Build chỉ còn tripwire fail-closed, không còn dò/copy/tạo marker GS."""
    text = _read(BUILD)
    assert r"C:\Program Files\gs" not in text
    assert "$GS_SRC" not in text
    assert "$GS_DEST" not in text
    assert "$BUNDLE_GS" not in text
    assert "NO_GHOSTSCRIPT.txt" not in text
    assert "forbiddenGhostscriptPayload" in text
    assert "Build aborted to preserve the PPE-only release contract" in text


def test_build_has_no_ghostscript_opt_in():
    text = _read(BUILD)
    assert "WithGhostscript" not in text
    assert "NoGhostscript" not in text
    assert "PRYNX_BUNDLE_GS" not in text
    assert not re.search(r'\$BUNDLE_GS\s*=\s*\$true', text)


def test_tauri_resources_do_not_bundle_ghostscript_tree():
    config = json.loads(_read(TAURI_CONFIG))
    resources = config["bundle"]["resources"]
    normalized = [str(resource).replace("\\", "/").casefold() for resource in resources]
    assert not any("binaries/gs" in resource for resource in normalized)


@pytest.mark.parametrize(
    "path",
    [DEV_SETUP, README, ENV_EXAMPLE, GITIGNORE],
    ids=lambda path: path.name,
)
def test_current_setup_and_operator_docs_do_not_require_ghostscript(path):
    """Luồng dev hiện hành chỉ mô tả PPE/PDFium, không được kéo GS trở lại."""
    text = _read(path)
    forbidden = (
        "ghostscript",
        "artifexsoftware.ghostscript",
        "gswin64c",
        "gswin32c",
        "ghostscript_path",
        "prynx_no_gs_build",
        "prynx_print_engine",
        "no_ghostscript.txt",
    )
    hits = [token for token in forbidden if token in text.casefold()]
    assert not hits, f"{path.name} còn yêu cầu/cấu hình engine cũ: {hits}"


def test_dev_setup_has_six_contiguous_steps_after_dependency_cleanup():
    text = _read(DEV_SETUP)
    numbered = re.findall(r'Write-Step\s+"(\d+)/(\d+)\s+-', text)
    assert numbered == [(str(step), "6") for step in range(1, 7)]


def test_current_docs_name_the_bundled_ppe_pdfium_stack():
    combined = _read(README) + _read(ENV_EXAMPLE)
    assert "PrynX Print Engine (PPE)" in combined
    assert "PDFium" in combined


def test_runtime_policy_ignores_all_gs_environment(monkeypatch):
    """Biến legacy không được dựng lại field cấu hình hay engine song song."""
    monkeypatch.setenv("GHOSTSCRIPT_PATH", r"C:\Program Files\gs\gswin64c.exe")
    monkeypatch.setenv("PRYNX_PRINT_ENGINE", "gs")
    monkeypatch.setenv("PRYNX_ALLOW_GS_FALLBACK", "true")
    monkeypatch.setenv("PRYNX_FORCE_GS", "true")

    from app.config import Settings

    configured = Settings()
    assert not hasattr(configured, "GHOSTSCRIPT_PATH")
    assert not hasattr(configured, "PRYNX_PRINT_ENGINE")
    assert not hasattr(configured, "PRYNX_ALLOW_GS_FALLBACK")
    assert not hasattr(configured, "PRYNX_FORCE_GS")


def test_corpus_gate_uses_fixed_no_gs_contract():
    """Cổng corpus dùng tripwire, không đọc telemetry/cấu hình engine đã xoá."""
    text = _read(AUDIT)
    assert "settings.GHOSTSCRIPT_PATH" not in text
    assert "PRYNX_NO_GS_BUILD" not in text
    assert "gs_usage" not in text
    assert "GhostscriptBlocked" in text


@pytest.mark.parametrize("entry", RELEASE_ENTRIES, ids=lambda p: p.name)
def test_release_entries_never_turn_bundling_back_on(entry):
    """Wrapper phát hành không được bật lại bundle GS.

    Chúng KHÔNG cần truyền gì cả — mặc định đã là no-GS. Điều phải chặn là một
    wrapper nào đó lặng lẽ bật lại.
    """
    text = _read(entry)
    assert "-WithGhostscript" not in text, f"{entry.name} bật lại bundle Ghostscript"
    assert not re.search(r'PRYNX_BUNDLE_GS\s*=\s*["\']?1', text), (
        f"{entry.name} đặt PRYNX_BUNDLE_GS=1"
    )


# ─────────────────────────────────────────────────────────────────────────────
#  §3.3 — verifier phải chạy được trên artifact thật
# ─────────────────────────────────────────────────────────────────────────────

def test_verifier_reads_main_binary_name_from_config():
    """Tên binary lấy từ `src-tauri/Cargo.toml`, không hardcode productName."""
    text = _read(VERIFIER)
    assert "src-tauri" in text and "Cargo.toml" in text, (
        "verifier phải đọc tên main binary từ cấu hình"
    )
    # Tên thật hiện tại phải nằm trong tập ứng viên (dù là qua Cargo.toml).
    cargo = REPO / "desktop" / "src-tauri" / "Cargo.toml"
    if cargo.is_file():
        m = re.search(r'^\s*name\s*=\s*"([^"]+)"', cargo.read_text(encoding="utf-8"), re.M)
        assert m, "không đọc được [package] name của src-tauri"
        assert m.group(1) == "pdf-inspector", (
            f"tên crate đổi thành {m.group(1)} — cập nhật lại test và verifier cùng lúc"
        )


def test_notice_matcher_is_not_simple_match():
    """`-SimpleMatch` với pattern `A|B|C` không bao giờ khớp.

    Đây là false-negative im lặng: NOTICE còn AGPL vẫn được báo sạch.
    """
    text = _read(VERIFIER)
    for line in text.splitlines():
        if "Ghostscript|Artifex|AGPL" in line:
            assert "-SimpleMatch" not in line, (
                "pattern có dấu | phải dùng regex, không dùng -SimpleMatch: " + line.strip()
            )

            break
    else:
        pytest.fail("không tìm thấy chốt kiểm NOTICE trong verifier")


def test_verifier_always_rejects_ghostscript_without_flag_or_marker():
    """Mọi verifier run đều quét binary/NOTICE, không phụ thuộc caller hay marker."""
    text = _read(VERIFIER)
    assert "ExpectNoGhostscript" not in text
    assert "NO_GHOSTSCRIPT.txt" not in text
    assert r"gs(?:win(?:32|64)c?)?\.exe" in text
    assert r"gsdll\d*\.dll" in text
    assert "Ghostscript|Artifex|AGPL" in text
    assert re.search(r"\$gsBinaries\s*=\s*@\(", text)


@pytest.mark.parametrize(
    "path",
    [BUILD, RELEASE_UPDATE, CLEAN_USER_VERIFIER, NOTICE_GENERATOR],
    ids=lambda path: path.name,
)
def test_release_pipeline_has_no_legacy_no_gs_switch(path):
    """PPE-only là bất biến, không còn cờ tùy chọn mà caller có thể truyền/quên."""
    text = _read(path)
    assert "ExpectNoGhostscript" not in text
    assert "NoGhostscript" not in text
    assert "--no-ghostscript" not in text

# ─────────────────────────────────────────────────────────────────────────────
#  §3.6 — bộ đo no-GS là release gate thật
# ─────────────────────────────────────────────────────────────────────────────

def test_no_gs_audit_forces_utf8_console():
    text = _read(AUDIT)
    assert 'reconfigure(encoding="utf-8"' in text, (
        "audit phải tự cấu hình UTF-8, không phụ thuộc PYTHONIOENCODING của máy chạy"
    )


def test_no_gs_audit_gate_fails_on_gs_or_error():
    text = _read(AUDIT)
    assert re.search(r'add_argument\(\s*"--gate"', text)
    assert re.search(r'counts\.get\("GS".*counts\.get\("ERROR"', text, re.S)
    assert re.search(r'if\s+args\.gate\s+and\s+blocking', text)
    assert re.search(r'if\s+args\.gate\s+and\s+blocking[\s\S]*?return\s+1', text)


def test_release_qa_runs_no_gs_gate_on_corpus():
    text = _read(RELEASE_QA)
    assert "gs_dependency_audit.py" in text
    assert "--gate" in text
    assert "PRYNX_NO_GS_CORPUS" in text
    assert re.search(r'--limit\s+18', text)


def test_release_qa_retries_no_gs_once_from_same_operation_checkpoint():
    text = _read(RELEASE_QA)
    assert "$NO_GS_MAX_ATTEMPTS = 2" in text
    assert re.search(
        r"for \(\$noGsAttempt = 1; \$noGsAttempt -le \$NO_GS_MAX_ATTEMPTS;",
        text,
    )
    assert "--gate --resume --out $NO_GS_AUDIT_OUT" in text
    assert "$noGsExit -ne 1" in text
    assert "Remove-Item -LiteralPath $NO_GS_AUDIT_OUT" not in text


def test_release_can_reuse_only_a_complete_fingerprint_matched_no_gs_pass():
    qa = _read(RELEASE_QA)
    build = _read(BUILD)
    release = _read(RELEASE_UPDATE)
    gui = _read(REPO / "quanly_phathanh.ps1")

    assert "[switch]$ReusePassedNoGs" in qa
    assert "Get-NoGsReusableFingerprint" in qa
    assert "sorted(pathlib.Path(sys.argv[1]).glob('*.pdf'))" in qa
    assert "Test-NoGsPassedCache" in qa
    assert "Test-NoGsPassedArtifact" in qa
    assert "$NO_GS_ARTIFACT_SCHEMA = 3" in qa
    assert '$NO_GS_FINGERPRINT_ALGORITHM = "sha256-content-v2"' in qa
    assert "$files.Count -ne $NO_GS_EXPECTED_FILES" in qa
    assert "$summary.Count -ne $NO_GS_EXPECTED_OPERATIONS" in qa
    assert '$record.Value.status -notin @("OK", "REFUSED")' in qa
    assert 'foreach ($blocking in @("GS", "ERROR", "TIMEOUT"))' in qa
    assert "Cache PDF 18 x 16 khong con khop/khong day du; tu dong chay lai." in qa
    assert "Khong xac minh duoc cache PDF 18 x 16; tu dong chay lai day du." in qa
    assert "Save-NoGsPassedCache" in qa
    assert "[switch]$ReusePassedNoGs" in build
    assert '-File "$ROOT\\scripts\\run_release_qa.ps1" -ReusePassedNoGs' in build
    assert "[switch]$ReusePassedNoGs" in release
    assert "$buildArgs.ReusePassedNoGs = $true" in release
    assert "$chkReuseNoGs" in gui
    assert "Dùng lại kiểm tra PDF 18×16 đã đạt" in gui


def test_release_auto_uses_clean_user_when_prynx_is_already_installed():
    release = _read(RELEASE_UPDATE)
    assert '"$ROOT\\scripts\\verify_artifact_clean_user.ps1"' in release
    assert "$needsCleanUserSmoke" in release
    assert 'Start-Process -FilePath "powershell.exe"' in release
    assert "-Verb RunAs -Wait -PassThru" in release


def test_release_qa_covers_typecheck_and_print_engine():
    text = _read(RELEASE_QA)
    assert "npm.cmd run typecheck" in text
    assert r'Push-Location "$ROOT\print_engine"' in text
    assert 'Invoke-Checked "Print engine tests" { cargo test --locked }' in text
    assert (
        'Invoke-Checked "Print engine release compile" '
        '{ cargo check --release --locked }'
    ) in text


def test_release_qa_stages_all_frontend_workspace_sibling_fixtures():
    text = _read(RELEASE_QA)
    assert "native\\tests\\fixtures\\dieline_default_request.json" in text
    assert "imposition_core\\tests\\fixtures\\grid_parity_simple_auto.json" in text


def test_staged_native_qa_uses_a_runtime_specific_no_gs_artifact():
    qa = _read(RELEASE_QA)
    build = _read(BUILD)
    assert "PRYNX_NO_GS_AUDIT_OUT" in qa
    assert "PRYNX_NO_GS_AUDIT_OUT" in build
    assert "release_no_gs_audit-native-$nativeQaId.json" in build


def test_staged_native_qa_canonicalizes_windows_short_path_aliases():
    text = _read(RELEASE_QA)
    assert "pathlib.Path(os.environ['PRYNX_RELEASE_NATIVE_SITE']).resolve()" in text
    assert "package.is_relative_to(site)" in text
    assert "$actualNativePackage.StartsWith(" not in text


def test_release_uses_updater_signature_generated_for_each_version():
    build = _read(BUILD)
    release = _read(RELEASE_UPDATE)
    config = _read(REPO / "desktop" / "src-tauri" / "tauri.release.conf.json")
    assert "src-tauri/tauri.release.conf.json" in build
    assert "TAURI_SIGNING_PRIVATE_KEY" in release
    assert ".sig" in release
    assert '"createUpdaterArtifacts": false' in config
    assert '$tauriSignerArgs = @("@tauri-apps/cli", "signer", "sign")' in build
    assert '$tauriSignerArgs += "--password="' in build
    assert "npx @tauriSignerArgs" in build
    assert "LastWriteTimeUtc -lt $installer.LastWriteTimeUtc" in build


def test_release_does_not_require_windows_authenticode():
    combined = _read(BUILD) + _read(RELEASE_UPDATE)
    markers = ("AuthenticodeThumbprint", "certificateThumbprint", "Get-AuthenticodeSignature")
    for marker in markers:
        assert marker not in combined


def test_public_release_requires_committed_version_and_clean_source():
    release = _read(RELEASE_UPDATE)
    build = _read(BUILD)
    assert "Assert-CommittedReleaseVersion -ExpectedVersion $Version" in release
    assert "status --porcelain=v1 --untracked-files=all" in release
    assert "[System.IO.File]::WriteAllText($confPath" not in release
    assert "[System.IO.File]::WriteAllText($pkgPath" not in release
    assert "[System.IO.File]::WriteAllText($cargoPath" not in release
    assert "$buildArgs = @{ Release = $true }" in release
    assert "Release build refuses inline -Version mutation" in build
    assert "Assert-ReleaseSourceState -CaptureCommit" in build


def test_release_remote_preflight_runs_before_build_and_rechecks_before_upload():
    """BUILD (audit 2026-08-13 §BR.02): lỗi remote biết sớm không được đợi hơn một giờ."""
    release = _read(RELEASE_UPDATE)
    preflight = release.index("# BUILD (audit 2026-08-13 BR.02): nhung loi remote da biet")
    build_call = release.index('& "$ROOT\\build_production.ps1" @buildArgs')
    publish = release.index("# ---- 7. Publish len GitHub Releases ----")
    upload_call = release.index("gh release upload", publish)
    create_call = release.index("gh release create", publish)

    source_preflight = release.index(
        "Assert-GitHubCommitAvailable -Repo $sourceRepo -Commit $sourceHead",
        preflight,
    )
    target_preflight = release.index(
        "Assert-GitHubCommitAvailable -Repo $ReleaseRepo -Commit $releaseTargetCommit",
        preflight,
    )
    state_preflight = release.index(
        "Assert-GitHubReleaseTagState -Repo $ReleaseRepo -Tag $tag",
        preflight,
    )
    assert preflight < source_preflight < target_preflight < state_preflight < build_call

    source_recheck = release.index(
        "Assert-GitHubCommitAvailable -Repo $sourceRepo -Commit $manifestCommit",
        publish,
    )
    target_recheck = release.index(
        "Assert-GitHubCommitAvailable -Repo $ReleaseRepo -Commit $releaseTargetCommit",
        publish,
    )
    state_recheck = release.index(
        "Assert-GitHubReleaseTagState -Repo $ReleaseRepo -Tag $tag",
        publish,
    )
    assert publish < source_recheck < target_recheck < state_recheck < upload_call
    assert state_recheck < create_call
    state_change_guard = release.index(
        "if ($releaseExists -ne $preflightReleaseExists)",
        state_recheck,
    )
    assert state_recheck < state_change_guard < upload_call
    assert state_change_guard < create_call
    assert "elseif ($tagExists)" in release
    assert "Tag $Tag da ton tai nhung chua co release" in release
    assert "HTTP\\s+404" in release


def test_release_gui_uses_read_only_source_version_without_mutating_config():
    """UIUX (audit 2026-08-13 §BR.11): GUI hiển thị version, không giả làm bước bump."""
    gui = _read(REPO / "quanly_phathanh.ps1")

    assert "function Get-SourceVersion" in gui
    assert "$txtVer.Text = $SourceVersion; $txtVer.ReadOnly = $true" in gui
    assert "function Save-Config" not in gui
    assert "Set-Content -LiteralPath $CONFIG" not in gui
    assert "$saved.Version" not in gui
    assert '$verArg = " -Version' not in gui
    assert "Start-ReleaseController -Mode internal -Version $version" in gui
    assert "Start-ReleaseController -Mode publish -Version $version" in gui
    assert "function Start-HiddenPowerShell" in gui
    assert "Diagnostics.ProcessStartInfo" in gui
    assert "build_production.ps1" not in gui
    assert "release_update.ps1" not in gui


def test_prynx_launcher_opens_live_terminal_for_internal_and_publish_runs():
    """UIUX (audit 2026-08-14 §BR.13): hai chế độ dùng chung terminal log nhìn thấy được."""
    launcher = _read(PRYNX_LAUNCHER)
    gui = _read(REPO / "quanly_phathanh.ps1")
    watcher = _read(RELEASE_LOG_TERMINAL)

    assert "-ShowBuildTerminal" in launcher
    assert "param([switch]$ShowBuildTerminal)" in gui
    assert "function Start-ReleaseLogTerminal" in gui
    assert "$startInfo.UseShellExecute = $true" in gui
    assert "$startInfo.CreateNoWindow = $false" in gui
    assert "Start-ReleaseLogTerminal -ControllerPid $controllerProcess.Id" in gui
    assert "Đóng cửa sổ này không làm dừng build." in watcher
    assert 'if ([string]$status.mode -eq "publish")' in watcher


def test_release_log_terminal_survives_transient_status_replacement(tmp_path: Path):
    powershell = shutil.which("powershell") or shutil.which("pwsh")
    if not powershell:
        pytest.skip("không có PowerShell trên máy này")

    log_path = tmp_path / "build.log"
    log_path.write_text("[1/5] smoke terminal\nBUILD COMPLETE\n", encoding="utf-8")
    status = {
        "schema": 1,
        "runId": "smoke",
        "mode": "internal",
        "version": "1.0.0",
        "state": "running",
        "stage": "Kiểm thử phát hành",
        "message": "Build đang chạy nền.",
        "controllerPid": 4242,
        "childPid": None,
        "startedAtUtc": "2026-08-14T00:00:00Z",
        "updatedAtUtc": "2026-08-14T00:00:01Z",
        "durationSeconds": 1,
        "exitCode": None,
        "logPath": str(log_path),
    }
    (tmp_path / "latest.json").write_text(json.dumps(status), encoding="utf-8")
    proc = subprocess.Popen(
        [
            powershell,
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(RELEASE_LOG_TERMINAL),
            "-StateRoot",
            str(tmp_path),
            "-ControllerPid",
            "4242",
            "-PollMilliseconds",
            "50",
            "-NoPause",
        ],
        cwd=REPO,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    time.sleep(0.5)
    (tmp_path / "latest.json").unlink()
    time.sleep(0.15)
    with log_path.open("a", encoding="utf-8") as log_file:
        log_file.write("status replacement survived\n")
    status.update(
        state="succeeded",
        stage="Đóng gói bộ cài",
        message="Build nội bộ đã hoàn tất.",
        exitCode=0,
    )
    (tmp_path / "latest.json").write_text(json.dumps(status), encoding="utf-8")
    stdout, stderr = proc.communicate(timeout=30)
    output = (stdout + stderr).decode("utf-8", errors="replace")
    assert proc.returncode == 0, output
    assert "smoke terminal" in output
    assert "status replacement survived" in output
    assert "Không còn đọc được trạng thái" not in output
    assert "Mã thoát: 0" in output


def test_release_controller_owns_mutex_status_log_and_child_exit_code():
    """BUILD (audit 2026-08-13 §BR.03/10/12): controller không được bắn-và-quên."""
    controller = _read(RELEASE_CONTROLLER)
    gui = _read(REPO / "quanly_phathanh.ps1")
    build = _read(BUILD)
    release = _read(RELEASE_UPDATE)

    assert "Global\\PrynX-BuildRelease-" in controller
    assert '$mutexScope = if ([string]::IsNullOrWhiteSpace($CommandPath)) { $ROOT } else { $StateRoot }' in controller
    assert "$mutex.WaitOne(0, $false)" in controller
    assert "Write-JsonAtomic" in controller
    assert "[IO.File]::Replace($tempPath, $Path, $backupPath, $true)" in controller
    assert "for ($attempt = 1; $attempt -le 100; $attempt++)" in controller
    assert 'Join-Path $StateRoot "latest.json"' in controller
    assert 'Join-Path $runDirectory "build.log"' in controller
    assert "$childProcess.ExitCode" in controller
    assert "while (-not $childProcess.HasExited" in controller
    assert "ProcessStartInfo" in controller
    assert "StandardOutputEncoding = [Text.Encoding]::UTF8" in controller
    assert "-EncodedCommand" in controller
    assert "commandPathBase64" in controller
    assert "Start-Process -FilePath \"powershell.exe\"" not in controller
    assert "TAURI_SIGNING_PRIVATE_KEY_PASSWORD" not in gui
    assert "New-SigningPasswordPackage" in gui
    assert "ProtectedData]::Protect" in gui
    assert "ProtectedData]::Unprotect" in controller
    child_wait = controller.index("$childProcess.WaitForExit()")
    secret_cleanup = controller.index(
        "Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
        child_wait,
    )
    assert child_wait < secret_cleanup
    assert "$btnLocal.Enabled = $enabled" in gui
    assert "$btnPublish.Enabled = $enabled" in gui
    assert "$statusTimer.Interval = 2000" in gui
    assert 'Start-Process notepad.exe' in gui
    assert "Get-StageFromLog" in controller
    assert "ReadLineAsync" in controller
    assert "$logWriter.AutoFlush = $true" in controller
    assert "[IO.FileShare]::Delete" in gui
    assert "[IO.FileShare]::Delete" in _read(RELEASE_LOG_TERMINAL)
    assert "PRYNX_RELEASE_PROGRESS_PATH" not in build
    assert "PRYNX_RELEASE_PROGRESS_PATH" not in release


def test_release_controller_propagates_child_exit_and_writes_terminal_status(tmp_path: Path):
    """Chạy controller thật với probe cục bộ; tuyệt đối không gọi build/GitHub production."""
    powershell = shutil.which("powershell") or shutil.which("pwsh")
    if not powershell:
        pytest.skip("không có PowerShell trên máy này")

    probe = tmp_path / "probe.ps1"
    probe.write_text(
        '[Console]::OutputEncoding = [Text.Encoding]::UTF8\n'
        'Write-Output "[1/5] tiến độ"\n'
        'exit 7\n',
        encoding="utf-8-sig",
    )
    state_root = tmp_path / "state"
    proc = subprocess.run(
        [
            powershell,
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(RELEASE_CONTROLLER),
            "-Mode",
            "internal",
            "-StateRoot",
            str(state_root),
            "-CommandPath",
            str(probe),
        ],
        cwd=REPO,
        capture_output=True,
        timeout=30,
        check=False,
    )
    assert proc.returncode == 7, (proc.stdout, proc.stderr)
    status = json.loads((state_root / "latest.json").read_text(encoding="utf-8-sig"))
    assert status["state"] == "failed"
    assert status["exitCode"] == 7
    assert status["stage"] == "Biên dịch backend"
    assert status["controllerPid"] > 0
    assert status["childPid"] is None
    assert Path(status["logPath"]).read_text(encoding="utf-8-sig").strip() == "[1/5] tiến độ"


def test_release_controller_retries_status_replace_while_reader_holds_latest(tmp_path: Path):
    """Windows reader không chia sẻ DELETE không được làm controller giết build."""
    powershell = shutil.which("powershell") or shutil.which("pwsh")
    if not powershell:
        pytest.skip("không có PowerShell trên máy này")

    probe = tmp_path / "slow_probe.ps1"
    probe.write_text(
        '[Console]::OutputEncoding = [Text.Encoding]::UTF8\n'
        'Write-Output "[0/5] probe đang chạy"\n'
        'Start-Sleep -Seconds 3\n'
        'Write-Output "probe hoàn tất"\n'
        'exit 0\n',
        encoding="utf-8-sig",
    )
    state_root = tmp_path / "state"
    proc = subprocess.Popen(
        [
            powershell,
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(RELEASE_CONTROLLER),
            "-Mode",
            "internal",
            "-StateRoot",
            str(state_root),
            "-CommandPath",
            str(probe),
        ],
        cwd=REPO,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    latest_path = state_root / "latest.json"
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        try:
            status = json.loads(latest_path.read_text(encoding="utf-8-sig"))
            if status["state"] == "running":
                break
        except (OSError, json.JSONDecodeError):
            pass
        time.sleep(0.05)
    else:
        proc.kill()
        pytest.fail("controller không tạo trạng thái running trong 10 giây")

    # Trên Windows, handle đọc mặc định không chia sẻ quyền xóa/thay thế file.
    with latest_path.open("rb") as locked_reader:
        locked_reader.read(1)
        time.sleep(1.5)

    stdout, stderr = proc.communicate(timeout=20)
    output = (stdout + stderr).decode("utf-8", errors="replace")
    assert proc.returncode == 0, output
    final_status = json.loads(latest_path.read_text(encoding="utf-8-sig"))
    assert final_status["state"] == "succeeded"
    assert final_status["exitCode"] == 0


def test_release_controller_binds_publish_version_notes_and_switch(tmp_path: Path):
    """Hashtable splatting phải giữ đúng ba tham số public, kể cả ghi chú tiếng Việt."""
    powershell = shutil.which("powershell") or shutil.which("pwsh")
    if not powershell:
        pytest.skip("không có PowerShell trên máy này")

    probe = tmp_path / "publish_probe.ps1"
    probe.write_text(
        'param([string]$Version, [string]$Notes, [switch]$ReusePassedNoGs)\n'
        '[Console]::OutputEncoding = [Text.Encoding]::UTF8\n'
        'Write-Output ("version=" + $Version)\n'
        'Write-Output ("notes=" + $Notes)\n'
        'Write-Output ("reuse=" + $ReusePassedNoGs.IsPresent)\n'
        'exit 0\n',
        encoding="utf-8-sig",
    )
    state_root = tmp_path / "state publish"
    notes = "Ghi chú có dấu và khoảng trắng"
    notes_b64 = __import__("base64").b64encode(notes.encode("utf-8")).decode("ascii")
    proc = subprocess.run(
        [
            powershell,
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(RELEASE_CONTROLLER),
            "-Mode",
            "publish",
            "-Version",
            "1.2.3-rc.4",
            "-NotesBase64",
            notes_b64,
            "-ReusePassedNoGs",
            "-StateRoot",
            str(state_root),
            "-CommandPath",
            str(probe),
        ],
        cwd=REPO,
        capture_output=True,
        timeout=30,
        check=False,
    )
    assert proc.returncode == 0, (proc.stdout, proc.stderr)
    status = json.loads((state_root / "latest.json").read_text(encoding="utf-8-sig"))
    log = Path(status["logPath"]).read_text(encoding="utf-8-sig")
    assert "version=1.2.3-rc.4" in log
    assert f"notes={notes}" in log
    assert "reuse=True" in log


# ─────────────────────────────────────────────────────────────────────────────
#  Bất biến encoding của script phát hành
# ─────────────────────────────────────────────────────────────────────────────

# Dùng placeholder + `replace` chứ KHÔNG `str.format`: snippet PowerShell đầy `{}`
# nên `format` sẽ hiểu chúng là ô thay thế và ném `KeyError`.
_PARSE_SNIPPET = (
    "$e=$null; "
    "[System.Management.Automation.Language.Parser]::ParseFile("
    "'@@PATH@@',[ref]$null,[ref]$e) | Out-Null; "
    "if ($e) { $e[0].Extent.StartLineNumber.ToString() + ': ' + $e[0].Message } "
    "else { 'OK' }"
)


@pytest.mark.parametrize(
    "script",
    [
        pytest.param(REPO / "build_production.ps1", id="build_production"),
        pytest.param(REPO / "scripts" / "verify_installed_artifact.ps1", id="verify_installed"),
        pytest.param(REPO / "scripts" / "run_release_qa.ps1", id="run_release_qa"),
        pytest.param(REPO / "release_update.ps1", id="release_update"),
        pytest.param(REPO / "quanly_phathanh.ps1", id="quanly_phathanh"),
        pytest.param(RELEASE_CONTROLLER, id="release_controller"),
        pytest.param(RELEASE_LOG_TERMINAL, id="release_log_terminal"),
    ],
)
def test_release_scripts_parse_under_windows_powershell(script):
    """Script phát hành phải PARSE được bằng chính PowerShell của máy.

    Đây là bất biến hẹp nhưng đúng chỗ, thay cho các chốt gián tiếp về encoding.
    Đo được 2026-07-27: `verify_installed_artifact.ps1` khi vừa commit chứa ký tự
    ngoài ASCII mà cp1252 đọc thành **dấu nháy** (`—` = `E2 80 94`, byte `0x94` là
    `"`), nên PowerShell 5.1 báo `Unexpected token` ở một dòng ASCII phía sau và
    gate hậu kiểm **không thể chạy** — trước cả hai bug logic mà audit lần 3 tìm ra.

    Kiểm theo byte thì vừa báo oan vừa bỏ sót: dấu tiếng Việt cũng sinh byte `0x91`
    (`ố` = `E1 BB 91`) mà `quanly_phathanh.ps1` vẫn chạy tốt, vì lỗi chỉ xảy ra khi
    số dấu nháy sinh ra lẻ. Chỉ chính bộ phân tích cú pháp trả lời đúng được.
    """
    import shutil
    import subprocess

    if not script.is_file():
        pytest.skip(f"thiếu {script.name}")
    powershell = shutil.which("powershell") or shutil.which("pwsh")
    if not powershell:
        pytest.skip("không có PowerShell trên máy này")

    proc = subprocess.run(
        [powershell, "-NoProfile", "-NonInteractive", "-Command",
         _PARSE_SNIPPET.replace("@@PATH@@", str(script).replace("'", "''"))],
        capture_output=True, text=True, timeout=120,
    )
    out = (proc.stdout or "").strip()
    assert out == "OK", f"{script.name} không parse được -> {out or proc.stderr.strip()[:200]}"


# ─────────────────────────────────────────────────────────────────────────────
#  NOTICE trong repo — khoá lỗ hổng đã gây hồi quy ngày 2026-07-28
#
#  Chuyện đã xảy ra: dữ liệu từng khai nhầm một component không đóng gói là
#  `bundled:true`, khiến NOTICE tái tạo tuyên bố sai về payload phát hành.
#
#  Gate cũ chỉ canh (a) build script truyền cờ, (b) verifier soi artifact ĐÃ CÀI.
#  Không gì canh chính file NOTICE trong repo — tức là văn bản mà người đọc repo và
#  bên pháp lý nhìn vào. Ba test dưới đóng chỗ đó.
#
#  Cách sửa gốc: `load_native` luôn bỏ mọi component `bundled=false`; không còn
#  cờ dòng lệnh điều khiển nội dung pháp lý.
# ─────────────────────────────────────────────────────────────────────────────

NOTICE = REPO / "THIRD_PARTY_NOTICES.md"
COMPONENTS = REPO / "scripts" / "bundled_components.json"


def test_notice_generator_khong_ghi_lai_khi_chi_doi_ngay(tmp_path: Path):
    """BUILD (audit 2026-08-11 §REL.PROVENANCE): ngày build không làm source dirty."""
    generator = runpy.run_path(str(NOTICE_GENERATOR), run_name="prynx_notice_test")
    write_if_changed = generator["_write_notice_if_changed"]
    out = tmp_path / "THIRD_PARTY_NOTICES.md"
    old = "header\n*Sinh tự động ngày 2026-08-06 bằng generator.*\npayload-a\n"
    same_payload = "header\n*Sinh tự động ngày 2026-08-11 bằng generator.*\npayload-a\n"
    changed_payload = "header\n*Sinh tự động ngày 2026-08-11 bằng generator.*\npayload-b\n"

    out.write_text(old, encoding="utf-8")
    assert write_if_changed(out, same_payload) is False
    assert out.read_text(encoding="utf-8") == old

    assert write_if_changed(out, changed_payload) is True
    assert out.read_text(encoding="utf-8") == changed_payload


def _native_components() -> list[dict]:
    return json.loads(_read(COMPONENTS))["native_components"]


def test_ghostscript_is_declared_not_bundled():
    """Cờ dữ liệu là chốt DUY NHẤT không phụ thuộc việc caller nhớ truyền cờ."""
    gs = [c for c in _native_components() if c.get("id") == "ghostscript"]
    assert gs, (
        "mất entry ghostscript khỏi bundled_components.json — giữ nó lại với "
        "bundled=false làm mốc lịch sử, đừng xoá"
    )
    assert gs[0].get("bundled") is False, (
        "ghostscript phải khai bundled=false. Đặt lại true là NOTICE sẽ khai "
        "AGPL-3.0 có trong installer ngay lần sinh lại kế tiếp, kể cả khi "
        "build_production.ps1 vẫn không đóng gói GS."
    )


def test_repo_notice_declares_no_strong_copyleft_in_release():
    """Mục 'CÓ trong bản phát hành' không được chứa thành phần copyleft mạnh."""
    text = _read(NOTICE)
    marker = "### Copyleft mạnh — CÓ trong bản phát hành"
    assert marker in text, f"NOTICE mất mục '{marker}' — generator đã đổi khuôn?"

    section = text.split(marker, 1)[1].split("###", 1)[0]
    listed = [
        line.strip()
        for line in section.splitlines()
        if line.strip().startswith("- ")
    ]
    assert not listed, (
        "NOTICE khai có copyleft mạnh trong bản phát hành: "
        f"{listed}. Nếu đúng là đã đóng gói thì phải có quyết định giấy phép; "
        "nếu không thì sinh lại NOTICE (scripts/gen_third_party_notices.py)."
    )


def test_repo_notice_never_mentions_agpl():
    """AGPL ở bất kỳ đâu trong NOTICE nghĩa là ta đang tự khai nghĩa vụ copyleft."""
    hits = [
        f"dòng {i}: {line.strip()}"
        for i, line in enumerate(_read(NOTICE).splitlines(), start=1)
        if "AGPL" in line
    ]
    assert not hits, (
        "NOTICE còn nhắc AGPL:\n  " + "\n  ".join(hits)
        + "\nPrynX không đóng gói thành phần AGPL nào. "
        "Chạy lại scripts/gen_third_party_notices.py."
    )
