/**
 * Danh sách khuôn của "Bình lồng ghép tự do" — phase P10, dựng lại theo panel Bình tem bế.
 *
 * Kế hoạch: `docs/KE_HOACH_MIXED_TRUE_SHAPE_NESTING_DOC_LAP_2026-08-26.md` §6.4, §15, §16.4.
 *
 * **Vì sao là thẻ dọc, không phải bảng.** Bản đầu dùng `<table>` bốn cột với cột xoay rộng
 * 260px. Khi tool chuyển sang bố cục của Bình tem bế thì mọi thiết lập nằm trong panel phải
 * rộng ~380px, và bảng đó không thể vừa: cột xoay bị bóp còn ~120px, ô "danh sách góc" cắt
 * mất chữ số — mà mất chữ số là mất dữ liệu. Mỗi khuôn thành một thẻ xếp dọc, đúng dáng
 * `SettingRow` variant `card` của dự án.
 *
 * Ba điểm về giao diện xoay, đều là ràng buộc chứ không phải lựa chọn thẩm mỹ:
 *
 * 1. **Mặc định hiển thị là "theo cài đặt chung"** (`inherit`), và cài đặt chung mặc định
 *    là **tự do**. Người dùng phải chủ động chọn mới thu hẹp miền góc.
 * 2. **Không có ô "bước góc".** Preset 0/180 và 0/90/180/270 ghi thẳng vào `discrete`; ô
 *    nhập tay là **danh sách góc**, không phải bước nhảy.
 * 3. **Không có nút lật/gương/tỷ lệ.** Không có control nào sinh ra `mirror`/`scale`.
 */

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import {
  ROTATION_MODE_LABEL,
  ROTATION_MODE_ORDER,
  formatAngleList,
  parseAngleList,
  switchRotationMode,
} from '../../lib/mixed-nesting/rotationEditing';
import type { PartRotationConstraint, RotationMode } from '../../lib/mixed-nesting/types';
import type { MixedNestingPart } from '../../stores/useMixedNestingStore';
import { NumberField, SelectField, TextField } from './PanelPrimitives';

export interface PartsTableProps {
  parts: readonly MixedNestingPart[];
  disabled?: boolean;
  onQuantityChange: (uiId: string, quantity: number) => void;
  onRotationChange: (uiId: string, constraint: PartRotationConstraint) => void;
  onRemove: (uiId: string) => void;
}

/** Nút nhỏ trong thẻ khuôn. Cỡ 11 + viền nhạt, trùng nút phụ của panel Bình tem bế. */
const CHIP_CLASS =
  'rounded border border-slate-300 dark:border-white/20 px-2 h-6 text-[11px] font-medium'
  + ' text-slate-600 dark:text-zinc-300 hover:border-indigo-400 hover:text-indigo-600'
  + ' dark:hover:text-indigo-400 transition-colors disabled:opacity-40';

