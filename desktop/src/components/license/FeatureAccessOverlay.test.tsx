// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import FeatureAccessOverlay from './FeatureAccessOverlay';

vi.mock('./ProFeatureBadge', () => ({
  default: ({ featureId }: { featureId: string }) => <span>{featureId}</span>,
}));

afterEach(cleanup);

describe('FeatureAccessOverlay', () => {
  it('portal lên body, nằm trên modal công cụ và nhận focus ngay', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = render(<FeatureAccessOverlay featureId="packaging.dieline" />, { container: host });

    const dialog = screen.getByRole('alertdialog');
    const overlay = dialog.parentElement as HTMLElement;
    expect(document.body.contains(overlay)).toBe(true);
    expect(host.contains(overlay)).toBe(false);
    expect(overlay.className).toContain('z-[2147483647]');
    expect(document.activeElement).toBe(dialog);

    view.unmount();
    host.remove();
  });

  it('giữ Tab trong overlay và không truyền phím xuống cửa sổ', () => {
    const onLeave = vi.fn();
    const windowKey = vi.fn();
    window.addEventListener('keydown', windowKey);
    render(<FeatureAccessOverlay featureId="prepress.paper_library" onLeave={onLeave} />);

    const dialog = screen.getByRole('alertdialog');
    const leaveButton = screen.getByRole('button', { name: 'Về trang chính' });
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(leaveButton);
    expect(windowKey).not.toHaveBeenCalled();

    fireEvent.click(leaveButton);
    expect(onLeave).toHaveBeenCalledOnce();
    window.removeEventListener('keydown', windowKey);
  });

  it('phím Escape đưa người dùng về trang chính khi có đường thoát', () => {
    const onLeave = vi.fn();
    render(<FeatureAccessOverlay featureId="impo.booklet" onLeave={onLeave} />);

    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });

    expect(onLeave).toHaveBeenCalledOnce();
  });
});
