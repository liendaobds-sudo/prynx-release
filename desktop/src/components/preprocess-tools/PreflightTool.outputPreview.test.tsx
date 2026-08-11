// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import PreflightTool from './PreflightTool';

vi.mock('../../hooks/useWorkingPdf', () => ({
  useWorkingPdf: () => async () => null,
}));

describe('PreflightTool — mở Xem trước bản in', () => {
  it('không submit form hoặc phát click lên ancestor', () => {
    const onOpenOutputPreview = vi.fn();
    const onSubmit = vi.fn();

    render(
      <form onSubmit={onSubmit}>
        <PreflightTool
          pdfFile={null}
          onFileFixed={vi.fn()}
          onOpenOutputPreview={onOpenOutputPreview}
        />
      </form>,
    );

    const button = screen.getByRole('button', { name: /Xem trước bản in/i });
    expect(button.getAttribute('type')).toBe('button');

    fireEvent.click(button);

    expect(onOpenOutputPreview).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