function RotationEditor({
  constraint,
  disabled,
  onChange,
}: {
  constraint: PartRotationConstraint;
  disabled?: boolean;
  onChange: (next: PartRotationConstraint) => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-2">
      <SelectField
        label={t('mixedNesting.partsTable:xoay')}
        value={constraint.mode}
        disabled={disabled}
        options={ROTATION_MODE_ORDER.map((mode) => ({
          value: mode,
          label: ROTATION_MODE_LABEL[mode],
        }))}
        onChange={(value) => onChange(switchRotationMode(constraint, value as RotationMode))}
      />

      {constraint.mode === 'fixed' && (
        <NumberField
          label={t('mixedNesting.partsTable:goc')}
          unit="°"
          value={constraint.angleDeg}
          disabled={disabled}
          onChange={(value) => onChange({ mode: 'fixed', angleDeg: value })}
        />
      )}

      {constraint.mode === 'discrete' && (
        <>
          <div className="flex items-center gap-1.5 pl-[107px]">
            {/* Hai preset là lối tắt, KHÔNG phải miền mặc định. */}
            <button
              type="button"
              className={CHIP_CLASS}
              disabled={disabled}
              onClick={() => onChange({ mode: 'discrete', anglesDeg: [0, 180] })}
            >
              0/180
            </button>
            <button
              type="button"
              className={CHIP_CLASS}
              disabled={disabled}
              onClick={() => onChange({ mode: 'discrete', anglesDeg: [0, 90, 180, 270] })}
            >
              0/90/180/270
            </button>
          </div>
          <TextField
            label={t('mixedNesting.partsTable:danh_sach_goc')}
            value={formatAngleList(constraint.anglesDeg)}
            placeholder="0, 13.372849, 41.25"
            disabled={disabled}
            onChange={(raw) => onChange({ mode: 'discrete', anglesDeg: parseAngleList(raw) })}
          />
        </>
      )}

      {constraint.mode === 'ranges' && (
        <div className="flex flex-col gap-2">
          {constraint.arcs.map((arc, index) => (
            <div key={index} className="flex items-end gap-1.5">
              <div className="flex-1 min-w-0">
                <NumberField
                  label={t('mixedNesting.partsTable:tu_goc')}
                  unit="°"
                  value={arc.startDeg}
                  disabled={disabled}
                  onChange={(value) =>
                    onChange({
                      mode: 'ranges',
                      arcs: constraint.arcs.map((item, position) =>
                        position === index ? { ...item, startDeg: value } : item,
                      ),
                    })
                  }
                />
                <div className="mt-2">
                  <NumberField
                    label={t('mixedNesting.partsTable:mo_rong')}
                    unit="°"
                    value={arc.sweepDeg}
                    disabled={disabled}
                    onChange={(value) =>
                      onChange({
                        mode: 'ranges',
                        arcs: constraint.arcs.map((item, position) =>
                          position === index ? { ...item, sweepDeg: value } : item,
                        ),
                      })
                    }
                  />
                </div>
              </div>
              {constraint.arcs.length > 1 && (
                <button
                  type="button"
                  className="shrink-0 w-8 h-8 flex items-center justify-center rounded text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30 transition-colors"
                  disabled={disabled}
                  aria-label={t('mixedNesting.partsTable:xoa_cung_n', { n: index + 1 })}
                  onClick={() =>
                    onChange({
                      mode: 'ranges',
                      arcs: constraint.arcs.filter((_, position) => position !== index),
                    })
                  }
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>
          ))}
          <div className="pl-[107px]">
            <button
              type="button"
              className={CHIP_CLASS}
              disabled={disabled}
              onClick={() =>
                onChange({ mode: 'ranges', arcs: [...constraint.arcs, { startDeg: 0, sweepDeg: 45 }] })
              }
            >
              {t('mixedNesting.partsTable:them_cung')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function PartsTable({
  parts,
  disabled,
  onQuantityChange,
  onRotationChange,
  onRemove,
}: PartsTableProps) {
  const { t } = useTranslation();
  const tongSoCon = useMemo(
    () => parts.reduce((sum, part) => sum + part.quantity, 0),
    [parts],
  );

  if (parts.length === 0) {
    return (
      <p
        className="rounded-lg border border-dashed border-slate-300 dark:border-white/10 p-4 text-center text-[11px] text-slate-500 dark:text-zinc-400"
        data-testid="mn-parts-empty"
      >
        {t('mixedNesting.partsTable:chua_co_khuon_nao')}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2" data-testid="mn-parts-table">
      {parts.map((part) => (
        <div
          key={part.uiId}
          data-part-id={part.partId}
          className="rounded-lg border border-slate-200 dark:border-white/10 bg-white dark:bg-zinc-900 p-3 shadow-sm"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div
                className="text-[13px] font-bold text-slate-800 dark:text-white truncate"
                title={part.partId}
              >
                {part.partId}
              </div>
              {part.sourceLabel && (
                <div className="text-[11px] text-slate-500 dark:text-zinc-400 truncate" title={part.sourceLabel}>
                  {part.sourceLabel}
                </div>
              )}
              <div className="text-[10px] text-slate-400 dark:text-zinc-500 tabular-nums">
                {part.holes.length > 0
                  ? t('mixedNesting.partsTable:n_dinh_m_lo', {
                      n: part.outer.length,
                      m: part.holes.length,
                    })
                  : t('mixedNesting.partsTable:n_dinh', { n: part.outer.length })}
              </div>
            </div>
            <button
              type="button"
              className="shrink-0 w-7 h-7 flex items-center justify-center rounded text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30 transition-colors disabled:opacity-40"
              disabled={disabled}
              aria-label={t('mixedNesting.partsTable:xoa_khuon_x', { x: part.partId })}
              title={t('mixedNesting.partsTable:xoa_khuon_nay')}
              onClick={() => onRemove(part.uiId)}
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          </div>

          <div className="mt-3 flex flex-col gap-2">
            <NumberField
              label={t('mixedNesting.partsTable:so_con')}
              value={part.quantity}
              min={1}
              integer
              disabled={disabled}
              onChange={(value) => onQuantityChange(part.uiId, Math.max(1, value))}
            />
            <RotationEditor
              constraint={part.rotationConstraint}
              disabled={disabled}
              onChange={(next) => onRotationChange(part.uiId, next)}
            />
          </div>
        </div>
      ))}
      <p className="text-[11px] text-slate-500 dark:text-zinc-400 tabular-nums">
        {t('mixedNesting.partsTable:n_loai_khuon_tong_m_con', {
          n: parts.length,
          m: tongSoCon,
        })}
      </p>
    </div>
  );
}
