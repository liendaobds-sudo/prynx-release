"""
PDF/X Export Engine — Xuất PDF chuẩn PDF/X-1a hoặc PDF/X-4.

Chức năng tương đương Acrobat Pro → Print Production → Save as PDF/X.
"""
import os
import asyncio
import logging
import threading
import uuid
from pathlib import Path

import pikepdf

from app.config import settings
from app.core.engine_support import (
    InternalEngineUnsupported,
    unsupported_message,
)

logger = logging.getLogger(__name__)

# Namespace định danh PDF/X trong XMP (ISO 15930-7 §6.2).
_PDFX_ID_NS = "http://www.npes.org/pdfx/ns/id/"


def _remove_file_quietly(path: str) -> None:
    try:
        if os.path.isfile(path):
            os.remove(path)
    except OSError:
        pass


def _raise_if_cancelled(cancel_check) -> None:
    if cancel_check is not None and cancel_check():
        raise InterruptedError("Tác vụ xuất PDF/X đã bị hủy.")


def _validate_staged_pdfx(
    input_path: str,
    staged_path: str,
    cancel_event: threading.Event,
) -> None:
    """Hậu kiểm tối thiểu trước khi công bố file PDF/X bằng rename atomic."""
    _raise_if_cancelled(cancel_event.is_set)
    if not os.path.isfile(staged_path) or os.path.getsize(staged_path) == 0:
        raise ValueError("Engine không tạo được file PDF/X hợp lệ.")
    with pikepdf.open(input_path) as source, pikepdf.open(staged_path) as staged:
        if len(source.pages) != len(staged.pages):
            raise ValueError(
                "Số trang PDF/X không khớp file nguồn "
                f"({len(staged.pages)} != {len(source.pages)})."
            )
    _raise_if_cancelled(cancel_event.is_set)


def _ensure_trimbox(pdf_path: str) -> int:
    """Đặt `/TrimBox = /CropBox` (hoặc `/MediaBox`) cho trang chưa khai. Trả số trang đã sửa.

    Ưu tiên CropBox: nếu file đã cắt hiển thị thì vùng cắt thành phẩm nằm trong
    đó, lấy MediaBox sẽ rộng hơn thực tế.
    """
    fixed = 0
    with pikepdf.open(pdf_path, allow_overwriting_input=True) as pdf:
        for page in pdf.pages:
            if page.get("/TrimBox") is not None or page.get("/ArtBox") is not None:
                continue
            box = page.get("/CropBox") or page.get("/MediaBox")
            if box is None:
                continue
            page["/TrimBox"] = pikepdf.Array([*box])
            fixed += 1
        if fixed:
            pdf.save(pdf_path)
    return fixed


def _attach_output_intent(
    pdf_path: str, icc_path: str, cond_id: str, cond_name: str
) -> None:
    """Gắn `/OutputIntents` với ICC nhúng bằng pikepdf.

    OutputIntent phải mang **profile nhúng thật** (`/DestOutputProfile`), không
    chỉ tên điều kiện: nhà in cần chính bảng màu đó để soft-proof lại, và một
    OutputIntent trỏ vào profile họ không có là lời khai rỗng.
    """
    with open(icc_path, "rb") as fh:
        icc_bytes = fh.read()

    with pikepdf.open(pdf_path, allow_overwriting_input=True) as pdf:
        icc_stream = pdf.make_stream(icc_bytes)
        icc_stream["/N"] = 4  # CMYK
        intent = pdf.make_indirect(
            pikepdf.Dictionary(
                Type=pikepdf.Name("/OutputIntent"),
                S=pikepdf.Name("/GTS_PDFX"),
                OutputCondition=pikepdf.String(cond_name),
                OutputConditionIdentifier=pikepdf.String(cond_id),
                RegistryName=pikepdf.String("http://www.color.org"),
                Info=pikepdf.String(cond_name),
                DestOutputProfile=icc_stream,
            )
        )
        pdf.Root["/OutputIntents"] = pikepdf.Array([intent])
        # PDF/X đòi khai tình trạng bẫy chồng màu; không khai là thiếu mục bắt
        # buộc. `False` là mặc định trung thực — file chưa qua bước trapping.
        if pdf.docinfo is None:
            pdf.docinfo = pikepdf.Dictionary()
        if "/Trapped" not in pdf.docinfo:
            pdf.docinfo["/Trapped"] = pikepdf.Name("/False")
        pdf.docinfo["/GTS_PDFXVersion"] = pikepdf.String("PDF/X-4")
        pdf.save(pdf_path)


