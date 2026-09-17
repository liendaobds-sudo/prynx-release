import React, { useState, useRef, useEffect, useMemo } from 'react';
import { Bold, Italic, Minus, Plus, Type, Check, Search } from 'lucide-react';
import { getSystemFonts } from '@/lib/api';
import { pickFontForName } from './editGeometry';

export interface FloatingTextToolbarProps {
    visible: boolean;
    bbox: [number, number, number, number]; // [x0, y0, x1, y1] theo canvas point
    scale: number;
    fontName: string;
    fontFile?: string;
    fontSizePt: number;
    color: number[] | null; // RGB [r, g, b] 0..255
    bold: boolean;
    italic: boolean;
    onFontChange: (fontName: string, fontFile?: string) => void;
    onFontSizeChange: (sizePt: number) => void;
    onColorChange: (color: number[]) => void;
    onToggleBold: () => void;
    onToggleItalic: () => void;
    onOpenEditor: () => void;
}

const PRESET_COLORS = [
    { name: 'Đen 100K', hex: '#000000', rgb: [0, 0, 0] },
    { name: 'Trắng', hex: '#ffffff', rgb: [255, 255, 255] },
    { name: 'Đỏ in', hex: '#e11d48', rgb: [225, 29, 72] },
    { name: 'Xanh Cyan', hex: '#0284c7', rgb: [2, 132, 199] },
    { name: 'Xanh lá', hex: '#16a34a', rgb: [22, 163, 74] },
    { name: 'Vàng in', hex: '#eab308', rgb: [234, 179, 8] },
    { name: 'Cam', hex: '#ea580c', rgb: [234, 88, 12] },
    { name: 'Xám', hex: '#475569', rgb: [71, 85, 105] },
];

const STANDARD_FONTS = [
    { name: 'Arial', path: '' },
    { name: 'Helvetica', path: '' },
    { name: 'Times New Roman', path: '' },
    { name: 'Courier New', path: '' },
    { name: 'Roboto', path: '' },
    { name: 'Montserrat', path: '' },
    { name: 'Open Sans', path: '' },
    { name: 'Tahoma', path: '' },
    { name: 'Verdana', path: '' },
    { name: 'Georgia', path: '' },
];

