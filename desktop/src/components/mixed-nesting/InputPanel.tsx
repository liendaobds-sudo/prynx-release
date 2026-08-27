/**
 * Panel tham số của "Bình lồng ghép tự do" — phase P10, chỉnh lại theo bộ khung Bình tem bế.
 *
 * Kế hoạch: `docs/KE_HOACH_MIXED_TRUE_SHAPE_NESTING_DOC_LAP_2026-08-26.md` §6.4, §14, §15.
 *
 * Ba điểm đáng nêu:
 *
 * 1. **`fast/balanced/tight` được mô tả đúng bản chất**: chúng chỉ đổi *lượng công tìm
 *    kiếm*. Copy tuyệt đối không được ám chỉ profile thu hẹp miền góc — đó là điều kế
 *    hoạch cấm, và copy sai sẽ dạy người dùng một mô hình sai.
 * 2. **"Giới hạn thời gian" là tùy chọn.** Không đặt thì engine chạy work-plan cố định và
 *    kết quả **tái lập được**; đặt thì chỉ cam kết phương án tốt nhất tới lúc hết hạn.
 * 3. **Không có control nào sinh mirror/scale/bước góc/lưới toạ độ.**
 *
 * Hình thức đi theo panel phải của Bình tem bế: nhãn in hoa cỡ 11 rộng 95px, control cao
 * 8, nhóm cách nhau bằng `Divider`, mô tả cỡ 11 màu slate-500. Xem
 * `imposition-tools/sections/GridSettingsSection.tsx` là bản gốc của khuôn này.
 */

import { useTranslation } from 'react-i18next';

import { switchRotationMode } from '../../lib/mixed-nesting/rotationEditing';
import type {
  JobRotationConstraint,
  MixedNestingProfile,
  SheetSpec,
} from '../../lib/mixed-nesting/types';
import {
  Accordion,
  Checkbox,
  Divider,
  GroupLabel,
  NumberField,
  PanelNote,
  SelectField,
} from './PanelPrimitives';

export interface InputPanelProps {
  sheet: SheetSpec;
  gapMm: number;
  profile: MixedNestingProfile;
  seed: number;
  timeBudgetMs: number | null;
  defaultRotation: JobRotationConstraint;
  disabled?: boolean;
  onSheetChange: (patch: Partial<SheetSpec>) => void;
  onMarginChange: (patch: Partial<SheetSpec['marginMm']>) => void;
  onGapChange: (value: number) => void;
  onProfileChange: (value: MixedNestingProfile) => void;
  onSeedChange: (value: number) => void;
  onTimeBudgetChange: (value: number | null) => void;
  onDefaultRotationChange: (value: JobRotationConstraint) => void;
}

const PROFILE_ORDER: readonly MixedNestingProfile[] = ['fast', 'balanced', 'tight'];
const MARGIN_SIDES = ['left', 'right', 'top', 'bottom'] as const;

