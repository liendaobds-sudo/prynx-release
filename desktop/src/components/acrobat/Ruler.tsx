import { useEffect, useRef, useState } from 'react';

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
}

const DPI = 96;
const INCH_TO_MM = 25.4;

export function Ruler({ orientation, scrollContainerRef, zoom, unit, thickness = 20, onMouseDown, pageAnchorId }: RulerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const mousePosRef = useRef<{x: number, y: number} | null>(null);

  // We need to trigger a redraw when resize happens
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [scrollOffset, setScrollOffset] = useState(0);

  // Measure container
  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      for (let entry of entries) {
        setSize({
          width: entry.contentRect.width,
          height: entry.contentRect.height
        });
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  // Sync scroll
  useEffect(() => {
    const scroller = scrollContainerRef.current;
    if (!scroller) return;

    let rafId: number;
    let lastScroll = -1;
    let lastMouseX = -1;
    let lastMouseY = -1;

    const syncScroll = () => {
      let needsUpdate = false;
      const currentScroll = orientation === 'horizontal' ? scroller.scrollLeft : scroller.scrollTop;
      if (currentScroll !== lastScroll) {
        setScrollOffset(currentScroll);
        lastScroll = currentScroll;
        needsUpdate = true;
      }
      
      // We also trigger a re-render if mouse position changed significantly, but we can just use state or force a redraw.
      // Wait, since we are using React, triggering setScrollOffset causes a re-render.
      // If we want to redraw on mouse move WITHOUT React re-render, we'd need to put the drawing logic outside of the `useEffect` dependency array and just call it.
      // For simplicity, we just trigger a tiny state update to force redraw if mouse moves? No, that's bad.
      // Let's just draw in the RAF loop directly!
      
      rafId = requestAnimationFrame(syncScroll);
    };

    rafId = requestAnimationFrame(syncScroll);
    return () => cancelAnimationFrame(rafId);
  }, [scrollContainerRef, orientation]);

  // Track mouse
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!scrollContainerRef.current) return;
      const rect = scrollContainerRef.current.getBoundingClientRect();
      // Check if mouse is inside the scroll container
      if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) {
        mousePosRef.current = {
          x: e.clientX - rect.left + scrollContainerRef.current.scrollLeft,
          y: e.clientY - rect.top + scrollContainerRef.current.scrollTop
        };
      } else {
        mousePosRef.current = null;
      }
    };
    
    window.addEventListener('mousemove', handleMouseMove);
    return () => window.removeEventListener('mousemove', handleMouseMove);
  }, [scrollContainerRef]);

  // Render canvas loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationFrameId: number;

    const draw = () => {
      if (size.width === 0 || size.height === 0) {
        animationFrameId = requestAnimationFrame(draw);
        return;
      }

      // Handle HiDPI displays
      const dpr = window.devicePixelRatio || 1;
      
      // Only resize if needed to avoid flickering
      if (canvas.width !== size.width * dpr || canvas.height !== size.height * dpr) {
        canvas.width = size.width * dpr;
        canvas.height = size.height * dpr;
      }
      
      ctx.save();
      ctx.scale(dpr, dpr);

      // Handle Dark Mode
      const isDark = document.documentElement.classList.contains('dark');

      // Clear background
      ctx.fillStyle = isDark ? '#121212' : '#f5f5f5'; // Dark/Light grey bg matching Acrobat
      ctx.fillRect(0, 0, size.width, size.height);

      // Inner border
      ctx.strokeStyle = isDark ? '#27272a' : '#cccccc'; // Dark/Light border
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (orientation === 'horizontal') {
        ctx.moveTo(0, thickness - 0.5);
        ctx.lineTo(size.width, thickness - 0.5);
      } else {
        ctx.moveTo(thickness - 0.5, 0);
        ctx.lineTo(thickness - 0.5, size.height);
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

      const length = orientation === 'horizontal' ? size.width : size.height;

      // Gốc "0" của thước = mép trang thật (đo DOM mỗi frame → tự bám trang dù
      // scroll hay re-center do panel đổi width). Fallback về gốc cuộn nếu không
      // tìm thấy trang (giữ hành vi cũ). Vì draw() chạy trong RAF loop liên tục,
      // getBoundingClientRect luôn phản ánh vị trí trang hiện tại.
      const canvasRect = canvas.getBoundingClientRect();
      const anchorEl = pageAnchorId ? scrollContainerRef.current?.querySelector<HTMLElement>(`#${pageAnchorId}`) : null;
      let anchorOffset: number;
      if (anchorEl) {
        const pr = anchorEl.getBoundingClientRect();
        anchorOffset = orientation === 'horizontal' ? (pr.left - canvasRect.left) : (pr.top - canvasRect.top);
      } else {
        anchorOffset = -scrollOffset;
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
        const pos = Math.round(orientation === 'horizontal' ? mPos.x - scrollOffset : mPos.y - scrollOffset) + 0.5;
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
      
      animationFrameId = requestAnimationFrame(draw);
    };

    draw();

    return () => cancelAnimationFrame(animationFrameId);
  }, [size, scrollOffset, zoom, unit, orientation, thickness]);

  return (
    <div 
      ref={containerRef}
      onMouseDown={(e) => onMouseDown && onMouseDown(e, orientation)}
      className={`absolute top-0 left-0 bg-slate-50 dark:bg-[#121212] z-40 border-slate-300 dark:border-white/5 ${orientation === 'horizontal' ? 'w-full border-b' : 'h-full border-r'}`}
      style={{
        [orientation === 'horizontal' ? 'height' : 'width']: thickness,
        [orientation === 'horizontal' ? 'marginLeft' : 'marginTop']: orientation === 'horizontal' ? thickness : thickness // To offset the corner
      }}
    >
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
    </div>
  );
}
