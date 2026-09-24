// @vitest-environment jsdom
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import GiantImageOptimizationModal from './GiantImageOptimizationModal';
import type { ImageHeaderInfo } from '../../lib/imageHeaderInspector';

const mockHeader: ImageHeaderInfo = {
  width: 18896,
  height: 28346,
  totalPixels: 535626016,
  dpiX: 600,
  dpiY: 600,
  physicalWidthCm: 80.0,
  physicalHeightCm: 120.0,
  estimatedRawMb: 2043,
  isOversized: true,
  format: 'png',
};

describe('GiantImageOptimizationModal', () => {
  it('không render khi open = false', () => {
    const { container } = render(
      <GiantImageOptimizationModal
        open={false}
        fileName="poster.png"
        headerInfo={mockHeader}
        onOptimize={vi.fn()}
        onProceedOriginal={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('hiển thị đầy đủ thông số kích thước, điểm ảnh và DPI khi open = true', () => {
    render(
      <GiantImageOptimizationModal
        open={true}
        fileName="HADECO_Poster.png"
        headerInfo={mockHeader}
        onOptimize={vi.fn()}
        onProceedOriginal={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText(/HADECO_Poster\.png/)).toBeDefined();
    expect(screen.getByText(/18,896 × 28,346 px/)).toBeDefined();
    expect(screen.getByText(/535\.6 MP/)).toBeDefined();
    expect(screen.getAllByText(/600 DPI/).length).toBeGreaterThanOrEqual(1);
  });

  it('kích hoạt onOptimize(150) khi bấm nút tối ưu 150 DPI', () => {
    const onOptimize = vi.fn();
    render(
      <GiantImageOptimizationModal
        open={true}
        fileName="poster.png"
        headerInfo={mockHeader}
        onOptimize={onOptimize}
        onProceedOriginal={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const btn150 = screen.getByRole('button', { name: /150 DPI/ });
    fireEvent.click(btn150);
    expect(onOptimize).toHaveBeenCalledWith(150);
  });

  it('kích hoạt onOptimize(200) khi bấm nút tối ưu 200 DPI', () => {
    const onOptimize = vi.fn();
    render(
      <GiantImageOptimizationModal
        open={true}
        fileName="poster.png"
        headerInfo={mockHeader}
        onOptimize={onOptimize}
        onProceedOriginal={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const btn200 = screen.getByRole('button', { name: /200 DPI/ });
    fireEvent.click(btn200);
    expect(onOptimize).toHaveBeenCalledWith(200);
  });

  it('kích hoạt onOptimize(300) khi bấm nút tối ưu 300 DPI', () => {
    const onOptimize = vi.fn();
    render(
      <GiantImageOptimizationModal
        open={true}
        fileName="poster.png"
        headerInfo={mockHeader}
        onOptimize={onOptimize}
        onProceedOriginal={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const btn300 = screen.getByRole('button', { name: /300 DPI/ });
    fireEvent.click(btn300);
    expect(onOptimize).toHaveBeenCalledWith(300);
  });

  it('kích hoạt onOptimize(100) khi bấm nút tối ưu 100 DPI', () => {
    const onOptimize = vi.fn();
    render(
      <GiantImageOptimizationModal
        open={true}
        fileName="poster.png"
        headerInfo={mockHeader}
        onOptimize={onOptimize}
        onProceedOriginal={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const btn100 = screen.getByRole('button', { name: /100 DPI/ });
    fireEvent.click(btn100);
    expect(onOptimize).toHaveBeenCalledWith(100);
  });

  it('cho phép nhập DPI tùy chỉnh và kích hoạt onOptimize với giá trị đã nhập', () => {
    const onOptimize = vi.fn();
    render(
      <GiantImageOptimizationModal
        open={true}
        fileName="poster.png"
        headerInfo={mockHeader}
        onOptimize={onOptimize}
        onProceedOriginal={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    // Mở phần tùy chỉnh DPI
    const toggleCustom = screen.getByRole('button', { name: /Tùy chỉnh DPI/ });
    fireEvent.click(toggleCustom);

    // Tìm input số và nhập 250
    const input = screen.getByRole('spinbutton');
    fireEvent.change(input, { target: { value: '250' } });

    // Bấm nút áp dụng
    const applyBtn = screen.getByRole('button', { name: /250 DPI/ });
    fireEvent.click(applyBtn);
    expect(onOptimize).toHaveBeenCalledWith(250);
  });

  it('kích hoạt onProceedOriginal khi bấm mở ảnh gốc', () => {
    const onProceedOriginal = vi.fn();
    render(
      <GiantImageOptimizationModal
        open={true}
        fileName="poster.png"
        headerInfo={mockHeader}
        onOptimize={vi.fn()}
        onProceedOriginal={onProceedOriginal}
        onCancel={vi.fn()}
      />,
    );

    const btnOriginal = screen.getByRole('button', { name: /Mở ảnh gốc không nén/ });
    fireEvent.click(btnOriginal);
    expect(onProceedOriginal).toHaveBeenCalledTimes(1);
  });

  it('kích hoạt onCancel khi bấm nút hủy bỏ', () => {
    const onCancel = vi.fn();
    render(
      <GiantImageOptimizationModal
        open={true}
        fileName="poster.png"
        headerInfo={mockHeader}
        onOptimize={vi.fn()}
        onProceedOriginal={vi.fn()}
        onCancel={onCancel}
      />,
    );

    const btnCancel = screen.getByRole('button', { name: /Hủy bỏ/ });
    fireEvent.click(btnCancel);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
