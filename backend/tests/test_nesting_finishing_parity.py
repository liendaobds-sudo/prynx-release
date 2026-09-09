"""Gia công của nhánh nesting — đối chiếu trên FILE THẬT của khách.

FIX (audit 2026-08-28 §NEST-FINISHING). Đây là test sinh ra từ một lỗi đã giao ra người
dùng, nên nó cố ý dùng ``test/test nesting.pdf`` chứ **không** dùng fixture tự dựng.

## Vì sao fixture tự dựng không bắt được lỗi

Lô nối dây đầu chỉ map **hình học** (khổ tờ, lề, khoảng hở, số lượng). Mọi thiết lập gia
công rơi về mặc định, nên tờ bình ra:

- **không có ốc bế** (`ImpositionPontSpec.type` mặc định `"none"`);
- **không có dấu xén** (`ImpositionTrimSpec.type` mặc định `"none"`);
- **không có report**;
- và **đường bế bị in lên trang in**, vì renderer paint nguyên trang nguồn mà nguồn tem bế
  mang nét CutContour trong chính artwork.

Fixture của tôi là khuôn vuông vẽ tay, không có ốc, không có dấu xén, không cấu hình
report — nên **mọi assert đều xanh trên một tờ bình thiếu hết gia công**. Đúng cái bẫy
`prynx-dieline` cảnh báo.

Thêm một lỗi cùng loại ở nhánh tự lấp đầy tờ: `pages` bị viết cứng `[0]`, nên khách ghép 13
mẫu và để trống SL thì nhận tờ bình **chỉ có mẫu đầu tiên**, 12 mẫu còn lại bị bỏ im lặng.
"""

from __future__ import annotations

from pathlib import Path

import pikepdf
import pytest

SOURCE = Path(__file__).resolve().parents[2] / "test" / "test nesting.pdf"

requires_real_source = pytest.mark.skipif(
    not SOURCE.is_file(), reason=f"thiếu file nguồn thật: {SOURCE}"
)


def _settings(**overrides):
    """Thiết lập đúng như `processHandlers` gửi cho một job tem bế có gia công đủ."""

    base = {
        "gridStrategy": "true_shape_nesting",
        "isDieCutMode": True,
        "sheetWidth": 320.0,
        "sheetHeight": 430.0,
        "gapX": 2.0,
        "gapY": 2.0,
        "marginLeft": 5.0,
        "marginRight": 5.0,
        "marginTop": 5.0,
        "marginBottom": 5.0,
        # SL để trống = "tự lấp đầy tờ", đúng ca người dùng gặp lỗi.
        "targetQuantitiesByPage": {str(index): 0 for index in range(13)},
        "detectedShapesByPage": {str(index): "CUSTOM" for index in range(13)},
        # ── Gia công ──
        "pontType": "custom",
        "pontConfig": {
            "shape": "circle",
            "size": 5.0,
            "thickness": 0.5,
            "isGraphtec": False,
            "layerInfoName": "SA info",
            "layerName": "Pont",
            "groupName": "G",
            "itemName": "I",
            "disableCollision": False,
            # FIX (audit 2026-08-28 §NEST-FINISHING-KEYS): fixture cũ dùng
            # `guide1Position`/`guide1OffsetX` — KHÔNG phải tên khoá thật. Vì bản hiện thực
            # cũng đọc sai y như vậy nên hai bên khớp và test xanh trong khi guide chưa bao
            # giờ tới được tờ in thật. Tên thật lấy từ
            # `desktop/src/components/imposition-tools/types.ts` và
            # `backend/app/schemas/pont.py`: `Enabled`/`Pos`/`OffX`/`OffY`.
            "guide1Enabled": True,
            "guide1Pos": "TL",
            "guide1Length": 20.0,
            "guide1Thickness": 0.5,
            "guide1OffX": 1.5,
            "guide1OffY": 2.5,
            # Guide 2 khai đủ nhưng TẮT: khoá luôn việc cờ `Enabled` được tôn trọng.
            "guide2Enabled": False,
            "guide2Pos": "BR",
            "guide2Length": 20.0,
            "guide2Thickness": 0.5,
        },
        "separateCutPage": True,
        "cutType": "default",
        "dieSizeMode": "die",
        "dieOffsetMm": 0.0,
        "fillBlockGap": 0.0,
        "pontsOnCutFile": True,
        "markType": "corners",
        "markLength": 5.0,
        "markOffset": 3.0,
        "markThickness": 0.25,
        "markStyle": "default",
        "exportUniqueSheets": True,
        "reportDisplay": {
            "enabled": True,
            "fieldOrder": ["orderCode", "labelName", "material"],
            "labelNameText": "YEAY",
        },
        "reportMaterial": "Decal",
        "reportLamination": 1,
        "reportLaminationSides": 1,
        "reportOrderCode": "DH-001",
    }
    base.update(overrides)
    return base


