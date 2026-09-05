import * as Sentry from '@sentry/react';
import { invoke } from '@tauri-apps/api/core';

import packageInfo from '../../package.json';

export const APP_VERSION = packageInfo.version || 'unknown';

const MAX_MESSAGE_LENGTH = 800;
const MAX_COMPONENT_STACK_LENGTH = 5000;

export interface UiDiagnosticReportOptions {
  includeTechnicalDetails?: boolean;
  userAgent?: string;
}

function cleanDiagnosticText(value: string | undefined, maxLength: number): string {
  if (!value) return '';
  return value
    .replace(/file:\/\/\/[A-Za-z]:\/[^\s)]+/gi, '<local-file>')
    .replace(/[A-Za-z]:\\[^\r\n]+/g, '<local-path>')
    .replace(/https?:\/\/[^\s)]+/gi, '<url>')
    .replace(/\bBearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer <redacted>')
    .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, '<token>')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, maxLength);
}

function cleanDiagnosticId(value: string, fallback: string): string {
  const cleaned = value.replace(/[^a-z0-9._:-]/gi, '').slice(0, 80);
  return cleaned || fallback;
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
      scope.setTag('ui_area', cleanDiagnosticId(area, 'ui'));
      scope.setTag('ui_error_id', cleanDiagnosticId(errorId, 'unknown'));
      scope.setTag('app_version', APP_VERSION);
      scope.setLevel('error');
      if (import.meta.env.DEV) {
        if (safeComponentStack) scope.setExtra('component_stack', safeComponentStack);
        Sentry.captureException(error);
      } else {
        // SEC (audit 2026-09-05 §LOG.05): không gửi raw exception/stack/tên
        // engine lên telemetry production. Error ID là khóa đối chiếu duy nhất.
        Sentry.captureMessage('PrynX UI error');
      }
    });
  } catch {
    // Diagnostics must never cause a second UI failure.
  }

  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    void invoke('log_frontend_error', {
      area,
      errorId,
      appVersion: APP_VERSION,
      message: import.meta.env.DEV ? message : 'UI error',
      componentStack: import.meta.env.DEV ? (safeComponentStack || null) : null,
    }).catch(() => undefined);
  }
}

export function buildUiDiagnosticReport(
  area: string,
  errorId: string,
  error: Error | null,
  options: UiDiagnosticReportOptions = {},
): string {
  const includeTechnicalDetails = options.includeTechnicalDetails ?? import.meta.env.DEV;
  const base = [
    `PrynX ${APP_VERSION}`,
    `Error ID: ${cleanDiagnosticId(errorId, 'unknown')}`,
    `Area: ${cleanDiagnosticId(area, 'ui')}`,
  ];
  if (!includeTechnicalDetails) {
    return [...base, 'Technical details: hidden in production'].join('\n');
  }
  const userAgent = options.userAgent
    ?? (typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown');
  return [
    ...base,
    `Error: ${cleanDiagnosticText(
      error ? `${error.name}: ${error.message}` : 'Unknown UI error',
      MAX_MESSAGE_LENGTH,
    )}`,
    `Platform: ${cleanDiagnosticText(userAgent, MAX_MESSAGE_LENGTH)}`,
    error?.stack
      ? `Stack:\n${cleanDiagnosticText(error.stack, MAX_COMPONENT_STACK_LENGTH)}`
      : '',
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
