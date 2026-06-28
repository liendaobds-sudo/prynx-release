import { useState, useEffect, useCallback } from 'react';
import { ChevronDown, HelpCircle } from 'lucide-react';
import { authenticatedFetch, getApiUrl, uploadPDF } from '../../lib/api';
import { useWorkingPdf } from '../../hooks/useWorkingPdf';
import { recipeRecorder } from '../../lib/recipe/RecipeRecorder';
import ToolHelpModal from '../ToolHelpModal';
import type { ToolHelp } from '../../lib/toolHelp';

interface Props {
  pdfFile: File | null;
  onFileFixed?: (blob: Blob, name: string) => void;
}

// Nội dung hướng dẫn chi tiết (mở bằng nút "Hướng dẫn").
const COLOR_HELP: ToolHelp = {
  title: 'Chuyển đổi màu — Hướng dẫn',
  tagline: 'Đưa file về đúng hệ màu để in, tránh lệch màu so với thiết kế.',
  sections: [
    {
      heading: 'Chọn loại chuyển đổi',
      items: [
        'RGB → CMYK: màn hình dùng màu RGB, còn máy in offset dùng 4 mực C-M-Y-K. Bước này đổi RGB sang CMYK để in ra đúng màu. Hầu như luôn cần khi gửi nhà in.',
        'Chuyển sang đen trắng (Grayscale): bỏ toàn bộ màu, in một màu đen. Chỉ dùng khi CỐ Ý in trắng đen — thao tác này sẽ làm mất màu cả tài liệu.',
        'Spot Color → CMYK: đổi màu pha (Pantone, HKS…) sang 4 màu CMYK tương đương. Dùng khi in 4 màu, không tách bản màu pha riêng.',
      ],
    },
    {
      heading: 'Hồ sơ màu đích (Profile)',
      items: [
        'Tự động: giữ hồ sơ màu có sẵn trong file. Chọn khi bạn không chắc.',
        'In offset (FOGRA39): tiêu chuẩn màu phổ biến cho giấy couché. Chọn khi nhà in yêu cầu chuẩn này.',
      ],
    },
    {
      heading: 'Giữ chữ & nét đen in 1 màu đen',
      items: [
        'Khi đổi sang CMYK, chữ đen dễ bị pha từ cả 4 mực (gọi là "rich black").',
        'Lúc in, 4 mực lệch nhau vài phần mm sẽ tạo viền màu nhòe quanh chữ (lỗi chồng màu).',
        'Bật mục này để chữ/nét đen chỉ in bằng mực đen K → sắc nét, không lệch viền. Nên BẬT cho in offset.',
      ],
    },
    {
      heading: 'Tùy chọn nâng cao — Cách quy đổi màu',
      items: [
        'Giữ màu gần nhất: cân bằng, hợp hầu hết ấn phẩm (mặc định).',
        'Tốt cho ảnh: giữ chuyển sắc mượt, hợp hình chụp.',
        'Rực rỡ: ưu tiên màu tươi, hợp biểu đồ / mảng màu đồ họa.',
        'Tuyệt đối: giữ nguyên giá trị màu, dùng khi làm proof thử màu.',
        'Không rõ thì cứ để mặc định.',
      ],
    },
  ],
  printNote: 'RGB→CMYK và "giữ đen 100% K" quan trọng nhất cho IN OFFSET. In nhanh (kỹ thuật số) thường tự xử lý nên ít cần chỉnh.',
};

