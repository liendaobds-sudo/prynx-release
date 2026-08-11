// @vitest-environment jsdom

import { act, cleanup, render } from '@testing-library/react';
import type { RefObject } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DimensionLayer } from './DimensionLayer';
import { GuideLayer, type Guide } from './GuideLayer';
import { Ruler } from './Ruler';

class FakeResizeObserver {
  constructor(callback: ResizeObserverCallback) { void callback; }
  observe() {}
  unobserve() {}
  disconnect() {}
}

class FakeMutationObserver {
  constructor(callback: MutationCallback) { void callback; }
  observe() {}
  disconnect() {}
  takeRecords(): MutationRecord[] { return []; }
}

const guides: Guide[] = [
  { id: 'a', type: 'vertical', pos: 0.2 },
  { id: 'b', type: 'vertical', pos: 0.8 },
];

describe('viewer motion lifecycle', () => {
  let callbacks: FrameRequestCallback[];
  let scroller: HTMLDivElement;
  let scrollRef: RefObject<HTMLElement>;

  beforeEach(() => {
    callbacks = [];
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    vi.stubGlobal('MutationObserver', FakeMutationObserver);
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 240 });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 20 });
    Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ left: 0, top: 0, width: 240, height: 20, right: 240, bottom: 20, x: 0, y: 0, toJSON: () => ({}) }),
    });
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      configurable: true,
      value: vi.fn(() => ({
        save: vi.fn(), restore: vi.fn(), scale: vi.fn(), fillRect: vi.fn(),
        beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
        fillText: vi.fn(), translate: vi.fn(), rotate: vi.fn(),
      })),
    });

    scroller = document.createElement('div');
    const anchor = document.createElement('div');
    anchor.id = 'page-anchor';
    scroller.appendChild(anchor);
    document.body.appendChild(scroller);
    scrollRef = { current: scroller };
  });

  afterEach(() => {
    cleanup();
    scroller.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const flushFrame = () => {
    const pending = callbacks.splice(0);
    act(() => pending.forEach(callback => callback(16)));
  };

  it('Ruler chỉ lên lịch một frame theo event và không tự lặp khi idle', () => {
    const view = render(
      <Ruler orientation="horizontal" scrollContainerRef={scrollRef} zoom={1} unit="mm" pageAnchorId="page-anchor" />,
    );

    expect(callbacks).toHaveLength(1);
    flushFrame();
    expect(callbacks).toHaveLength(0);

    act(() => {
      scroller.dispatchEvent(new Event('scroll'));
      scroller.dispatchEvent(new Event('scroll'));
    });
    expect(callbacks).toHaveLength(1);
    flushFrame();
    expect(callbacks).toHaveLength(0);

    view.unmount();
    act(() => scroller.dispatchEvent(new Event('scroll')));
    expect(callbacks).toHaveLength(0);
  });

  it('Ruler tự vẽ khi vùng cuộn xuất hiện sau lần render đầu, không cần đổi zoom', () => {
    const delayedScrollRef: RefObject<HTMLElement | null> = { current: null };
    const view = render(
      <Ruler
        orientation="horizontal"
        scrollContainerRef={delayedScrollRef}
        zoom={1}
        unit="mm"
        pageAnchorId="page-anchor"
        layoutReady={false}
      />,
    );

    expect(callbacks).toHaveLength(0);
    delayedScrollRef.current = scroller;
    view.rerender(
      <Ruler
        orientation="horizontal"
        scrollContainerRef={delayedScrollRef}
        zoom={1}
        unit="mm"
        pageAnchorId="page-anchor"
        layoutReady
      />,
    );

    expect(callbacks).toHaveLength(1);
    flushFrame();
    expect(callbacks).toHaveLength(0);
  });

  it('Guide và DIM đồng bộ một frame rồi dừng, không tự reschedule', () => {
    const guideView = render(
      <GuideLayer
        scrollContainerRef={scrollRef}
        guides={guides}
        draggingGuide={null}
        selectedGuideId={null}
        onGuideMouseDown={vi.fn()}
        pageAnchorId="page-anchor"
      />,
    );
    expect(callbacks).toHaveLength(1);
    flushFrame();
    expect(callbacks).toHaveLength(0);
    guideView.unmount();

    const dimensionView = render(
      <DimensionLayer
        pageAnchorId="page-anchor"
        scrollContainerRef={scrollRef}
        guides={guides}
        dimensions={[{ id: 'dim', page: 1, orientation: 'horizontal', guideAId: 'a', guideBId: 'b', offsetRatio: 0.5 }]}
        activePage={1}
        pageWidthPt={595}
        pageHeightPt={842}
        unit="mm"
        onRemove={vi.fn()}
      />,
    );
    expect(callbacks).toHaveLength(1);
    flushFrame();
    expect(callbacks).toHaveLength(0);
    dimensionView.unmount();
  });

  it('tab nền và overlay rỗng không tạo RAF', () => {
    render(
      <>
        <Ruler orientation="vertical" scrollContainerRef={scrollRef} zoom={1} unit="mm" isActive={false} />
        <GuideLayer
          scrollContainerRef={scrollRef}
          guides={guides}
          draggingGuide={null}
          selectedGuideId={null}
          onGuideMouseDown={vi.fn()}
          isActive={false}
        />
        <DimensionLayer
          pageAnchorId="page-anchor"
          scrollContainerRef={scrollRef}
          guides={guides}
          dimensions={[]}
          activePage={1}
          pageWidthPt={595}
          pageHeightPt={842}
          unit="mm"
          onRemove={vi.fn()}
        />
      </>,
    );

    expect(callbacks).toHaveLength(0);
  });
});
