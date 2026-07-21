import type { PageResult } from '@/stores/comparisonStore';
import { getResultImageUrl } from '@/lib/api';
import { useTranslation } from 'react-i18next';

interface DiffSidebarProps {
  results: PageResult[];
  summary: Record<string, unknown> | null;
  onPageClick: (pageNum: number) => void;
  activePage?: number;
  onPlayGif: (url: string) => void;
  onRegionClick?: (page: number, nx: number, ny: number) => void;
}

export default function DiffSidebar({
  results,
  summary,
  onPageClick,
  activePage,
  onPlayGif,
  onRegionClick,
}: DiffSidebarProps) {
  const { t } = useTranslation();
  const totalDiffs = results.reduce((sum, r) => sum + r.diff_count, 0);
  const pagesPass = results.filter((r) => r.status === 'pass').length;
  const pagesFail = results.filter((r) => r.status === 'fail').length;
  const pagesWarn = results.filter((r) => r.status === 'warning').length;

  return (
    <div className="w-80 flex flex-col h-full border-l border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-zinc-900/50 transition-colors">
      {/* Summary header */}
      <div className="p-4 border-b border-slate-200 dark:border-white/10 transition-colors">
        <h3 className="font-bold text-slate-900 dark:text-white text-sm mb-3 transition-colors">{t('misc.diffSidebar:ket_qua_so_sanh')}</h3>

        {/* Status counts */}
        <div className="flex gap-2 mb-3">
          <div className="flex-1 bg-green-500/10 rounded-lg p-2 text-center">
            <div className="text-lg font-bold text-green-400">{pagesPass}</div>
            <div className="text-xs text-green-300">{t('misc.diffSidebar:y_het')}</div>
          </div>
          <div className="flex-1 bg-red-500/10 rounded-lg p-2 text-center">
            <div className="text-lg font-bold text-red-400">{pagesFail}</div>
            <div className="text-xs text-red-300">{t('misc.diffSidebar:thay_doi')}</div>
          </div>
          <div className="flex-1 bg-amber-500/10 rounded-lg p-2 text-center">
            <div className="text-lg font-bold text-amber-400">{pagesWarn}</div>
            <div className="text-xs text-amber-300">{t('misc.diffSidebar:lech_nhe')}</div>
          </div>
        </div>

        <div className="text-xs text-slate-500 dark:text-zinc-400 transition-colors space-y-1">
          <div className={totalDiffs === 0 ? 'text-green-600 dark:text-green-400 font-semibold' : 'text-red-600 dark:text-red-400 font-semibold'}>
            {totalDiffs === 0
              ? 'ĐẠT kiểm in — không có lỗi'
              : `${totalDiffs} lỗi in — KHÔNG ĐẠT (sai 1 chi tiết cũng là lỗi)`}
          </div>
          <div>
            {results.length} trang
            {summary && typeof summary.visual_similarity === 'number' && (
              <span className="text-slate-400 dark:text-zinc-500">
                {' '}· giống hình (tham khảo): {summary.visual_similarity as number}%
              </span>
            )}
            {summary && typeof summary.visual_similarity !== 'number' && typeof summary.average_similarity === 'number' && (
              <span className="text-slate-400 dark:text-zinc-500">
                {' '}· giống hình (tham khảo): {summary.average_similarity as number}%
              </span>
            )}
          </div>
        </div>
      </div>

      {Array.isArray(summary?.llm_warnings) && summary.llm_warnings.length > 0 && (
        <div className="p-4 border-b border-amber-200 dark:border-amber-500/20 bg-amber-50 dark:bg-amber-900/20 transition-colors">
          <h4 className="text-sm font-bold text-amber-700 dark:text-amber-400 mb-2 flex items-center gap-2 transition-colors">
            <span>✨</span> {t('misc.diffSidebar:canh_bao_chinh_ta_ai')}
          </h4>
          <ul className="space-y-1.5 scrollbar-thin overflow-y-auto max-h-40 pr-2">
            {(summary.llm_warnings as string[]).map((warning, idx) => (
              <li key={idx} className="text-xs text-amber-800 dark:text-amber-300 leading-relaxed flex items-start gap-1.5 transition-colors">
                <span className="text-amber-500 mt-0.5 mt-[-1px]">▸</span>
                <span>{warning}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Page list */}
      <div className="flex-1 overflow-y-auto">
        {results.map((page) => (
          <div
            key={page.page_number}
            onClick={() => onPageClick(page.page_number)}
            className={`sidebar-item flex items-start gap-3 p-3 transition-colors cursor-pointer border-b border-slate-100 dark:border-white/5 ${
              activePage === page.page_number ? 'bg-blue-50 dark:bg-blue-900/20 border-l-4 border-blue-500 dark:border-blue-400' : 'hover:bg-slate-100 dark:hover:bg-zinc-800/50'
            }`}
          >
            {/* Status dot */}
            <div
              className={`mt-1 w-3 h-3 rounded-full flex-shrink-0 ${
                page.status === 'pass'
                  ? 'bg-green-500'
                  : page.status === 'fail'
                  ? 'bg-red-500'
                  : 'bg-amber-500'
              }`}
            />
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm font-medium text-slate-900 dark:text-zinc-200 transition-colors">
                  Trang {page.page_number}
                  {page.matched_b_page && page.matched_b_page !== page.page_number && (
                    <span className="ml-1 text-[10px] text-indigo-500">
                      {'\u2192 T\u1edd b\u00ecnh '}{page.matched_b_page}
                    </span>
                  )}
                </span>
                <span
                  className={`badge ${
                    page.status === 'pass'
                      ? 'badge-pass'
                      : page.status === 'fail'
                      ? 'badge-fail'
                      : 'badge-warning'
                  }`}
                >
                  {page.similarity_score.toFixed(1)}%
                </span>
              </div>
              {/* 🎞️ Inline GIF Preview - Click to enlarge */}
              {page.gif_image_url && (
                <div 
                  className="mt-3 relative group cursor-pointer overflow-hidden rounded-lg border border-slate-200 hover:border-slate-400 transition-colors"
                  onClick={(e) => {
                    e.stopPropagation();
                    onPlayGif(getResultImageUrl(page.gif_image_url!));
                  }}
                  title={t('misc.diffSidebar:nhan_de_xem_toan_man_hinh')}
                >
                  <img 
                    src={getResultImageUrl(page.gif_image_url)} 
                    alt="Animation Preview" 
                    className="w-full h-auto object-cover opacity-90 group-hover:opacity-100 transition-opacity"
                  />
                  
                  {/* Overlay Play Icon */}
                  <div className="absolute inset-0 bg-black/20 group-hover:bg-black/40 flex items-center justify-center transition-colors">
                    <div className="w-8 h-8 rounded-full bg-black/60 border border-white/20 flex items-center justify-center backdrop-blur-sm shadow-lg group-hover:scale-110 transition-transform">
                      <span className="text-white text-xs">⛶</span>
                    </div>
                  </div>
                  
                  <div className="absolute bottom-1 left-1 bg-black/60 px-2 py-0.5 rounded text-[10px] text-white backdrop-blur-md border border-white/10">
                    GIF
                  </div>
                </div>
              )}

              {page.diff_regions.length > 0 && (
                <div className="text-xs text-slate-500 dark:text-zinc-400 transition-colors">
                  Phát hiện {page.diff_count} điểm khác biệt
                </div>
              )}

              {page.is_imposition_mode && (
                <div className="mt-2 bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-500/20 text-indigo-700 dark:text-indigo-400 text-xs px-2 py-1.5 rounded-md flex items-center justify-center transition-colors">
                  <span className="mr-1">🤖</span> AI Imposition Mode
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
