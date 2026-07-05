import React, { useEffect, useRef } from 'react';

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
}

export function GuideLayer({ scrollContainerRef, guides, draggingGuide, selectedGuideId, onGuideMouseDown, pageAnchorId }: GuideLayerProps) {
  const layerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const scroller = scrollContainerRef.current;
    const layer = layerRef.current;
    if (!scroller || !layer) return;

    let rafId: number;

    const sync = () => {
      const scrollX = scroller.scrollLeft;
      const scrollY = scroller.scrollTop;

      // Gốc "0" = mép trang thật (đo DOM), để guide bám trang y hệt thước. Nếu
      // không có anchor → dùng -scroll (tương đương hành vi cũ theo gốc cuộn).
      const layerRect = layer.getBoundingClientRect();
      const anchorEl = pageAnchorId ? document.getElementById(pageAnchorId) : null;
      let originX = -scrollX;
      let originY = -scrollY;
      if (anchorEl) {
        const pr = anchorEl.getBoundingClientRect();
        originX = pr.left - layerRect.left;
        originY = pr.top - layerRect.top;
      }

      // Update guide positions
      const guideElements = layer.querySelectorAll('.acrobat-guide');
      guideElements.forEach(el => {
        const type = el.getAttribute('data-type');
        const pos = parseFloat(el.getAttribute('data-pos') || '0');

        if (type === 'horizontal') {
          (el as HTMLElement).style.transform = `translateY(${pos + originY}px)`;
        } else {
          (el as HTMLElement).style.transform = `translateX(${pos + originX}px)`;
        }
      });

      rafId = requestAnimationFrame(sync);
    };

    rafId = requestAnimationFrame(sync);
    return () => cancelAnimationFrame(rafId);
  }, [guides, draggingGuide, scrollContainerRef, pageAnchorId]);

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
