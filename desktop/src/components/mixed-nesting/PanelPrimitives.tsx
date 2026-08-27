/**
 * Primitive panel của "Bình lồng ghép tự do" — khớp bộ khung Bình tem bế.
 *
 * Vì sao file này tồn tại: dự án **không có** component `Field`/`NumberInput` dùng chung.
 * Khuôn field được copy inline ở từng section của Bình tem bế
 * (`imposition-tools/sections/GridSettingsSection.tsx:194-206`). Copy nguyên khuôn đó vào
 * mười chỗ trong tool này là mời gọi trôi dạt, nên gói lại đúng **một** lần ở đây, giữ
 * nguyên từng class để hai tool nhìn không lệch một pixel.
 *
 * Ba ràng buộc kế thừa từ kế hoạch, đừng nới:
 *
 * 1. **Ô số không có `step`.** Toạ độ và góc là số thực liên tục; `step` làm trình duyệt
 *    gợi ý làm tròn và dạy người dùng rằng có lưới.
 * 2. **Không `toFixed`/`Math.round` trong hiển thị giá trị.** Cắt chữ số là mất dữ liệu.
 * 3. Mọi export ở file này **phải là component** — eslint `react-refresh/only-export-components`
 *    chặn file component export hằng hoặc hàm thuần.
 */

import { useId, useState, type ReactNode } from 'react';

/** Class ô nhập, trùng `imposition-tools/SharedUI.tsx::inputCls` cộng phần căn phải cho số. */
const CONTROL_BASE =
  'h-8 px-2 border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900'
  + ' text-sm focus:outline-none focus:border-indigo-500';

// ─────────────────────────────────────────────────────────────────────────────
//  Ba primitive nhân bản từ `imposition-tools/SharedUI.tsx`
// ─────────────────────────────────────────────────────────────────────────────
//
// Vì sao NHÂN BẢN chứ không `import` từ SharedUI: `SharedUI.tsx` export cả `ToolItem`, và
// ES import kéo theo **toàn bộ** module — nghĩa là `ToolHelpModal`, `toolHelp`,
// `ProFeatureBadge`, `useAuthStore`. Tool này là một lazy chunk **standalone**, nên import
// đó nhồi cả cây modal trợ giúp của workspace vào chunk của nó. Đo được ngay ở test: một
// test render tab nền đi từ mili-giây lên **quá 5 giây** rồi timeout, chỉ vì
// `vi.resetModules()` phải nạp lại cây đó mỗi lượt.
//
// Đánh đổi là nguy cơ trôi dạt hình thức. Chống bằng `PanelPrimitives.test.tsx`: nó ĐỌC
// `SharedUI.tsx` và đòi từng chuỗi class dưới đây phải còn nguyên trong đó. Sửa SharedUI mà
// quên bên này thì test đỏ, không phải người dùng phát hiện.

/** Trùng `SharedUI::Divider`. */
const DIVIDER_CLASS = 'h-px bg-slate-200 dark:bg-white/10 w-full';

/** Trùng `SharedUI::Checkbox`. */
const CHECKBOX_LABEL_CLASS = 'flex items-center gap-2 cursor-pointer';
const CHECKBOX_BOX_CLASS = 'w-4 h-4 rounded border flex items-center justify-center transition-colors';
const CHECKBOX_ON_CLASS = 'bg-indigo-500 border-indigo-500';
const CHECKBOX_OFF_CLASS = 'bg-white dark:bg-zinc-800 border-slate-300 dark:border-zinc-500';

/** Trùng `SharedUI::Accordion`. */
const ACCORDION_SHELL_CLASS = 'border border-slate-200 dark:border-white/10 rounded-lg overflow-hidden';
const ACCORDION_HEAD_CLASS =
  'w-full flex items-center justify-between px-3 py-2 text-[11px] font-bold text-slate-600'
  + ' tracking-wide hover:bg-slate-50 dark:hover:bg-zinc-800/50 transition-colors focus:outline-none';
const ACCORDION_BODY_CLASS = 'px-3 pb-3 space-y-1.5';

/** Chỉ để test parity đọc — mọi export ở file này phải là component, nên bọc thành component. */
export function SharedUiClassProbe() {
  return (
    <span
      hidden
      data-divider={DIVIDER_CLASS}
      data-checkbox-label={CHECKBOX_LABEL_CLASS}
      data-checkbox-box={CHECKBOX_BOX_CLASS}
      data-checkbox-on={CHECKBOX_ON_CLASS}
      data-checkbox-off={CHECKBOX_OFF_CLASS}
      data-accordion-shell={ACCORDION_SHELL_CLASS}
      data-accordion-head={ACCORDION_HEAD_CLASS}
      data-accordion-body={ACCORDION_BODY_CLASS}
    />
  );
}

export function Divider() {
  return <div className={DIVIDER_CLASS} />;
}

