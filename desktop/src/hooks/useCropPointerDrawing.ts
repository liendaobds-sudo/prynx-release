import { useCallback, useEffect, useLayoutEffect, useRef, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';

import { cropDragToFrac, type CropRegionFrac } from '../lib/cropGeometry';

interface Point {
  x: number;
  y: number;
}

interface CropPointerDrawingOptions {
  enabled: boolean;
  containerRef: RefObject<HTMLElement | null>;
  marqueeRef: RefObject<HTMLElement | null>;
  displayWidth: number;
  displayHeight: number;
  getCoords: (clientX: number, clientY: number, rect: DOMRect) => Point;
  onComplete: (region: CropRegionFrac) => void;
  onStart?: () => void;
}

interface CropPointerSession {
  pointerId: number;
  startX: number;
  startY: number;
  captureTarget: HTMLElement;
  rect: DOMRect;
}

function releaseCapture(session: CropPointerSession): void {
  try {
    if (session.captureTarget.hasPointerCapture?.(session.pointerId)) {
      session.captureTarget.releasePointerCapture(session.pointerId);
    }
  } catch {
    // The browser can release capture itself during pointercancel/unmount.
  }
}

/**
 * Pointer-captured crop drawing. A session always ends on up/cancel/blur, so a
 * completed region cannot leave stale drag state that interferes with the next.
 */
export function useCropPointerDrawing(options: CropPointerDrawingOptions) {
  const sessionRef = useRef<CropPointerSession | null>(null);
  const moveFrameRef = useRef<number | null>(null);
  const pendingMoveRef = useRef<{ pointerId: number; clientX: number; clientY: number } | null>(null);
  const optionsRef = useRef(options);
  useLayoutEffect(() => {
    optionsRef.current = options;
  }, [options]);

  const cancelMoveFrame = useCallback(() => {
    pendingMoveRef.current = null;
    if (moveFrameRef.current !== null) {
      cancelAnimationFrame(moveFrameRef.current);
      moveFrameRef.current = null;
    }
  }, []);

  const hideMarquee = useCallback(() => {
    const marquee = optionsRef.current.marqueeRef.current;
    if (marquee) {
      marquee.style.display = 'none';
      marquee.style.transform = '';
    }
  }, []);

  const cancel = useCallback(() => {
    cancelMoveFrame();
    const session = sessionRef.current;
    sessionRef.current = null;
    if (session) releaseCapture(session);
    hideMarquee();
  }, [cancelMoveFrame, hideMarquee]);

  useEffect(() => {
    if (!options.enabled) cancel();
  }, [cancel, options.enabled]);

  useEffect(() => {
    window.addEventListener('blur', cancel);
    return () => {
      window.removeEventListener('blur', cancel);
      cancel();
    };
  }, [cancel]);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const current = optionsRef.current;
    if (!current.enabled || event.button !== 0 || event.isPrimary === false) return;
    const container = current.containerRef.current;
    if (!container || current.displayWidth <= 0 || current.displayHeight <= 0) return;

    cancel();
    event.preventDefault();
    const rect = container.getBoundingClientRect();
    const coords = current.getCoords(
      event.clientX,
      event.clientY,
      rect,
    );
    const captureTarget = event.currentTarget;
    current.onStart?.();
    sessionRef.current = {
      pointerId: event.pointerId,
      startX: coords.x,
      startY: coords.y,
      captureTarget,
      rect,
    };
    try { captureTarget.setPointerCapture?.(event.pointerId); } catch { /* optional browser API */ }

    const marquee = current.marqueeRef.current;
    if (marquee) {
      marquee.style.display = 'block';
      marquee.style.left = '0px';
      marquee.style.top = '0px';
      marquee.style.transform = `translate3d(${coords.x}px, ${coords.y}px, 0)`;
      marquee.style.width = '0px';
      marquee.style.height = '0px';
    }
  }, [cancel]);

  const flushMove = useCallback(() => {
    moveFrameRef.current = null;
    const pending = pendingMoveRef.current;
    pendingMoveRef.current = null;
    const session = sessionRef.current;
    if (!pending || !session || session.pointerId !== pending.pointerId) return;

    const current = optionsRef.current;
    const coords = current.getCoords(pending.clientX, pending.clientY, session.rect);
    const left = Math.min(session.startX, coords.x);
    const top = Math.min(session.startY, coords.y);
    const marquee = current.marqueeRef.current;
    if (marquee) {
      marquee.style.transform = `translate3d(${left}px, ${top}px, 0)`;
      marquee.style.width = `${Math.abs(coords.x - session.startX)}px`;
      marquee.style.height = `${Math.abs(coords.y - session.startY)}px`;
    }
  }, []);

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const session = sessionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;

    event.preventDefault();
    pendingMoveRef.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
    };
    if (moveFrameRef.current === null) {
      moveFrameRef.current = requestAnimationFrame(flushMove);
    }
  }, [flushMove]);

  const finish = useCallback((event: ReactPointerEvent<HTMLElement>, commit: boolean) => {
    const session = sessionRef.current;
    const current = optionsRef.current;
    const container = current.containerRef.current;
    if (!session || session.pointerId !== event.pointerId) return;

    cancelMoveFrame();
    let region: CropRegionFrac | null = null;
    if (commit && container) {
      const coords = current.getCoords(
        event.clientX,
        event.clientY,
        session.rect,
      );
      region = cropDragToFrac(
        session.startX,
        session.startY,
        coords.x,
        coords.y,
        current.displayWidth,
        current.displayHeight,
      );
    }
    sessionRef.current = null;
    releaseCapture(session);
    hideMarquee();
    if (region) current.onComplete(region);
  }, [cancelMoveFrame, hideMarquee]);

  return {
    cancel,
    onPointerDown,
    onPointerMove,
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => finish(event, true),
    onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => finish(event, false),
    onLostPointerCapture: (event: ReactPointerEvent<HTMLElement>) => {
      const session = sessionRef.current;
      if (session?.pointerId === event.pointerId) cancel();
    },
  };
}
