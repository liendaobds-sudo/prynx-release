FROM python:3.11-slim

# Install system dependencies for OpenCV headless (pdfcpu legacy removed in unification Phase 1)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1-mesa-glx \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Create directories
RUN mkdir -p /app/uploads /app/results

EXPOSE 8000

# PERF/SEC (audit 2026-09-02 §PERF-NEST-07): proof CNC, job registry và
# scheduler admission đều là state process-local. Giữ đúng một API process để
# inspect → export không rơi sang thế hệ khác; các pool việc nặng bên trong vẫn
# tự dùng toàn bộ phần cứng theo hồ sơ RAM/CPU.
CMD ["sh", "-c", "alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 1"]
