import { useState, useRef, useEffect } from 'react';
import { Button } from './Button';
import { useTranslation } from 'react-i18next';

// Ngưỡng cảnh báo: trên mức này nên dùng so theo DÒNG cho nhanh.
const BIG_INPUT_CHARS = 300_000;

export default function TextCompareTab() {
  const { t } = useTranslation();
  const [textA, setTextA] = useState('');
  const [textB, setTextB] = useState('');
  const [ignoreSpaces, setIgnoreSpaces] = useState(false);
  const [mode, setMode] = useState<'word' | 'line'>('word');

  const [differences, setDifferences] = useState<any[] | null>(null);
  const [isComparing, setIsComparing] = useState(false);
  const [error, setError] = useState('');

  const workerRef = useRef<Worker | null>(null);

  // Dọn worker khi unmount.
  useEffect(() => () => { workerRef.current?.terminate(); workerRef.current = null; }, []);

  const totalLen = textA.length + textB.length;
  const isBig = totalLen > BIG_INPUT_CHARS;

  // Clear results when user starts editing again
  const handleTextChangeA = (val: string) => {
    setTextA(val);
    if (differences) setDifferences(null);
  };

  const handleTextChangeB = (val: string) => {
    setTextB(val);
    if (differences) setDifferences(null);
  };

  const handleCompare = () => {
    if (!textA && !textB) return;
    setError('');
    setIsComparing(true);

    // Chạy diff trong Web Worker → KHÔNG khoá main thread (spinner mượt, không đơ).
    // Tạo worker mới mỗi lần để tránh tích luỹ handler; terminate sau khi xong.
    workerRef.current?.terminate();
    const worker = new Worker(new URL('../workers/textDiffWorker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;

    worker.onmessage = (e: MessageEvent) => {
      const data = e.data;
      if (data?.ok) setDifferences(data.parts);
      else { setError(data?.error || t('tabs.textCompare:loi_khi_so_sanh_van_ban')); setDifferences(null); }
      setIsComparing(false);
      worker.terminate();
      if (workerRef.current === worker) workerRef.current = null;
    };
    worker.onerror = (err) => {
      setError('Lỗi xử lý nền: ' + (err.message || 'unknown'));
      setIsComparing(false);
      worker.terminate();
      if (workerRef.current === worker) workerRef.current = null;
    };

    worker.postMessage({ a: textA, b: textB, mode, ignoreSpaces });
  };

  const hasDifferences = differences ? differences.length > 1 || (differences.length === 1 && (differences[0].added || differences[0].removed)) : false;

  const handleClear = () => {
    setTextA('');
    setTextB('');
    setDifferences(null);
  };

  return (
    <div className="flex flex-col h-full gap-6 animate-fade-in relative w-full max-w-5xl mx-auto px-6 lg:px-10 py-8 overflow-y-auto">
      <div className="text-center mb-6">
        <h2 className="text-3xl font-bold text-slate-900 dark:text-white mb-3 transition-colors">{t('tabs.textCompare:so_sanh_van_ban')}</h2>
        <p className="text-slate-600 dark:text-zinc-400 transition-colors">
          {t('tabs.textCompare:phat_hien_ngay_lap_tuc_loi_go_sai_thua')}
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 w-full">
        <div className="flex flex-col">
          <label className="text-sm font-semibold text-slate-700 dark:text-zinc-300 mb-2 flex justify-between transition-colors">
            {t('tabs.textCompare:ban_goc_text_1')}
          </label>
          <textarea
            value={textA}
            onChange={(e) => handleTextChangeA(e.target.value)}
            className="w-full h-48 bg-white dark:!bg-zinc-800 shadow-sm border border-slate-200/60 dark:!border-white/10 rounded-xl p-4 text-slate-900 dark:!text-zinc-200 placeholder-slate-400 dark:!placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 resize-y transition-colors"
            placeholder={t('tabs.textCompare:dan_noi_dung_van_ban_goc_vao_day')}
          />
        </div>

        <div className="flex flex-col">
          <label className="text-sm font-semibold text-slate-700 dark:text-zinc-300 mb-2 flex justify-between transition-colors">
            {t('tabs.textCompare:ban_da_sua_text_2')}
          </label>
          <textarea
            value={textB}
            onChange={(e) => handleTextChangeB(e.target.value)}
            className="w-full h-48 bg-white dark:!bg-zinc-800 shadow-sm border border-slate-200/60 dark:!border-white/10 rounded-xl p-4 text-slate-900 dark:!text-zinc-200 placeholder-slate-400 dark:!placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-purple-500/50 resize-y transition-colors"
            placeholder={t('tabs.textCompare:dan_noi_dung_phien_ban_moi_vao_day')}
          />
        </div>
      </div>

      {/* Tuỳ chọn so sánh + cảnh báo văn bản lớn */}
      <div className="flex flex-wrap items-center justify-center gap-3 -mt-2">
        <div className="flex items-center gap-1 bg-slate-100 dark:bg-zinc-800 rounded-lg p-0.5 text-[12px]">
          <button onClick={() => { setMode('word'); setDifferences(null); }} className={`px-3 py-1.5 rounded-md font-semibold transition-colors ${mode === 'word' ? 'bg-white dark:bg-zinc-700 text-indigo-600 dark:text-indigo-300 shadow-sm' : 'text-slate-500 dark:text-zinc-400'}`}>{t('tabs.textCompare:so_theo_tu')}</button>
          <button onClick={() => { setMode('line'); setDifferences(null); }} className={`px-3 py-1.5 rounded-md font-semibold transition-colors ${mode === 'line' ? 'bg-white dark:bg-zinc-700 text-indigo-600 dark:text-indigo-300 shadow-sm' : 'text-slate-500 dark:text-zinc-400'}`}>{t('tabs.textCompare:so_theo_dong')}</button>
        </div>
        {isBig && (
          <span className="text-[12px] text-amber-600 dark:text-amber-400">⚠️ Văn bản lớn (~{Math.round(totalLen / 1000)}K ký tự) — nên chọn "So theo Dòng" cho nhanh.</span>
        )}
      </div>

      <div className="flex justify-center -mt-2 mb-2 relative z-10 w-full animate-fade-in">
        <Button 
          onClick={handleCompare} 
          disabled={(!textA && !textB) || isComparing}
          className="shadow-md shadow-blue-500/20 px-8 py-3 text-base font-semibold"
        >
          {isComparing ? (
            <span className="flex items-center gap-2">
              <svg className="animate-spin h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              {t('tabs.textCompare:dang_phan_tich_text')}
            </span>
          ) : (
            t('tabs.textCompare:tien_hanh_so_sanh_text')
          )}
        </Button>
      </div>

      <div className="glass-card p-6 min-h-[250px] flex flex-col transition-colors">
        <div className="flex justify-between items-end mb-4 border-b border-slate-200 dark:border-white/10 pb-4 transition-colors">
          <div>
            <h3 className="text-lg font-semibold text-slate-900 dark:text-white transition-colors">{t('tabs.textCompare:ket_qua_phan_tich')}</h3>
            {hasDifferences ? (
              <p className="text-sm text-amber-600 mt-1">{t('tabs.textCompare:phat_hien_co_su_thay_doi_noi_dung')}</p>
            ) : (
              (textA || textB) && <p className="text-sm text-emerald-600 mt-1">{t('tabs.textCompare:hai_doan_van_ban_giong_nhau_hoan_toan')}</p>
            )}
          </div>
          
          <div className="flex flex-col items-end gap-3">
            <label className="flex items-center gap-2 cursor-pointer bg-white/50 dark:bg-zinc-900/50 p-2 rounded-lg border border-slate-200 dark:!border-white/10 transition-colors shadow-sm">
              <div className={`w-4 h-4 shrink-0 rounded border flex items-center justify-center transition-colors ${ignoreSpaces ? 'bg-blue-600 border-blue-600' : 'bg-white dark:bg-zinc-800 border-slate-300 dark:border-zinc-600'}`}>
                  {ignoreSpaces && (
                      <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={4} d="M5 13l4 4L19 7" />
                      </svg>
                  )}
              </div>
              <input 
                type="checkbox" 
                checked={ignoreSpaces}
                onChange={(e) => {
                  setIgnoreSpaces(e.target.checked);
                  setDifferences(null);
                }}
                className="hidden"
              />
              <span className="text-sm text-slate-700 dark:text-zinc-300 font-medium">
                {t('tabs.textCompare:bo_qua_khoang_trong_space')}
              </span>
            </label>
            
            <div className="flex gap-2">
              <div 
                style={{ padding: '8px 16px' }}
                className="flex items-center gap-2 text-sm text-slate-600 dark:text-zinc-400 bg-slate-50 dark:bg-zinc-900 shrink-0 whitespace-nowrap rounded-lg border border-slate-200 dark:!border-white/20 transition-colors"
              >
                <span className="w-4 h-4 text-xs font-bold leading-none bg-red-100 text-red-700 border border-red-300 inline-flex items-center justify-center rounded-[3px] line-through">a</span> {t('tabs.textCompare:noi_dung_bi_xoa')}
              </div>
              <div 
                style={{ padding: '8px 16px' }}
                className="flex items-center gap-2 text-sm text-slate-600 dark:text-zinc-400 bg-slate-50 dark:bg-zinc-900 shrink-0 whitespace-nowrap rounded-lg border border-slate-200 dark:!border-white/20 transition-colors"
              >
                <span className="w-4 h-4 text-xs font-bold leading-none bg-emerald-100 text-emerald-700 border border-emerald-300 inline-flex items-center justify-center rounded-[3px] underline">b</span> {t('tabs.textCompare:noi_dung_them_moi')}
              </div>
              <Button variant="secondary" size="sm" onClick={handleClear} className="ml-2">
                Clear
              </Button>
            </div>
          </div>
        </div>

        <div className="w-full flex-1 bg-white dark:!bg-zinc-950 shadow-sm rounded-lg p-5 border border-slate-200 dark:!border-white/10 overflow-y-auto whitespace-pre-wrap font-mono text-[15px] leading-relaxed break-words text-slate-800 dark:!text-zinc-200 transition-colors">
          {isComparing ? (
            <div className="h-full flex items-center justify-center text-slate-400">
               <span className="animate-pulse">{t('tabs.textCompare:dang_ra_soat_noi_dung')}</span>
            </div>
          ) : !differences ? (
            <div className="h-full flex items-center justify-center text-slate-400 italic">
               Vui lòng nhấn "Tiến hành so sánh Text" để hiển thị kết quả...
            </div>
          ) : (
            differences.map((part, index) => {
              if (part.added) {
                return (
                  <ins
                    key={index}
                    className="bg-emerald-100 text-emerald-800 no-underline border-b-2 border-emerald-300 px-0.5 rounded-sm"
                  >
                    {part.value}
                  </ins>
                );
              }
              if (part.removed) {
                return (
                  <del
                    key={index}
                    className="bg-red-100 text-red-800 line-through opacity-80 px-0.5 rounded-sm"
                  >
                    {part.value}
                  </del>
                );
              }
              // Normal text
              return <span key={index}>{part.value}</span>;
            })
          )}
        </div>
      </div>
    </div>
  );
}
