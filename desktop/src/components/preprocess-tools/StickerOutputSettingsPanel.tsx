import { useId, type ReactNode } from 'react';

import { tv } from '../../i18n';
import { RichSelect } from '../imposition-tools/SharedUI';
import {
    sanitizeStickerOutputSettings,
    type StickerBleedColorType,
    type StickerCornerStyle,
    type StickerCutMode,
    type StickerOutputSettings,
    type StickerSolidBleedCmyk,
} from './stickerOutputSettings';
import { BLEED_COLOR_MODES_STICKER, CUT_MODES_RICH } from './stickerToolPolicy';
import { ToolDivider, ToolSectionLabel } from './ToolUI';


export interface StickerOutputSettingsPanelProps {
    value: StickerOutputSettings;
    onChange: (next: StickerOutputSettings) => void;
    disabled?: boolean;
    preserveNotice?: ReactNode;
}

interface NumberSettingProps {
    id: string;
    label: string;
    value: number;
    min: number;
    max: number;
    step: number;
    disabled: boolean;
    onChange: (value: number) => void;
}

const CORNER_OPTIONS: ReadonlyArray<{
    value: StickerCornerStyle;
    label: string;
    description: string;
}> = [
    {
        value: 'preserve',
        label: 'Giữ nguyên',
        description: 'Giữ quỹ đạo và đặc trưng góc của đường bế gốc.',
    },
    {
        value: 'round',
        label: 'Bo tròn',
        description: 'Làm tròn các góc gắt để máy bế chạy êm hơn.',
    },
    {
        value: 'miter',
        label: 'Góc nhọn',
        description: 'Giữ giao điểm góc nhọn theo kiểu miter.',
    },
];

const CMYK_CHANNELS = ['C', 'M', 'Y', 'K'] as const;

function copyCmyk(value: StickerSolidBleedCmyk): StickerSolidBleedCmyk {
    return [value[0], value[1], value[2], value[3]];
}

function NumberSetting({
    id,
    label,
    value,
    min,
    max,
    step,
    disabled,
    onChange,
}: NumberSettingProps) {
    return (
        <label htmlFor={id} className="block min-w-0">
            <span className="mb-1 block text-[12.5px] font-semibold text-slate-600 dark:text-zinc-300">
                {tv(label)}
            </span>
            <div className="flex items-center gap-1.5">
                <input
                    id={id}
                    type="number"
                    aria-label={`${tv(label)} (mm)`}
                    min={min}
                    max={max}
                    step={step}
                    value={value}
                    disabled={disabled}
                    onChange={event => {
                        const next = event.currentTarget.valueAsNumber;
                        if (Number.isFinite(next)) onChange(next);
                    }}
                    className="h-9 min-w-0 flex-1 rounded-md border border-slate-300 bg-white px-2.5 text-center text-[14px] font-semibold transition-all focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500/20 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/20 dark:bg-zinc-900"
                />
                <span className="shrink-0 text-[12.5px] font-semibold text-slate-500 dark:text-zinc-400">
                    mm
                </span>
            </div>
        </label>
    );
}

export interface StickerBleedColorControlProps {
    value: StickerOutputSettings;
    onChange: (next: StickerOutputSettings) => void;
    disabled?: boolean;
    className?: string;
}

