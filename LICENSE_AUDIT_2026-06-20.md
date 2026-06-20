# LICENSE COVERAGE AUDIT — PrynX Backend

**Audit Date:** 2026-06-20  
**Scope:** FastAPI routes + dependencies  
**Rule:** Trace-to-ground-truth per audit-rules.md §1–§5  

---

## 📋 Router Level Protection

| Router File | Router Declaration | License Protection |
|---|---|---|
| edit.py:65 | `APIRouter(dependencies=[Depends(require_license)])` | ✅ ROUTER-LEVEL |
| export.py:18 | `APIRouter(..., dependencies=[Depends(require_license)])` | ✅ ROUTER-LEVEL |
| imposition.py:16 | `APIRouter(..., dependencies=[Depends(require_license)])` | ✅ ROUTER-LEVEL |
| pdf_tools.py:24 | `APIRouter(..., dependencies=[Depends(require_license)])` | ✅ ROUTER-LEVEL |
| preflight.py:34 | `APIRouter(dependencies=[Depends(require_license)])` | ✅ ROUTER-LEVEL |
| compare.py:17 | `APIRouter()` | ❌ NO ROUTER-LEVEL |
| qc.py:13 | `APIRouter()` | ❌ NO ROUTER-LEVEL |
| report.py:24 | `APIRouter()` | ❌ NO ROUTER-LEVEL |
| results.py:17 | `APIRouter()` | ❌ NO ROUTER-LEVEL |
| system.py:11 | `APIRouter()` | ❌ NO ROUTER-LEVEL |
| upload.py:20 | `APIRouter()` | ❌ NO ROUTER-LEVEL |
| vdp.py:19 | `APIRouter()` | ❌ NO ROUTER-LEVEL |
| ws.py:14 | `APIRouter()` | ❌ NO ROUTER-LEVEL |

---

## 🔍 Endpoint-Level Verification

**Routers WITHOUT router-level protection require EVERY endpoint to have `Depends(require_license)`**

### ✅ compare.py (1 endpoint)
- `POST /jobs/compare` @line 40 → **license_info: dict = Depends(require_license)** ✅

### ✅ qc.py (2 endpoints)
- `POST /qc/check-text` @line 23 → **license_info: dict = Depends(require_license)** ✅
- `POST /qc/extract-text` @line 57 → **license_info: dict = Depends(require_license)** ✅

### ✅ report.py (1 endpoint)
- `GET /jobs/{job_id}/report` @line 94 → **license_info: dict = Depends(require_license)** ✅

### ✅ results.py (5 endpoints)
- `GET /jobs/{job_id}` @line 52 → **license_info: dict = Depends(require_license)** ✅
- `GET /jobs/{job_id}/results` @line 61 → **license_info: dict = Depends(require_license)** ✅
- `GET /jobs/{job_id}/page/{page_num}` @line 91 → **license_info: dict = Depends(require_license)** ✅
- `DELETE /jobs/{job_id}` @line 105 → **license_info: dict = Depends(require_license)** ✅
- `GET /files/{file_id}/serve` @line 120 → **license_info: dict = Depends(require_license)** ✅

### ✅ system.py (3 endpoints)
- `GET /system/gpu-status` @line 14 → **license_info: dict = Depends(require_license)** ✅
- `POST /system/install-gpu-plugin` @line 20 → **license_info: dict = Depends(require_license)** ✅
- `POST /system/recover-jobs` @line 60 → **license_info: dict = Depends(require_license)** ✅

### ✅ upload.py (1 endpoint)
- `POST /upload` @line 24 → **license_info: dict = Depends(require_license)** ✅

### ✅ vdp.py (5 endpoints)
- `POST /generate` @line 87 → **license_info: dict = Depends(require_license)** @line 94 ✅
- `GET /status/{job_id}` @line 179 → **license_info: dict = Depends(require_license)** ✅
- `GET /download/{job_id}` @line 202 → **license_info: dict = Depends(require_license)** ✅
- `POST /upload` @line 220 → **license_info: dict = Depends(require_license)** ✅
- `GET /fonts` @line 234 → **license_info: dict = Depends(require_license)** ✅

### ⚠️ ws.py (1 WebSocket)
- `WS /ws/jobs/{job_id}/progress` @line 17
  - **CUSTOM VERIFICATION:** Calls `verify_sidecar_signature()` at @line 34
  - **ISSUE:** `verify_sidecar_signature()` returns `True` when DEV_MODE=true (@license_guard.py:154)
  - **[SUSPECTED] DEVMODE BYPASS** — if DEV_MODE enabled, WS accepts without token validation

