"""Hợp đồng triển khai cho proof inspect server-owned của máy bế CNC."""

from __future__ import annotations

import json
from pathlib import Path
import re


def test_docker_chay_mot_api_process_cho_proof_process_local() -> None:
    """Docker không được phân inspect/export sang hai kho proof khác nhau."""
    backend_dir = Path(__file__).resolve().parents[4]
    dockerfile = backend_dir / "Dockerfile"
    cmd_lines = [
        line.removeprefix("CMD ")
        for line in dockerfile.read_text(encoding="utf-8").splitlines()
        if line.startswith("CMD ")
    ]

    assert len(cmd_lines) == 1
    command = json.loads(cmd_lines[0])
    worker_counts = re.findall(r"--workers\s+(\d+)", " ".join(command))

    # Proof giữ secret + CutModel trong RAM của đúng process phát hành.
    assert worker_counts == ["1"]
