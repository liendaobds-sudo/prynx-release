"""
Kiem lien thong token license (chay 1 lan truoc khi bat cuong che production).

Muc dich: xac nhan cap khoa LIVE khop -- edge function Supabase ky token bang
LICENSE_SIGNING_KEY (private tren server), backend verify bang _LICENSE_PUBLIC_KEY_B64
nhung trong license_guard.py. Neu khop => an toan bat PRYNX_ENFORCE_LICENSE_TOKEN.

Cach chay (can 1 license key prynx con hieu luc):
    backend\\venv\\Scripts\\python.exe verify_token_pipeline.py <LICENSE_KEY>

Script CHI doc/verify, khong ghi gi len DB. Co the xoa file sau khi dung.
"""
import sys
import httpx

from app.core.license_guard import verify_license_token

SUPABASE_URL = "https://ryvyuxjgdcvoxujqmggm.supabase.co"
# Anon key (cong khai trong bundle) -- chi dung de goi edge function.
ANON_KEY = (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
    "eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ5dnl1eGpnZGN2b3h1anFtZ2dtIiwicm9sZSI6ImFub24i"
    "LCJpYXQiOjE3NjgzNzU1NzEsImV4cCI6MjA4Mzk1MTU3MX0."
    "cwvnWOV7L-3efirO35VnW4zZx9FG6D1p5-Pve-SsQKk"
)
TEST_HWID = "PIPELINE-TEST-HWID"
PRODUCT = "prynx"


def main() -> int:
    if len(sys.argv) < 2:
        print("Thieu license key. Dung: python verify_token_pipeline.py <LICENSE_KEY>")
        return 2
    license_key = sys.argv[1].strip()

    print(f"[1/3] Goi edge function license-verify (machine_id={TEST_HWID})...")
    try:
        resp = httpx.post(
            f"{SUPABASE_URL}/functions/v1/license-verify",
            headers={
                "apikey": ANON_KEY,
                "Authorization": f"Bearer {ANON_KEY}",
                "Content-Type": "application/json",
            },
            json={"license_key": license_key, "machine_id": TEST_HWID, "product_id": PRODUCT},
            timeout=20.0,
        )
    except Exception as e:
        print(f"   [LOI] Khong goi duoc edge function: {e}")
        return 1

    print(f"   HTTP {resp.status_code}")
    try:
        data = resp.json()
    except Exception:
        print(f"   [LOI] Phan hoi khong phai JSON: {resp.text[:200]}")
        return 1

    status = data.get("status")
    print(f"   status = {status} | message = {data.get('message')}")

    if status != "VALID":
        print("   [DUNG] Key khong VALID nen edge khong phat token. Hay dung 1 key prynx con hieu luc,")
        print("          hoac kiem tra key chua vuot so may (machine_id test la may moi).")
        return 1

    token = data.get("token")
    if not token:
        print("   [LOI] status=VALID nhung KHONG co token => LICENSE_SIGNING_KEY chua set tren server.")
        print("         => Set secret roi deploy lai edge function truoc khi bat cuong che.")
        return 1
    print("[2/3] Da nhan token tu server.")

    print("[3/3] Backend verify token bang public key nhung san...")
    ok, reason = verify_license_token(token, TEST_HWID, license_key)
    if ok:
        print("\n   ===> THANH CONG: cap khoa LIVE KHOP. An toan bat PRYNX_ENFORCE_LICENSE_TOKEN.\n")
        return 0
    print(f"\n   ===> THAT BAI: backend tu choi token ({reason}).")
    print("        Nguyen nhan thuong gap: LICENSE_SIGNING_KEY tren server KHONG khop")
    print("        _LICENSE_PUBLIC_KEY_B64 trong license_guard.py. DUNG bat cuong che toi khi sua.\n")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