// Giải thích SÂU cho khu "Tùy chọn nâng cao" (chuẩn màu + cách quy đổi).
const ADVANCED_HELP: ToolHelp = {
  title: 'Chuẩn màu & Cách quy đổi — Giải thích kỹ',
  tagline: 'Phần kỹ thuật cho người làm in chuyên. Không rành cứ để mặc định.',
  sections: [
    {
      heading: 'Chuẩn màu đích (ICC profile) là gì?',
      items: [
        'Mỗi điều kiện in (loại máy + loại giấy + loại mực) cho ra màu hơi khác nhau. "Chuẩn màu" là bộ thông số mô tả cách một điều kiện in tái tạo màu, giúp màu in ra sát với dự kiến.',
        'Tự động: app dùng hồ sơ màu sẵn có trong file (hoặc mặc định an toàn). Hợp gần như mọi trường hợp.',
        'In offset (FOGRA39): chuẩn châu Âu cho giấy couché (giấy láng), còn gọi ISO Coated. Chọn khi nhà in nói rõ cần FOGRA39.',
        'Chọn "sai" chuẩn thường chỉ lệch màu nhẹ, không làm hỏng file. Không chắc → để Tự động.',
      ],
    },
    {
      heading: 'Cách quy đổi màu (Rendering Intent) là gì?',
      items: [
        'Màu trên màn hình (RGB) rộng hơn màu in được (CMYK). Khi đổi sang CMYK có những màu "ngoài tầm in". Mục này quyết định cách ép các màu đó vào vùng in được.',
        'Giữ màu gần nhất: giữ đúng màu in được, màu ngoài tầm kéo về gần nhất. Cân bằng — mặc định cho tờ rơi, bao bì, văn bản.',
        'Tốt cho ảnh: nén cả dải màu cho mượt, giữ chuyển sắc tự nhiên. Hợp ảnh chụp.',
        'Rực rỡ: ưu tiên màu tươi/đậm, ít quan tâm chính xác. Hợp biểu đồ, mảng màu đồ họa.',
        'Tuyệt đối: giữ y nguyên giá trị màu (kể cả nền giấy). Dùng khi làm proof thử màu / mô phỏng loại giấy khác.',
      ],
    },
    {
      heading: 'Tóm lại nên chọn gì?',
      items: [
        'Đa số: để cả hai ở MẶC ĐỊNH (Tự động + Giữ màu gần nhất).',
        'In ảnh là chính: thử "Tốt cho ảnh".',
        'Nhà in yêu cầu FOGRA39: chọn "In offset (FOGRA39)".',
      ],
    },
  ],
  printNote: 'Các tùy chọn này ảnh hưởng độ chính xác màu khi IN OFFSET. In nhanh ít bị ảnh hưởng.',
};

const CONVERSIONS = [
  { id: 'rgb_to_cmyk', icon: '🔵→🟡', label: 'RGB → CMYK', desc: 'Chuyển toàn bộ object RGB sang không gian màu CMYK. Bắt buộc cho in offset truyền thống.' },
  { id: 'gray_to_cmyk', icon: '⬛→⬜', label: 'Chuyển sang đen trắng (Grayscale)', desc: 'Chuyển toàn bộ nội dung sang thang xám (DeviceGray) để in một màu đen. Lưu ý: thao tác này LÀM MẤT MÀU của cả tài liệu.' },
  { id: 'spot_to_cmyk', icon: '🟣→🟡', label: 'Spot Color → CMYK', desc: 'Chuyển tất cả màu pha (Pantone, HKS, custom spot) sang CMYK tương đương. Cần cho in 4 màu.' },
];

const ICC_PROFILES = [
  { value: 'auto', label: 'Tự động (khuyên dùng)', desc: 'Cứ để cái này nếu bạn không rành.' },
  { value: 'fogra39', label: 'In offset (FOGRA39)', desc: 'Chỉ chọn khi nhà in yêu cầu chuẩn này.' },
];

const RENDERING_INTENTS = [
  { value: 'relative', label: 'Giữ màu gần nhất', desc: 'Mặc định — hợp hầu hết ấn phẩm' },
  { value: 'perceptual', label: 'Tốt cho ảnh', desc: 'Duy trì quan hệ giữa các màu' },
  { value: 'saturation', label: 'Rực rỡ', desc: 'Hợp biểu đồ / đồ họa' },
  { value: 'absolute', label: 'Tuyệt đối', desc: 'Proofing, giữ nguyên giá trị' },
];