export function Checkbox({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
}) {
  return (
    <label className={CHECKBOX_LABEL_CLASS}>
      <div className={`${CHECKBOX_BOX_CLASS} ${checked ? CHECKBOX_ON_CLASS : CHECKBOX_OFF_CLASS}`}>
        {checked && (
          <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={4} d="M5 13l4 4L19 7" />
          </svg>
        )}
      </div>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="hidden"
      />
      <span className="text-sm">{label}</span>
    </label>
  );
}

export function Accordion({
  title,
  initialOpen = false,
  children,
}: {
  title: string;
  initialOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <div className={ACCORDION_SHELL_CLASS}>
      <button type="button" onClick={() => setOpen(!open)} className={ACCORDION_HEAD_CLASS}>
        <span>{title}</span>
        <svg
          className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && <div className={ACCORDION_BODY_CLASS}>{children}</div>}
    </div>
  );
}

/** Một hàng thiết lập: nhãn in hoa cỡ 11 bên trái, control bên phải. */
export function FieldRow({
  label,
  htmlFor,
  children,
  hint,
}: {
  label: string;
  htmlFor?: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <label
        htmlFor={htmlFor}
        title={hint}
        className="text-[11px] font-bold text-slate-600 dark:text-zinc-400 uppercase tracking-wide shrink-0 w-[95px]"
      >
        {label}
      </label>
      <div className="flex flex-1 items-center gap-2 min-w-0">{children}</div>
    </div>
  );
}

/**
 * Ô nhập số có đơn vị hiển thị chồng bên trong.
 *
 * `onChange` chỉ báo khi phân tích được số hữu hạn — gõ dở ("12.", "-") không được biến
 * thành `NaN` rồi ghi vào store.
 */
export function NumberField({
  label,
  value,
  unit,
  min,
  max,
  disabled,
  integer,
  onChange,
}: {
  label: string;
  value: number;
  unit?: string;
  min?: number;
  max?: number;
  disabled?: boolean;
  /** Bắt về số nguyên (số tờ, số con, seed). Mặc định giữ số thực. */
  integer?: boolean;
  onChange: (value: number) => void;
}) {
  const id = useId();
  return (
    <FieldRow label={label} htmlFor={id}>
      <div className="relative flex-1 min-w-0">
        <input
          id={id}
          type="number"
          inputMode="decimal"
          // Tắt nút tăng/giảm của trình duyệt: chúng nhảy theo `step` nguyên và dạy người
          // dùng rằng toạ độ có lưới. Viết bằng arbitrary variant để không cần file CSS riêng.
          className={
            `${CONTROL_BASE} w-full text-right tabular-nums ${unit ? 'pr-9' : ''}`
            + ' [&::-webkit-inner-spin-button]:appearance-none'
            + ' [&::-webkit-outer-spin-button]:appearance-none'
          }
          value={value}
          min={min}
          max={max}
          disabled={disabled}
          onChange={(event) => {
            const parsed = integer
              ? Number.parseInt(event.target.value, 10)
              : Number.parseFloat(event.target.value);
            if (!Number.isFinite(parsed)) return;
            onChange(parsed);
          }}
        />
        {unit && (
          <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-slate-400 dark:text-zinc-500 pointer-events-none">
            {unit}
          </span>
        )}
      </div>
    </FieldRow>
  );
}

/** Ô nhập chuỗi (danh sách góc). Không căn phải: người dùng đọc từ đầu danh sách. */
export function TextField({
  label,
  value,
  placeholder,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <FieldRow label={label} htmlFor={id}>
      <input
        id={id}
        type="text"
        className={`${CONTROL_BASE} flex-1 min-w-0 tabular-nums`}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </FieldRow>
  );
}

/** Dropdown gốc của trình duyệt, `appearance-auto` như các section của Bình tem bế. */
export function SelectField({
  label,
  value,
  disabled,
  options,
  onChange,
}: {
  label: string;
  value: string;
  disabled?: boolean;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <FieldRow label={label} htmlFor={id}>
      <select
        id={id}
        value={value}
        disabled={disabled}
        className={`${CONTROL_BASE} flex-1 min-w-0 appearance-auto font-medium`}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </FieldRow>
  );
}

/** Ghi chú dưới một nhóm field. Cỡ 11 như mọi mô tả trong panel. */
export function PanelNote({
  children,
  tone = 'muted',
}: {
  children: ReactNode;
  tone?: 'muted' | 'warning';
}) {
  const cls =
    tone === 'warning'
      ? 'text-[11px] text-red-600 dark:text-red-400'
      : 'text-[11px] text-slate-500 dark:text-zinc-400';
  return <p className={cls}>{children}</p>;
}

/** Nhãn nhóm, trùng `SharedUI::SectionLabel` nhưng thêm in hoa cho khớp panel. */
export function GroupLabel({ children }: { children: ReactNode }) {
  return (
    <span className="text-[11px] font-bold text-slate-600 dark:text-zinc-400 uppercase tracking-wide">
      {children}
    </span>
  );
}