export const FloatingTextToolbar: React.FC<FloatingTextToolbarProps> = ({
    visible,
    bbox,
    scale,
    fontName,
    fontFile,
    fontSizePt,
    color,
    bold,
    italic,
    onFontChange,
    onFontSizeChange,
    onColorChange,
    onToggleBold,
    onToggleItalic,
    onOpenEditor,
}) => {
    const [showColorPicker, setShowColorPicker] = useState(false);
    const [showFontPicker, setShowFontPicker] = useState(false);
    const [fontSearch, setFontSearch] = useState('');
    const [systemFonts, setSystemFonts] = useState<{ name: string; path: string }[]>([]);
    const [sizeInput, setSizeInput] = useState<string>(String(Math.round(fontSizePt || 12)));
    const colorPopRef = useRef<HTMLDivElement>(null);
    const fontPopRef = useRef<HTMLDivElement>(null);

    // Tải danh sách font hệ thống một lần
    useEffect(() => {
        getSystemFonts()
            .then((fonts) => {
                if (Array.isArray(fonts)) {
                    setSystemFonts(fonts);
                }
            })
            .catch(() => {});
    }, []);

    useEffect(() => {
        setSizeInput(String(Math.round(fontSizePt || 12)));
    }, [fontSizePt]);

    // Đóng popover khi click ra ngoài
    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (colorPopRef.current && !colorPopRef.current.contains(e.target as Node)) {
                setShowColorPicker(false);
            }
            if (fontPopRef.current && !fontPopRef.current.contains(e.target as Node)) {
                setShowFontPicker(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    // Danh sách font lọc theo tìm kiếm (tự động map đường dẫn file font thật từ systemFonts)
    const allAvailableFonts = useMemo(() => {
        const set = new Set<string>();
        const list: { name: string; path: string }[] = [];

        // 1. Font hiện tại nếu có
        if (fontName) {
            const matched = pickFontForName(fontName, systemFonts);
            list.push({ name: fontName, path: fontFile || matched?.path || '' });
            set.add(fontName.toLowerCase().replace(/[^a-z0-9]/g, ''));
        }

        // 2. Toàn bộ systemFonts từ máy tính (đã có đường dẫn .path thật 100%)
        for (const sysF of systemFonts) {
            const key = sysF.name.toLowerCase().replace(/[^a-z0-9]/g, '');
            if (!set.has(key)) {
                set.add(key);
                list.push(sysF);
            }
        }

        // 3. STANDARD_FONTS: tự động map sang đường dẫn .path từ systemFonts
        for (const sf of STANDARD_FONTS) {
            const key = sf.name.toLowerCase().replace(/[^a-z0-9]/g, '');
            if (!set.has(key)) {
                const matched = pickFontForName(sf.name, systemFonts);
                set.add(key);
                list.push({ name: sf.name, path: matched?.path || '' });
            }
        }

        return list;
    }, [fontName, fontFile, systemFonts]);

    const filteredFonts = useMemo(() => {
        if (!fontSearch.trim()) return allAvailableFonts.slice(0, 100);
        const q = fontSearch.toLowerCase();
        return allAvailableFonts.filter(f => f.name.toLowerCase().includes(q)).slice(0, 100);
    }, [allAvailableFonts, fontSearch]);

    if (!visible) return null;

    const [x0, y0, x1, y1] = bbox;
    const boxW = (x1 - x0) * scale;
    const boxLeft = x0 * scale;
    const boxTop = y0 * scale;

    // Vị trí thanh công cụ: canh giữa theo chiều ngang của chữ, đặt phía trên chữ 46px
    const toolbarWidth = 380;
    let left = boxLeft + (boxW / 2) - (toolbarWidth / 2);
    if (left < 10) left = 10;
    
    // Nếu quá sát mép trên màn hình, lật xuống dưới
    let top = boxTop - 46;
    if (top < 10) {
        top = (y1 * scale) + 10;
    }

    const currentColorRgb = color || [0, 0, 0];
    const currentColorHex = `#${currentColorRgb.map(c => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0')).join('')}`;
    const openDownwards = top < 260;

    const handleCommitSize = (valStr: string) => {
        const num = parseFloat(valStr);
        if (!isNaN(num) && num >= 4 && num <= 200) {
            onFontSizeChange(num);
            setSizeInput(String(num));
        } else {
            setSizeInput(String(Math.round(fontSizePt || 12)));
        }
    };

    const handleHexColor = (hex: string) => {
        const cleanHex = hex.replace('#', '');
        if (cleanHex.length === 6) {
            const r = parseInt(cleanHex.substring(0, 2), 16);
            const g = parseInt(cleanHex.substring(2, 4), 16);
            const b = parseInt(cleanHex.substring(4, 6), 16);
            if (!isNaN(r) && !isNaN(g) && !isNaN(b)) {
                onColorChange([r, g, b]);
            }
        }
    };

    return (
        <div
            data-edit-ui="1"
            className="absolute z-[65] flex items-center gap-1.5 bg-slate-900/95 text-white backdrop-blur-md px-2 py-1.5 rounded-xl shadow-2xl border border-slate-700/80 select-none text-xs"
            style={{ left, top }}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
        >
            {/* 1. Font Family Dropdown */}
            <div className="relative" ref={fontPopRef}>
                <button
                    type="button"
                    className="flex items-center justify-between gap-1.5 px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 min-w-[100px] max-w-[130px] transition-colors"
                    title={`Phông chữ: ${fontName || 'Mặc định'}`}
                    onClick={() => {
                        setShowFontPicker(!showFontPicker);
                        setShowColorPicker(false);
                        setFontSearch('');
                    }}
                >
                    <span className="truncate font-medium">{fontName || 'Phông chữ'}</span>
                    <span className="text-[9px] text-slate-400 shrink-0">▼</span>
                </button>

                {showFontPicker && (
                    <div className={`absolute left-0 ${openDownwards ? 'top-full mt-2' : 'bottom-full mb-2'} w-72 bg-slate-900 border border-slate-700 rounded-xl p-2.5 shadow-2xl z-50 flex flex-col gap-2`}>
                        {/* Search Input */}
                        <div className="relative flex items-center">
                            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 pointer-events-none" />
                            <input
                                autoFocus
                                type="text"
                                value={fontSearch}
                                placeholder="Tìm phông chữ..."
                                onChange={(e) => setFontSearch(e.target.value)}
                                className="w-full pl-8 pr-2.5 py-1.5 bg-slate-800 text-white text-xs rounded-lg border border-slate-700 outline-none focus:border-emerald-500 placeholder:text-slate-500"
                            />
                        </div>

                        {/* Font List */}
                        <div className="max-h-56 overflow-y-auto space-y-0.5 pr-1 custom-scrollbar">
                            {filteredFonts.map((f, idx) => {
                                const isSelected = fontName && f.name.toLowerCase() === fontName.toLowerCase();
                                return (
                                    <button
                                        key={`${f.name}_${idx}`}
                                        type="button"
                                        className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-left transition-colors ${
                                            isSelected ? 'bg-emerald-600/20 text-emerald-400 font-semibold' : 'hover:bg-slate-800 text-slate-200'
                                        }`}
                                        onClick={() => {
                                            onFontChange(f.name, f.path || undefined);
                                            setShowFontPicker(false);
                                        }}
                                    >
                                        <div className="flex flex-col truncate pr-2">
                                            <span className="text-xs truncate">{f.name}</span>
                                            <span
                                                className="text-[11px] text-slate-400 truncate opacity-70"
                                                style={{ fontFamily: f.name }}
                                            >
                                                PrynX Typography 123
                                            </span>
                                        </div>
                                        {isSelected && <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0" />}
                                    </button>
                                );
                            })}
                            {filteredFonts.length === 0 && (
                                <div className="text-center py-4 text-xs text-slate-500 italic">
                                    Không tìm thấy phông chữ phù hợp
                                </div>
                            )}
                        </div>
                    </div>
                )}
            </div>

            <div className="w-px h-4 bg-slate-700" />

            {/* 2. Font Size Stepper */}
            <div className="flex items-center bg-slate-800 rounded border border-slate-700">
                <button
                    type="button"
                    className="px-1.5 py-1 hover:bg-slate-700 text-slate-300 transition-colors"
                    title="Giảm cỡ chữ"
                    onClick={() => {
                        const next = Math.max(4, (fontSizePt || 12) - 1);
                        onFontSizeChange(next);
                    }}
                >
                    <Minus className="w-3 h-3" />
                </button>
                <input
                    type="text"
                    value={sizeInput}
                    className="w-8 text-center bg-transparent text-white text-[11px] font-semibold outline-none py-0.5"
                    onChange={(e) => setSizeInput(e.target.value)}
                    onBlur={() => handleCommitSize(sizeInput)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                            e.currentTarget.blur();
                        }
                    }}
                />
                <span className="text-[9px] text-slate-400 pr-1">pt</span>
                <button
                    type="button"
                    className="px-1.5 py-1 hover:bg-slate-700 text-slate-300 transition-colors"
                    title="Tăng cỡ chữ"
                    onClick={() => {
                        const next = Math.min(200, (fontSizePt || 12) + 1);
                        onFontSizeChange(next);
                    }}
                >
                    <Plus className="w-3 h-3" />
                </button>
            </div>

            <div className="w-px h-4 bg-slate-700" />

            {/* 3. Text Color Picker Swatch */}
            <div className="relative" ref={colorPopRef}>
                <button
                    type="button"
                    className="flex items-center gap-1.5 px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700"
                    title="Màu chữ"
                    onClick={() => {
                        setShowColorPicker(!showColorPicker);
                        setShowFontPicker(false);
                    }}
                >
                    <div
                        className="w-3.5 h-3.5 rounded-full border border-white/40 shadow-inner"
                        style={{ backgroundColor: currentColorHex }}
                    />
                    <span className="text-[9px] text-slate-400">▼</span>
                </button>

                {showColorPicker && (
                    <div className={`absolute left-0 ${openDownwards ? 'top-full mt-2' : 'bottom-full mb-2'} w-48 bg-slate-900 border border-slate-700 rounded-xl p-2.5 shadow-2xl z-50`}>
                        <div className="text-[10px] font-medium text-slate-400 mb-1.5">Màu in chuẩn</div>
                        <div className="grid grid-cols-4 gap-1.5 mb-2.5">
                            {PRESET_COLORS.map(p => (
                                <button
                                    key={p.hex}
                                    type="button"
                                    className="w-8 h-8 rounded-lg border border-white/20 flex items-center justify-center transition-transform hover:scale-110"
                                    style={{ backgroundColor: p.hex }}
                                    title={p.name}
                                    onClick={() => {
                                        onColorChange(p.rgb);
                                        setShowColorPicker(false);
                                    }}
                                >
                                    {currentColorHex.toLowerCase() === p.hex.toLowerCase() && (
                                        <Check className={`w-3.5 h-3.5 ${p.hex === '#ffffff' ? 'text-black' : 'text-white'}`} />
                                    )}
                                </button>
                            ))}
                        </div>
                        <div className="flex items-center gap-1.5 pt-2 border-t border-slate-800">
                            <input
                                type="color"
                                value={currentColorHex}
                                className="w-6 h-6 rounded cursor-pointer bg-transparent border-0"
                                onChange={(e) => handleHexColor(e.target.value)}
                            />
                            <input
                                type="text"
                                value={currentColorHex}
                                className="flex-1 bg-slate-800 text-white px-1.5 py-0.5 rounded text-[11px] font-mono uppercase outline-none border border-slate-700 text-center"
                                onChange={(e) => handleHexColor(e.target.value)}
                            />
                        </div>
                    </div>
                )}
            </div>

            <div className="w-px h-4 bg-slate-700" />

            {/* 4. Bold Button */}
            <button
                type="button"
                className={`px-2 py-1 rounded transition-colors ${bold ? 'bg-emerald-600 text-white font-bold' : 'hover:bg-slate-800 text-slate-300'}`}
                title="In đậm (Bold)"
                onClick={onToggleBold}
            >
                <Bold className="w-3.5 h-3.5" />
            </button>

            {/* 5. Italic Button */}
            <button
                type="button"
                className={`px-2 py-1 rounded transition-colors ${italic ? 'bg-emerald-600 text-white italic' : 'hover:bg-slate-800 text-slate-300'}`}
                title="In nghiêng (Italic)"
                onClick={onToggleItalic}
            >
                <Italic className="w-3.5 h-3.5" />
            </button>

            <div className="w-px h-4 bg-slate-700" />

            {/* 6. Edit Text Content Button */}
            <button
                type="button"
                className="flex items-center gap-1 px-2.5 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-medium transition-colors shadow"
                title="Sửa nội dung chữ"
                onClick={onOpenEditor}
            >
                <Type className="w-3 h-3" />
                <span>Sửa chữ</span>
            </button>
        </div>
    );
};
