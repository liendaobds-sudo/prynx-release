from __future__ import annotations

import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "verify_artifact_clean_user.ps1"
ARTIFACT_VERIFIER = ROOT / "scripts" / "verify_installed_artifact.ps1"
TAURI_LIB = ROOT / "desktop" / "src-tauri" / "src" / "lib.rs"


def _startup_timeout(text: str) -> int:
    match = re.search(r"\$StartupTimeoutSeconds\s*=\s*(\d+)", text)
    assert match is not None
    return int(match.group(1))


def test_clean_user_runner_is_sid_scoped_and_never_persists_password() -> None:
    text = SCRIPT.read_text(encoding="utf-8")

    assert "New-LocalUser" in text
    assert "Remove-LocalUser" in text
    assert "Win32_UserProfile" in text
    assert "[string]$current.Sid.Value -eq $createdSid" in text
    assert "Remove-CimInstance" in text
    assert "ConvertFrom-SecureString" not in text
    assert "SecureStringToBSTR" not in text
    assert "RedirectStandardOutput" in text
    assert "RedirectStandardError" in text


def test_clean_user_runner_does_not_delete_profile_paths_directly() -> None:
    text = SCRIPT.read_text(encoding="utf-8")

    assert "Remove-Item -LiteralPath $profile" not in text
    assert "Remove-Item -Recurse" not in text
    assert "Get-LocalUser -Name $userName" in text


def test_artifact_cleanup_retries_transient_nsis_remove_race() -> None:
    text = ARTIFACT_VERIFIER.read_text(encoding="utf-8")

    assert "for ($attempt = 1; $attempt -le 5; $attempt++)" in text
    assert "Start-Sleep -Milliseconds 250" in text
    assert "Khong xoa duoc cay cai Temp sau 5 lan" in text


def test_startup_timeouts_leave_room_for_each_outer_verifier() -> None:
    clean_user_timeout = _startup_timeout(SCRIPT.read_text(encoding="utf-8"))
    artifact_timeout = _startup_timeout(ARTIFACT_VERIFIER.read_text(encoding="utf-8"))
    tauri_text = TAURI_LIB.read_text(encoding="utf-8")
    match = re.search(r"SIDECAR_STARTUP_TIMEOUT[^\n]+from_secs\((\d+)\)", tauri_text)
    assert match is not None
    app_timeout = int(match.group(1))

    assert app_timeout == 60
    assert artifact_timeout > app_timeout
    assert clean_user_timeout > artifact_timeout


def test_runtime_verifier_waits_for_current_authenticated_sidecar_breadcrumb() -> None:
    verifier_text = ARTIFACT_VERIFIER.read_text(encoding="utf-8")
    tauri_text = TAURI_LIB.read_text(encoding="utf-8")

    assert 'startup_breadcrumb("sidecar: ready (startup proof OK)")' in tauri_text
    assert "sidecar: ready \\(startup proof OK\\)" in verifier_text
    assert "sidecar: spawned on :8321" not in verifier_text