def _finalize_pdfx4_identification(pdf_path: str) -> None:
    """Bổ sung định danh XMP và phiên bản bắt buộc của PDF/X-4.

    PDF/X-4 (ISO 15930-7) đòi PDF **1.6** và định danh nằm trong **XMP**
    (`pdfxid:GTS_PDFXVersion`), không chỉ trong Info dict.

    Hệ quả nếu bỏ qua: file khai "PDF/X-4" mà cấu trúc là X-3 và thiếu XMP —
    validator sẽ từ chối, và một file khai sai chuẩn còn tệ hơn file không
    khai gì, vì nhà in tin lời khai rồi mới phát hiện trên máy.

    Bước này chỉ **thêm định danh**, không đụng nội dung trang; lỗi ở đây
    không được làm hỏng file đã xuất nên chỉ cảnh báo.
    """
    try:
        with pikepdf.open(pdf_path, allow_overwriting_input=True) as pdf:
            with pdf.open_metadata(set_pikepdf_as_editor=False) as meta:
                meta[f"{{{_PDFX_ID_NS}}}GTS_PDFXVersion"] = "PDF/X-4"
            # Info dict giữ nguyên: Acrobat vẫn đọc nó, và X-1a/X-3 dùng nó.
            pdf.save(pdf_path, min_version="1.6")
    except Exception as exc:  # noqa: BLE001
        logger.warning("PDF/X-4: không ghi được định danh XMP/version: %s", exc)

