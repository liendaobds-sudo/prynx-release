export const SUPPORTED_IMAGE_EXTENSIONS = [
  'png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff',
] as const;

export type SupportedImageExtension = typeof SUPPORTED_IMAGE_EXTENSIONS[number];

export const IMAGE_ACCEPT_ATTR = SUPPORTED_IMAGE_EXTENSIONS
  .map(extension => `.${extension}`)
  .join(',');

export function imageFileExtension(fileName: string): SupportedImageExtension | null {
  const match = (fileName || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  const extension = match?.[1] as SupportedImageExtension | undefined;
  return extension && SUPPORTED_IMAGE_EXTENSIONS.includes(extension) ? extension : null;
}

export function isSupportedImageFileName(fileName: string): boolean {
  return imageFileExtension(fileName) !== null;
}

export function mimeForImageName(fileName: string): string | null {
  const extension = imageFileExtension(fileName);
  if (!extension) return null;
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
  if (extension === 'tif' || extension === 'tiff') return 'image/tiff';
  return `image/${extension}`;
}
