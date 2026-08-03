from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "verify_artifact_clean_user.ps1"
ARTIFACT_VERIFIER = ROOT / "scripts" / "verify_installed_artifact.ps1"


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
