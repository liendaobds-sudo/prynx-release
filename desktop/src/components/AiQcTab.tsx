import { useState } from 'react';
import { authenticatedFetch, getApiUrl, prepareFileForUpload } from '../lib/api';
import { useComparisonStore } from '../stores/comparisonStore';
import { Button } from './Button';
import { toast } from './ui/Toast';

export default function AiQcTab() {
  const { llmMode, cloudApiKey } = useComparisonStore();
  const [textInput, setTextInput] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [aiOutput, setAiOutput] = useState<string[]>([]);
  const [isExtracting, setIsExtracting] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  const handleRunQc = async () => {
    if (!textInput.trim()) {
      toast.info("Vui lòng nhập văn bản cần soát lỗi.");
      return;
    }

    if (llmMode === 'off') {
      toast.info("Vui lòng chọn một Mô hình AI (Gemini/OpenAI/Ollama) trong danh sách cấu hình.");
      return;
    }

    if (['gemini', 'openai', 'deepseek'].includes(llmMode) && !cloudApiKey) {
      toast.info("Vui lòng nhập API Key cho Cloud AI đã chọn.");
      return;
    }

    setIsProcessing(true);
    setAiOutput([]);
    try {
      const response = await authenticatedFetch(`${getApiUrl()}/qc/check-text`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: textInput,
          llm_mode: llmMode,
          api_key: cloudApiKey
        })
      });

      if (!response.ok) {
        throw new Error(`Lỗi máy chủ (${response.status})`);
      }

      const result = await response.json();
      if (result.errors && result.errors.length > 0) {
        setAiOutput(result.errors);
      } else {
        setAiOutput(["✅ Không phát hiện thấy lỗi chính tả hay ngữ pháp nghiêm trọng nào."]);
      }
    } catch (e: any) {
      setAiOutput([`❌ Đã xảy ra lỗi khi gọi AI: ${e.message}`]);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleFileUpload = async (file: File) => {
    setIsExtracting(true);
    try {
      const realFile = await prepareFileForUpload(file);
      const formData = new FormData();
      formData.append('file', realFile, file.name);
      const response = await authenticatedFetch(`${getApiUrl()}/qc/extract-text`, {
        method: 'POST',
        body: formData,
      });
      if (!response.ok) throw new Error("Không thể trích xuất File. Vui lòng kiểm tra lại định dạng.");
      const data = await response.json();
      if (data.text) {
        setTextInput(data.text);
      } else {
         toast.info("Không tìm thấy ký tự nào trong file này (có thể file rỗng hoặc bị mã hoá).");
      }
    } catch (e: any) {
      toast.error(`Lỗi trích xuất: ${e.message}`);
    } finally {
      setIsExtracting(false);
    }
  };

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };
  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    // Only set false if leaving the main container
    if (e.currentTarget === e.target) {
      setIsDragging(false);
    }
  };
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFileUpload(e.dataTransfer.files[0]);
    }
  };

  return (
    <div className="w-full max-w-6xl mx-auto h-full flex flex-col gap-6 animate-fade-in pl-8 pr-4">
      {/* HEADER INFO */}
      <div className="text-center mb-2 shrink-0">
        <h1 className="text-3xl font-bold text-slate-900 dark:text-white mb-3 transition-colors">✨ Trợ lý Phân tích Văn bản (AI QC)</h1>
        <p className="text-slate-600 dark:text-zinc-400 transition-colors max-w-2xl mx-auto">
          Sử dụng Trí tuệ nhân tạo (LLMs) như một Proofreader để truy quét các lỗi chính tả tinh vi, lỗi ngữ pháp và diễn đạt sai lệch chuyên ngành trong file in.
        </p>
      </div>

      <div className="flex flex-col lg:flex-row gap-6 h-full min-h-0 pb-8 flex-1">
        {/* LEFT COLUMN: INPUT */}
        <div className="w-full lg:w-1/2 flex flex-col flex-shrink-0 min-h-0 gap-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-700 dark:text-zinc-300">Văn bản Đầu vào (Text / PDF / Image)</h3>
            <div className="flex items-center gap-2">
              <label className="cursor-pointer">
                <span className="px-3 py-1.5 text-xs font-semibold bg-emerald-500 text-white rounded border border-emerald-600/50 hover:bg-emerald-600 shadow-sm transition-colors block">
                  Tải File Lên
                </span>
                <input type="file" className="hidden" accept=".pdf,.png,.jpg,.jpeg" onChange={(e) => {
                  if (e.target.files && e.target.files[0]) handleFileUpload(e.target.files[0]);
                  e.target.value = ''; // Reset to allow re-upload
                }} />
              </label>
              <Button variant="secondary" size="sm" onClick={() => setTextInput('')}>Làm mới</Button>
            </div>
          </div>
          
          <div 
            className={`w-full flex-1 relative rounded-xl border-2 border-dashed transition-all duration-300 overflow-hidden ${isDragging ? 'border-emerald-500 bg-emerald-500/5' : 'border-slate-300 dark:border-white/20'}`}
            onDragEnter={handleDragEnter}
          >
            {/* Drag Overlay to intercept file drops cleanly over the textarea */}
            {isDragging && (
              <div 
                className="absolute inset-0 z-20 bg-emerald-500/10 backdrop-blur-[2px] flex items-center justify-center"
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
              >
                <span className="text-emerald-600 dark:text-emerald-400 font-semibold text-lg bg-white dark:bg-zinc-900 border border-emerald-500/30 px-6 py-3 rounded-xl shadow-xl pointer-events-none animate-fade-in-up">
                  👇 Buông chuột để nạp File
                </span>
              </div>
            )}
            {isExtracting && (
              <div className="absolute inset-0 bg-white/80 dark:bg-zinc-900/80 backdrop-blur-sm z-10 flex flex-col items-center justify-center">
                 <div className="w-8 h-8 rounded-full border-2 border-emerald-500 border-t-transparent animate-spin mb-3"></div>
                 <span className="text-sm font-semibold text-emerald-600 dark:text-emerald-400">Đang quét OCR / PDF...</span>
              </div>
            )}
            <textarea
              value={textInput}
              onChange={(e) => setTextInput(e.target.value)}
              className="w-full h-full min-h-[250px] bg-white dark:!bg-zinc-800 shadow-none border-0 p-4 text-slate-900 dark:!text-zinc-200 placeholder-slate-400 dark:!placeholder-zinc-500 focus:outline-none focus:ring-0 resize-none transition-colors"
              placeholder="Có thể Gõ text, Dán (Ctrl+V) hoặc Bấm Tải File (PDF/PNG) - Thậm chí Kéo Thả trực tiếp file vào khung này để AI bóc tách chữ tự động..."
            />
          </div>

          <Button 
            variant="primary" 
            className="w-full mt-2 h-12 text-sm font-bold shadow-lg shadow-indigo-500/20"
            onClick={handleRunQc}
            disabled={isProcessing}
          >
            {isProcessing ? "Đang nhờ AI phân tích..." : "Thực thi AI Tìm lỗi (Analyze)"}
          </Button>
        </div>

        {/* RIGHT COLUMN: CONFIG & OUTPUT */}
        <div className="w-full lg:w-1/2 flex flex-col gap-6 flex-shrink-0 lg:overflow-y-auto">
          
          {/* AI Status Hint */}
          <div className="bg-slate-50 dark:bg-zinc-900/50 p-4 rounded-xl border border-slate-200 dark:border-white/10 shrink-0">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-[15px] font-semibold text-indigo-600 dark:text-indigo-400 mb-1">🤖 Động cơ AI</h3>
                <p className="text-xs text-slate-500 dark:text-zinc-400">
                  {llmMode === 'off' ? '⚠️ Chưa cấu hình. Vui lòng mở Cài đặt (⚙️) để chọn Model AI và nhập API Key.' : `✅ Đang dùng: ${llmMode === 'gemini' ? 'Google Gemini' : llmMode === 'openai' ? 'OpenAI ChatGPT' : 'DeepSeek'}`}
                </p>
              </div>
              {llmMode !== 'off' && (
                <span className="inline-flex items-center px-2.5 py-1 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 rounded-md text-xs font-semibold border border-emerald-500/20">
                  Sẵn sàng
                </span>
              )}
            </div>
          </div>

          {/* AI Result Box */}
          <div className="flex-1 flex flex-col bg-white dark:!bg-zinc-950 shadow-sm rounded-lg p-5 border border-slate-200 dark:!border-white/10 min-h-[250px] overflow-hidden">
            <h3 className="text-[15px] font-semibold text-slate-800 dark:text-zinc-200 mb-3 pb-2 border-b border-slate-100 dark:!border-white/5">
              Báo cáo Soát lỗi từ AI:
            </h3>
            <div className="flex-1 overflow-y-auto space-y-3 pr-2">
              {aiOutput.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full opacity-50 text-slate-500 dark:text-zinc-400">
                  <span className="text-4xl mb-3">🤖</span>
                  <p>Báo cáo của AI Proofreader sẽ hiển thị tại đây.</p>
                </div>
              ) : (
                <ul className="list-disc pl-5 space-y-2 text-sm text-slate-800 dark:!text-zinc-200">
                  {aiOutput.map((item, idx) => (
                    <li key={idx} className={item.includes('❌') ? 'text-red-500' : item.includes('✅') ? 'text-emerald-500' : ''}>
                      {item}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
