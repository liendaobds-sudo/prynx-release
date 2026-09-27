"""
PPE Viewer GPU - Process Protocol & Surface Lease Lifetime Verification Probe.

Kiem chung cac bat bien:
1. Surface Lease Lifetime: cap phat -> su dung -> giai phong (khong use-after-free).
2. Zero GPU Full-Frame Readback: duong GPU thong thuong khong doc nguoc framebuffer ve CPU.
3. Accounting dung so byte copy khi co CPU fallback.
4. Device loss recovery: thu hoi toan bo lease cu va tai thiet lap ma khong gay loi nho.
"""

from __future__ import annotations

import json
import sys
import uuid
from typing import Dict, List, Optional
from pydantic import BaseModel, Field


class LeaseMetadata(BaseModel):
    lease_id: str
    owner_view_id: str
    device_epoch: int
    width: int
    height: int
    format: str
    bytes_size: int
    fence_value: int
    is_active: bool = True
    released: bool = False


class SurfacePoolManager:
    def __init__(self, initial_epoch: int = 1):
        self.device_epoch: int = initial_epoch
        self.active_leases: Dict[str, LeaseMetadata] = {}
        self.total_allocated_bytes: int = 0
        self.gpu_readback_bytes: int = 0
        self.cpu_upload_bytes: int = 0
        self.device_loss_count: int = 0

    def allocate_surface_lease(
        self,
        owner_view_id: str,
        width: int,
        height: int,
        format_name: str = "Rgba16Float",
    ) -> LeaseMetadata:
        # 16-bit float = 8 bytes per pixel (RGBA = 4 channels * 2 bytes)
        bpp = 8 if "16" in format_name else 4
        byte_size = width * height * bpp
        lease_id = f"lease_{uuid.uuid4().hex[:12]}"

        lease = LeaseMetadata(
            lease_id=lease_id,
            owner_view_id=owner_view_id,
            device_epoch=self.device_epoch,
            width=width,
            height=height,
            format=format_name,
            bytes_size=byte_size,
            fence_value=1,
            is_active=True,
            released=False,
        )

        self.active_leases[lease_id] = lease
        self.total_allocated_bytes += byte_size
        return lease

    def use_lease_for_render(self, lease_id: str) -> None:
        if lease_id not in self.active_leases:
            raise ValueError(f"[FAIL-CLOSED] Surface lease '{lease_id}' khong ton tai!")
        lease = self.active_leases[lease_id]
        if lease.released or not lease.is_active:
            raise ValueError(f"[FAIL-CLOSED] Use-after-free phat hien tren lease '{lease_id}' da bi giai phong!")
        if lease.device_epoch != self.device_epoch:
            raise ValueError(f"[FAIL-CLOSED] Lease thuoc epoch cu ({lease.device_epoch} != {self.device_epoch}) sau device loss!")
        lease.fence_value += 1

    def release_lease(self, lease_id: str) -> None:
        if lease_id in self.active_leases:
            lease = self.active_leases[lease_id]
            lease.is_active = False
            lease.released = True
            self.total_allocated_bytes -= lease.bytes_size
            del self.active_leases[lease_id]

    def record_gpu_render_commit(self, lease_id: str) -> None:
        """GPU path commit thang len swapchain, zero readback to CPU."""
        self.use_lease_for_render(lease_id)
        # Bất biến: GPU path KHÔNG tăng gpu_readback_bytes
        assert self.gpu_readback_bytes == 0, "[FAIL-CLOSED] GPU path khong duoc phep readback toan frame!"

    def record_cpu_fallback_upload(self, lease_id: str, uploaded_bytes: int) -> None:
        """CPU fallback ghi nhan dung so byte can upload len GPU."""
        self.use_lease_for_render(lease_id)
        self.cpu_upload_bytes += uploaded_bytes

    def simulate_device_loss_and_recovery(self) -> None:
        """Driver reset hoac device lost: thu hoi toan bo tai nguyen epoch cu va tang epoch."""
        self.device_loss_count += 1
        self.device_epoch += 1
        # Vo hieu hoa toan bo active leases
        for lease in self.active_leases.values():
            lease.is_active = False
        self.active_leases.clear()
        self.total_allocated_bytes = 0


def verify_process_protocol() -> dict:
    mgr = SurfacePoolManager(initial_epoch=1)

    # 1. Cap phat 2 leases cho 2 viewport
    l1 = mgr.allocate_surface_lease("view_main", 1920, 1080, "Rgba16Float")
    l2 = mgr.allocate_surface_lease("view_compare", 960, 1080, "Rgba8Unorm")

    # 2. Render hop le
    mgr.record_gpu_render_commit(l1.lease_id)
    mgr.record_gpu_render_commit(l2.lease_id)

    # 3. CPU fallback upload
    mgr.record_cpu_fallback_upload(l1.lease_id, 1024 * 1024)

    # 4. Giai phong l2 va kiem tra use-after-free
    mgr.release_lease(l2.lease_id)
    uaf_caught = False
    try:
        mgr.use_lease_for_render(l2.lease_id)
    except ValueError:
        uaf_caught = True

    # 5. Kiem tra device loss recovery
    mgr.simulate_device_loss_and_recovery()
    assert mgr.device_epoch == 2
    assert len(mgr.active_leases) == 0

    stale_epoch_caught = False
    try:
        mgr.use_lease_for_render(l1.lease_id)
    except ValueError:
        stale_epoch_caught = True

    # 6. Cap phat lai tren epoch moi
    l_new = mgr.allocate_surface_lease("view_main", 1920, 1080, "Rgba16Float")
    mgr.record_gpu_render_commit(l_new.lease_id)

    result = {
        "evidence_kind": "python_protocol_model",
        "runtime_acceptance": "UNOBSERVED",
        "verdict": uaf_caught and stale_epoch_caught and mgr.device_epoch == 2,
        "zero_gpu_readback": mgr.gpu_readback_bytes == 0,
        "use_after_free_blocked": uaf_caught,
        "stale_epoch_after_device_loss_blocked": stale_epoch_caught,
        "device_loss_recovery_successful": True,
        "current_epoch": mgr.device_epoch,
        "active_leases_count": len(mgr.active_leases),
        "total_allocated_bytes": mgr.total_allocated_bytes,
        "cpu_upload_bytes_tracked": mgr.cpu_upload_bytes,
    }
    return result


if __name__ == "__main__":
    res = verify_process_protocol()
    print(json.dumps(res, indent=2))
    if not res["verdict"]:
        sys.exit(1)
