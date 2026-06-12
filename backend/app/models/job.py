"""
SQLAlchemy models for the PDF comparison system.
Compatible with both PostgreSQL and SQLite (DEV_MODE).
"""
import uuid
import json
from datetime import datetime, timezone

from sqlalchemy import Column, String, Integer, BigInteger, Text, Float, ForeignKey, DateTime, Boolean, TypeDecorator, types
from sqlalchemy.orm import relationship

from app.database import Base


def utcnow():
    return datetime.now(timezone.utc)


def new_uuid():
    return str(uuid.uuid4())


class JSONType(TypeDecorator):
    """Cross-database JSON column (works with SQLite and PostgreSQL)."""
    impl = Text
    cache_ok = True

    def process_bind_param(self, value, dialect):
        if value is not None:
            return json.dumps(value, ensure_ascii=False)
        return None

    def process_result_value(self, value, dialect):
        if value is not None:
            return json.loads(value)
        return None


class UploadedFile(Base):
    __tablename__ = "uploaded_files"

    id = Column(String(36), primary_key=True, default=new_uuid)
    filename = Column(String(255), nullable=False)
    original_name = Column(String(255), nullable=False)
    file_path = Column(Text, nullable=False)
    file_size = Column(BigInteger)
    page_count = Column(Integer)
    pdf_metadata = Column(JSONType)
    created_at = Column(DateTime, default=utcnow)
    expires_at = Column(DateTime)


class ComparisonJob(Base):
    __tablename__ = "comparison_jobs"

    id = Column(String(36), primary_key=True, default=new_uuid)
    job_type = Column(String(50), nullable=False, default="version_compare")
    status = Column(String(50), default="pending")
    file_a_id = Column(String(36), ForeignKey("uploaded_files.id"))
    file_b_id = Column(String(36), ForeignKey("uploaded_files.id"))
    config = Column(JSONType)
    progress = Column(Integer, default=0)
    current_page = Column(Integer, default=0)
    total_pages = Column(Integer)
    result_summary = Column(JSONType)
    error_message = Column(Text)
    status_message = Column(Text)  # Progress text (e.g. "Đang chuyển đổi PDF...")
    created_at = Column(DateTime, default=utcnow)
    started_at = Column(DateTime)
    completed_at = Column(DateTime)

    file_a = relationship("UploadedFile", foreign_keys=[file_a_id])
    file_b = relationship("UploadedFile", foreign_keys=[file_b_id])
    page_results = relationship("PageResult", back_populates="job", cascade="all, delete-orphan")


class PageResult(Base):
    __tablename__ = "page_results"

    id = Column(String(36), primary_key=True, default=new_uuid)
    job_id = Column(String(36), ForeignKey("comparison_jobs.id"))
    page_number = Column(Integer, nullable=False)
    status = Column(String(20))
    similarity_score = Column(Float)
    diff_count = Column(Integer)
    diff_regions = Column(JSONType)
    highlighted_image_path = Column(Text)
    gif_image_path = Column(Text)
    is_imposition_mode = Column(Boolean, default=False)
    created_at = Column(DateTime, default=utcnow)

    job = relationship("ComparisonJob", back_populates="page_results")
