import { useEffect } from 'react'
import { isReadablePastedImagePayload } from '@shared/types'

/**
 * Clipboard and drag payloads, resolved to the paths the Tray holds.
 *
 * Two kinds of payload arrive by the same door. A file copied in Explorer or
 * Finder still has a real path, and referencing it in place is what the Tray
 * has always promised. A screenshot on the clipboard is bytes and nothing else,
 * so the main process has to write it down before it can be held.
 */

/** DataTransfer is only readable during the event that carried it. */
export function filesFrom(data: DataTransfer | null): File[] {
  return data ? Array.from(data.files) : []
}

export function hasImage(files: File[]): boolean {
  return files.some((file) => file.type.startsWith('image/'))
}

/**
 * Resolves each file to a path, saving clipboard bytes when there is none.
 *
 * The files must be collected synchronously by the caller: `DataTransfer` is
 * dead once the event handler returns, while the `File` handles taken from it
 * stay valid across the awaits below.
 */
export async function trayPathsFor(files: File[]): Promise<string[]> {
  const paths: string[] = []
  for (const file of files) {
    const existing = pathForFile(file)
    if (existing) {
      paths.push(existing)
      continue
    }
    // No path and not an image: nothing here can become an @-reference, and
    // reading the bytes of some dropped video would only waste memory to learn
    // that. Images are read; the main process refuses anything oversized.
    if (!file.type.startsWith('image/')) continue
    // Check before arrayBuffer(): the main-process cap protects disk and IPC,
    // but allocating an arbitrarily large browser drag in the renderer would
    // already have consumed the memory we mean to bound.
    if (!isReadablePastedImagePayload(file.type, file.size)) {
      console.warn(`[notch] refused a pasted ${file.type} of ${file.size} bytes`)
      continue
    }
    const saved = await window.notch.savePastedImage(new Uint8Array(await file.arrayBuffer()))
    if (saved) paths.push(saved)
    // Refused: oversized, or bytes the main process could not name. Nothing
    // appears in the tray either way, so leave a trace of why.
    else console.warn(`[notch] refused a pasted ${file.type || 'payload'} of ${file.size} bytes`)
  }
  return paths
}

function pathForFile(file: File): string {
  try {
    return window.notch.pathForFile(file)
  } catch {
    // A clipboard bitmap is not a file on disk; webUtils says so by throwing.
    return ''
  }
}

/**
 * Ctrl/⌘-V anywhere in the panel drops clipboard images into the Tray.
 *
 * Bound to the window rather than the Tray pane so a screenshot can be pasted
 * while the user is still typing the prompt it belongs to. A paste carrying no
 * image is left entirely alone, so text still pastes into the prompt.
 */
export function usePasteImages(onAdd: (paths: string[]) => void): void {
  useEffect(() => {
    const onPaste = (event: ClipboardEvent): void => {
      const files = filesFrom(event.clipboardData)
      if (!hasImage(files)) return
      event.preventDefault()
      void trayPathsFor(files).then((paths) => {
        if (paths.length) onAdd(paths)
      })
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [onAdd])
}
