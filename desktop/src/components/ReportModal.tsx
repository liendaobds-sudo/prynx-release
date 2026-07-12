import { createPortal } from 'react-dom';
import { useEffect } from 'react';
import { X } from 'lucide-react';
import { useComparisonStore } from '../stores/comparisonStore';
import { Button } from './Button';
import { useTranslation } from 'react-i18next';

interface ReportModalProps {
  onClose: () => void;
}

export default function ReportModal({ onClose }: ReportModalProps) {
  const { t } = useTranslation();
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const { results, summary, fileA, fileB } = useComparisonStore();

  const s = summary as Record<string, any> | null;
  const overallStatus = s?.overall_status ?? 'N/A';
  const avgSim = s?.average_similarity ?? 0;
  const totalDiffs = s?.total_diff_count ?? 0;
  const pagesPass = s?.pages_pass ?? 0;
  const pagesFail = s?.pages_fail ?? 0;
  const pagesWarning = s?.pages_warning ?? 0;
  const totalInstances = s?.total_instances ?? 0;
  const failedInstances = s?.failed_instances ?? 0;
  const llmWarnings: string[] = s?.llm_warnings ?? [];

  const statusColor =
    overallStatus === 'PASS' ? 'text-green-400' :
    overallStatus === 'FAIL' ? 'text-red-400' : 'text-amber-400';
  const statusBg =
    overallStatus === 'PASS' ? 'bg-green-500/10 border-green-500/20' :
    overallStatus === 'FAIL' ? 'bg-red-500/10 border-red-500/20' : 'bg-amber-500/10 border-amber-500/20';
  const statusText =
    overallStatus === 'PASS' ? t('misc.report:trung_khop') :
    overallStatus === 'FAIL' ? t('misc.report:sai_lech') : t('misc.report:canh_bao');

  return createPortal(
    <div className="fixed inset-0 z-modal bg-slate-900/40 dark:bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 transition-colors">
      <div role="dialog" aria-modal="true" aria-label={t('misc.report:bao_cao_kiem_tra_ban_in')} className="glass-card w-full max-w-2xl max-h-[85vh] overflow-y-auto p-6 rounded-2xl shadow-2xl relative border border-slate-200 animate-fade-in transition-colors">
        <button 
          onClick={onClose}
          className="absolute top-4 right-4 text-slate-400 dark:text-zinc-500 hover:text-slate-900 dark:hover:text-white w-8 h-8 rounded-full bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10 flex items-center justify-center transition-colors"
          title={t('misc.report:dong')}
          aria-label={t('misc.report:dong')}
        >
          <X className="w-4 h-4" />
        </button>

        <h2 className="text-xl font-bold text-slate-900 dark:text-white mb-1 transition-colors">{t('misc.report:bao_cao_kiem_tra_ban_in_2')}</h2>
        <p className="text-xs text-slate-500 dark:text-zinc-400 mb-6 transition-colors">PrynX • PrintSolutions.vn</p>

        {/* ── Overall Status Banner ── */}
        <div className={`p-4 rounded-xl border mb-5 ${statusBg} flex items-center justify-between`}>
          <div>
            <div className="text-xs text-slate-500 mb-1">{t('misc.report:ket_luan')}</div>
            <div className={`text-2xl font-bold ${statusColor}`}>{statusText}</div>
          </div>
          <div className="text-right">
            <div className="text-xs text-slate-400 mb-1">{t('misc.report:tuong_dong_trung_binh')}</div>
            <div className={`text-2xl font-bold ${avgSim >= 99 ? 'text-green-400' : avgSim >= 95 ? 'text-amber-400' : 'text-red-400'}`}>
              {avgSim.toFixed(2)}%
            </div>
          </div>
        </div>

        {/* ── File Info ── */}
        <div className="bg-slate-50 dark:bg-zinc-800/50 p-4 rounded-xl border border-slate-200 dark:border-white/10 mb-5 transition-colors">
          <h3 className="text-sm font-semibold text-blue-600 dark:text-blue-400 mb-3 transition-colors">{t('misc.report:thong_tin_tep')}</h3>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-xs text-slate-500 dark:text-zinc-400 transition-colors">{t('misc.report:tep_mau_a')}</div>
              <div className="text-sm text-slate-900 dark:text-zinc-200 truncate transition-colors">{fileA?.original_name ?? 'N/A'}</div>
              <div className="text-xs text-slate-500 dark:text-zinc-400 mt-0.5 transition-colors">{fileA?.page_count ?? 0} trang</div>
            </div>
            <div>
              <div className="text-xs text-slate-500 dark:text-zinc-400 transition-colors">{t('misc.report:tep_kiem_tra_b')}</div>
              <div className="text-sm text-slate-900 dark:text-zinc-200 truncate transition-colors">{fileB?.original_name ?? 'N/A'}</div>
              <div className="text-xs text-slate-500 dark:text-zinc-400 mt-0.5 transition-colors">{fileB?.page_count ?? 0} trang</div>
            </div>
          </div>
        </div>

        {/* ── Summary Cards ── */}
        <div className="grid grid-cols-4 gap-3 mb-5">
          <div className="bg-slate-50 dark:bg-zinc-800/50 p-3 rounded-xl border border-slate-200 dark:border-white/10 text-center transition-colors">
            <div className="text-lg font-bold text-slate-900 dark:text-white transition-colors">{results.length}</div>
            <div className="text-xs text-slate-500 dark:text-zinc-400 transition-colors">{t('misc.report:tong_trang')}</div>
          </div>
          <div className="bg-green-500/10 p-3 rounded-xl border border-green-500/20 text-center">
            <div className="text-lg font-bold text-green-400">{pagesPass}</div>
            <div className="text-xs text-green-300">{t('misc.report:dat')}</div>
          </div>
          <div className="bg-red-500/10 p-3 rounded-xl border border-red-500/20 text-center">
            <div className="text-lg font-bold text-red-400">{pagesFail}</div>
            <div className="text-xs text-red-300">{t('misc.report:loi')}</div>
          </div>
          <div className="bg-amber-500/10 p-3 rounded-xl border border-amber-500/20 text-center">
            <div className="text-lg font-bold text-amber-400">{pagesWarning}</div>
            <div className="text-xs text-amber-300">{t('misc.report:canh_bao_2')}</div>
          </div>
        </div>

        {/* ── Imposition Stats ── */}
        {totalInstances > 0 && (
          <div className="bg-indigo-50 dark:bg-indigo-900/20 p-4 rounded-xl border border-indigo-200 dark:border-indigo-500/20 mb-5 transition-colors">
            <h3 className="text-sm font-semibold text-indigo-700 dark:text-indigo-400 mb-2 transition-colors">{t('misc.report:phan_tich_binh_bai_imposition')}</h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="text-xs text-slate-500 dark:text-zinc-400 transition-colors">{t('misc.report:tong_ban_sao_phat_hien')}</div>
                <div className="text-lg font-bold text-slate-900 dark:text-white transition-colors">{totalInstances}</div>
              </div>
              <div>
                <div className="text-xs text-slate-500 dark:text-zinc-400 transition-colors">{t('misc.report:ban_sao_bi_loi')}</div>
                <div className={`text-lg font-bold ${failedInstances > 0 ? 'text-red-500' : 'text-green-600 dark:text-green-400'}`}>
                  {failedInstances}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── LLM Warnings ── */}
        {llmWarnings.length > 0 && (
          <div className="bg-amber-50 dark:bg-amber-900/20 p-4 rounded-xl border border-amber-200 dark:border-amber-500/20 mb-5 transition-colors">
            <h3 className="text-sm font-semibold text-amber-700 dark:text-amber-400 mb-2 transition-colors">{t('misc.report:canh_bao_chinh_ta_ai')}</h3>
            <ul className="space-y-1.5">
              {llmWarnings.map((w, i) => (
                <li key={i} className="text-xs text-amber-800 dark:text-amber-300 leading-relaxed flex items-start gap-1.5 transition-colors">
                  <span className="text-amber-500 mt-0.5">▸</span>
                  <span>{w}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* ── Per-Page Detail ── */}
        <div className="bg-slate-50 dark:bg-zinc-800/50 p-4 rounded-xl border border-slate-200 dark:border-white/10 mb-5 transition-colors">
          <h3 className="text-sm font-semibold text-blue-600 dark:text-blue-400 mb-3 transition-colors">{t('misc.report:chi_tiet_tung_trang')}</h3>
          <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
            {results.map((page) => {
              const pageStatus = page.status === 'pass' ? '✅' : page.status === 'fail' ? '❌' : '⚠️';
              const simColor = page.similarity_score >= 99.9 ? 'text-green-400' :
                               page.similarity_score >= 95 ? 'text-amber-400 dark:text-amber-300' : 'text-red-400 dark:text-red-300';

              return (
                <div key={page.page_number} className="flex items-center justify-between bg-white dark:bg-zinc-900 p-2.5 rounded-lg border border-slate-200 dark:border-white/10 transition-colors">
                  <div className="flex items-center gap-2">
                    <span className="text-sm">{pageStatus}</span>
                    <span className="text-sm text-slate-800 dark:text-zinc-200 font-medium transition-colors">Trang {page.page_number}</span>
                    {page.diff_count > 0 && (
                      <span className="text-xs text-red-600 dark:text-red-400 bg-red-100 dark:bg-red-900/30 px-1.5 py-0.5 rounded border border-red-200 dark:border-red-500/20">{page.diff_count} lỗi</span>
                    )}
                  </div>
                  <span className={`text-sm font-medium ${simColor}`}>
                    {page.similarity_score.toFixed(1)}%
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* ── Removed Generic Coordinate Error List ── */}
        {/* ── Close ── */}
        <div className="flex justify-end border-t border-white/5 pt-4">
          <Button 
            onClick={onClose}
            variant="secondary"
          >
            {t('misc.report:dong')}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  );
}
