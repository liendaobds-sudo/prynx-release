// @ts-nocheck
import React from 'react';
import { Button } from '../Button';
import { useWorkspaceStore } from '../../stores/useWorkspaceStore';
import { useImposerSettingsStore } from '../imposition-tools/useImposerSettingsStore';

interface SaveModalProps {
    handleSaveFile: (isSaveAs: boolean) => void;
    onSavePrint?: () => void;
}

export default function SaveModal({ handleSaveFile, onSavePrint }: SaveModalProps) {
    const { showSaveAsModal, setShowSaveAsModal, file, setReportMsg } = useWorkspaceStore();
    const { batchOutput } = useImposerSettingsStore();
    if (!showSaveAsModal) return null;

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="bg-[#f3f4f6] dark:bg-[#1a1a1a] rounded shadow-2xl flex flex-col w-[800px] h-[580px] overflow-hidden border border-black/20 dark:border-white/10 animate-in zoom-in-95 duration-200">

                {/* HEADER */}
                <div className="flex items-center justify-between px-6 py-4 bg-white dark:bg-[#252525] border-b border-gray-200 dark:border-gray-800">
                    <h2 className="text-[22px] font-medium text-slate-800 dark:text-gray-100">Lưu thành PDF</h2>
                    <button onClick={() => setShowSaveAsModal(false)} className="text-gray-400 hover:text-gray-800 dark:hover:text-white transition-colors focus:outline-none">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
                    </button>
                </div>

                {/* BODY */}
                <div className="flex flex-1 overflow-hidden">
                    {/* LEFT MENU */}
                    <div className="w-[200px] bg-white dark:bg-[#252525] flex flex-col pt-4 border-r border-gray-200 dark:border-gray-800">
                        <span className="text-[11px] font-bold tracking-wider text-gray-500 uppercase px-6 pb-2">NƠI LƯU</span>
                        <div className="flex flex-col">
                            <button className="px-6 py-2 text-left text-[14px] bg-[#eef2fc] text-[#0f52ba] dark:bg-[#0f52ba]/20 dark:text-[#6e9fff] transition-colors focus:outline-none border-l-2 border-[#0f52ba]">
                                Máy tính của bạn
                            </button>
                            <button className="px-6 py-2 text-left text-[14px] text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-white/5 transition-colors focus:outline-none border-l-2 border-transparent">
                                Bộ nhớ đám mây
                            </button>
                            <button className="px-6 py-2 text-left text-[14px] text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-white/5 transition-colors focus:outline-none border-l-2 border-transparent">
                                Thêm vị trí lưu
                            </button>
                        </div>
                    </div>

                    {/* RIGHT CONTENT */}
                    <div className="flex-1 flex flex-col bg-[#fcfcfc] dark:bg-[#1a1a1a] pb-6 pt-4 px-8 overflow-y-auto scroller-thin">


                        <span className="text-[16px] text-gray-700 dark:text-gray-200 mb-4">Lưu vào thư mục gần đây...</span>

                        <div className="flex flex-col gap-2">
                            {batchOutput && file === (batchOutput.mergedBlob as any) ? (
                                <>
                                    <div className="text-[12px] text-orange-600 dark:text-orange-400 font-bold mb-1">🔥 XUẤT NHIỀU KHỔ KẼM (AUTO CATALOG)</div>

                                    <button
                                        onClick={() => { setShowSaveAsModal(false); handleSaveFile(false); }}
                                        className="flex gap-4 items-center p-3 border border-[#0f52ba] bg-[#f8fbff] dark:bg-[#0f52ba]/10 rounded focus:outline-none text-left hover:bg-blue-50 dark:hover:bg-blue-900/30 transition-colors"
                                    >
                                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#0f52ba" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>
                                        <div className="flex flex-col">
                                            <span className="text-[15px] text-[#0f52ba] dark:text-[#6e9fff] font-bold">Lưu thành 1 File Gộp</span>
                                            <span className="text-[12px] text-gray-500 line-clamp-1">Giữ nguyên định dạng gộp {batchOutput.docs.length} tấm kẽm để dễ gửi khách duyệt.</span>
                                        </div>
                                    </button>

                                    <button
                                        onClick={async () => {
                                            setShowSaveAsModal(false);
                                            batchOutput.docs.forEach((doc, idx) => {
                                                setTimeout(() => {
                                                    const url = URL.createObjectURL(doc.blob);
                                                    const a = document.createElement('link');
                                                    a.href = url;
                                                    (a as any).download = doc.filename;
                                                    a.click();
                                                    URL.revokeObjectURL(url);
                                                }, idx * 500);
                                            });
                                            setReportMsg(prev => prev + '\n\n📥 Đã gửi lệnh tải rời nhiều file thành công!');
                                        }}
                                        className="flex gap-4 items-center p-3 border border-emerald-500 bg-emerald-50 dark:bg-emerald-500/10 rounded focus:outline-none text-left hover:bg-emerald-100 dark:hover:bg-emerald-500/20 transition-colors mt-2"
                                    >
                                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                                        <div className="flex flex-col">
                                            <span className="text-[15px] text-emerald-700 dark:text-emerald-400 font-bold">Tải rời từng kẽm (Download {batchOutput.docs.length} files)</span>
                                            <span className="text-[12px] text-gray-500 line-clamp-1">Trình duyệt sẽ tự động xả nhiều file PDF riêng lẻ vào thư mục Downloads của bạn.</span>
                                        </div>
                                    </button>
                                </>
                            ) : (
                                <button
                                    onClick={() => { setShowSaveAsModal(false); handleSaveFile(false); }}
                                    className="flex gap-4 items-center p-3 border border-[#0f52ba] bg-[#f8fbff] dark:bg-[#0f52ba]/10 rounded focus:outline-none text-left"
                                >
                                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#0f52ba" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M2 19a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2H4a2 2 0 0 0-2 2z" /></svg>
                                    <div className="flex flex-col">
                                        <span className="text-[15px] text-gray-800 dark:text-gray-100">Downloads</span>
                                        <span className="text-[12px] text-gray-500">C:\Users\Target\Downloads</span>
                                    </div>
                                </button>
                            )}
                        </div>
                    </div>
                </div>

                {/* FOOTER */}
                <div className="flex items-center justify-end px-6 py-4 bg-white dark:bg-[#252525] border-t border-gray-200 dark:border-gray-800 shrink-0">

                    <div className="flex gap-3">
                        <button
                            onClick={() => setShowSaveAsModal(false)}
                            className="px-6 py-2 min-w-[90px] border border-gray-300 dark:border-gray-600 rounded-md text-[14px] font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors focus:outline-none"
                        >
                            Hủy bỏ
                        </button>
                        {onSavePrint && (
                            <button
                                onClick={() => { setShowSaveAsModal(false); onSavePrint(); }}
                                className="px-6 py-2 border border-rose-400 text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-500/10 rounded-md text-[14px] font-medium transition-colors focus:outline-none flex items-center gap-1.5"
                                title="Lưu tách từng tờ in (và file bế) ra thư mục, đặt tên theo report"
                            >
                                🖨️ Lưu file in (tách lẻ)
                            </button>
                        )}
                        <button
                            onClick={() => { setShowSaveAsModal(false); handleSaveFile(true); }}
                            className="px-6 py-2 bg-[#0f52ba] hover:bg-[#0c439c] text-white rounded-md text-[14px] font-medium transition-colors shadow-sm focus:outline-none flex items-center justify-center"
                        >
                            Chọn Thư mục Khác...
                        </button>
                    </div>
                </div>

            </div>
        </div>
    );
}
