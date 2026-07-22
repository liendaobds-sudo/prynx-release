import * as Sentry from '@sentry/react';
import { invoke } from '@tauri-apps/api/core';

import packageInfo from '../../package.json';

export const APP_VERSION = packageInfo.version || 'unknown';

const MAX_MESSAGE_LENGTH = 800;
const MAX_COMPONENT_STACK_LENGTH = 5000;

function cleanDiagnosticText(value: string | undefined, maxLength: number): string {
  if (!value) return '';
  return value
    .replace(/file:\/\/\/[A-Za-z]:\/[^\s)]+/gi, '<local-file>')
    .replace(/[A-Za-z]:\\[^\r\n]+/g, '<local-path>')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, maxLength);
}

export function createUiErrorId(area: string): string {
  const areaCode = area.replace(/[^a-z0-9]/gi, '').slice(0, 4).toUpperCase() || 'UI';
  const timeCode = Date.now().toString(36).slice(-6).toUpperCase();
  const randomCode = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${areaCode}-${timeCode}-${randomCode}`;
}

export function reportUiError(
  area: string,
  errorId: string,
  error: Error,
  componentStack?: string,
): void {
  const message = cleanDiagnosticText(`${error.name}: ${error.message}`, MAX_MESSAGE_LENGTH);
  const safeComponentStack = cleanDiagnosticText(componentStack, MAX_COMPONENT_STACK_LENGTH);

  try {
    Sentry.withScope((scope) => {
      scope.setTag('ui_area', area);
      scope.setTag('ui_error_id', errorId);
      scope.setTag('app_version', APP_VERSION);
      if (safeComponentStack) scope.setExtra('component_stack', safeComponentStack);
      Sentry.captureException(error);
    });
  } catch {
    // Diagnostics must never cause a second UI failure.
  }

  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    void invoke('log_frontend_error', {
      area,
      errorId,
      appVersion: APP_VERSION,
      message,
      componentStack: safeComponentStack || null,
    }).catch(() => undefined);
  }
}

export function buildUiDiagnosticReport(
  area: string,
  errorId: string,
  error: Error | null,
): string {
  return [
    `PrynX ${APP_VERSION}`,
    `Error ID: ${errorId}`,
    `Area: ${area}`,
    `Error: ${error ? `${error.name}: ${error.message}` : 'Unknown UI error'}`,
    `Platform: ${typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown'}`,
    error?.stack ? `Stack:\n${error.stack}` : '',
  ].filter(Boolean).join('\n');
}

export async function copyUiDiagnosticReport(report: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(report);
    return true;
  } catch {
    try {
      const textarea = document.createElement('textarea');
      textarea.value = report;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      const copied = document.execCommand('copy');
      textarea.remove();
      return copied;
    } catch {
      return false;
    }
  }
}
