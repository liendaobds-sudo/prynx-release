import React, { useEffect, useMemo, useRef } from 'react';
import i18n from '../../i18n';
import { toast } from '../ui/Toast';
import type { Guide } from './GuideLayer';
import { formatDimension, type DimensionMeasurement, type MeasurementUnit } from './dimensionMath';

interface Props {
  pageAnchorId: string;
  scrollContainerRef: React.RefObject<HTMLElement>;
  guides: Guide[];
  dimensions: DimensionMeasurement[];
  activePage: number;
  pageWidthPt: number;
  pageHeightPt: number;
  unit: MeasurementUnit;
  isActive?: boolean;
  onRemove: (id: string) => void;
}

export function DimensionLayer({ pageAnchorId, scrollContainerRef, guides, dimensions, activePage, pageWidthPt, pageHeightPt, unit, isActive = true, onRemove }: Props) {
  const layerRef = useRef<HTMLDivElement>(null);
  const guideMap = useMemo(() => new Map(guides.map(g => [g.id, g])), [guides]);
  useEffect(() => {
    const layer = layerRef.current;
    const scroller = scrollContainerRef.current;
    const hasActiveDimension = dimensions.some(d => d.page === activePage);
    if (!isActive || !layer || !scroller || !hasActiveDimension) return;

    let rafId: number | null = null;
    let observedAnchor: HTMLElement | null = null;
    const resizeObserver = new ResizeObserver(() => scheduleSync());

    const sync = () => {
      rafId = null;
      const parent = layer.parentElement;
      const anchor = scroller.querySelector<HTMLElement>(`#${pageAnchorId}`);
      if (anchor !== observedAnchor) {
        if (observedAnchor) resizeObserver.unobserve(observedAnchor);
        observedAnchor = anchor;
        if (observedAnchor) resizeObserver.observe(observedAnchor);
      }
      if (anchor && parent) {
        const pr = parent.getBoundingClientRect(); const ar = anchor.getBoundingClientRect();
        layer.style.left = `${ar.left - pr.left}px`; layer.style.top = `${ar.top - pr.top}px`;
        layer.style.width = `${ar.width}px`; layer.style.height = `${ar.height}px`; layer.style.visibility = 'visible';
      } else layer.style.visibility = 'hidden';
    };

    // PERF (audit 2026-08-07 §MOTION.1): chỉ đồng bộ khi layout/scroll đổi;
    // tab idle không còn giữ vòng RAF vĩnh viễn.
    function scheduleSync() {
      if (rafId === null) rafId = requestAnimationFrame(sync);
    }

    const contentObserver = new MutationObserver(() => scheduleSync());
    resizeObserver.observe(scroller);
    resizeObserver.observe(layer);
    if (layer.parentElement) resizeObserver.observe(layer.parentElement);
    contentObserver.observe(scroller, { childList: true, subtree: true });
    scroller.addEventListener('scroll', scheduleSync, { passive: true });
    window.addEventListener('resize', scheduleSync, { passive: true });
    scheduleSync();

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
      contentObserver.disconnect();
      scroller.removeEventListener('scroll', scheduleSync);
      window.removeEventListener('resize', scheduleSync);
    };
  }, [isActive, pageAnchorId, scrollContainerRef, dimensions, activePage]);

  return <div ref={layerRef} className="absolute pointer-events-none z-[46] overflow-visible">
    {dimensions.filter(d => d.page === activePage).map(d => {
      const a = guideMap.get(d.guideAId); const b = guideMap.get(d.guideBId); if (!a || !b) return null;
      const start = Math.min(a.pos, b.pos); const end = Math.max(a.pos, b.pos); const span = end - start;
      const label = formatDimension(span * (d.orientation === 'horizontal' ? pageWidthPt : pageHeightPt), unit);
      if (d.orientation === 'horizontal') return <div key={d.id} className="absolute h-0 border-t border-rose-600 text-rose-700 dark:text-rose-400" style={{ left: `${start * 100}%`, width: `${span * 100}%`, top: `${d.offsetRatio * 100}%` }}>
        <span className="absolute left-0 -top-2 h-4 border-l border-rose-600"/><span className="absolute right-0 -top-2 h-4 border-r border-rose-600"/>
        <span className="absolute left-0 top-[-4px] border-y-[4px] border-y-transparent border-l-[6px] border-l-rose-600"/><span className="absolute right-0 top-[-4px] border-y-[4px] border-y-transparent border-r-[6px] border-r-rose-600"/>
        <button onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onRemove(d.id); toast.info(i18n.t('misc.acrobatViewer:da_xoa_dim', { defaultValue: 'Đã xóa số đo {{label}}', label })); }} className="pointer-events-auto absolute left-1/2 top-0 -translate-x-1/2 -translate-y-1/2 rounded border border-rose-300 bg-white/95 px-1.5 py-0.5 text-[11px] font-semibold shadow-sm whitespace-nowrap hover:bg-rose-50" title={i18n.t('misc.acrobatViewer:bam_de_xoa_dim', { defaultValue: 'Bấm để xóa số đo này' })} /* UIUX (audit 2026-07-27 §C-18) */>{label}</button>
      </div>;
      return <div key={d.id} className="absolute w-0 border-l border-rose-600 text-rose-700 dark:text-rose-400" style={{ top: `${start * 100}%`, height: `${span * 100}%`, left: `${d.offsetRatio * 100}%` }}>
        <span className="absolute top-0 -left-2 w-4 border-t border-rose-600"/><span className="absolute bottom-0 -left-2 w-4 border-b border-rose-600"/>
        <span className="absolute top-0 left-[-4px] border-x-[4px] border-x-transparent border-t-[6px] border-t-rose-600"/><span className="absolute bottom-0 left-[-4px] border-x-[4px] border-x-transparent border-b-[6px] border-b-rose-600"/>
        <button onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onRemove(d.id); toast.info(i18n.t('misc.acrobatViewer:da_xoa_dim', { defaultValue: 'Đã xóa số đo {{label}}', label })); }} className="pointer-events-auto absolute left-0 top-1/2 -translate-x-1/2 -translate-y-1/2 -rotate-90 rounded border border-rose-300 bg-white/95 px-1.5 py-0.5 text-[11px] font-semibold shadow-sm whitespace-nowrap hover:bg-rose-50" title={i18n.t('misc.acrobatViewer:bam_de_xoa_dim', { defaultValue: 'Bấm để xóa số đo này' })} /* UIUX (audit 2026-07-27 §C-18) */>{label}</button>
      </div>;
    })}
  </div>;
}
