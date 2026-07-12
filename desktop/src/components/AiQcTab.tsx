import { useState } from 'react';
import { authenticatedFetch, getApiUrl, prepareFileForUpload } from '../lib/api';
import { useComparisonStore } from '../stores/comparisonStore';
import { Button } from './Button';
import { toast } from './ui/Toast';
import { useTranslation } from 'react-i18next';

export default function AiQcTab() {
  const { t } = useTranslation();
  const { llmMode, cloudApiKey } = useComparisonStore();
  const [textInput, setTextInput] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [aiOutput, setAiOutput] = useState<string[]>([]);
  const [isExtracting, setIsExtracting] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  const handleRunQc = async () => {
    if (!textInput.trim()) {
      toast.info(t('tabs.aiQc:vui_long_nhap_van_ban_can_soat_loi'));
      return;
    }

    if (llmMode === 'off') {
      toast.info(t('tabs.aiQc:vui_long_chon_mot_mo_hinh_ai_gemini'));
      return;
    }

    if (['gemini', 'openai', 'deepseek'].includes(llmMode) && !cloudApiKey) {
      toast.info(t('tabs.aiQc:vui_long_nhap_api_key_cho_cloud_ai_da'));
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
        setAiOutput([t('tabs.aiQc:khong_phat_hien_thay_loi_chinh_ta_hay')]);
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
      if (!response.ok) throw new Error(t('tabs.aiQc:khong_the_trich_xuat_file_vui_long_kiem'));
      const data = await response.json();
      if (data.text) {
        setTextInput(data.text);
      } else {
         toast.info(t('tabs.aiQc:khong_tim_thay_ky_tu_nao_trong_file_nay'));
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
        <h1 className="text-3xl font-bold text-slate-900 dark:text-white mb-3 transition-colors">{t('tabs.aiQc:tro_ly_phan_tich_van_ban_ai_qc')}</h1>
        <p className="text-slate-600 dark:text-zinc-400 transition-colors max-w-2xl mx-auto">
          {t('tabs.aiQc:su_dung_tri_tue_nhan_tao_llms_nhu_mot')}
        </p>
      </div>

      <div className="flex flex-col lg:flex-row gap-6 h-full min-h-0 pb-8 flex-1">
        {/* LEFT COLUMN: INPUT */}
        <div className="w-full lg:w-1/2 flex flex-col flex-shrink-0 min-h-0 gap-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-700 dark:text-zinc-300">{t('tabs.aiQc:van_ban_dau_vao_text_pdf_image')}</h3>
            <div className="flex items-center gap-2">
              <label className="cursor-pointer">
                <span className="px-3 py-1.5 text-xs font-semibold bg-emerald-500 text-white rounded border border-emerald-600/50 hover:bg-emerald-600 shadow-sm transition-colors block">
                  {t('tabs.aiQc:tai_file_len')}
                </span>
                <input type="file" className="hidden" accept=".pdf,.png,.jpg,.jpeg" onChange={(e) => {
                  if (e.target.files && e.target.files[0]) handleFileUpload(e.target.files[0]);
                  e.target.value = ''; // Reset to allow re-upload
                }} />
              </label>
              <Button variant="secondary" size="sm" onClick={() => setTextInput('')}>{t('tabs.aiQc:lam_moi')}</Button>
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
                  {t('tabs.aiQc:buong_chuot_de_nap_file')}
                </span>
              </div>
            )}
            {isExtracting && (
              <div className="absolute inset-0 bg-white/80 dark:bg-zinc-900/80 backdrop-blur-sm z-10 flex flex-col items-center justify-center">
                 <div className="w-8 h-8 rounded-full border-2 border-emerald-500 border-t-transparent animate-spin mb-3"></div>
                 <span className="text-sm font-semibold text-emerald-600 dark:text-emerald-400">{t('tabs.aiQc:dang_quet_ocr_pdf')}</span>
              </div>
            )}
            <textarea
              value={textInput}
              onChange={(e) => setTextInput(e.target.value)}
              className="w-full h-full min-h-[250px] bg-white dark:!bg-zinc-800 shadow-none border-0 p-4 text-slate-900 dark:!text-zinc-200 placeholder-slate-400 dark:!placeholder-zinc-500 focus:outline-none focus:ring-0 resize-none transition-colors"
              placeholder={t('tabs.aiQc:co_the_go_text_dan_ctrl_v_hoac_bam_tai')}
            />
          </div>

          <Button 
            variant="primary" 
            className="w-full mt-2 h-12 text-sm font-bold shadow-lg shadow-indigo-500/20"
            onClick={handleRunQc}
            disabled={isProcessing}
          >
            {isProcessing ? t('tabs.aiQc:dang_nho_ai_phan_tich') : t('tabs.aiQc:thuc_thi_ai_tim_loi_analyze')}
          </Button>
        </div>

        {/* RIGHT COLUMN: CONFIG & OUTPUT */}
        <div className="w-full lg:w-1/2 flex flex-col gap-6 flex-shrink-0 lg:overflow-y-auto">
          
          {/* AI Status Hint */}
          <div className="bg-slate-50 dark:bg-zinc-900/50 p-4 rounded-xl border border-slate-200 dark:border-white/10 shrink-0">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-[15px] font-semibold text-indigo-600 dark:text-indigo-400 mb-1">{t('tabs.aiQc:dong_co_ai')}</h3>
                <p className="text-xs text-slate-500 dark:text-zinc-400">
                  {llmMode === 'off' ? t('tabs.aiQc:chua_cau_hinh_vui_long_mo_cai_dat_de') : `✅ Đang dùng: ${llmMode === 'gemini' ? 'Google Gemini' : llmMode === 'openai' ? 'OpenAI ChatGPT' : 'DeepSeek'}`}
                </p>
              </div>
              {llmMode !== 'off' && (
                <span className="inline-flex items-center px-2.5 py-1 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 rounded-md text-xs font-semibold border border-emerald-500/20">
                  {t('tabs.aiQc:san_sang')}
                </span>
              )}
            </div>
          </div>

          {/* AI Result Box */}
          <div className="flex-1 flex flex-col bg-white dark:!bg-zinc-950 shadow-sm rounded-lg p-5 border border-slate-200 dark:!border-white/10 min-h-[250px] overflow-hidden">
            <h3 className="text-[15px] font-semibold text-slate-800 dark:text-zinc-200 mb-3 pb-2 border-b border-slate-100 dark:!border-white/5">
              {t('tabs.aiQc:bao_cao_soat_loi_tu_ai')}
            </h3>
            <div className="flex-1 overflow-y-auto space-y-3 pr-2">
              {aiOutput.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full opacity-50 text-slate-500 dark:text-zinc-400">
                  <span className="text-4xl mb-3">🤖</span>
                  <p>{t('tabs.aiQc:bao_cao_cua_ai_proofreader_se_hien_thi')}</p>
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