/** Bộ chọn cách tạo màu cho vùng tràn lề, dùng chung cho cả PDF và ảnh nhiều tem. */
export function StickerBleedColorControl({
    value,
    onChange,
    disabled = false,
    className = '',
}: StickerBleedColorControlProps) {
    const settings = sanitizeStickerOutputSettings(value);
    const inputIdPrefix = useId();

    const emitPatch = (patch: Partial<StickerOutputSettings>) => {
        if (disabled) return;
        const nextCmyk = patch.solidBleedCmyk
            ? copyCmyk(patch.solidBleedCmyk)
            : copyCmyk(settings.solidBleedCmyk);
        onChange(sanitizeStickerOutputSettings({
            ...settings,
            ...patch,
            solidBleedCmyk: nextCmyk,
        }));
    };

    const changeCmykChannel = (index: number, channelValue: number) => {
        const next: [number, number, number, number] = [
            settings.solidBleedCmyk[0],
            settings.solidBleedCmyk[1],
            settings.solidBleedCmyk[2],
            settings.solidBleedCmyk[3],
        ];
        next[index] = channelValue;
        emitPatch({ solidBleedCmyk: next });
    };

    return (
        <fieldset
            disabled={disabled}
            aria-disabled={disabled}
            className={`m-0 min-w-0 border-0 p-0 disabled:opacity-70 ${className}`}
        >
            <div role="group" aria-label={tv('Màu bù xén')} className="relative z-[50]">
                <span className="mb-1 block text-[12.5px] font-semibold text-slate-600 dark:text-zinc-300">
                    {tv('Màu bù xén')}
                </span>
                <RichSelect
                    value={settings.bleedColorType}
                    onChange={next => emitPatch({ bleedColorType: next as StickerBleedColorType })}
                    options={BLEED_COLOR_MODES_STICKER}
                />
            </div>

            {settings.bleedColorType === 'solid' ? (
                <div
                    role="group"
                    aria-label={tv('Màu bù xén CMYK')}
                    className="mt-3 rounded-lg border border-slate-200 bg-white p-3 dark:border-zinc-700 dark:bg-zinc-800"
                >
                    <div className="grid grid-cols-4 gap-2">
                        {CMYK_CHANNELS.map((channel, index) => {
                            const inputId = `${inputIdPrefix}-sticker-output-cmyk-${channel}`;
                            return (
                                <label key={channel} htmlFor={inputId} className="min-w-0">
                                    <span className="mb-1 block text-center text-[10px] font-bold text-slate-700 dark:text-zinc-300">
                                        {channel}
                                    </span>
                                    <input
                                        id={inputId}
                                        type="number"
                                        aria-label={`${channel} (%)`}
                                        min={0}
                                        max={100}
                                        step={1}
                                        value={settings.solidBleedCmyk[index]}
                                        disabled={disabled}
                                        onChange={event => {
                                            const next = event.currentTarget.valueAsNumber;
                                            if (Number.isFinite(next)) changeCmykChannel(index, next);
                                        }}
                                        className="h-8 w-full rounded border border-slate-200 bg-slate-50 text-center text-xs disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-600 dark:bg-zinc-900"
                                    />
                                </label>
                            );
                        })}
                    </div>
                </div>
            ) : null}
        </fieldset>
    );
}

/**
 * Thiết lập đầu ra dùng chung cho luồng nhận diện tem mới.
 * Component được điều khiển hoàn toàn; mọi giá trị phát ra đều được chuẩn hóa tập trung.
 */
