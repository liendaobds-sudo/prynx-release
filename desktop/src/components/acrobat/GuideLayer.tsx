import React, { useEffect, useRef } from 'react';

// pos is normalized to the active page: 0 = top/left, 1 = bottom/right.
export type Guide = { id: string; type: 'horizontal' | 'vertical'; pos: number };

interface GuideLayerProps {
  scrollContainerRef: React.RefObject<HTMLElement>;
  guides: Guide[];
  draggingGuide: Guide | null;
  selectedGuideId: string | null;
  onGuideMouseDown: (e: React.MouseEvent, guide: Guide) => void;
  /** id phần tử trang dùng làm gốc "0" (mép trang thật). guide.pos được lưu theo
   *  toạ độ TƯƠNG ĐỐI mép trang → tự bám trang dù scroll hay re-center. Fallback
   *  về gốc cuộn nếu không có/không tìm thấy (hành vi cũ). */
  pageAnchorId?: string;
  /** Tab đang hiển thị — tab nền không giữ listener/RAF đồng bộ guide. */
  isActive?: boolean;
}

export function GuideLayer({ scrollContainerRef, guides, draggingGuide, selectedGuideId, onGuideMouseDown, pageAnchorId, isActive = true }: GuideLayerProps) {
  const layerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const scroller = scrollContainerRef.current;
    const layer = layerRef.current;
    if (!isActive || !scroller || !layer || (guides.length === 0 && !draggingGuide)) return;

    let rafId: number | null = null;
    let observedAnchor: HTMLElement | null = null;
    const resizeObserver = new ResizeObserver(() => scheduleSync());

    const sync = () => {
      rafId = null;
      const scrollX = scroller.scrollLeft;
      const scrollY = scroller.scrollTop;

      // Gốc "0" = mép trang thật (đo DOM), để guide bám trang y hệt thước. Nếu
      // không có anchor → dùng -scroll (tương đương hành vi cũ theo gốc cuộn).
      const layerRect = layer.getBoundingClientRect();
      const anchorEl = pageAnchorId ? scroller.querySelector<HTMLElement>(`#${pageAnchorId}`) : null;
      if (anchorEl !== observedAnchor) {
        if (observedAnchor) resizeObserver.unobserve(observedAnchor);
        observedAnchor = anchorEl;
        if (observedAnchor) resizeObserver.observe(observedAnchor);
      }
      let originX = -scrollX;
      let originY = -scrollY;
      let pageWidth = 1;
      let pageHeight = 1;
      if (anchorEl) {
        const pr = anchorEl.getBoundingClientRect();
        originX = pr.left - layerRect.left;
        originY = pr.top - layerRect.top;
        pageWidth = pr.width;
        pageHeight = pr.height;
      }

      // Update guide positions
      const guideElements = layer.querySelectorAll('.acrobat-guide');
      guideElements.forEach(el => {
        const type = el.getAttribute('data-type');
        const pos = parseFloat(el.getAttribute('data-pos') || '0');

        if (type === 'horizontal') {
          (el as HTMLElement).style.transform = `translateY(${pos * pageHeight + originY}px)`;
        } else {
          (el as HTMLElement).style.transform = `translateX(${pos * pageWidth + originX}px)`;
        }
      });

    };

    // PERF (audit 2026-08-07 §MOTION.1): RAF chỉ gộp event trong một frame,
    // không tự reschedule khi trang đứng yên.
    function scheduleSync() {
      if (rafId === null) rafId = requestAnimationFrame(sync);
    }

    const contentObserver = new MutationObserver(() => scheduleSync());
    resizeObserver.observe(scroller);
    resizeObserver.observe(layer);
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
  }, [isActive, guides, draggingGuide, scrollContainerRef, pageAnchorId]);

  return (
    <div ref={layerRef} className="absolute inset-0 pointer-events-none z-[45] overflow-hidden">
      {guides.map(guide => {
        const isSelected = guide.id === selectedGuideId;
        return (
          <div
            key={guide.id}
            data-id={guide.id}
            data-type={guide.type}
            data-pos={guide.pos}
            className={`acrobat-guide absolute top-0 left-0 pointer-events-auto hover:bg-cyan-400 group ${isSelected ? 'bg-blue-600 dark:bg-blue-500 z-10' : 'bg-cyan-500'}`}
            style={{
              width: guide.type === 'horizontal' ? '100%' : 1,
              height: guide.type === 'horizontal' ? 1 : '100%',
              cursor: guide.type === 'horizontal' ? 'row-resize' : 'col-resize',
              transform: guide.type === 'horizontal' ? `translateY(${guide.pos}px)` : `translateX(${guide.pos}px)`
            }}
            onMouseDown={(e) => onGuideMouseDown(e, guide)}
          >
            {/* Hitbox for easier grabbing */}
            <div className={`absolute bg-transparent ${guide.type === 'horizontal' ? '-top-1.5 h-4 w-full' : '-left-1.5 w-4 h-full'}`} />
          </div>
        );
      })}
      {draggingGuide && (
        <div
          data-id={draggingGuide.id}
          data-type={draggingGuide.type}
          data-pos={draggingGuide.pos}
          className="acrobat-guide absolute top-0 left-0 bg-cyan-400 pointer-events-none opacity-80"
          style={{
            width: draggingGuide.type === 'horizontal' ? '100%' : 1,
            height: draggingGuide.type === 'horizontal' ? 1 : '100%',
            transform: draggingGuide.type === 'horizontal' ? `translateY(${draggingGuide.pos}px)` : `translateX(${draggingGuide.pos}px)`
          }}
        />
      )}
    </div>
  );
}
