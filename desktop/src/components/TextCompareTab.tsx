import { useState, useMemo } from 'react';
import { diffChars } from 'diff';
import { Button } from './Button';

export default function TextCompareTab() {
  const [textA, setTextA] = useState('');
  const [textB, setTextB] = useState('');
  const [ignoreSpaces, setIgnoreSpaces] = useState(false);

  const [differences, setDifferences] = useState<any[] | null>(null);
  const [isComparing, setIsComparing] = useState(false);

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
    setIsComparing(true);
    
    // Use setTimeout to allow the React render cycle to show the loading spinner 
    // before we block the thread with the heavy diffChars synchronous calculation.
    setTimeout(() => {
      try {
        const aToCompare = ignoreSpaces ? textA.replace(/\s+/g, '') : textA;
        const bToCompare = ignoreSpaces ? textB.replace(/\s+/g, '') : textB;
        
        const result = diffChars(aToCompare, bToCompare);
        setDifferences(result);
      } finally {
        setIsComparing(false);
      }
    }, 50);
  };

  const hasDifferences = differences ? differences.length > 1 || (differences.length === 1 && (differences[0].added || differences[0].removed)) : false;

  const handleClear = () => {
    setTextA('');
    setTextB('');
    setDifferences(null);
  };

  return (
    <div className="flex flex-col h-full gap-6 animate-fade-in relative">
      <div className="text-center mb-6">
        <h2 className="text-3xl font-bold text-slate-900 dark:text-white mb-3 transition-colors">📝 So sánh Văn bản</h2>
        <p className="text-slate-600 dark:text-zinc-400 transition-colors">
          Phát hiện ngay lập tức lỗi gõ sai, thừa thiếu ký tự giữa Copywriter và Designer.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 w-full">
        <div className="flex flex-col">
          <label className="text-sm font-semibold text-slate-700 dark:text-zinc-300 mb-2 flex justify-between transition-colors">
            Bản Gốc (Text 1)
          </label>
          <textarea
            value={textA}
            onChange={(e) => handleTextChangeA(e.target.value)}
            className="w-full h-48 bg-white dark:!bg-zinc-800 shadow-sm border border-slate-200/60 dark:!border-white/10 rounded-xl p-4 text-slate-900 dark:!text-zinc-200 placeholder-slate-400 dark:!placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 resize-y transition-colors"
            placeholder="Dán nội dung văn bản gốc vào đây..."
          />
        </div>

        <div className="flex flex-col">
          <label className="text-sm font-semibold text-slate-700 dark:text-zinc-300 mb-2 flex justify-between transition-colors">
            Bản Đã Sửa (Text 2)
          </label>
          <textarea
            value={textB}
            onChange={(e) => handleTextChangeB(e.target.value)}
            className="w-full h-48 bg-white dark:!bg-zinc-800 shadow-sm border border-slate-200/60 dark:!border-white/10 rounded-xl p-4 text-slate-900 dark:!text-zinc-200 placeholder-slate-400 dark:!placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-purple-500/50 resize-y transition-colors"
            placeholder="Dán nội dung phiên bản mới vào đây..."
          />
        </div>
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
              Đang phân tích text...
            </span>
          ) : (
            "🚀 Tiến hành so sánh Text"
          )}
        </Button>
      </div>

      <div className="glass-card p-6 min-h-[250px] flex flex-col transition-colors">
        <div className="flex justify-between items-end mb-4 border-b border-slate-200 dark:border-white/10 pb-4 transition-colors">
          <div>
            <h3 className="text-lg font-semibold text-slate-900 dark:text-white transition-colors">Kết quả phân tích</h3>
            {hasDifferences ? (
              <p className="text-sm text-amber-600 mt-1">⚠️ Phát hiện có sự thay đổi nội dung</p>
            ) : (
              (textA || textB) && <p className="text-sm text-emerald-600 mt-1">✅ Hai đoạn văn bản giống nhau hoàn toàn</p>
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
                Bỏ qua khoảng trống (Space)
              </span>
            </label>
            
            <div className="flex gap-2">
              <div 
                style={{ padding: '8px 16px' }}
                className="flex items-center gap-2 text-sm text-slate-600 dark:text-zinc-400 bg-slate-50 dark:bg-zinc-900 shrink-0 whitespace-nowrap rounded-lg border border-slate-200 dark:!border-white/20 transition-colors"
              >
                <span className="w-4 h-4 text-xs font-bold leading-none bg-red-100 text-red-700 border border-red-300 inline-flex items-center justify-center rounded-[3px] line-through">a</span> Nội dung bị xóa
              </div>
              <div 
                style={{ padding: '8px 16px' }}
                className="flex items-center gap-2 text-sm text-slate-600 dark:text-zinc-400 bg-slate-50 dark:bg-zinc-900 shrink-0 whitespace-nowrap rounded-lg border border-slate-200 dark:!border-white/20 transition-colors"
              >
                <span className="w-4 h-4 text-xs font-bold leading-none bg-emerald-100 text-emerald-700 border border-emerald-300 inline-flex items-center justify-center rounded-[3px] underline">b</span> Nội dung thêm mới
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
               <span className="animate-pulse">Đang rà soát từng ký tự...</span>
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