class PdfxExportEngine:

    def __init__(self):
        self.output_dir = Path(settings.RESULTS_DIR) / "preflight_output"
        self.output_dir.mkdir(parents=True, exist_ok=True)
        # Cảnh báo + engine của lần xuất gần nhất, để route trả kèm file.
        # Bước object-level có thể ĐẶT TrimBox thay người dùng; im lặng ở đây
        # là để họ gửi nhà in một file bị xén nhầm.
        self.last_warnings: list[str] = []
        self.last_engine: str | None = None

    def check_compliance(self, file_path: str, standard: str = "x4") -> dict:
        """
        Kiểm tra file hiện tại có đạt chuẩn PDF/X chưa.
        standard: 'x1a' | 'x4'
        Returns: dict with checks and overall pass/fail.
        """
        doc = pikepdf.Pdf.open(file_path)
        checks = []

        # 1. Check fonts embedded
        fonts_ok = True
        unembed_fonts = []
        for page_idx in range(len(doc.pages)):
            page = doc.pages[page_idx]
            # Scan font resources
            try:
                resources = page.get("/Resources")
                if resources and "/Font" in resources:
                    fonts_dict = resources["/Font"]
                    for font_name in fonts_dict:
                        font_obj = fonts_dict[font_name]
                        if isinstance(font_obj, pikepdf.Object):
                            font_obj = font_obj.resolve() if hasattr(font_obj, 'resolve') else font_obj
                        # Check if font has embedded stream (FontFile/FontFile2/FontFile3)
                        desc = font_obj.get("/FontDescriptor") if hasattr(font_obj, 'get') else None
                        if desc:
                            if isinstance(desc, pikepdf.Object) and hasattr(desc, 'resolve'):
                                desc = desc.resolve()
                            has_file = any(k in desc for k in ["/FontFile", "/FontFile2", "/FontFile3"]) if hasattr(desc, '__contains__') else False
                            if not has_file:
                                fonts_ok = False
                                fname = str(font_obj.get("/BaseFont", font_name))
                                if fname not in unembed_fonts:
                                    unembed_fonts.append(fname)
            except Exception:
                pass
        checks.append({
            "id": "FONTS_EMBEDDED",
            "label": "Font đã nhúng",
            "passed": fonts_ok,
            "detail": f"Font chưa nhúng: {', '.join(unembed_fonts)}" if not fonts_ok else "Tất cả font đã nhúng"
        })

        # 2. Check TrimBox exists
        has_trimbox = True
        for page_idx in range(len(doc.pages)):
            page = doc.pages[page_idx]
            page_str = str(page.obj)
            if "/TrimBox" not in page_str:
                has_trimbox = False
                break
        checks.append({
            "id": "TRIMBOX_EXISTS",
            "label": "TrimBox đã thiết lập",
            "passed": has_trimbox,
            "detail": "TrimBox có trên tất cả trang" if has_trimbox else "Một số trang thiếu TrimBox"
        })

        # 3. Check color spaces (only for X-1a)
        has_rgb = False
        if standard == "x1a":
            for page_idx in range(min(len(doc.pages), 10)):  # Sample first 10 pages
                page = doc.pages[page_idx]
                page_str = str(page.obj)
                if "/DeviceRGB" in page_str or "/CalRGB" in page_str or "/ICCBased" in page_str:
                    has_rgb = True
                    break
            checks.append({
                "id": "CMYK_ONLY",
                "label": "Chỉ sử dụng CMYK",
                "passed": not has_rgb,
                "detail": "Phát hiện RGB, cần convert sang CMYK" if has_rgb else "Chỉ có CMYK"
            })

        # 4. Check transparency (only for X-1a, must be flattened)
        has_transparency = False
        if standard == "x1a":
            for page_idx in range(len(doc.pages)):
                page = doc.pages[page_idx]
                page_str = str(page.obj)
                if "/Group" in page_str and "/Transparency" in page_str:
                    has_transparency = True
                    break
            checks.append({
                "id": "NO_TRANSPARENCY",
                "label": "Không có Transparency",
                "passed": not has_transparency,
                "detail": "Phát hiện Transparency, cần flatten" if has_transparency else "Không có Transparency"
            })

        # 5. Check OutputIntent
        catalog = str(doc.Root)
        has_output_intent = "/OutputIntents" in catalog
        checks.append({
            "id": "OUTPUT_INTENT",
            "label": "Output Intent (ICC Profile)",
            "passed": has_output_intent,
            "detail": "Đã gắn Output Intent" if has_output_intent else "Chưa có Output Intent"
        })

        # 6. PDF version check
        pdf_version = str(doc.pdf_version)
        checks.append({
            "id": "PDF_VERSION",
            "label": "Phiên bản PDF",
            "passed": True,  # bước xuất tự nâng version cho đúng chuẩn
            "detail": pdf_version or "Không xác định"
        })

        # 7. Định danh PDF/X — chỗ khác nhau giữa hai chuẩn và là chỗ dễ khai sai.
        #
        # X-1a/X-3 (PDF 1.3/1.4) đặt `/GTS_PDFXVersion` trong **Info dict**;
        # X-4 (ISO 15930-7) đòi PDF **1.6** và định danh trong **XMP**
        # (`pdfxid:GTS_PDFXVersion`). Kiểm cả hai vì một file khai sai chuẩn
        # còn tệ hơn file không khai: nhà in tin lời khai rồi mới phát hiện
        # trên máy in.
        if standard == "x1a":
            info_ver = None
            try:
                info_ver = str(doc.docinfo.get("/GTS_PDFXVersion", "")) if doc.docinfo else ""
            except Exception:  # noqa: BLE001
                info_ver = ""
            # X-1a đòi PDF 1.3: chính phiên bản đó mới bảo đảm không còn trong
            # suốt (PDF 1.3 không có khái niệm này). Khai X-1a trên file 1.6 là
            # mâu thuẫn tự thân, nên phải kiểm cả hai.
            version_ok = pdf_version <= "1.4"
            checks.append({
                "id": "PDFX_IDENTIFICATION",
                "label": "Định danh PDF/X-1a (Info + version)",
                "passed": bool(info_ver and "PDF/X" in info_ver) and version_ok,
                "detail": (
                    f"Info={info_ver or 'thiếu'}, PDF {pdf_version}"
                    + ("" if version_ok else " — X-1a đòi ≤ 1.4")
                ),
            })
        else:
            xmp_ver = ""
            try:
                meta = doc.open_metadata()
                xmp_ver = str(meta.get(f"{{{_PDFX_ID_NS}}}GTS_PDFXVersion", "") or "")
            except Exception:  # noqa: BLE001
                xmp_ver = ""
            version_ok = pdf_version >= "1.6"
            checks.append({
                "id": "PDFX_IDENTIFICATION",
                "label": "Định danh PDF/X-4 (XMP + version)",
                "passed": bool(xmp_ver and "PDF/X-4" in xmp_ver) and version_ok,
                "detail": (
                    f"XMP={xmp_ver or 'thiếu'}, PDF {pdf_version}"
                    + ("" if version_ok else " — X-4 đòi ≥ 1.6")
                ),
            })

        doc.close()

        all_passed = all(c["passed"] for c in checks)
        return {
            "standard": standard,
            "standard_label": "PDF/X-1a" if standard == "x1a" else "PDF/X-4",
            "passed": all_passed,
            "checks": checks,
            "total_checks": len(checks),
            "passed_checks": sum(1 for c in checks if c["passed"]),
        }

    def _resolve_output_intent_icc(self):
        """Tìm ICC profile CMYK cho OutputIntent.
        Dùng cùng profile CMYK của app với separations, soft-proof và TAC.
        Trả (path, condition_id, condition_name) hoặc (None, None, None).
        """
        # OutputIntent khai điều kiện in của file, nên nó phải đúng profile mà
        # separations / soft-proof / TAC đã dùng để
        # kiểm — khai điều kiện khác là nói với nhà in một chuyện chưa được
        # kiểm chứng.
        try:
            from app.core import icc_profiles

            path = icc_profiles.resolve_cmyk_profile_path()
            if path and os.path.isfile(path):
                base = os.path.basename(path)
                if "fogra39" in base.lower():
                    return path, "FOGRA39", "Coated FOGRA39 (ISO 12647-2:2004)"
                return (
                    path,
                    os.path.splitext(base)[0],
                    f"{base} (profile CMYK của PrynX)",
                )
        except Exception as exc:  # noqa: BLE001
            logger.warning("PDF/X: không lấy được ICC CMYK của app: %s", exc)
        return None, None, None

    async def export_pdfx(self, file_path: str, standard: str = "x4") -> str:
        """
        Xuất file PDF chuẩn PDF/X.
        standard: 'x1a' | 'x4'

        PDF/X-4 đi đường **object-level** (pikepdf): X-4 cho phép
        giữ nguyên trong suốt và ICC, nên việc cần làm chỉ là quy đổi màu về
        CMYK, bảo đảm font nhúng, rồi gắn OutputIntent + định danh — cả ba đã có
        sẵn. File giữ nguyên vector/layer/spot ngoài các object cần quy đổi.

        PDF/X-1a flatten trong suốt qua PPE rồi hạ về PDF 1.3. Nếu engine nội bộ
        không chứng minh được compliance, tác vụ dừng và không giao file dở.
        """
        output_name = f"{Path(file_path).stem}_PDF-X_{standard}_{uuid.uuid4().hex[:6]}.pdf"
        output_path = str(self.output_dir / output_name)
        staged_path = str(
            self.output_dir
            / f".{Path(output_name).stem}.{uuid.uuid4().hex}.pending.pdf"
        )
        cancel_event = threading.Event()
        self.last_warnings = []
        self.last_engine = None

        try:
            async def run_worker_and_publish() -> bool:
                native_ok = await asyncio.to_thread(
                    self._export_x1a_native
                    if standard == "x1a"
                    else self._export_x4_native,
                    file_path,
                    staged_path,
                    cancel_check=cancel_event.is_set,
                )
                if not native_ok:
                    return False
                await asyncio.to_thread(
                    _validate_staged_pdfx,
                    file_path,
                    staged_path,
                    cancel_event,
                )
                _raise_if_cancelled(cancel_event.is_set)
                os.replace(staged_path, output_path)
                return True

            # PERF/CORRECTNESS (audit 2026-08-10 §PPE.REAUDIT.3): shield chỉ
            # ngăn asyncio đánh dấu Future thread là xong giả. Khi caller hủy,
            # token vẫn được gửi xuống worker và ta chờ nó đóng file thật.
            worker_task = asyncio.create_task(run_worker_and_publish())
            try:
                native_ok = await asyncio.shield(worker_task)
            except asyncio.CancelledError:
                cancel_event.set()
                try:
                    await asyncio.shield(worker_task)
                except BaseException:
                    pass
                _remove_file_quietly(staged_path)
                _remove_file_quietly(output_path)
                raise
            if native_ok:
                self.last_engine = "pikepdf"
                logger.info(f"Exported PDF/X-{standard} (pikepdf) → {output_path}")
                return output_path
        except Exception as exc:  # noqa: BLE001
            logger.warning("PDF/X object-level lỗi: %s", exc)
        finally:
            _remove_file_quietly(staged_path)

        # GS-SUNSET (audit 2026-08-08 §GS.2): native/PPE không chứng minh được
        # compliance thì dừng có chủ đích và xoá mọi output trung gian.
        _remove_file_quietly(output_path)
        self.last_engine = "none"
        raise InternalEngineUnsupported(
            unsupported_message(f"Xuất PDF/X-{standard.upper()}")
        )

    def _export_x1a_native(
        self,
        input_path: str,
        output_path: str,
        *,
        cancel_check=None,
    ) -> bool:
        """PDF/X-1a bằng pikepdf: flatten trong suốt rồi đi tiếp đường X-4.

        X-1a khác X-4 ở hai điểm: **không cho phép trong suốt** và **không cho
        ICC ngoài OutputIntent**. Điểm đầu nay xử lý được nhờ `flatten_transparency`
        (raster hoá qua PPE, có cảnh báo mất vector). Điểm thứ hai được thoả gián
        tiếp: `convert_to_cmyk` đã đưa mọi thứ về DeviceCMYK.

        Trả `False` khi PPE không xử lý chắc chắn được transparency.
        """
        import tempfile as _tempfile

        from app.core import pdf_actions_native

        _raise_if_cancelled(cancel_check)
        signs = pdf_actions_native.detect_transparency(
            input_path, cancel_check=cancel_check
        )
        source = input_path
        tmp_flat = None
        try:
            if signs:
                fd, tmp_flat = _tempfile.mkstemp(suffix="_flat.pdf", dir=str(self.output_dir))
                os.close(fd)
                flat = pdf_actions_native.flatten_transparency(
                    input_path,
                    tmp_flat,
                    300.0,
                    cancel_check=cancel_check,
                )
                if not flat.get("supported"):
                    return False
                self.last_warnings.extend(flat.get("warnings", []))
                source = tmp_flat

            _raise_if_cancelled(cancel_check)
            if not self._export_x4_native(
                source,
                output_path,
                version="1.3",
                cancel_check=cancel_check,
            ):
                return False
        finally:
            if tmp_flat and os.path.exists(tmp_flat):
                try:
                    os.remove(tmp_flat)
                except OSError:
                    pass

        # Định danh X-1a nằm ở Info dict (PDF 1.3 chưa dùng XMP cho việc này),
        # và bản thân **phiên bản PDF phải là 1.3**: đó là cách chuẩn bảo đảm
        # không còn trong suốt, vì PDF 1.3 không có khái niệm đó. Ghi 1.6 rồi
        # khai X-1a là mâu thuẫn tự thân — `force_version` mới hạ được (
        # `min_version` chỉ nâng lên).
        _raise_if_cancelled(cancel_check)
        with pikepdf.open(output_path, allow_overwriting_input=True) as pdf:
            pdf.docinfo["/GTS_PDFXVersion"] = pikepdf.String("PDF/X-1:2001")
            pdf.docinfo["/GTS_PDFXConformance"] = pikepdf.String("PDF/X-1a:2001")
            pdf.save(output_path, force_version="1.3")
        _raise_if_cancelled(cancel_check)
        return True

    def _export_x4_native(
        self,
        input_path: str,
        output_path: str,
        version: str = "1.6",
        *,
        cancel_check=None,
    ) -> bool:
        """PDF/X-4 bằng pikepdf. `False` nghĩa là phải dừng an toàn.

        Từ chối (chứ không cố sửa) khi file thiếu điều kiện mà bước này không
        đảm bảo nổi: font chưa nhúng, hoặc trang thiếu TrimBox/ArtBox. PDF/X đòi
        cả hai, và khai đạt chuẩn khi chưa đạt là kiểu sai tệ nhất ở đây.
        """
        from app.core import pdf_actions_native

        _raise_if_cancelled(cancel_check)
        icc_path, cond_id, cond_name = self._resolve_output_intent_icc()
        if not icc_path:
            logger.info("PDF/X-4 native: không có ICC cho OutputIntent")
            return False

        fonts = pdf_actions_native.analyze_font_embedding(input_path)
        _raise_if_cancelled(cancel_check)
        if not fonts.get("readable", True):
            logger.info("PDF/X native: không đọc được font của file")
            return False
        if fonts.get("missing"):
            logger.info(
                "PDF/X-4 native: còn font chưa nhúng (%s)",
                ", ".join(fonts["missing"][:4]),
            )
            return False

        # TrimBox/ArtBox: PDF/X bắt buộc phải có ít nhất một trong hai.
        # Đặt TrimBox = MediaBox là cách mọi công cụ prepress làm khi file không
        # khai, nhưng nó ngầm tuyên bố "trang này KHÔNG có bleed" — sai với file
        # thật sự có bleed. Vì vậy luôn kèm cảnh báo.
        pages_without_trim = 0
        with pikepdf.open(input_path) as probe:
            for page in probe.pages:
                _raise_if_cancelled(cancel_check)
                if page.get("/TrimBox") is None and page.get("/ArtBox") is None:
                    pages_without_trim += 1
        if pages_without_trim:
            self.last_warnings.append(
                f"{pages_without_trim} trang không khai TrimBox — đã đặt TrimBox = khổ "
                "trang để đạt PDF/X. NẾU file có bleed thì TrimBox này SAI (sẽ xén vào "
                "phần bleed); hãy đặt TrimBox đúng rồi xuất lại."
            )

        # Quy đổi màu về CMYK. `supported=False` nghĩa là object-level chưa xử
        # lý chắc chắn được cấu trúc màu của file.
        srgb = None
        try:
            from app.core import icc_profiles

            srgb = icc_profiles.resolve_srgb_profile_path()
        except Exception:  # noqa: BLE001
            srgb = None
        if not srgb:
            return False

        conv = pdf_actions_native.convert_to_cmyk(
            input_path,
            output_path,
            icc_path,
            srgb,
            cancel_check=cancel_check,
        )
        if not conv.get("supported"):
            logger.info(
                "PDF/X-4 native: không quy đổi được màu (%s)",
                "; ".join(conv.get("blockers", [])),
            )
            return False

        _raise_if_cancelled(cancel_check)
        if pages_without_trim:
            _ensure_trimbox(output_path)
            _raise_if_cancelled(cancel_check)
        _attach_output_intent(output_path, icc_path, cond_id, cond_name)
        _raise_if_cancelled(cancel_check)
        if version == "1.6":
            _finalize_pdfx4_identification(output_path)
        _raise_if_cancelled(cancel_check)
        return True
