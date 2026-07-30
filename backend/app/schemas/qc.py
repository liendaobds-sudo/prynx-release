"""Hợp đồng API (request + response) — KIENTRUC audit 2026-07-29 §A.2.

Model được gom từ file route về đây để hai đầu desktop ↔ backend có MỘT chỗ tra hợp đồng.
File route import lại từ đây, nên mọi đường import cũ vẫn dùng được.
"""

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator  # noqa: F401


class TextQcRequest(BaseModel):
    text: str
    llm_mode: str
    api_key: str

class TextQcResponse(BaseModel):
    errors: List[str]

class ExtractTextResponse(BaseModel):
    text: str
