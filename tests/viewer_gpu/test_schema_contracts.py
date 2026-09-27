"""
Unit test kiem chung Schema Contracts cho PPE Viewer GPU:
- Scene IR Version 1 (schemas/viewer_gpu/scene_ir_v1.json)
- Render Graph Version 1 (schemas/viewer_gpu/render_graph_v1.json)
- Feature Ownership Matrix (docs/PPE_VIEWER_GPU_SCHEMA_V1.md)
"""

from __future__ import annotations

import json
import re
from pathlib import Path
import pytest
from pydantic import BaseModel, Field, ValidationError

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
SCENE_IR_SCHEMA_FILE = REPO_ROOT / "schemas" / "viewer_gpu" / "scene_ir_v1.json"
RENDER_GRAPH_SCHEMA_FILE = REPO_ROOT / "schemas" / "viewer_gpu" / "render_graph_v1.json"
SCHEMA_DOC = REPO_ROOT / "docs" / "PPE_VIEWER_GPU_SCHEMA_V1.md"


def test_schema_files_exist_and_valid_json():
    """Kiem tra cac file schema ton tai va la JSON hop le."""
    assert SCENE_IR_SCHEMA_FILE.exists(), f"Khong tim thay {SCENE_IR_SCHEMA_FILE}"
    assert RENDER_GRAPH_SCHEMA_FILE.exists(), f"Khong tim thay {RENDER_GRAPH_SCHEMA_FILE}"

    with open(SCENE_IR_SCHEMA_FILE, "r", encoding="utf-8") as f:
        scene_schema = json.load(f)
    assert scene_schema.get("title") == "PPEViewerSceneIR"
    assert "required" in scene_schema
    assert "properties" in scene_schema

    with open(RENDER_GRAPH_SCHEMA_FILE, "r", encoding="utf-8") as f:
        graph_schema = json.load(f)
    assert graph_schema.get("title") == "PPEViewerRenderGraph"
    assert "required" in graph_schema
    assert "properties" in graph_schema


# Pydantic models kiem chung sat sao theo Schema v1
class PageBox(BaseModel):
    media_box: list[float]
    crop_box: list[float]
    bleed_box: list[float] | None = None
    trim_box: list[float] | None = None

    def validate_boxes(self):
        if len(self.media_box) != 4 or len(self.crop_box) != 4:
            raise ValueError("Page boxes phai chua dung 4 toa do [x0, y0, x1, y1]")


class DrawCommand(BaseModel):
    id: int
    command_type: str
    bounds: list[float]
    paint_mode: str | None = None
    color_space: str | None = None
    color_values: list[float] | None = None
    alpha: float | None = None
    overprint: bool | None = None
    payload_ref: str | None = None

    def validate_command(self):
        valid_types = {
            "path", "text_run", "image", "shading",
            "clip_push", "clip_pop", "group_push", "group_pop", "mask_push", "mask_pop"
        }
        if self.command_type not in valid_types:
            raise ValueError(f"Invalid command_type: {self.command_type}")
        if len(self.bounds) != 4:
            raise ValueError("Bounds phai chua dung 4 toa do [x0, y0, x1, y1]")
        if self.alpha is not None and not (0.0 <= self.alpha <= 1.0):
            raise ValueError(f"Alpha out of range: {self.alpha}")


class SceneIR(BaseModel):
    schema_version: str
    document_revision: str
    page_index: int
    page_box: PageBox
    rotation_degrees: int
    user_unit: float
    draw_commands: list[DrawCommand]
    resources: dict
    metadata: dict | None = None

    def validate_scene(self):
        if not re.match(r"^1\.[0-9]+\.[0-9]+$", self.schema_version):
            raise ValueError(f"Schema version khong hop le: {self.schema_version}")
        if self.page_index < 0:
            raise ValueError("page_index phai >= 0")
        if self.rotation_degrees not in (0, 90, 180, 270):
            raise ValueError(f"Goc xoay {self.rotation_degrees} khong hop le")
        if self.user_unit <= 0:
            raise ValueError("user_unit phai > 0")
        self.page_box.validate_boxes()
        for cmd in self.draw_commands:
            cmd.validate_command()


class RenderGraphNode(BaseModel):
    node_id: str
    pass_type: str
    backend: str
    inputs: list[str] = Field(default_factory=list)
    output_surface_lease_id: str
    fallback_reason: str | None = None

    def validate_node(self):
        valid_passes = {
            "raster_pass", "group_blend_pass", "smask_pass",
            "color_resolve_pass", "overlay_pass", "present_blit_pass"
        }
        if self.pass_type not in valid_passes:
            raise ValueError(f"Invalid pass_type: {self.pass_type}")
        if self.backend not in {"gpu_shader", "gpu_blit", "cpu_fallback"}:
            raise ValueError(f"Invalid backend: {self.backend}")


class RenderGraph(BaseModel):
    schema_version: str
    graph_id: str
    target_id: str
    viewport: dict
    camera: dict
    color_contract: dict
    nodes: list[RenderGraphNode]
    edges: list[dict]
    capability_plan: dict

    def validate_graph(self):
        if not re.match(r"^1\.[0-9]+\.[0-9]+$", self.schema_version):
            raise ValueError(f"Schema version khong hop le: {self.schema_version}")
        if self.viewport.get("width_px", 0) <= 0 or self.viewport.get("height_px", 0) <= 0:
            raise ValueError("Viewport dimension phai > 0")
        if self.camera.get("scale", 0) <= 0:
            raise ValueError("Camera scale phai > 0")
        if self.camera.get("rotation_degrees") not in (0, 90, 180, 270):
            raise ValueError("Camera rotation khong hop le")
        if len(self.nodes) == 0:
            raise ValueError("Render graph phai chua it nhat 1 node")
        for node in self.nodes:
            node.validate_node()


