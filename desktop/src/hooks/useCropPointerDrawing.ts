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
  const optionsRef = useRef(options);
  useLayoutEffect(() => {
    optionsRef.current = options;
  }, [options]);

  const hideMarquee = useCallback(() => {
    const marquee = optionsRef.current.marqueeRef.current;
    if (marquee) marquee.style.display = 'none';
  }, []);

  const cancel = useCallback(() => {
    const session = sessionRef.current;
    sessionRef.current = null;
    if (session) releaseCapture(session);
    hideMarquee();
  }, [hideMarquee]);

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
    const coords = current.getCoords(
      event.clientX,
      event.clientY,
      container.getBoundingClientRect(),
    );
    const captureTarget = event.currentTarget;
    current.onStart?.();
    sessionRef.current = {
      pointerId: event.pointerId,
      startX: coords.x,
      startY: coords.y,
      captureTarget,
    };
    try { captureTarget.setPointerCapture?.(event.pointerId); } catch { /* optional browser API */ }

    const marquee = current.marqueeRef.current;
    if (marquee) {
      marquee.style.display = 'block';
      marquee.style.left = `${coords.x}px`;
      marquee.style.top = `${coords.y}px`;
      marquee.style.width = '0px';
      marquee.style.height = '0px';
    }
  }, [cancel]);

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const session = sessionRef.current;
    const current = optionsRef.current;
    const container = current.containerRef.current;
    if (!session || session.pointerId !== event.pointerId || !container) return;

    event.preventDefault();
    const coords = current.getCoords(
      event.clientX,
      event.clientY,
      container.getBoundingClientRect(),
    );
    const marquee = current.marqueeRef.current;
    if (marquee) {
      marquee.style.left = `${Math.min(session.startX, coords.x)}px`;
      marquee.style.top = `${Math.min(session.startY, coords.y)}px`;
      marquee.style.width = `${Math.abs(coords.x - session.startX)}px`;
      marquee.style.height = `${Math.abs(coords.y - session.startY)}px`;
    }
  }, []);

  const finish = useCallback((event: ReactPointerEvent<HTMLElement>, commit: boolean) => {
    const session = sessionRef.current;
    const current = optionsRef.current;
    const container = current.containerRef.current;
    if (!session || session.pointerId !== event.pointerId) return;

    let region: CropRegionFrac | null = null;
    if (commit && container) {
      const coords = current.getCoords(
        event.clientX,
        event.clientY,
        container.getBoundingClientRect(),
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
  }, [hideMarquee]);

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
