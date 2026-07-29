import React, { useState, useEffect, useRef } from 'react';
import { getSystemFonts } from '@/lib/api';
import { localFileUrl } from '@/lib/localFileTransport';
import { useTranslation } from 'react-i18next';

interface FontSelectorProps {
    value: string;
    fontFile?: string;
    onChange: (fontName: string, fontFile?: string) => void;
}

export const FontSelector = ({ value, fontFile, onChange }: FontSelectorProps) => {
  const { t } = useTranslation();
    const [systemFonts, setSystemFonts] = useState<{name: string, path: string}[]>([]);
    const [fontSearch, setFontSearch] = useState('');
    const [isOpen, setIsOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        getSystemFonts().then(setSystemFonts).catch(console.error);
    }, []);

    // Handle outside click
    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
                setIsOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const allFonts = [
        { name: 'Helvetica', path: '' },
        { name: 'Times-Roman', path: '' },
        { name: 'Courier', path: '' },
        ...systemFonts
    ];

    const filteredFonts = allFonts
        .filter(f => f.name.toLowerCase().includes(fontSearch.toLowerCase()))
        .slice(0, 200);

    return (
        <div className="relative w-full" ref={containerRef}>
            {/* Inject font-face for the currently selected font if it has a file */}
            {fontFile && (window as any).__TAURI_INTERNALS__ && (
                <style>{`
                    @font-face {
                        font-family: "${value}_local";
                        src: url("${localFileUrl(fontFile)}");
                    }
                `}</style>
            )}

            <input 
                value={isOpen ? fontSearch : (value || 'Helvetica')}
                onChange={(e) => {
                    setFontSearch(e.target.value);
                    if (!isOpen) setIsOpen(true);
                }}
                onFocus={() => {
                    setFontSearch('');
                    setIsOpen(true);
                }}
                placeholder={t('preprocess.fontSelector:go_de_tim_font')}
                className="w-full h-8 px-2 text-[12px] font-semibold bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-md focus:outline-none focus:border-indigo-500 transition-all"
            />
            {isOpen && (
                <div className="absolute top-full left-0 w-[250px] z-[100] mt-1 max-h-64 overflow-y-auto bg-white dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 rounded-md shadow-2xl py-1">
                    {filteredFonts.map((font, idx) => {
                        const isCustom = !!font.path;
                        const previewFontFamily = font.name === 'Helvetica' ? 'Arial' : font.name === 'Times-Roman' ? '"Times New Roman"' : font.name === 'Courier' ? 'Courier' : `"${font.name}_preview"`;
                        
                        return (
                            <div 
                                key={`${font.name}_${idx}`}
                                className="px-3 py-2 cursor-pointer hover:bg-indigo-50 dark:hover:bg-indigo-900/30 flex flex-col group border-b border-slate-100 dark:border-zinc-700/50 last:border-0"
                                onClick={(e) => {
                                    onChange(font.name, font.path || undefined);
                                    setIsOpen(false);
                                }}
                            >
                                {/* Inject preview font-face just-in-time */}
                                {isCustom && (window as any).__TAURI_INTERNALS__ && (
                                    <style>{`
                                        @font-face {
                                            font-family: "${font.name}_preview";
                                            src: url("${localFileUrl(font.path)}");
                                        }
                                    `}</style>
                                )}
                                <span className="text-[11px] font-medium text-slate-700 dark:text-zinc-300 truncate mb-1">{font.name}</span>
                                <span 
                                    className="text-[16px] text-slate-800 dark:text-zinc-100 truncate"
                                    style={{ fontFamily: previewFontFamily }}
                                >
                                    PrynX 123
                                </span>
                            </div>
                        );
                    })}
                    {filteredFonts.length === 0 && (
                        <div className="px-3 py-2 text-xs text-slate-500 italic text-center">{t('preprocess.fontSelector:khong_tim_thay_font')}</div>
                    )}
                </div>
            )}
        </div>
    );
};
