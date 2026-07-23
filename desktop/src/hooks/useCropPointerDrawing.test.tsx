// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { useRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { useCropPointerDrawing } from './useCropPointerDrawing';
import type { CropRegionFrac } from '../lib/cropGeometry';

function Harness() {
  const containerRef = useRef<HTMLDivElement>(null);
  const marqueeRef = useRef<HTMLDivElement>(null);
  const [regions, setRegions] = useState<CropRegionFrac[]>([]);
  const drawing = useCropPointerDrawing({
    enabled: true,
    containerRef,
    marqueeRef,
    displayWidth: 200,
    displayHeight: 100,
    getCoords: (clientX, clientY) => ({ x: clientX, y: clientY }),
    onComplete: (region) => setRegions((current) => [...current, region]),
  });

  return (
    <div
      ref={containerRef}
      data-testid="crop-canvas"
      onPointerDown={drawing.onPointerDown}
      onPointerMove={drawing.onPointerMove}
      onPointerUp={drawing.onPointerUp}
      onPointerCancel={drawing.onPointerCancel}
      onLostPointerCapture={drawing.onLostPointerCapture}
    >
      <div ref={marqueeRef} data-testid="crop-marquee" />
      <output data-testid="crop-count">{regions.length}</output>
    </div>
  );
}

function installPointerCapture(element: HTMLElement) {
  const captured = new Set<number>();
  element.setPointerCapture = vi.fn((pointerId: number) => { captured.add(pointerId); });
  element.hasPointerCapture = vi.fn((pointerId: number) => captured.has(pointerId));
  element.releasePointerCapture = vi.fn((pointerId: number) => { captured.delete(pointerId); });
}

function firePointer(
  element: HTMLElement,
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  init: { pointerId: number; clientX: number; clientY: number; button?: number },
) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(event, 'pointerId', { value: init.pointerId });
  Object.defineProperty(event, 'isPrimary', { value: true });
  fireEvent(element, event);
}

describe('useCropPointerDrawing', () => {
  it('finishes one region cleanly and immediately accepts the next drag', () => {
    render(<Harness />);
    const canvas = screen.getByTestId('crop-canvas');
    installPointerCapture(canvas);

    firePointer(canvas, 'pointerdown', { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
    firePointer(canvas, 'pointermove', { pointerId: 1, clientX: 80, clientY: 45 });
    firePointer(canvas, 'pointerup', { pointerId: 1, clientX: 80, clientY: 45 });

    firePointer(canvas, 'pointerdown', { pointerId: 2, button: 0, clientX: 105, clientY: 15 });
    firePointer(canvas, 'pointermove', { pointerId: 2, clientX: 190, clientY: 80 });
    firePointer(canvas, 'pointerup', { pointerId: 2, clientX: 190, clientY: 80 });

    expect(screen.getByTestId('crop-count').textContent).toBe('2');
    expect(canvas.setPointerCapture).toHaveBeenCalledTimes(2);
    expect(canvas.releasePointerCapture).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('crop-marquee').style.display).toBe('none');
  });

  it('clears a cancelled drag so it cannot stick to the following one', () => {
    render(<Harness />);
    const canvas = screen.getByTestId('crop-canvas');
    installPointerCapture(canvas);

    firePointer(canvas, 'pointerdown', { pointerId: 7, button: 0, clientX: 10, clientY: 10 });
    firePointer(canvas, 'pointercancel', { pointerId: 7, clientX: 60, clientY: 40 });
    firePointer(canvas, 'pointerdown', { pointerId: 8, button: 0, clientX: 90, clientY: 10 });

    firePointer(canvas, 'pointerup', { pointerId: 8, clientX: 180, clientY: 90 });

    expect(screen.getByTestId('crop-count').textContent).toBe('1');
    expect(screen.getByTestId('crop-marquee').style.display).toBe('none');
  });

  it('measures layout once per drag instead of once per pointer move', () => {
    render(<Harness />);
    const canvas = screen.getByTestId('crop-canvas');
    installPointerCapture(canvas);
    const rectSpy = vi.spyOn(canvas, 'getBoundingClientRect');

    firePointer(canvas, 'pointerdown', { pointerId: 9, button: 0, clientX: 10, clientY: 10 });
    firePointer(canvas, 'pointermove', { pointerId: 9, clientX: 30, clientY: 20 });
    firePointer(canvas, 'pointermove', { pointerId: 9, clientX: 60, clientY: 40 });
    firePointer(canvas, 'pointermove', { pointerId: 9, clientX: 100, clientY: 60 });
    firePointer(canvas, 'pointerup', { pointerId: 9, clientX: 100, clientY: 60 });

    expect(rectSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('crop-count').textContent).toBe('1');
  });
});