def _job(**overrides):
    from app.workers.nup_true_shape_nesting import build_true_shape_nesting_job

    return build_true_shape_nesting_job(
        str(SOURCE), _settings(**overrides), job_id="parity01"
    )


# ── 1. Mọi mẫu phải lên tờ, không chỉ mẫu đầu ────────────────────────────────

@requires_real_source
@pytest.mark.parametrize("tool", ["sticker", "cnc"])
def test_sr_file_that_giu_layer_sau_ghep_cac_mau(tmp_path, monkeypatch, tool):
    """File khách → solve/render thật → ghép S&R vẫn đủ cây boong mỗi mẫu."""
    from app.workers.nup_true_shape_nesting import run_true_shape_nesting
    from app.core.nesting_manifest_store import NestingManifestStore

    monkeypatch.setenv("PRYNX_TRUE_SHAPE_NESTING_ENABLED", "true")
    store = NestingManifestStore(root=tmp_path / "manifests")

    settings = _settings(
        taskMode="step_repeat",
        layoutType="repeat",
        imposerMode=tool,
        targetQuantitiesByPage={"0": 1, "2" if tool == "cnc" else "1": 1},
    )
    settings["pontConfig"].update({
        "isGraphtec": True,
        "layerInfoName": "SA info PROBE",
        "layerName": "Marks_Model_",
        "groupName": "MarkLine",
        "itemName": "MKLINE",
    })
    output = tmp_path / f"sr-{tool}.pdf"
    run_true_shape_nesting(str(SOURCE), str(output), settings, store=store)
    with pikepdf.open(output) as pdf:
        assert len(pdf.pages) == 4
        ocgs = pdf.Root.OCProperties.OCGs
        assert [str(ref.Name) for ref in ocgs] == [
            "SA info PROBE", "Marks_Model_", "MarkLine",
        ] * 2
        assert len({ref.objgen for ref in ocgs}) == 6
        for sheet in range(2):
            group = ocgs[sheet * 3 + 2]
            order = pdf.Root.OCProperties.D.Order
            assert order[sheet * 3 + 2][0].objgen == group.objgen
            marked_pages = (sheet * 2, sheet * 2 + 1) if tool == "cnc" else (sheet * 2 + 1,)
            for page_index in marked_pages:
                props = pdf.pages[page_index].obj.Resources.Properties
                assert props.MC_PONT_GROUP.objgen == group.objgen
                assert str(props.NM_PONT_ITEM.NM) == "MKLINE"
        assert pdf.check_pdf_syntax() == []


@requires_real_source
def test_tu_lap_day_to_lay_du_moi_mau():
    """13 mẫu, SL để trống ⇒ job phải có 13 mẫu.

    Bản đầu viết cứng `pages = [0]` nên chỉ mẫu đầu lên tờ. Preview vẫn hiện đủ 13 vì nó
    đi đường lưới cũ, nên lệch càng khó phát hiện.
    """

    job = _job()

    assert job.layout_intent == "autofill_single_sheet"
    assert len(job.parts) == 13, "tự lấp đầy tờ phải nhận MỌI mẫu"
    assert all(part.quantity is None for part in job.parts)


@requires_real_source
def test_so_luong_khai_tuong_minh_thi_theo_dung_khai():
    """Có SL thì chỉ lấy trang có SL > 0 — không kéo cả 13 mẫu vào."""

    job = _job(targetQuantitiesByPage={"0": 10, "3": 4})

    assert job.layout_intent == "quantity_fulfillment"
    assert [part.page_index for part in job.parts] == [0, 3]
    assert [part.quantity for part in job.parts] == [10, 4]