export default function InputPanel({
  sheet,
  gapMm,
  profile,
  seed,
  timeBudgetMs,
  defaultRotation,
  disabled,
  onSheetChange,
  onMarginChange,
  onGapChange,
  onProfileChange,
  onSeedChange,
  onTimeBudgetChange,
  onDefaultRotationChange,
}: InputPanelProps) {
  const { t } = useTranslation();
  const usableWidth = sheet.widthMm - sheet.marginMm.left - sheet.marginMm.right;
  const usableHeight = sheet.heightMm - sheet.marginMm.top - sheet.marginMm.bottom;
  const usableOk = usableWidth > 0 && usableHeight > 0;

  const marginLabel: Record<(typeof MARGIN_SIDES)[number], string> = {
    left: t('mixedNesting.inputPanel:le_trai'),
    right: t('mixedNesting.inputPanel:le_phai'),
    top: t('mixedNesting.inputPanel:le_tren'),
    bottom: t('mixedNesting.inputPanel:le_duoi'),
  };

  return (
    <div className="flex flex-col gap-3" data-testid="mn-input-panel">
      {/* ── Khổ tờ ── */}
      <GroupLabel>{t('mixedNesting.inputPanel:kho_to')}</GroupLabel>
      <NumberField
        label={t('mixedNesting.inputPanel:rong')}
        unit="mm"
        value={sheet.widthMm}
        min={1}
        disabled={disabled}
        onChange={(value) => onSheetChange({ widthMm: value })}
      />
      <NumberField
        label={t('mixedNesting.inputPanel:cao')}
        unit="mm"
        value={sheet.heightMm}
        min={1}
        disabled={disabled}
        onChange={(value) => onSheetChange({ heightMm: value })}
      />
      <NumberField
        label={t('mixedNesting.inputPanel:so_to_toi_da')}
        value={sheet.maxSheets}
        min={1}
        integer
        disabled={disabled}
        onChange={(value) => onSheetChange({ maxSheets: Math.max(1, value) })}
      />

      <Divider />

      {/* ── Lề và khoảng hở ── */}
      <GroupLabel>{t('mixedNesting.inputPanel:le_to_va_khoang_ho')}</GroupLabel>
      {MARGIN_SIDES.map((side) => (
        <NumberField
          key={side}
          label={marginLabel[side]}
          unit="mm"
          value={sheet.marginMm[side]}
          min={0}
          disabled={disabled}
          onChange={(value) => onMarginChange({ [side]: value })}
        />
      ))}
      <NumberField
        label={t('mixedNesting.inputPanel:khoang_ho')}
        unit="mm"
        value={gapMm}
        min={0}
        disabled={disabled}
        onChange={onGapChange}
      />
      <div data-testid="mn-usable-area">
        {usableOk ? (
          <PanelNote>
            {t('mixedNesting.inputPanel:vung_dung_duoc_w_x_h_mm', {
              w: usableWidth,
              h: usableHeight,
            })}
          </PanelNote>
        ) : (
          <PanelNote tone="warning">{t('mixedNesting.inputPanel:le_lon_hon_kho_to')}</PanelNote>
        )}
      </div>

      <Divider />

      {/* ── Xoay mặc định ── */}
      <GroupLabel>{t('mixedNesting.inputPanel:xoay_mac_dinh')}</GroupLabel>
      <SelectField
        label={t('mixedNesting.inputPanel:rang_buoc')}
        value={defaultRotation.mode}
        disabled={disabled}
        options={[
          { value: 'free', label: t('mixedNesting.inputPanel:tu_do_0_360') },
          { value: 'fixed', label: t('mixedNesting.inputPanel:khoa_mot_goc') },
          { value: 'discrete', label: t('mixedNesting.inputPanel:danh_sach_goc') },
          { value: 'ranges', label: t('mixedNesting.inputPanel:khoang_goc') },
        ]}
        onChange={(value) => {
          const next = switchRotationMode(defaultRotation, value as never);
          // Cấp job không nhận `inherit` — không có gì để kế thừa.
          if (next.mode === 'inherit') return;
          onDefaultRotationChange(next);
        }}
      />
      <PanelNote>{t('mixedNesting.inputPanel:mac_dinh_xoay_tu_do_tung_khuon_thu_hep')}</PanelNote>

      <Divider />

      {/* ── Mức tìm kiếm ── */}
      <GroupLabel>{t('mixedNesting.inputPanel:muc_tim_kiem')}</GroupLabel>
      <SelectField
        label={t('mixedNesting.inputPanel:muc')}
        value={profile}
        disabled={disabled}
        // Khoá TĨNH cho từng mức, không nội suy `profile_${value}`: test danh mục i18n chỉ
        // thu được khoá là chuỗi literal, nên khoá động lọt lưới và hiện raw key lúc chạy.
        options={PROFILE_ORDER.map((value) => ({
          value,
          label: {
            fast: t('mixedNesting.inputPanel:profile_nhanh'),
            balanced: t('mixedNesting.inputPanel:profile_can_bang'),
            tight: t('mixedNesting.inputPanel:profile_chat'),
          }[value],
        }))}
        onChange={(value) => onProfileChange(value as MixedNestingProfile)}
      />
      <PanelNote>{t('mixedNesting.inputPanel:ba_muc_chi_doi_so_luot_thu')}</PanelNote>

      {/* Hai thiết lập dưới đây ít dùng hàng ngày nên gấp lại, giống cách Bình tem bế
          xếp nhóm mở rộng — nhưng KHÔNG ẩn: mở ra là thấy đủ. */}
      <Accordion title={t('mixedNesting.inputPanel:thiet_lap_mo_rong')}>
        <div className="flex flex-col gap-3 pt-1">
          <Checkbox
            checked={timeBudgetMs !== null}
            onChange={(checked) => onTimeBudgetChange(checked ? 30_000 : null)}
            label={t('mixedNesting.inputPanel:dung_sau_mot_khoang_thoi_gian')}
          />
          {timeBudgetMs !== null && (
            <NumberField
              label={t('mixedNesting.inputPanel:toi_da')}
              unit={t('mixedNesting.inputPanel:giay')}
              value={Math.round(timeBudgetMs / 1000)}
              min={1}
              integer
              disabled={disabled}
              onChange={(value) => onTimeBudgetChange(Math.max(1, value) * 1000)}
            />
          )}
          <PanelNote>
            {timeBudgetMs === null
              ? t('mixedNesting.inputPanel:khong_gioi_han_chay_het_ke_hoach')
              : t('mixedNesting.inputPanel:co_gioi_han_tra_phuong_an_tot_nhat')}
          </PanelNote>

          <NumberField
            label={t('mixedNesting.inputPanel:seed')}
            value={seed}
            min={0}
            integer
            disabled={disabled}
            onChange={(value) => onSeedChange(Math.max(0, value))}
          />
          <PanelNote>{t('mixedNesting.inputPanel:giu_nguyen_seed_de_chay_lai')}</PanelNote>
        </div>
      </Accordion>
    </div>
  );
}
