FROM python:3.11-slim

# Install system dependencies for OpenCV headless and pdfcpu
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1-mesa-glx \
    libglib2.0-0 \
    wget \
    tar \
    && rm -rf /var/lib/apt/lists/*

# Download and install pdfcpu for Linux
RUN wget https://github.com/pdfcpu/pdfcpu/releases/download/v0.11.1/pdfcpu_0.11.1_Linux_x86_64.tar.gz \
    && tar -xzf pdfcpu_0.11.1_Linux_x86_64.tar.gz \
    && mv pdfcpu_0.11.1_Linux_x86_64/pdfcpu /usr/local/bin/ \
    && rm -rf pdfcpu_0.11.1_Linux_x86_64*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Create directories
RUN mkdir -p /app/uploads /app/results

EXPOSE 8000

CMD ["sh", "-c", "alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 2"]