### 🔴 main.py (1 app-level endpoint)
- `GET /health` @line 189 → **NO LICENSE CHECK**
  - **CLAIM:** Returns `{"status": "ok", "app": settings.APP_NAME}` (informational only)
  - **[VERIFIED] 🟢 VÔHẠI** — does NOT process/read/write PDFs; health check endpoint standard practice

---

## 🔐 Protected Routers (Router-Level)

These 5 routers apply `dependencies=[Depends(require_license)]` at router declaration,
protecting all their endpoints automatically:

1. **edit.py** (16 endpoints) — PDF object editing
2. **export.py** (image export) 
3. **imposition.py** (imposition/nup/sticker planning)
4. **pdf_tools.py** (PDF utilities: merge, split, rotate, etc.)
5. **preflight.py** (preflight checking)

**All endpoints in these routers = [VERIFIED] ✅ PROTECTED**

---

## 📊 Summary Table

| Category | Count | Status |
|---|---|---|
| Total Routers | 13 | - |
| Router-Level Protected | 5 | ✅ |
| Endpoint-Level Protected (no router-level) | 19 | ✅ |
| App-Level Unprotected (`/health`) | 1 | 🟢 Harmless |
| **WebSocket (with signature check)** | 1 | ⚠️ DEV_MODE BYPASS |

---

## 🎯 Findings

### [VERIFIED] ✅ — NO CRITICAL BYPASSES FOUND (non-DEV_MODE)

All **HTTP REST endpoints** that handle actual PDF operations (compare, qc, report, 
results, system, upload, vdp, edit, export, imposition, preflight, pdf_tools) are 
protected by `require_license` dependency either at:
1. **Router level** (5 routers), OR
2. **Endpoint level** (8 routers without router-level protection)

**In production (DEV_MODE=false):**
- Every endpoint requires sidecar token + HMAC signature verification
- WebSocket also requires token/signature (does NOT bypass when DEV_MODE=false)
- `/health` endpoint unprotected but **harmless** (no data processing)

### [SUSPECTED] ⚠️ — DEV_MODE WEAKENS WS SECURITY

**Location:** `backend/app/core/license_guard.py:154–155` in `verify_sidecar_signature()`

**Condition:** When `DEV_MODE=true` OR environment `DEV_MODE` env var set to "true"/"yes"/"1"

**Impact:** 
- WebSocket endpoint `/ws/jobs/{job_id}/progress` accepts **any token/signature** 
  (returns `True` immediately)
- Requires monitoring `DEV_MODE` is **never set in released binary**

**Mitigation Status:** `license_guard.py:67–68` checks for compiled binary:
```python
if "__compiled__" in globals() or getattr(sys, "frozen", False):
    return False  # Never DEV_MODE in binary
```
✅ **VERIFIED** — Nuitka compiled binary cannot be DEV_MODE

---

## 📝 Recommendations

1. ✅ **HTTP Endpoints:** Fully licensed (no action needed)
2. ✅ **WebSocket:** License verification working in production (no action needed)
3. ✅ **Dev Safety:** Binary forced to production mode (no action needed)
4. 🟢 **Health Check:** `/health` unprotected by design (OK for monitoring systems)

**Conclusion: NO CRITICAL BYPASS ROUTES FOUND FOR LIVE CODE**


---

## APPENDIX: Full Route Trace

### Route 1: compare.py — `/jobs/compare` (PDF Comparison)
- **File:** `backend/app/api/routes/compare.py:40`
- **Method:** `POST`
- **Handler:** `create_comparison_job()`
- **License Check:** Line 44 — `license_info: dict = Depends(require_license)`
- **Work:** Validates files, creates comparison job, dispatches to Celery/thread worker
- **Status:** [VERIFIED] ✅ PROTECTED

### Route 2: qc.py — `/qc/check-text` (AI Text QC)
- **File:** `backend/app/api/routes/qc.py:23`
- **Method:** `POST`
- **Handler:** `check_text()`
- **License Check:** Line 24 — `license_info: dict = Depends(require_license)`
- **Work:** LLM-based text checking (Gemini/OpenAI/Deepseek)
- **Status:** [VERIFIED] ✅ PROTECTED

### Route 3: qc.py — `/qc/extract-text` (OCR/Text Extraction)
- **File:** `backend/app/api/routes/qc.py:57`
- **Method:** `POST`
- **Handler:** `extract_text()`
- **License Check:** Line 58 — `license_info: dict = Depends(require_license)`
- **Work:** PDF→text extraction (pdfplumber + Tesseract OCR fallback)
- **Status:** [VERIFIED] ✅ PROTECTED

