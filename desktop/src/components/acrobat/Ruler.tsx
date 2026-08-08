import { useEffect, useRef } from 'react';

interface RulerProps {
  orientation: 'horizontal' | 'vertical';
  scrollContainerRef: React.RefObject<HTMLElement>;
  zoom: number;
  unit: 'mm' | 'cm' | 'inch';
  thickness?: number;
  onMouseDown?: (e: React.MouseEvent, orientation: 'horizontal' | 'vertical') => void;
  /** id phần tử trang dùng làm gốc "0" của thước (mép trang thật). Nếu không có
   *  hoặc không tìm thấy → fallback về gốc vùng cuộn (hành vi cũ). */
  pageAnchorId?: string;
  /** UIUX (audit 2026-07-27 §C-04): chuột phải lên thước → xoay vòng đơn vị mm→cm→inch. */
  onCycleUnit?: () => void;
  /** Tab đang hiển thị — tab nền không giữ listener/RAF của thước. */
  isActive?: boolean;
}

const DPI = 96;

export function Ruler({ orientation, scrollContainerRef, zoom, unit, thickness = 20, onMouseDown, pageAnchorId, onCycleUnit, isActive = true }: RulerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const mousePosRef = useRef<{x: number, y: number} | null>(null);

  // PERF (audit 2026-08-07 §MOTION.1): vẽ theo sự kiện. RAF chỉ gộp nhiều
  // scroll/resize/mousemove vào một frame, tuyệt đối không tự gọi lại khi idle.
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    const scroller = scrollContainerRef.current;
    if (!isActive || !canvas || !container || !scroller) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationFrameId: number | null = null;
    let observedAnchor: HTMLElement | null = null;

    const resizeObserver = new ResizeObserver(() => scheduleDraw());

    const draw = () => {
      animationFrameId = null;
      const width = container.clientWidth;
      const height = container.clientHeight;
      if (width === 0 || height === 0) return;

      // Handle HiDPI displays
      const dpr = window.devicePixelRatio || 1;
      
      // Only resize if needed to avoid flickering
      const pixelWidth = Math.max(1, Math.round(width * dpr));
      const pixelHeight = Math.max(1, Math.round(height * dpr));
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
      }
      
      ctx.save();
      ctx.scale(dpr, dpr);

      // Handle Dark Mode
      const isDark = document.documentElement.classList.contains('dark');

      // Clear background
      ctx.fillStyle = isDark ? '#121212' : '#f5f5f5'; // Dark/Light grey bg matching Acrobat
      ctx.fillRect(0, 0, width, height);

      // Inner border
      ctx.strokeStyle = isDark ? '#27272a' : '#cccccc'; // Dark/Light border
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (orientation === 'horizontal') {
        ctx.moveTo(0, thickness - 0.5);
        ctx.lineTo(width, thickness - 0.5);
      } else {
        ctx.moveTo(thickness - 0.5, 0);
        ctx.lineTo(thickness - 0.5, height);
      }
      ctx.stroke();

      ctx.strokeStyle = isDark ? '#52525b' : '#888888'; // Grey ticks
      ctx.lineWidth = 1;
      ctx.font = '10px Inter, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';

      // Calculate pixels per unit
      let pxPerUnit = 0;
      let tickStep = 1;
      let midStep = 5;
      let labelStep = 10;

      if (unit === 'inch') {
        pxPerUnit = DPI * zoom;
        if (zoom > 2) { tickStep = 1/16; midStep = 1/2; labelStep = 0.5; }
        else if (zoom < 0.5) { tickStep = 1/4; midStep = 1; labelStep = 2; }
        else { tickStep = 1/8; midStep = 1/2; labelStep = 1; }
      } else if (unit === 'cm') {
        pxPerUnit = (DPI / 2.54) * zoom;
        if (zoom > 2) { tickStep = 0.1; midStep = 0.5; labelStep = 0.5; }
        else if (zoom < 0.5) { tickStep = 1; midStep = 5; labelStep = 10; }
        else { tickStep = 0.1; midStep = 0.5; labelStep = 1; }
      } else if (unit === 'mm') {
        pxPerUnit = (DPI / 25.4) * zoom;
        if (zoom > 2) { tickStep = 1; midStep = 5; labelStep = 5; }
        else if (zoom < 0.5) { tickStep = 10; midStep = 50; labelStep = 50; }
        else { tickStep = 1; midStep = 5; labelStep = 10; }
      }

      const length = orientation === 'horizontal' ? width : height;

      // Gốc "0" của thước = mép trang thật (đo DOM mỗi frame → tự bám trang dù
      // scroll hay re-center do panel đổi width). Fallback về gốc cuộn nếu không
      // tìm thấy trang (giữ hành vi cũ). Vì draw() chạy trong RAF loop liên tục,
      // getBoundingClientRect luôn phản ánh vị trí trang hiện tại.
      const canvasRect = canvas.getBoundingClientRect();
      const anchorEl = pageAnchorId ? scroller.querySelector<HTMLElement>(`#${pageAnchorId}`) : null;
      if (anchorEl !== observedAnchor) {
        if (observedAnchor) resizeObserver.unobserve(observedAnchor);
        observedAnchor = anchorEl;
        if (observedAnchor) resizeObserver.observe(observedAnchor);
      }
      let anchorOffset: number;
      if (anchorEl) {
        const pr = anchorEl.getBoundingClientRect();
        anchorOffset = orientation === 'horizontal' ? (pr.left - canvasRect.left) : (pr.top - canvasRect.top);
      } else {
        anchorOffset = -(orientation === 'horizontal' ? scroller.scrollLeft : scroller.scrollTop);
      }

      // value tại canvas-pos p: v = (p - anchorOffset) / pxPerUnit
      const startVal = Math.floor((0 - anchorOffset) / pxPerUnit / tickStep) * tickStep;
      const endVal = Math.ceil((length - anchorOffset) / pxPerUnit / tickStep) * tickStep;
      const epsilon = tickStep * 0.01;

      ctx.beginPath();
      // Draw ticks
      for (let v = startVal; v <= endVal + epsilon; v += tickStep) {
        const pos = Math.round(v * pxPerUnit + anchorOffset) + 0.5;
        if (pos < 0 || pos > length) continue;

        const isLabel = Math.abs(v % labelStep) < epsilon || Math.abs((v % labelStep) - labelStep) < epsilon;
        const isMid = Math.abs(v % midStep) < epsilon || Math.abs((v % midStep) - midStep) < epsilon;

        let tickLength = thickness * 0.15; // minor
        if (isLabel) {
          tickLength = thickness; // major (full height for labels)
        } else if (isMid) {
          tickLength = thickness * 0.3; // mid
        }

        if (orientation === 'horizontal') {
          ctx.moveTo(pos, thickness - tickLength);
          ctx.lineTo(pos, thickness);
        } else {
          ctx.moveTo(thickness - tickLength, pos);
          ctx.lineTo(thickness, pos);
        }
      }
      ctx.stroke();

      // Draw labels in a separate pass to overlap ticks nicely
      ctx.fillStyle = isDark ? '#60a5fa' : '#4178b9'; // Acrobat Blue text
      for (let v = startVal; v <= endVal + epsilon; v += tickStep) {
        const pos = Math.round(v * pxPerUnit + anchorOffset) + 0.5;
        if (pos >= 0 && pos <= length) {
          const isLabel = Math.abs(v % labelStep) < epsilon || Math.abs((v % labelStep) - labelStep) < epsilon;
          if (isLabel) {
            const labelStr = Number(v.toFixed(2)).toString();
            if (orientation === 'horizontal') {
              ctx.textAlign = 'left';
              ctx.fillText(labelStr, pos + 3, thickness / 2);
            } else {
              ctx.save();
              ctx.translate(thickness / 2, pos + 3);
              ctx.rotate(-Math.PI / 2);
              ctx.textAlign = 'right'; // Makes the text extend downwards (in world Y) from the origin
              ctx.fillText(labelStr, 0, 0);
              ctx.restore();
            }
          }
        }
      }

      // Draw mouse indicator
      const mPos = mousePosRef.current;
      if (mPos) {
        const pos = Math.round(orientation === 'horizontal'
          ? mPos.x - scroller.scrollLeft
          : mPos.y - scroller.scrollTop) + 0.5;
        if (pos >= 0 && pos <= length) {
          ctx.beginPath();
          ctx.strokeStyle = '#ef4444'; // red-500
          ctx.lineWidth = 1.5;
          if (orientation === 'horizontal') {
            ctx.moveTo(pos, 0);
            ctx.lineTo(pos, thickness);
          } else {
            ctx.moveTo(0, pos);
            ctx.lineTo(thickness, pos);
          }
          ctx.stroke();
        }
      }
      
      ctx.restore();
    };

    function scheduleDraw() {
      if (animationFrameId === null) animationFrameId = requestAnimationFrame(draw);
    }

    const handleMouseMove = (event: MouseEvent) => {
      const rect = scroller.getBoundingClientRect();
      if (event.clientX >= rect.left && event.clientX <= rect.right
        && event.clientY >= rect.top && event.clientY <= rect.bottom) {
        mousePosRef.current = {
          x: event.clientX - rect.left + scroller.scrollLeft,
          y: event.clientY - rect.top + scroller.scrollTop,
        };
      } else {
        mousePosRef.current = null;
      }
      scheduleDraw();
    };

    const contentObserver = new MutationObserver(() => scheduleDraw());
    const themeObserver = new MutationObserver(() => scheduleDraw());
    resizeObserver.observe(container);
    resizeObserver.observe(scroller);
    contentObserver.observe(scroller, { childList: true, subtree: true });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    scroller.addEventListener('scroll', scheduleDraw, { passive: true });
    window.addEventListener('mousemove', handleMouseMove, { passive: true });
    scheduleDraw();

    return () => {
      if (animationFrameId !== null) cancelAnimationFrame(animationFrameId);
      resizeObserver.disconnect();
      contentObserver.disconnect();
      themeObserver.disconnect();
      scroller.removeEventListener('scroll', scheduleDraw);
      window.removeEventListener('mousemove', handleMouseMove);
    };
  }, [isActive, scrollContainerRef, zoom, unit, orientation, thickness, pageAnchorId]);

  return (
    <div
      ref={containerRef}
      onMouseDown={(e) => onMouseDown && onMouseDown(e, orientation)}
      // UIUX (audit 2026-07-27 §C-04): chuột phải lên thước (cả ngang lẫn dọc) → đổi đơn vị.
      onContextMenu={(e) => { if (onCycleUnit) { e.preventDefault(); onCycleUnit(); } }}
      className={`absolute top-0 left-0 bg-slate-50 dark:bg-[#121212] z-40 border-slate-300 dark:border-white/5 ${orientation === 'horizontal' ? 'w-full border-b' : 'h-full border-r'}`}
      style={{
        [orientation === 'horizontal' ? 'height' : 'width']: thickness,
        [orientation === 'horizontal' ? 'marginLeft' : 'marginTop']: orientation === 'horizontal' ? thickness : thickness // To offset the corner
      }}
    >
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
      {/* UIUX (audit 2026-07-27 §C-03): nhãn đơn vị hiện hành ở Ô VUÔNG GÓC giao 2 thước.
          Canvas thước KHÔNG phủ ô góc (container đã offset marginLeft=thickness) nên vẽ
          bằng div đặt tại left:-thickness thay vì fillText; màu/nền tái dùng class sẵn có.
          stopPropagation mousedown để click ô góc không tạo guide; click = đổi đơn vị. */}
      {orientation === 'horizontal' && (
        <div
          className="absolute top-0 flex items-center justify-center bg-slate-50 dark:bg-[#121212] border-b border-r border-slate-300 dark:border-white/5 text-slate-400 dark:text-zinc-500 select-none cursor-pointer"
          style={{ left: -thickness, width: thickness, height: thickness, fontSize: 9, lineHeight: 1 }}
          onMouseDown={(e) => { e.stopPropagation(); }}
          onClick={() => onCycleUnit && onCycleUnit()}
        >
          {unit === 'inch' ? 'in' : unit}
        </div>
      )}
    </div>
  );
}
