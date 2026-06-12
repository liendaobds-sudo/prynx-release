import React, { useEffect, useRef } from 'react';

export type Guide = { id: string; type: 'horizontal' | 'vertical'; pos: number };

interface GuideLayerProps {
  scrollContainerRef: React.RefObject<HTMLElement>;
  guides: Guide[];
  draggingGuide: Guide | null;
  selectedGuideId: string | null;
  onGuideMouseDown: (e: React.MouseEvent, guide: Guide) => void;
}

export function GuideLayer({ scrollContainerRef, guides, draggingGuide, selectedGuideId, onGuideMouseDown }: GuideLayerProps) {
  const layerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const scroller = scrollContainerRef.current;
    const layer = layerRef.current;
    if (!scroller || !layer) return;

    let rafId: number;

    const sync = () => {
      const scrollX = scroller.scrollLeft;
      const scrollY = scroller.scrollTop;

      // Update guide positions
      const guideElements = layer.querySelectorAll('.acrobat-guide');
      guideElements.forEach(el => {
        const type = el.getAttribute('data-type');
        const pos = parseFloat(el.getAttribute('data-pos') || '0');

        if (type === 'horizontal') {
          (el as HTMLElement).style.transform = `translateY(${pos - scrollY}px)`;
        } else {
          (el as HTMLElement).style.transform = `translateX(${pos - scrollX}px)`;
        }
      });

      rafId = requestAnimationFrame(sync);
    };

    rafId = requestAnimationFrame(sync);
    return () => cancelAnimationFrame(rafId);
  }, [guides, draggingGuide, scrollContainerRef]);

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