export default function ConvertColorsTool({ pdfFile, onFileFixed }: Props) {
  const [fileId, setFileId] = useState('');
  const [selectedConversions, setSelectedConversions] = useState<Set<string>>(new Set(['rgb_to_cmyk']));
  const [profile, setProfile] = useState('auto');
  const [intent, setIntent] = useState('relative');
  const [preserveBlack, setPreserveBlack] = useState(true);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState('');
  const [isConversionsOpen, setIsConversionsOpen] = useState(true);
  const [isProfileOpen, setIsProfileOpen] = useState(true);
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showAdvHelp, setShowAdvHelp] = useState(false);

  useEffect(() => { setFileId(''); setResult(null); setError(''); }, [pdfFile]);

  const getWorkingFile = useWorkingPdf();
  const ensureUploaded = useCallback(async (): Promise<string> => {
    if (fileId) return fileId;
    if (!pdfFile) throw new Error('Chưa có file PDF');
    const r = await uploadPDF((await getWorkingFile()) || pdfFile);
    setFileId(r.id);
    return r.id;
  }, [fileId, pdfFile, getWorkingFile]);

  const toggleConversion = (id: string) => {
    setSelectedConversions(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const run = async () => {
    if (selectedConversions.size === 0) return;
    setRunning(true); setResult(null); setError('');
    try {
      const fid = await ensureUploaded();
      recipeRecorder.noteOperation('convertcolors', {
        conversions: Array.from(selectedConversions),
        icc_profile: profile,
        rendering_intent: intent,
        preserve_black: preserveBlack,
      });
      const res = await authenticatedFetch(`${getApiUrl()}/preflight/convert-colors`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          file_id: fid,
          conversions: Array.from(selectedConversions),
          icc_profile: profile,
          rendering_intent: intent,
          preserve_black: preserveBlack,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setResult(data);
        if (data.output_filename && onFileFixed) {
          const dl = await authenticatedFetch(`${getApiUrl()}/preflight/download/${data.output_filename}`);
          onFileFixed(await dl.blob(), data.output_filename);
        }
      } else { recipeRecorder.discardPending(); setError(data.error || data.detail || 'Thất bại'); }
    } catch (e: any) { recipeRecorder.discardPending(); setError(e.message); }
    setRunning(false);
  };

  if (!pdfFile) return <div className="text-[11px] text-slate-400 text-center py-6">Vui lòng mở file PDF trước</div>;

  return (
    <div className="space-y-4 animate-in fade-in duration-200">

      {/* ═══ NÚT HƯỚNG DẪN ═══ */}
      <button onClick={() => setShowHelp(true)}
        className="w-full flex items-center justify-center gap-1.5 text-[12px] font-medium text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-500/10 py-2 rounded-lg border border-indigo-200 dark:border-indigo-800/50 transition-colors">
        <HelpCircle className="w-4 h-4" /> Chưa rõ? Xem hướng dẫn &amp; giải thích
      </button>

      {showHelp && <ToolHelpModal help={COLOR_HELP} icon="🎨" onClose={() => setShowHelp(false)} />}
      {showAdvHelp && <ToolHelpModal help={ADVANCED_HELP} icon="🎛️" onClose={() => setShowAdvHelp(false)} />}

      {/* ═══ SECTION 1: CHỌN CHUYỂN ĐỔI ═══ */}
      <div className="space-y-2">
        <div className="flex items-center justify-between mb-3">
          <button onClick={() => setIsConversionsOpen(!isConversionsOpen)} className="flex items-center gap-2 group">
            <span className="text-[11px] font-bold text-slate-600 tracking-wide group-hover:text-slate-800 dark:group-hover:text-zinc-300 transition-colors">
              🎨 CHUYỂN ĐỔI MÀU
            </span>
            <ChevronDown className={`w-3 h-3 text-slate-400 transition-transform duration-200 ${isConversionsOpen ? 'rotate-180' : ''}`} />
          </button>
          <button onClick={() => {
            if (selectedConversions.size === CONVERSIONS.length) setSelectedConversions(new Set());
            else setSelectedConversions(new Set(CONVERSIONS.map(c => c.id)));
          }} className="text-[11px] font-medium text-blue-500 hover:text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-500/10 px-2 py-0.5 rounded transition-colors">
            {selectedConversions.size === CONVERSIONS.length ? 'Bỏ chọn hết' : 'Chọn tất cả'}
          </button>
        </div>

        {isConversionsOpen && (
          <div className="animate-in slide-in-from-top-2 fade-in duration-200">
            <div className="space-y-1.5">
              {CONVERSIONS.map((c, i) => {
                const sel = selectedConversions.has(c.id);
                return (
                  <button key={c.id} onClick={() => toggleConversion(c.id)}
                    className={`w-full text-left px-3 py-2 rounded-lg border text-[12px] transition-all flex items-center gap-2
                      ${sel ? 'border-teal-500 bg-teal-500/10 font-semibold text-teal-700 dark:text-teal-300' : 'border-slate-200 dark:border-white/10 hover:bg-slate-50 dark:hover:bg-zinc-800 text-slate-600 dark:text-zinc-400'}`}>
                    <span className="text-sm shrink-0">{c.icon}</span>
                    <span className="truncate flex-1">{c.label}</span>

                    {/* Tooltip */}
                    <div className="relative group/tooltip flex items-center justify-center w-4 h-4 rounded-full bg-slate-100 dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 text-[10px] text-slate-500 shrink-0 hover:bg-slate-200 dark:hover:bg-zinc-700 transition-colors"
                      onClick={(e) => e.stopPropagation()}>
                      ?
                      <div className="absolute bottom-full mb-2 right-0 w-max max-w-[220px] p-3 bg-slate-800 dark:bg-zinc-700 text-white text-[11px] font-normal leading-relaxed rounded-lg shadow-xl opacity-0 invisible group-hover/tooltip:opacity-100 group-hover/tooltip:visible transition-all z-[100] pointer-events-none text-left whitespace-normal break-words">
                        {c.desc}
                        <div className="absolute top-full right-3 w-2 h-2 bg-slate-800 dark:bg-zinc-700 transform rotate-45 -mt-1" />
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* ═══ SECTION 2: ICC & RENDERING ═══ */}
      <div className="h-px w-full bg-slate-200 dark:bg-zinc-700" />
      <div className="space-y-2">
        <button onClick={() => setIsProfileOpen(!isProfileOpen)} className="w-full flex items-center justify-center gap-2 group">
          <span className="text-[11px] font-bold text-slate-600 tracking-wide group-hover:text-slate-800 dark:group-hover:text-zinc-300 transition-colors">
            🎯 TIÊU CHUẨN MÀU IN
          </span>
          <ChevronDown className={`w-3 h-3 text-slate-400 transition-transform duration-200 ${isProfileOpen ? 'rotate-180' : ''}`} />
        </button>

        {isProfileOpen && (
          <div className="animate-in slide-in-from-top-2 fade-in duration-200 space-y-3">
            {/* Giữ đen 100% K — thứ DUY NHẤT cần quan tâm ở màn hình chính */}
            <button onClick={() => setPreserveBlack(!preserveBlack)}
              className={`w-full text-left px-3 py-2.5 rounded-lg border text-[12px] transition-all flex items-start gap-2.5
                ${preserveBlack ? 'border-teal-500 bg-teal-500/10 text-teal-700 dark:text-teal-300' : 'border-slate-200 dark:border-white/10 hover:bg-slate-50 dark:hover:bg-zinc-800 text-slate-600 dark:text-zinc-400'}`}>
              <div className={`mt-0.5 w-4 h-4 rounded border flex items-center justify-center transition-colors shrink-0 ${preserveBlack ? 'bg-teal-500 border-teal-500' : 'bg-white dark:bg-zinc-800 border-slate-300 dark:border-zinc-500'}`}>
                {preserveBlack && <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={4} d="M5 13l4 4L19 7" /></svg>}
              </div>
              <div className="flex-1">
                <span className="font-semibold block">Giữ chữ &amp; nét đen in 1 màu đen</span>
                <span className="text-[11px] text-slate-500 dark:text-zinc-400 block leading-snug mt-0.5">Chữ/nét đen chỉ in bằng mực đen (K), không pha 4 màu → tránh lệch viền khi in. Nên bật cho in offset.</span>
              </div>
            </button>

            {/* Tùy chọn nâng cao: chuẩn màu + cách quy đổi (mặc định ẩn — đa số không cần) */}
            <div className="rounded-lg border border-slate-200 dark:border-white/10 overflow-hidden">
              <div className="w-full flex items-center justify-between pr-2 hover:bg-slate-50 dark:hover:bg-zinc-800/50 transition-colors">
                <button onClick={() => setIsAdvancedOpen(!isAdvancedOpen)}
                  className="flex items-center gap-2 flex-1 px-3 py-2 text-[11px] font-bold text-slate-500 text-left">
                  <span>Tùy chọn nâng cao (chuẩn màu)</span>
                  <ChevronDown className={`w-3 h-3 transition-transform duration-200 ${isAdvancedOpen ? 'rotate-180' : ''}`} />
                </button>
                <button onClick={() => setShowAdvHelp(true)} title="Giải thích chi tiết"
                  className="shrink-0 w-6 h-6 flex items-center justify-center rounded-full text-slate-400 hover:text-indigo-600 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors">
                  <HelpCircle className="w-4 h-4" />
                </button>
              </div>
              {isAdvancedOpen && (
                <div className="p-3 pt-1 space-y-3 animate-in slide-in-from-top-1 fade-in duration-200">
                  {/* Chuẩn màu đích (ICC) */}
                  <div>
                    <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block mb-1">Chuẩn màu đích</span>
                    <p className="text-[11px] text-slate-400 dark:text-zinc-500 mb-2 leading-snug">Không rành thì cứ để <b>Tự động</b>.</p>
                    <div className="grid grid-cols-2 gap-1.5">
                      {ICC_PROFILES.map((p) => {
                        const sel = profile === p.value;
                        return (
                          <button key={p.value} onClick={() => setProfile(p.value)}
                            className={`text-left px-2.5 py-1.5 rounded-lg border text-[11px] transition-all
                              ${sel ? 'border-teal-500 bg-teal-500/10 font-semibold text-teal-700 dark:text-teal-300' : 'border-slate-200 dark:border-white/10 hover:bg-slate-50 dark:hover:bg-zinc-800 text-slate-600 dark:text-zinc-400'}`}>
                            <span className="block font-medium truncate">{p.label}</span>
                            <span className="text-[10px] text-slate-400 block leading-snug mt-0.5">{p.desc}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Cách quy đổi màu (Rendering Intent) */}
                  <div>
                    <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block mb-2">Cách quy đổi màu</span>
                    <div className="grid grid-cols-2 gap-1.5">
                      {RENDERING_INTENTS.map((ri) => {
                        const sel = intent === ri.value;
                        return (
                          <button key={ri.value} onClick={() => setIntent(ri.value)}
                            className={`text-left px-2.5 py-1.5 rounded-lg border text-[11px] transition-all
                              ${sel ? 'border-teal-500 bg-teal-500/10 font-semibold text-teal-700 dark:text-teal-300' : 'border-slate-200 dark:border-white/10 hover:bg-slate-50 dark:hover:bg-zinc-800 text-slate-600 dark:text-zinc-400'}`}>
                            <span className="block font-medium truncate">{ri.label}</span>
                            <span className="text-[10px] text-slate-400 block leading-snug mt-0.5">{ri.desc}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ═══ EXECUTE ═══ */}
      <div className="h-px w-full bg-slate-200 dark:bg-zinc-700" />
      {selectedConversions.size > 0 && (
        <button onClick={run} disabled={running}
          className="w-full px-2.5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-[12px] font-bold shadow-sm transition-colors disabled:opacity-50 flex items-center justify-center gap-2 border border-indigo-700">
          {running ? (<><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Đang chuyển đổi...</>) : (<>🚀 Thực thi ({selectedConversions.size})</>)}
        </button>
      )}

      {/* ═══ RESULT ═══ */}
      {result && (
        <div className="p-3 rounded-lg border bg-emerald-500/10 border-emerald-500/20">
          <h4 className="text-[11px] font-bold mb-1 text-emerald-600">✅ Thành công!</h4>
          {result.log?.map((l: any, i: number) => (
            <p key={i} className="text-[10px] text-slate-600 dark:text-zinc-300">{l.status === 'success' ? '✅' : '❌'} {l.message} ({l.duration_ms}ms)</p>
          ))}
          <p className="text-[10px] text-emerald-600 dark:text-emerald-400 mt-1 font-medium">✅ File đã được cập nhật trên Viewer.</p>
        </div>
      )}

      {error && <div className="mt-3 text-[11px] text-red-500 bg-red-50 dark:bg-red-900/20 px-3 py-2 rounded border border-red-200 dark:border-red-800/50">{error}</div>}
    </div>
  );
}
