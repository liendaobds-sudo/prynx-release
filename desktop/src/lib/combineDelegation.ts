export const LARGE_COMBINE_BYTES = 64 * 1024 * 1024;
export const LARGE_COMBINE_PAGES = 800;

export type CombineDelegationNode = {
  type: string;
  file?: { name: string; size: number };
  pageIndex?: number;
  groupId?: string;
  rotation?: number;
};

type DelegationOptions = {
  scaleMode: string;
  groupingEnabled?: boolean;
  requireTopLevel?: boolean;
  allowManifest?: boolean;
};

export function shouldDelegateLargePdfJob(
  nodes: CombineDelegationNode[],
  pageCounts: Record<string, number>,
  options: DelegationOptions,
): boolean {
  if (options.scaleMode !== 'keep' || options.groupingEnabled || nodes.length < 2) return false;

  const eligible = nodes.every(node => {
    if (options.allowManifest) {
      return node.type === 'blank' || (
        node.type === 'single'
        && !!node.file
        && node.file.name.toLowerCase().endsWith('.pdf')
      );
    }
    return node.type === 'single'
      && node.pageIndex === undefined
      && (!options.requireTopLevel || !node.groupId)
      && !!node.file
      && node.file.name.toLowerCase().endsWith('.pdf')
      && (node.rotation || 0) === 0;
  });
  if (!eligible || !nodes.some(node => !!node.file)) return false;

  const totalBytes = nodes.reduce((sum, node) => sum + (node.file?.size || 0), 0);
  const estimatedPages = nodes.reduce((sum, node) => {
    if (!node.file) return sum + 1;
    const file = node.file;
    return sum + (pageCounts[`${file.name}-${file.size}`]
      ?? Math.max(1, Math.ceil(file.size / 5000)));
  }, 0);

  return totalBytes >= LARGE_COMBINE_BYTES || estimatedPages >= LARGE_COMBINE_PAGES;
}
