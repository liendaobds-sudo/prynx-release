import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { relaunch } from '@tauri-apps/plugin-process';
import { open } from '@tauri-apps/plugin-dialog';
import { getGpuStatus, installGpuPlugin } from '../lib/api';
import { useComparisonStore } from '../stores/comparisonStore';
import { useAppSettingsStore } from '../stores/appSettingsStore';
import { TOOL_CATEGORIES, getToolsByCategory, getToolUniqueKey } from '../lib/toolRegistry';
import { Button } from './Button';
import { SettingRow } from './SettingRow';
import CutterMachinesPanel from './imposition-tools/cut-export/CutterMachinesPanel';
import { toast } from './ui/Toast';
import { Star, X } from 'lucide-react';

interface SettingsModalProps {
  onClose: () => void;
}

interface GpuStatus {
  is_gpu_available: boolean;
  current_backend: string;
  device_name: string;
  plugin_size_mb: number;
}

export default function SettingsModal({ onClose }: SettingsModalProps) {
  const { comparisonMode, setComparisonMode, isPackagingMode, setIsPackagingMode, llmMode, setLlmMode, cloudApiKey, setCloudApiKey } = useComparisonStore();
  const { 
    hiddenTools, toggleToolVisibility, favoriteTools, toggleFavoriteTool,
    defaultExportPath, setDefaultExportPath,
    autoRenameFormat, setAutoRenameFormat,
    measurementUnit, setMeasurementUnit,
    previewQuality, setPreviewQuality
  } = useAppSettingsStore();
  const [status, setStatus] = useState<GpuStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [successMsg, setSuccessMsg] = useState('');

  const [activeTab, setActiveTab] = useState<'gpu' | 'compare' | 'ai' | 'tools' | 'export' | 'workspace' | 'shortcuts' | 'cutter'>('gpu');

  useEffect(() => {
    fetchStatus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const fetchStatus = async () => {
    try {
      const data = await getGpuStatus();
      setStatus(data);
    } catch (e) {
      console.error('Failed to get GPU status:', e);
    } finally {
      setLoading(false);
    }
  };

  const handleInstall = async () => {
    setInstalling(true);
    setSuccessMsg('');
    try {
      const res = await installGpuPlugin();
      setSuccessMsg(res.message + ' ' + (res.note || ''));
      
      const updatedStatus = await getGpuStatus();
      setStatus(updatedStatus);
    } catch (err: any) {
      setSuccessMsg('Lỗi tải plugin: ' + err.message);
    } finally {
      setInstalling(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-modal bg-slate-900/40 dark:bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div role="dialog" aria-modal="true" aria-label="Cài đặt" className="glass-card w-full max-w-4xl h-[600px] flex flex-row rounded-2xl shadow-2xl relative border border-slate-200 animate-fade-in transition-colors overflow-hidden">
        
        {/* Left Sidebar */}
        <div className="w-64 bg-slate-50 dark:bg-zinc-800/80 border-r border-slate-200 dark:border-white/10 flex flex-col z-10 flex-shrink-0">
          <div className="p-5 border-b border-slate-200 dark:border-white/10 flex items-center justify-between">
             <h2 className="text-lg font-bold text-slate-900 dark:text-white transition-colors">⚙️ Preferences</h2>
          </div>
          <div className="flex-1 py-4 flex flex-col gap-1 px-3">
             <button onClick={() => setActiveTab('gpu')} className={`text-left px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${activeTab === 'gpu' ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300' : 'text-slate-600 hover:bg-slate-200/50 dark:text-zinc-400 dark:hover:bg-zinc-700/50 dark:hover:text-zinc-200'}`}>🚀 Hardware GPU</button>
             <button onClick={() => setActiveTab('compare')} className={`text-left px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${activeTab === 'compare' ? 'bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300' : 'text-slate-600 hover:bg-slate-200/50 dark:text-zinc-400 dark:hover:bg-zinc-700/50 dark:hover:text-zinc-200'}`}>🔍 Kiểm tra bản in</button>
             <button onClick={() => setActiveTab('ai')} className={`text-left px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${activeTab === 'ai' ? 'bg-purple-100 text-purple-700 dark:bg-purple-500/20 dark:text-purple-300' : 'text-slate-600 hover:bg-slate-200/50 dark:text-zinc-400 dark:hover:bg-zinc-700/50 dark:hover:text-zinc-200'}`}>🤖 Cấu hình AI</button>
             <button onClick={() => setActiveTab('tools')} className={`text-left px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${activeTab === 'tools' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300' : 'text-slate-600 hover:bg-slate-200/50 dark:text-zinc-400 dark:hover:bg-zinc-700/50 dark:hover:text-zinc-200'}`}>🛠 Quản lý công cụ</button>
             <button onClick={() => setActiveTab('export')} className={`text-left px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${activeTab === 'export' ? 'bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300' : 'text-slate-600 hover:bg-slate-200/50 dark:text-zinc-400 dark:hover:bg-zinc-700/50 dark:hover:text-zinc-200'}`}>📁 Lưu trữ & Đầu ra</button>
             <button onClick={() => setActiveTab('workspace')} className={`text-left px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${activeTab === 'workspace' ? 'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300' : 'text-slate-600 hover:bg-slate-200/50 dark:text-zinc-400 dark:hover:bg-zinc-700/50 dark:hover:text-zinc-200'}`}>📏 Không gian làm việc</button>
             <button onClick={() => setActiveTab('shortcuts')} className={`text-left px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${activeTab === 'shortcuts' ? 'bg-cyan-100 text-cyan-700 dark:bg-cyan-500/20 dark:text-cyan-300' : 'text-slate-600 hover:bg-slate-200/50 dark:text-zinc-400 dark:hover:bg-zinc-700/50 dark:hover:text-zinc-200'}`}>⌨️ Phím tắt hệ thống</button>
             <button onClick={() => setActiveTab('cutter')} className={`text-left px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${activeTab === 'cutter' ? 'bg-pink-100 text-pink-700 dark:bg-pink-500/20 dark:text-pink-300' : 'text-slate-600 hover:bg-slate-200/50 dark:text-zinc-400 dark:hover:bg-zinc-700/50 dark:hover:text-zinc-200'}`}>✂️ Máy bế</button>
          </div>
        </div>

        {/* Right Content */}
        <div className="flex-1 flex flex-col bg-white dark:bg-zinc-900/90 relative">
          <button 
            onClick={onClose}
            className="absolute top-4 right-4 text-slate-400 dark:text-zinc-500 hover:text-slate-900 dark:hover:text-white w-8 h-8 rounded-full bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10 flex items-center justify-center transition-colors z-20"
            title="Đóng"
            aria-label="Đóng"
          >
            <X className="w-4 h-4" />
          </button>
          
          <div className="flex-1 overflow-y-auto p-8 custom-scrollbar">
            {activeTab === 'gpu' && (
              <div className="animate-fade-in">
                <h3 className="text-xl font-bold text-slate-900 dark:text-white mb-2 transition-colors">Tăng tốc phần cứng (GPU)</h3>
                <p className="text-sm text-slate-500 dark:text-zinc-400 mb-8 leading-relaxed transition-colors">
                  Tăng tốc phần cứng giúp xử lý mượt mà tài liệu PDF dung lượng lớn.<br/>
                  Chuyên biệt cho hệ thống in ấn công suất cao. Yêu cầu Card đồ họa rời.
                </p>

                {loading ? (
                  <div className="text-slate-500 dark:text-zinc-400 text-sm transition-colors">Đang tải cấu hình...</div>
                ) : status ? (
                  <SettingRow 
                    variant="flat"
                    title="Lõi xử lý hiện tại"
                    description={status.is_gpu_available ? 'Card đồ họa rời (Tăng tốc phần cứng)' : 'Chế độ Tiêu chuẩn (CPU)'}
                    control={
                      status.is_gpu_available ? (
                        <span className="inline-flex items-center justify-center px-3 py-1.5 bg-green-500/10 text-green-400 rounded-md text-xs font-semibold border border-green-500/20 shadow-[0_0_10px_rgba(34,197,94,0.1)] flex-shrink-0">
                          Đã Kích Hoạt
                        </span>
                      ) : (
                        <Button
                          onClick={handleInstall}
                          disabled={installing || successMsg !== ''}
                          variant="primary"
                        >
                          {installing ? 'Đang Tải Plugin (2GB)...' : successMsg ? 'Tải Xong' : 'Cài Extension'}
                        </Button>
                      )
                    }
                  />
                ) : null}

                {successMsg && (
                  <div className="mt-3 p-3 bg-green-50 border border-green-200 rounded-lg">
                    <p className="text-xs text-green-700">✅ {successMsg}</p>
                  </div>
                )}
              </div>
            )}

            {activeTab === 'compare' && (
              <div className="animate-fade-in">
                <h3 className="text-xl font-bold text-slate-900 dark:text-white mb-2 transition-colors">Chế độ Kiểm tra Bản In</h3>
                <p className="text-sm text-slate-500 dark:text-zinc-400 mb-8 leading-relaxed transition-colors">
                  Tách lớp và so sánh chuyên sâu 4 kênh màu in công nghiệp (Cyan, Magenta, Yellow, Black) thay vì màu hiển thị (RGB).<br/>
                  Giúp phát hiện lỗi in đè, rớt màu, hoặc sai lệch màu spot, rich black.
                </p>

                <div className="flex" style={{ flexDirection: 'column' }}>
                  <SettingRow 
                    variant="flat"
                    title="Bóc Tách Khảo Sát Kênh Màu (CMYK)"
                    description="Chỉ kích hoạt khi soát lỗi sai lệch màu file xuất kẽm."
                    control={
                      <label className="relative flex items-center cursor-pointer group flex-shrink-0">
                        <input 
                          type="checkbox" 
                          className="sr-only peer" 
                          checked={comparisonMode === 'cmyk'}
                          onChange={(e) => setComparisonMode(e.target.checked ? 'cmyk' : 'full')}
                        />
                        <div className="w-11 h-6 bg-slate-200 dark:!bg-zinc-700 border border-slate-300 dark:!border-white/10 rounded-lg peer-checked:bg-blue-500 peer-checked:border-blue-600 shadow-inner transition-all duration-300"></div>
                        <div className="absolute left-[3px] top-[3px] bg-white dark:bg-zinc-200 rounded-md h-[18px] w-[18px] shadow-sm transform transition-transform duration-300 peer-checked:translate-x-[20px]"></div>
                      </label>
                    }
                  />
                  
                  <SettingRow 
                      variant="flat"
                      title="Chế độ Bao bì (Xếp Lồng Khớp)"
                      description="So sánh các trường hợp bình bài lồng nhau"
                      control={
                      <label className="relative flex items-center cursor-pointer group flex-shrink-0">
                        <input 
                          type="checkbox" 
                          className="sr-only peer" 
                          checked={isPackagingMode}
                          onChange={(e) => setIsPackagingMode(e.target.checked)}
                        />
                        <div className="w-11 h-6 bg-slate-200 dark:!bg-zinc-700 border border-slate-300 dark:!border-white/10 rounded-lg peer-checked:bg-blue-500 peer-checked:border-blue-600 shadow-inner transition-all duration-300"></div>
                        <div className="absolute left-[3px] top-[3px] bg-white dark:bg-zinc-200 rounded-md h-[18px] w-[18px] shadow-sm transform transition-transform duration-300 peer-checked:translate-x-[20px]"></div>
                      </label>
                    }
                  />
                </div>
              </div>
            )}

            {activeTab === 'ai' && (
              <div className="animate-fade-in">
                <h3 className="text-xl font-bold text-slate-900 dark:text-white mb-2 transition-colors">Cấu hình Trí tuệ Nhân tạo (AI)</h3>
                <p className="text-sm text-slate-500 dark:text-zinc-400 mb-8 leading-relaxed transition-colors">
                  Cấu hình API cho tính năng Soát lỗi Chính tả & Ngữ pháp tự động bằng AI.<br/>
                  API Key được mã hóa và lưu cục bộ trên máy tính của bạn.
                </p>

                <SettingRow 
                  variant="flat"
                  hideBorder={true}
                  className="py-1"
                  title="Lựa chọn LLM Model"
                  control={
                    <select 
                      className="bg-white dark:!bg-zinc-700 text-slate-900 dark:!text-white text-sm border border-slate-200 dark:!border-white/20 rounded-lg px-3 py-2 appearance-auto focus:ring-blue-500 transition-colors"
                      value={llmMode}
                      onChange={(e) => setLlmMode(e.target.value as any)}
                    >
                      <option value="off">Tắt / Vô hiệu hoá AI</option>
                      <option value="gemini">Google Gemini (Khuyên dùng)</option>
                      <option value="openai">OpenAI ChatGPT</option>
                      <option value="deepseek">DeepSeek Cloud API</option>
                    </select>
                  }
                />

                {['gemini', 'openai', 'deepseek'].includes(llmMode) && (
                  <div className="mt-3 flex gap-2">
                    <input 
                      type="password"
                      placeholder="Nhập API Key tương ứng..."
                      value={cloudApiKey}
                      onChange={(e) => setCloudApiKey(e.target.value)}
                      className="flex-1 bg-white dark:!bg-zinc-700 text-slate-900 dark:!text-white text-sm rounded-lg border border-slate-200 dark:!border-white/20 px-3 py-2 outline-none focus:border-indigo-500 shadow-sm transition-colors"
                    />
                    <Button 
                      variant="secondary" 
                      onClick={() => toast.success('✅ Đã lưu API Key thành công!')}
                    >
                      Lưu
                    </Button>
                  </div>
                )}
              </div>
            )}

            {activeTab === 'tools' && (
              <div className="animate-fade-in flex flex-col h-full">
                <h3 className="text-xl font-bold text-slate-900 dark:text-white mb-2 transition-colors">Quản lý hiển thị công cụ</h3>
                <p className="text-sm text-slate-500 dark:text-zinc-400 mb-8 leading-relaxed transition-colors shrink-0">
                  Bật/tắt các công cụ không sử dụng để không gian làm việc gọn gàng hơn.
                </p>

                <div className="space-y-6 flex-1 pr-4">
                  {TOOL_CATEGORIES.map(category => {
                    const tools = getToolsByCategory(category.id as any);
                    if (tools.length === 0) return null;
                    
                    return (
                      <div key={category.id} className="mb-6">
                        <div className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-3">
                          {category.title}
                        </div>
                        <div className="flex flex-col gap-1">
                          {tools.map(tool => {
                            const uniqueKey = getToolUniqueKey(tool);
                            const isHidden = hiddenTools.includes(uniqueKey);
                            
                            return (
                              <label key={uniqueKey} className="flex items-center p-2 rounded-lg hover:bg-slate-100 dark:hover:bg-zinc-800 cursor-pointer transition-colors border border-transparent hover:border-slate-200 dark:hover:border-zinc-700">
                                <div className="text-[20px] w-8 flex justify-center opacity-80">{tool.icon}</div>
                                <div className="flex-1 min-w-0 ml-2">
                                  <div className={`text-[14px] font-medium ${isHidden ? 'text-slate-400' : 'text-slate-800 dark:text-zinc-200'}`}>
                                    {tool.title}
                                  </div>
                                </div>
                                <div className="flex items-center gap-3 ml-3">
                                  <button
                                    onClick={(e) => { e.preventDefault(); toggleFavoriteTool(uniqueKey); }}
                                    className={`flex items-center justify-center transition-all duration-200 hover:scale-110 active:scale-95 ${
                                      favoriteTools.includes(uniqueKey)
                                        ? 'text-amber-400'
                                        : 'text-slate-300 dark:text-zinc-600 hover:text-amber-400'
                                    }`}
                                    title={favoriteTools.includes(uniqueKey) ? 'Bỏ yêu thích' : 'Thêm vào yêu thích'}
                                  >
                                    <Star className="w-5 h-5" fill={favoriteTools.includes(uniqueKey) ? 'currentColor' : 'none'} />
                                  </button>
                                  <div className="relative flex items-center group flex-shrink-0">
                                    <input 
                                      type="checkbox" 
                                      className="sr-only peer" 
                                      checked={!isHidden}
                                      onChange={() => toggleToolVisibility(uniqueKey)}
                                    />
                                    <div className="w-11 h-6 bg-slate-200 dark:!bg-zinc-700 border border-slate-300 dark:!border-white/10 rounded-lg peer-checked:bg-emerald-500 peer-checked:border-emerald-600 shadow-inner transition-all duration-300"></div>
                                    <div className="absolute left-[3px] top-[3px] bg-white dark:bg-zinc-200 rounded-md h-[18px] w-[18px] shadow-sm transform transition-transform duration-300 peer-checked:translate-x-[20px]"></div>
                                  </div>
                                </div>
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {activeTab === 'export' && (
              <div className="animate-fade-in flex flex-col h-full">
                <h3 className="text-xl font-bold text-slate-900 dark:text-white mb-2">Lưu trữ & Đầu ra</h3>
                <p className="text-sm text-slate-500 dark:text-zinc-400 mb-8 leading-relaxed shrink-0">
                  Cấu hình đường dẫn xuất file mặc định và tùy chỉnh hậu tố đổi tên tự động cho file xử lý xong.
                </p>

                <div className="space-y-6 flex-1 pr-4">
                  <div className="bg-slate-50 dark:bg-zinc-800/40 border border-slate-200 dark:border-white/10 rounded-xl p-5">
                    <h4 className="text-sm font-bold text-slate-800 dark:text-zinc-200 mb-4">Vị trí lưu mặc định</h4>
                    <div className="flex gap-2">
                      <div className="flex-1 bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-lg px-3 py-2 text-sm text-slate-600 dark:text-zinc-300 flex items-center overflow-hidden text-ellipsis whitespace-nowrap">
                        {defaultExportPath || 'Chưa thiết lập (Luôn hỏi khi lưu)'}
                      </div>
                      <Button 
                        variant="secondary"
                        onClick={async () => {
                          const selected = await open({
                            directory: true,
                            multiple: false,
                            title: 'Chọn thư mục lưu mặc định'
                          });
                          if (selected && typeof selected === 'string') {
                            setDefaultExportPath(selected);
                          }
                        }}
                      >
                        Chọn thư mục
                      </Button>
                      {defaultExportPath && (
                        <Button 
                          variant="destructive" 
                          onClick={() => setDefaultExportPath(null)}
                          title="Xóa mặc định"
                          aria-label="Xóa mặc định"
                        >
                          <X className="w-4 h-4" />
                        </Button>
                      )}
                    </div>
                  </div>

                  <div className="bg-slate-50 dark:bg-zinc-800/40 border border-slate-200 dark:border-white/10 rounded-xl p-5">
                    <h4 className="text-sm font-bold text-slate-800 dark:text-zinc-200 mb-4">Quy tắc tự đổi tên file (Auto-rename)</h4>
                    <input 
                      type="text" 
                      value={autoRenameFormat}
                      onChange={(e) => setAutoRenameFormat(e.target.value)}
                      placeholder="{original}_PrynX"
                      className="w-full bg-white dark:!bg-zinc-900 text-slate-900 dark:!text-white text-sm rounded-lg border border-slate-300 dark:!border-white/20 px-3 py-2 outline-none focus:border-indigo-500 shadow-sm transition-colors mb-3"
                    />
                    <div className="text-xs text-slate-500 dark:text-zinc-400 bg-slate-200/50 dark:bg-zinc-800/50 p-3 rounded-lg border border-slate-200 dark:border-white/5">
                      <span className="font-semibold block mb-1">Ví dụ:</span>
                      File gốc: <code className="text-slate-700 dark:text-zinc-300">BaoBi_KhachHang.pdf</code><br/>
                      Sau khi xử lý: <code className="text-indigo-600 dark:text-indigo-400">{autoRenameFormat.replace('{original}', 'BaoBi_KhachHang')}.pdf</code>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'workspace' && (
              <div className="animate-fade-in flex flex-col h-full">
                <h3 className="text-xl font-bold text-slate-900 dark:text-white mb-2">Không gian làm việc</h3>
                <p className="text-sm text-slate-500 dark:text-zinc-400 mb-8 leading-relaxed shrink-0">
                  Cấu hình hệ đo lường và chất lượng hiển thị hình ảnh Preview.
                </p>

                <div className="space-y-6 flex-1 pr-4">
                  <div className="bg-slate-50 dark:bg-zinc-800/40 border border-slate-200 dark:border-white/10 rounded-xl p-5">
                    <h4 className="text-sm font-bold text-slate-800 dark:text-zinc-200 mb-4">Hiển thị Thước đo (Rulers)</h4>
                    <label className="flex items-center gap-3 cursor-pointer group">
                      <div className="relative flex items-center flex-shrink-0">
                        <input 
                          type="checkbox" 
                          className="sr-only peer" 
                          checked={useAppSettingsStore.getState().showRulers}
                          onChange={useAppSettingsStore.getState().toggleRulers}
                        />
                        <div className="w-11 h-6 bg-slate-200 dark:bg-zinc-700 border border-slate-300 dark:border-white/10 rounded-full peer-checked:bg-emerald-500 peer-checked:border-emerald-600 shadow-inner transition-all duration-300"></div>
                        <div className="absolute left-[2px] top-[2px] bg-white rounded-full h-[20px] w-[20px] shadow-sm transform transition-transform duration-300 peer-checked:translate-x-[20px]"></div>
                      </div>
                      <div>
                        <div className="text-sm font-bold text-slate-900 dark:text-white">Bật vạch thước đo tọa độ</div>
                        <div className="text-[11px] text-slate-500 mt-0.5">Hiển thị thước dọc và ngang ở vùng không gian làm việc (Phím tắt: <kbd className="px-1 py-0.5 bg-slate-200 dark:bg-zinc-700 rounded border border-slate-300 dark:border-zinc-600 font-mono text-[10px]">Ctrl + R</kbd>)</div>
                      </div>
                    </label>
                  </div>

                  <div className="bg-slate-50 dark:bg-zinc-800/40 border border-slate-200 dark:border-white/10 rounded-xl p-5">
                    <h4 className="text-sm font-bold text-slate-800 dark:text-zinc-200 mb-4">Đơn vị đo lường mặc định</h4>
                    <div className="flex gap-4">
                      {['mm', 'cm', 'inch'].map(unit => (
                        <label 
                          key={unit} 
                          className="flex items-center gap-2 cursor-pointer group"
                          onClick={() => setMeasurementUnit(unit as any)}
                        >
                          <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors ${measurementUnit === unit ? 'border-amber-500' : 'border-slate-300 dark:border-zinc-600 group-hover:border-amber-400'}`}>
                            {measurementUnit === unit && <div className="w-2.5 h-2.5 rounded-full bg-amber-500" />}
                          </div>
                          <span className={`text-sm font-medium uppercase ${measurementUnit === unit ? 'text-slate-900 dark:text-white' : 'text-slate-600 dark:text-zinc-400'}`}>
                            {unit}
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>

                  <div className="bg-slate-50 dark:bg-zinc-800/40 border border-slate-200 dark:border-white/10 rounded-xl p-5">
                    <h4 className="text-sm font-bold text-slate-800 dark:text-zinc-200 mb-4">Chất lượng Preview PDF</h4>
                    <div className="flex flex-col gap-3">
                      <label 
                        className="flex items-start gap-3 cursor-pointer group p-3 rounded-lg hover:bg-slate-100 dark:hover:bg-zinc-800/50 transition-colors border border-transparent hover:border-slate-200 dark:hover:border-zinc-700"
                        onClick={() => setPreviewQuality('high')}
                      >
                        <div className={`mt-0.5 w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors shrink-0 ${previewQuality === 'high' ? 'border-amber-500' : 'border-slate-300 dark:border-zinc-600 group-hover:border-amber-400'}`}>
                          {previewQuality === 'high' && <div className="w-2.5 h-2.5 rounded-full bg-amber-500" />}
                        </div>
                        <div>
                          <div className={`text-sm font-bold ${previewQuality === 'high' ? 'text-slate-900 dark:text-white' : 'text-slate-700 dark:text-zinc-300'}`}>Chất lượng cao (Nét căng)</div>
                          <div className="text-[11px] text-slate-500 mt-0.5">Render sắc nét từng vector, dùng cho soi lỗi kỹ thuật. Cần RAM lớn.</div>
                        </div>
                      </label>
                      <label 
                        className="flex items-start gap-3 cursor-pointer group p-3 rounded-lg hover:bg-slate-100 dark:hover:bg-zinc-800/50 transition-colors border border-transparent hover:border-slate-200 dark:hover:border-zinc-700"
                        onClick={() => setPreviewQuality('fast')}
                      >
                        <div className={`mt-0.5 w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors shrink-0 ${previewQuality === 'fast' ? 'border-amber-500' : 'border-slate-300 dark:border-zinc-600 group-hover:border-amber-400'}`}>
                          {previewQuality === 'fast' && <div className="w-2.5 h-2.5 rounded-full bg-amber-500" />}
                        </div>
                        <div>
                          <div className={`text-sm font-bold ${previewQuality === 'fast' ? 'text-slate-900 dark:text-white' : 'text-slate-700 dark:text-zinc-300'}`}>Tốc độ nhanh (Low-res)</div>
                          <div className="text-[11px] text-slate-500 mt-0.5">Giảm chất lượng render để xem trước PDF hàng ngàn trang siêu mượt mà.</div>
                        </div>
                      </label>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'shortcuts' && (
              <div className="animate-fade-in flex flex-col h-full">
                <h3 className="text-xl font-bold text-slate-900 dark:text-white mb-2">Phím tắt hệ thống</h3>
                <p className="text-sm text-slate-500 dark:text-zinc-400 mb-8 leading-relaxed shrink-0">
                  Bảng tra cứu nhanh các phím tắt làm việc trong PrynX. Tính năng tự tùy biến phím tắt sẽ có mặt trong bản cập nhật sau.
                </p>

                <div className="space-y-2 flex-1 pr-4 overflow-y-auto custom-scrollbar pb-10">
                  {[
                    { keys: ['Ctrl', 'S'], desc: 'Lưu / Xuất file PDF hiện tại' },
                    { keys: ['Ctrl', 'Shift', 'S'], desc: 'Lưu đè file (Save As)' },
                    { keys: ['Ctrl', 'W'], desc: 'Đóng tab công cụ đang mở' },
                    { keys: ['Ctrl', 'K'], desc: 'Mở / Đóng bảng Cài đặt này' },
                    { keys: ['Alt', 'F4'], desc: 'Thoát phần mềm' },
                  ].map((shortcut, i) => (
                    <div key={i} className="flex items-center justify-between p-3 rounded-lg bg-slate-50 dark:bg-zinc-800/40 border border-slate-200 dark:border-white/5 hover:border-cyan-500/30 transition-colors">
                      <span className="text-sm font-medium text-slate-700 dark:text-zinc-300">{shortcut.desc}</span>
                      <div className="flex gap-1.5">
                        {shortcut.keys.map((k, j) => (
                          <kbd key={j} className="px-2 py-1 bg-white dark:bg-zinc-700 border border-slate-300 dark:border-zinc-600 rounded text-xs font-bold text-slate-600 dark:text-zinc-300 shadow-sm">
                            {k}
                          </kbd>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {activeTab === 'cutter' && <CutterMachinesPanel />}
          </div>

          {/* Footer */}
          <div className="p-4 border-t border-slate-200 dark:border-white/10 flex justify-end gap-3 flex-shrink-0 bg-slate-50 dark:bg-zinc-900/50">
            <Button 
              onClick={onClose}
              variant="primary"
            >
              Đóng
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