export default function StickerOutputSettingsPanel({
    value,
    onChange,
    disabled = false,
    preserveNotice,
}: StickerOutputSettingsPanelProps) {
    const settings = sanitizeStickerOutputSettings(value);

    const emitPatch = (patch: Partial<StickerOutputSettings>) => {
        if (disabled) return;

        const nextCmyk = patch.solidBleedCmyk
            ? copyCmyk(patch.solidBleedCmyk)
            : copyCmyk(settings.solidBleedCmyk);
        onChange(sanitizeStickerOutputSettings({
            ...settings,
            ...patch,
            solidBleedCmyk: nextCmyk,
        }));
    };

    return (
        <fieldset
            disabled={disabled}
            aria-disabled={disabled}
            aria-label={tv('Thiết lập đường bế tem')}
            className="m-0 min-w-0 space-y-4 border-0 p-0 disabled:opacity-70"
        >
            <div>
                <ToolSectionLabel>{tv('Đường cắt')}</ToolSectionLabel>
                {preserveNotice ? (
                    <div
                        role="note"
                        className="mb-3 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-[11px] leading-relaxed text-sky-800 dark:border-sky-800/60 dark:bg-sky-950/30 dark:text-sky-200"
                    >
                        {preserveNotice}
                    </div>
                ) : null}

                <div role="group" aria-label={tv('Chế độ đường cắt')} className="relative z-[60] mb-3">
                    <span className="mb-1 block text-[12.5px] font-semibold text-slate-600 dark:text-zinc-300">
                        {tv('Chế độ đường cắt')}
                    </span>
                    <RichSelect
                        value={settings.cutMode}
                        onChange={next => emitPatch({ cutMode: next as StickerCutMode })}
                        options={CUT_MODES_RICH}
                    />
                </div>

                <NumberSetting
                    id="sticker-output-offset-mm"
                    label="Co giãn đường cắt"
                    value={settings.offsetMm}
                    min={-10}
                    max={10}
                    step={0.1}
                    disabled={disabled}
                    onChange={offsetMm => emitPatch({ offsetMm })}
                />
                <p className="mt-1 text-[10px] leading-relaxed text-slate-400">
                    {tv('Số âm lùi đường cắt vào trong; số dương nới đường cắt ra ngoài.')}
                </p>

                <div role="group" aria-label={tv('Kiểu góc đường cắt')} className="mt-3 grid grid-cols-3 gap-1.5">
                    {CORNER_OPTIONS.map(option => (
                        <button
                            key={option.value}
                            type="button"
                            aria-label={tv(`${option.label}: ${option.description}`)}
                            aria-pressed={settings.cornerStyle === option.value}
                            title={tv(option.description)}
                            disabled={disabled}
                            onClick={() => emitPatch({ cornerStyle: option.value })}
                            className={`h-9 rounded border px-1 text-[11px] font-bold transition-all disabled:cursor-not-allowed disabled:opacity-50 ${
                                settings.cornerStyle === option.value
                                    ? 'border-teal-500 bg-teal-500/10 text-teal-700 dark:text-teal-300'
                                    : 'border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-white/10 dark:text-zinc-400 dark:hover:bg-zinc-800'
                            }`}
                        >
                            {tv(option.label)}
                        </button>
                    ))}
                </div>

                <div className="mt-3 grid grid-cols-2 gap-1.5">
                    <button
                        type="button"
                        aria-label={tv('Đặc ruột: bỏ qua các lỗ rỗng bên trong tem')}
                        aria-pressed={settings.fillHoles}
                        disabled={disabled}
                        onClick={() => emitPatch({ fillHoles: !settings.fillHoles })}
                        className={`min-h-10 rounded-lg border px-2 text-[11px] font-bold transition-all disabled:cursor-not-allowed disabled:opacity-50 ${
                            settings.fillHoles
                                ? 'border-teal-500 bg-teal-500/10 text-teal-700 dark:text-teal-300'
                                : 'border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-white/10 dark:text-zinc-400 dark:hover:bg-zinc-800'
                        }`}
                    >
                        {tv(settings.fillHoles ? 'Đặc ruột' : 'Giữ lỗ rỗng')}
                    </button>
                    <button
                        type="button"
                        aria-label={tv('Crop trang theo đường bế và phần bù xén')}
                        aria-pressed={settings.cropToSticker}
                        disabled={disabled}
                        onClick={() => emitPatch({ cropToSticker: !settings.cropToSticker })}
                        className={`min-h-10 rounded-lg border px-2 text-[11px] font-bold transition-all disabled:cursor-not-allowed disabled:opacity-50 ${
                            settings.cropToSticker
                                ? 'border-teal-500 bg-teal-500/10 text-teal-700 dark:text-teal-300'
                                : 'border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-white/10 dark:text-zinc-400 dark:hover:bg-zinc-800'
                        }`}
                    >
                        {tv(settings.cropToSticker ? 'Crop theo tem' : 'Giữ khổ trang')}
                    </button>
                </div>
            </div>

            <ToolDivider />

            <div>
                <ToolSectionLabel>{tv('Bù xén')}</ToolSectionLabel>
                <NumberSetting
                    id="sticker-output-bleed-mm"
                    label="Bù xén ngoài đường cắt"
                    value={settings.bleedMm}
                    min={0}
                    max={10}
                    step={0.1}
                    disabled={disabled}
                    onChange={bleedMm => emitPatch({ bleedMm })}
                />

                <StickerBleedColorControl
                    value={settings}
                    onChange={onChange}
                    disabled={disabled}
                    className="mt-3"
                />
            </div>
        </fieldset>
    );
}
