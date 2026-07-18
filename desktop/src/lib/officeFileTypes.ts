/**
 * Office / spreadsheet extensions accepted for → PDF conversion.
 * Keep in sync with backend OFFICE_EXTENSIONS.
 */
export const OFFICE_EXTENSIONS = [
  'doc', 'docx', 'odt', 'rtf',
  'xls', 'xlsx', 'ods', 'csv',
  'ppt', 'pptx', 'odp',
] as const;

export const OFFICE_ACCEPT_ATTR =
  '.doc,.docx,.xls,.xlsx,.ppt,.pptx,.odt,.ods,.odp,.rtf,.csv';

export function isOfficePathOrName(pathOrName: string): boolean {
  const lower = pathOrName.toLowerCase();
  return OFFICE_EXTENSIONS.some((ext) => lower.endsWith(`.${ext}`));
}

export function mimeForOfficeName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (lower.endsWith('.doc')) return 'application/msword';
  if (lower.endsWith('.xlsx')) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (lower.endsWith('.xls')) return 'application/vnd.ms-excel';
  if (lower.endsWith('.pptx')) return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  if (lower.endsWith('.ppt')) return 'application/vnd.ms-powerpoint';
  if (lower.endsWith('.csv')) return 'text/csv';
  if (lower.endsWith('.rtf')) return 'application/rtf';
  return 'application/octet-stream';
}

export function isPdfOrImagePath(pathOrName: string): boolean {
  const lower = pathOrName.toLowerCase();
  return (
    lower.endsWith('.pdf') ||
    lower.endsWith('.jpg') ||
    lower.endsWith('.jpeg') ||
    lower.endsWith('.png')
  );
}
