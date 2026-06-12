"""
Runner parity 2 chế độ (Task 2 / Requirements 8.3, 8.4).

Chế độ 1 — Rust ON (mặc định):
    Chạy golden + parity. Suite parity so trực tiếp Rust vs Python.
    Nếu Rust chưa cài, parity tự skip; golden chạy theo nhánh thuần Python.

Chế độ 2 — Ép Python (IMPOSITION_ALLOW_PY_FALLBACK=1):
    Chạy lại golden với cờ ép fallback Python để xác nhận nhánh Python
    cho cùng kết quả golden. (Cờ này được nối đầy đủ ở Task 14; đặt sẵn ở đây.)

Dùng:
    cd backend
    python tests/parity/run_parity.py
"""
import os
import subprocess
import sys

BACKEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def _run(label, env_extra=None):
    env = dict(os.environ)
    if env_extra:
        env.update(env_extra)
    print("\n" + "=" * 70)
    print("  " + label)
    print("=" * 70)
    cmd = [sys.executable, "-m", "pytest", "tests/golden", "tests/parity", "-q"]
    return subprocess.call(cmd, cwd=BACKEND_DIR, env=env)


def main():
    rc1 = _run("MODE 1 - Rust ON (parity Rust vs Python + golden)")
    rc2 = _run(
        "MODE 2 - Force Python (IMPOSITION_ALLOW_PY_FALLBACK=1)",
        env_extra={"IMPOSITION_ALLOW_PY_FALLBACK": "1"},
    )
    rc = rc1 or rc2
    print("\n" + "=" * 70)
    print("  RESULT: mode1=%d  mode2=%d  -> %s" % (rc1, rc2, "PASS" if rc == 0 else "FAIL"))
    print("=" * 70)
    sys.exit(rc)


if __name__ == "__main__":
    main()