def test_valid_scene_ir_fixture_passes():
    """Kiem tra mau Scene IR chuan qua duoc validation."""
    valid_data = {
        "schema_version": "1.0.0",
        "document_revision": "sha256:95f38cf429fe7dd7c6500043ce308fd2e87e80a2290217d428fe0c68c6098184",
        "page_index": 0,
        "page_box": {
            "media_box": [0.0, 0.0, 595.28, 841.89],
            "crop_box": [0.0, 0.0, 595.28, 841.89],
            "bleed_box": [0.0, 0.0, 595.28, 841.89],
            "trim_box": [10.0, 10.0, 585.28, 831.89]
        },
        "rotation_degrees": 0,
        "user_unit": 1.0,
        "draw_commands": [
            {
                "id": 1,
                "command_type": "path",
                "bounds": [0.0, 0.0, 100.0, 100.0],
                "paint_mode": "fill",
                "color_space": "DeviceCMYK",
                "color_values": [0.0, 1.0, 1.0, 0.0],
                "alpha": 1.0,
                "overprint": False
            },
            {
                "id": 2,
                "command_type": "text_run",
                "bounds": [50.0, 50.0, 200.0, 80.0],
                "paint_mode": "fill",
                "color_space": "DeviceCMYK",
                "color_values": [0.0, 0.0, 0.0, 1.0],
                "alpha": 1.0,
                "overprint": True
            }
        ],
        "resources": {
            "fonts": {"F1": {"name": "Helvetica"}},
            "images": {},
            "shadings": {}
        }
    }
    scene = SceneIR(**valid_data)
    scene.validate_scene()
    assert scene.page_index == 0
    assert len(scene.draw_commands) == 2


def test_scene_ir_fail_closed_on_invalid_data():
    """Kiem tra co che fail-closed tu choi Scene IR khong hop le."""
    # 1. Sai goc xoay
    with pytest.raises((ValueError, ValidationError)):
        s = SceneIR(
            schema_version="1.0.0",
            document_revision="test",
            page_index=0,
            page_box=PageBox(media_box=[0, 0, 100, 100], crop_box=[0, 0, 100, 100]),
            rotation_degrees=45,  # Goc xoay khong hop le
            user_unit=1.0,
            draw_commands=[],
            resources={"fonts": {}, "images": {}, "shadings": {}}
        )
        s.validate_scene()

    # 2. Sai command_type
    with pytest.raises((ValueError, ValidationError)):
        s = SceneIR(
            schema_version="1.0.0",
            document_revision="test",
            page_index=0,
            page_box=PageBox(media_box=[0, 0, 100, 100], crop_box=[0, 0, 100, 100]),
            rotation_degrees=0,
            user_unit=1.0,
            draw_commands=[
                DrawCommand(id=1, command_type="unknown_raster_op", bounds=[0, 0, 10, 10])
            ],
            resources={"fonts": {}, "images": {}, "shadings": {}}
        )
        s.validate_scene()


def test_valid_render_graph_fixture_passes():
    """Kiem tra mau Render Graph chuan qua duoc validation."""
    valid_graph_data = {
        "schema_version": "1.0.0",
        "graph_id": "graph_target_101",
        "target_id": "view_main_page_0",
        "viewport": {
            "width_px": 1920,
            "height_px": 1080,
            "dpr": 1.0
        },
        "camera": {
            "scale": 1.5,
            "offset_x": 100.0,
            "offset_y": 50.0,
            "rotation_degrees": 0
        },
        "color_contract": {
            "proof_mode": True,
            "rendering_intent": "RelativeColorimetric",
            "overprint_simulation": True,
            "display_profile_hash": "sha256:disp123",
            "proof_profile_hash": "sha256:isocoatedv2"
        },
        "nodes": [
            {
                "node_id": "n1_raster",
                "pass_type": "raster_pass",
                "backend": "gpu_shader",
                "inputs": [],
                "output_surface_lease_id": "lease_tex_rgba16f_1"
            },
            {
                "node_id": "n2_resolve",
                "pass_type": "color_resolve_pass",
                "backend": "gpu_shader",
                "inputs": ["n1_raster"],
                "output_surface_lease_id": "lease_tex_rgba8_swapchain"
            }
        ],
        "edges": [
            {"from_node_id": "n1_raster", "to_node_id": "n2_resolve"}
        ],
        "capability_plan": {
            "total_nodes": 2,
            "gpu_nodes": 2,
            "cpu_nodes": 0,
            "fallback_reasons": []
        }
    }
    graph = RenderGraph(**valid_graph_data)
    graph.validate_graph()
    assert graph.graph_id == "graph_target_101"
    assert len(graph.nodes) == 2


def test_feature_ownership_matrix_coverage():
    """Kiem tra bang phan dinh quyen so huu trong SCHEMA_V1.md phu du 12 tinh nang khong de trong."""
    assert SCHEMA_DOC.exists(), f"Khong tim thay {SCHEMA_DOC}"
    doc_text = SCHEMA_DOC.read_text(encoding="utf-8")

    # Kiem tra 12 ma tinh nang F01 -> F12 deu xuat hien trong ma tran
    for i in range(1, 13):
        code = f"F{i:02d}"
        assert f"| **{code}** |" in doc_text, f"Thieu tinh nang {code} trong Feature Ownership Matrix"

    # Kiem tra cac tu khoa chu so huu dac ta ro rang
    assert "Native Viewport" in doc_text
    assert "React Shell" in doc_text
    assert "airspace" in doc_text.lower()
