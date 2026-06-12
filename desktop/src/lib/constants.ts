/**
 * Shared constants used across the application.
 */

/**
 * File name prefixes that indicate a file was produced by
 * internal processing (imposition, split, merge, etc.)
 * and should be treated as "unsaved output".
 */
export const OUTPUT_PREFIXES = [
  'Imposed_',
  'Bi_Broc_Tach_',
  'Resized_',
  'Shuffled_',
  'Processed_',
  'Merged_',
  'Kem_Gop_',
  'Converted_',
  'FixedHairlines_',
  'FixedBoxes_',
  'Trapped_',
  'part_',
  'VDP_',
  'Numbered_',
  'Searchable_',
  'optimized_',
  'watermarked_',
  'Edited_',
  'Split_',
  'Interleaved_',
] as const;

/**
 * Check if a filename indicates it's an output/processed file.
 */
export function isOutputFile(name: string): boolean {
  return OUTPUT_PREFIXES.some(prefix => name.includes(prefix));
}