# ── 2. Gia công phải tới được job ────────────────────────────────────────────

@requires_real_source
def test_oc_be_toi_duoc_job():
    """Thiếu ốc là tờ bình không dùng được — đây là phần khách phát hiện đầu tiên."""

    job = _job()

    assert job.pont.type == "custom"
    assert job.pont.config is not None
    assert job.pont.config.shape == "circle"
    assert job.pont.config.size_mm == 5.0
    assert job.pont.config.thickness_mm == 0.5
    # Guide 1 bật, guide 2 khai đủ nhưng TẮT ⇒ đúng một guide, và độ lệch phải tới.
    assert len(job.pont.config.guides) == 1
    guide = job.pont.config.guides[0]
    assert guide.position == "TL"
    assert guide.offset_x_mm == 1.5
    assert guide.offset_y_mm == 2.5


@requires_real_source
def test_thieu_pont_config_thi_khong_gia_lap_oc():
    """`pontType` có mà `pontConfig` thiếu ⇒ không ốc, và không được ném lỗi."""

    job = _job(pontType="custom", pontConfig=None)

    assert job.pont.type == "none"
    assert job.pont.config is None


@requires_real_source
def test_pont_lay_le_to_khi_cau_hinh_khong_khai_le():
    """Hợp đồng rút gọn: thiếu lề ốc thì dùng lề tờ."""

    job = _job(marginLeft=7.0, marginTop=9.0)

    assert job.pont.config.margin_left_mm == 7.0
    assert job.pont.config.margin_top_mm == 9.0


@requires_real_source
def test_dau_xen_khong_toi_job_vi_ngoai_pham_vi():
    """FIX (audit 2026-08-28 §NEST-TRIM-OUT-OF-SCOPE): test này trước đây khẳng định
    ``trim.type == 'corners'`` — tức khẳng định một hành vi **sai**.

    Lane lưới không vẽ dấu xén cho die-cut (`nup_process_chunk.py:1059`), và UI không cho
    bật (`IMPOSER_CAPABILITIES`: `diecut`/`cnc` đều `supportsMarks: false`). Tem bế do dao
    cắt, dấu xén trên tờ là dấu vô nghĩa mà thợ dễ hiểu thành đường cắt.

    Fixture của file này khai `markType='corners'` để mô phỏng payload dựng tay; job phải
    ép về `none`. Lý luận đầy đủ và các test đơn vị ở
    `test_nup_nesting_finishing_keys.py`.
    """

    job = _job()

    assert job.trim.type == "none"


@requires_real_source
def test_trang_cut_rieng_toi_duoc_job():
    """Dao nằm trên trang in là tờ bình không dùng được."""

    job = _job()

    assert job.cut.separate_page is True
    assert job.cut.ponts_on_cut_file is True
    assert job.cut.die_size_mode == "die"


def test_mot_dao_luon_ep_tach_trang():
    """`one_dao` thuộc lane lưới cũ nhưng vẫn phải ép tách trang CUT.

    True-shape cố ý fail-closed cho 1 Dao vì đây là bài toán cắt chữ nhật. Vì vậy
    kiểm hợp đồng gia công ở helper canonical, không gọi nhầm builder true-shape.
    """
    from app.workers.nup_nesting_finishing import build_cut_spec

    cut = build_cut_spec(_settings(cutType="one_dao", separateCutPage=False))

    assert cut.type == "one_dao"
    assert cut.separate_page is True


@requires_real_source
def test_report_toi_duoc_job():
    job = _job()

    report = job.artifact_options.report
    assert report.enabled is True
    assert report.fields == ("orderCode", "labelName", "material")
    assert report.label_name == "YEAY"
    assert report.material == "Decal"
    assert report.lamination.type == "gloss"
    assert report.order_code == "DH-001"
    assert job.artifact_options.export_unique_sheets is True


@requires_real_source
def test_report_tat_thi_khong_ve():
    job = _job(reportDisplay={"enabled": False, "fieldOrder": ["orderCode"]})

    assert job.artifact_options.report.enabled is False