### Route 4–8: edit.py (16 endpoints)
- **File:** `backend/app/api/routes/edit.py:65`
- **Router Level:** `APIRouter(dependencies=[Depends(require_license)])`
- **All Endpoints Protected:** Objects listing, delete, transform, text edit, add
- **Status:** [VERIFIED] ✅ PROTECTED

### Route 9–13: export.py
- **File:** `backend/app/api/routes/export.py:18`
- **Router Level:** `APIRouter(..., dependencies=[Depends(require_license)])`
- **Work:** PDF→image export
- **Status:** [VERIFIED] ✅ PROTECTED

### Route 14–28: imposition.py (15 endpoints)
- **File:** `backend/app/api/routes/imposition.py:16`
- **Router Level:** `APIRouter(..., dependencies=[Depends(require_license)])`
- **Work:** Imposition planning, NUP, sticker, unlock PDF, layer detection
- **Status:** [VERIFIED] ✅ PROTECTED

### Route 29–36: pdf_tools.py (8 endpoints)
- **File:** `backend/app/api/routes/pdf_tools.py:24`
- **Router Level:** `APIRouter(..., dependencies=[Depends(require_license)])`
- **Work:** Merge, split, rotate, compress PDF
- **Status:** [VERIFIED] ✅ PROTECTED

### Route 37–70: preflight.py (34 endpoints)
- **File:** `backend/app/api/routes/preflight.py:34`
- **Router Level:** `APIRouter(dependencies=[Depends(require_license)])`
- **Work:** Extensive preflight validation rules
- **Status:** [VERIFIED] ✅ PROTECTED

### Route 71: report.py — `/jobs/{job_id}/report`
- **File:** `backend/app/api/routes/report.py:94`
- **Method:** `GET`
- **Handler:** `download_pdf_report()`
- **License Check:** Line 95 — `license_info: dict = Depends(require_license)`
- **Work:** Generate PDF report (ReportLab)
- **Status:** [VERIFIED] ✅ PROTECTED

### Route 72–76: results.py (5 endpoints)
- **File:** `backend/app/api/routes/results.py:52-122`
- **Endpoints:** get_job_status, get_job_results, get_page_result, delete_job, serve_file
- **License Check:** All have `license_info: dict = Depends(require_license)`
- **Work:** Job status, results fetching, file serving
- **Status:** [VERIFIED] ✅ PROTECTED

### Route 77–79: system.py (3 endpoints)
- **File:** `backend/app/api/routes/system.py:14-93`
- **Endpoints:** gpu_status, install_gpu_plugin, recover_stuck_jobs
- **License Check:** All have `license_info: dict = Depends(require_license)`
- **Work:** GPU acceleration config, job recovery
- **Status:** [VERIFIED] ✅ PROTECTED

### Route 80: upload.py — `/upload`
- **File:** `backend/app/api/routes/upload.py:24`
- **Method:** `POST`
- **Handler:** `upload_pdf()`
- **License Check:** Line 28 — `license_info: dict = Depends(require_license)`
- **Work:** PDF/image file upload with metadata extraction
- **Status:** [VERIFIED] ✅ PROTECTED

### Route 81–85: vdp.py (5 endpoints)
- **File:** `backend/app/api/routes/vdp.py:87-269`
- **Endpoints:** generate, status, download, upload, fonts
- **License Check:** All have `license_info: dict = Depends(require_license)`
- **Work:** Variable data printing (merge template + data)
- **Status:** [VERIFIED] ✅ PROTECTED

### Route 86: ws.py — `/ws/jobs/{job_id}/progress`
- **File:** `backend/app/api/routes/ws.py:17`
- **Method:** `WebSocket`
- **Handler:** `job_progress_ws()`
- **License Check:** Line 34 — `verify_sidecar_signature()` call
- **Work:** Real-time job progress streaming (Redis pub/sub or DB polling)
- **Security:** Uses HMAC-SHA256 signature (30-second window, replay-protected)
- **DEV_MODE Risk:** Returns True immediately if DEV_MODE=true (@license_guard.py:154)
- **Mitigation:** Binary forced DEV_MODE=false (Nuitka check @license_guard.py:67)
- **Status:** [VERIFIED] ✅ PROTECTED (production), [SUSPECTED] ⚠️ DEVMODE BYPASS (if enabled)

### Route 87: main.py — `/health`
- **File:** `backend/app/main.py:189`
- **Method:** `GET`
- **Handler:** `health_check()`
- **License Check:** NONE
- **Work:** Returns `{"status": "ok", "app": "PrynX"}` — informational only
- **Threat:** Not a bypass; no PDF operations
- **Status:** [VERIFIED] 🟢 VÔHẠI (harmless)

---

