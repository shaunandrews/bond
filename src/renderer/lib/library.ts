import type { LibraryAsset } from '../../shared/library'

/** Markdown/plaintext documents open in Bond's in-app viewer; everything else (pdf/html/other/media) opens via the native app. */
export function openLibraryAsset(asset: LibraryAsset): void {
  if (asset.kind === 'document' && (asset.format === 'markdown' || asset.format === 'plaintext')) {
    void window.bond.openViewer(asset.managedPath, asset.format, asset.title)
  } else {
    void window.bond.openPath(asset.managedPath)
  }
}

export function revealLibraryAsset(asset: LibraryAsset): void {
  void window.bond.revealInFinder(asset.managedPath)
}