# ── 3. Đường bế KHÔNG được nằm trên trang in ─────────────────────────────────

@pytest.fixture
def _env(monkeypatch, tmp_path):
    from app.core.nesting_preview_session import reset_preview_session_store

    monkeypatch.setattr(
        "app.core.nesting_rollout.true_shape_nesting_enabled", lambda: True
    )
    monkeypatch.setenv("PRYNX_MIXED_NESTING_DATA_DIR", str(tmp_path / "artifacts"))
    reset_preview_session_store()
    yield
    reset_preview_session_store()


@requires_real_source
def test_biến_thể_tach_net_be_phai_materialize_that():
    """Không được đổi cache key để giả lập tách CUT — writer chặn đúng.

    Guard này có sẵn trong `imposition_pdf_form` từ trước, và nó đúng: tách "giả" là
    chính lỗi đã giao ra người dùng.
    """

    from app.workers.imposition_pdf_form import (
        DIE_STRIPPED_FORM_VARIANT,
        ManifestPdfFormError,
    )

    assert DIE_STRIPPED_FORM_VARIANT != "artwork-raw"

    from app.workers.imposition_pdf_form import _die_strip_target

    # Spot: đúng tiêu chí lane cũ dùng.
    assert _die_strip_target({"mode": "spot", "spotNames": ["cutcontour"]}) == (
        None,
        "cutcontour",
    )
    # Process: đổi thành tuple màu.
    assert _die_strip_target(
        {"mode": "process", "processColor": {"space": "cmyk", "components": [0, 1, 0, 0]}}
    ) == ((0.0, 1.0, 0.0, 0.0), None)

    for bad in (
        {"mode": "spot", "spotNames": []},
        {"mode": "spot", "spotNames": [""]},
        {"mode": "process"},
        {"mode": "process", "processColor": {"space": "cmyk", "components": []}},
        {"mode": "khong-ton-tai"},
    ):
        with pytest.raises(ManifestPdfFormError):
            _die_strip_target(bad)


@requires_real_source
def test_net_be_khong_con_tren_trang_in(tmp_path, _env):
    """Chốt cuối: trang in KHÔNG còn kênh nét bế, trang CUT thì phải có.

    Đây là điều khách nhìn thấy trực tiếp — "đường bế vẫn nằm bên trang in".
    """

    from app.workers.nup_true_shape_nesting import run_true_shape_nesting

    output = tmp_path / "co-gia-cong.pdf"
    run_true_shape_nesting(
        str(SOURCE),
        str(output),
        _settings(targetQuantitiesByPage={"0": 4}, detectedShapesByPage={"0": "CUSTOM"}),
        "parity01",
    )

    assert output.is_file()
    with pikepdf.Pdf.open(str(output)) as pdf:
        assert len(pdf.pages) >= 2, "phải có trang in và trang CUT riêng"
        front_strokes = _artwork_stroke_ops(pdf.pages[0])

    # Assert theo MỰC, không theo resource: entry `/ColorSpace` còn sót là vô hại vì
    # không toán tử nào dùng tới. Đo được trên nguồn khách: trước tách có 1 toán tử `S`
    # dùng kênh CutContour, sau tách còn 0.
    assert front_strokes == 0, (
        f"trang in vẫn còn {front_strokes} nét stroke của artwork — đường bế chưa bị tách"
    )


def _artwork_stroke_ops(page) -> int:
    """Đếm toán tử stroke trong mọi Form artwork mà trang tham chiếu."""

    import re

    total = 0
    seen: set[int] = set()

    def walk(resources, depth: int = 0) -> None:
        nonlocal total
        if resources is None or depth > 6:
            return
        try:
            xobjects = resources.get("/XObject")
        except Exception:
            return
        if xobjects is None:
            return
        for _name, child in xobjects.items():
            try:
                if "/Form" not in str(child.get("/Subtype", "")):
                    continue
                key = id(child)
                if key in seen:
                    continue
                seen.add(key)
                text = child.read_bytes().decode("latin-1")
            except Exception:
                continue
            total += len(re.findall(r"(?:^|\n)S(?:\n|$)", text))
            walk(child.get("/Resources"), depth + 1)

    walk(page.obj.get("/Resources"))
    return total
