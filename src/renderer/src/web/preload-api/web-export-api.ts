import type { ExportApi } from '../../../../preload/api/filesystem-api'

// Why (VSAgent fork): the desktop export renders the document in a hidden
// BrowserWindow and writes the PDF through a native save dialog — neither exists
// in a browser tab, and the host's dialog would save on the server anyway. The
// browser already has this exact feature: print the document to PDF. The export
// HTML is a self-contained document with a script-free CSP, so it prints from a
// hidden same-origin iframe with the app's own chrome left out.

/** Frames are removed after the print dialog closes; this only bounds a dialog left open. */
const FRAME_CLEANUP_MS = 5 * 60_000

function printExportDocument(html: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const frame = document.createElement('iframe')
    frame.setAttribute('aria-hidden', 'true')
    frame.style.position = 'fixed'
    frame.style.right = '0'
    frame.style.bottom = '0'
    frame.style.width = '0'
    frame.style.height = '0'
    frame.style.border = '0'
    frame.style.visibility = 'hidden'

    let cleanupTimer: ReturnType<typeof setTimeout> | undefined
    const remove = (): void => {
      clearTimeout(cleanupTimer)
      frame.remove()
    }

    frame.addEventListener('load', () => {
      const view = frame.contentWindow
      if (!view) {
        remove()
        reject(new Error('Could not prepare the export document'))
        return
      }
      // Chrome fires afterprint for both save and cancel; keep the frame until then.
      view.addEventListener('afterprint', remove, { once: true })
      cleanupTimer = setTimeout(remove, FRAME_CLEANUP_MS)
      view.focus()
      view.print()
      resolve()
    })
    frame.addEventListener('error', () => {
      remove()
      reject(new Error('Could not prepare the export document'))
    })

    frame.srcdoc = html
    document.body.append(frame)
  })
}

export function createWebExportApi(): ExportApi {
  return {
    htmlToPdf: async ({ html }) => {
      if (!html.trim()) {
        // Why (VSAgent fork): byte-identical to upstream's main-process handler
        // (src/main/ipc/export.ts), which the caller renders verbatim — localizing
        // only here would split the web and desktop messages. Allowlisted instead.
        return { success: false, error: 'No content to export' }
      }
      try {
        await printExportDocument(html)
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to export PDF'
        }
      }
      // The browser's print dialog owns the save from here, and never reports its
      // outcome — so claim neither a file path nor a failure; the caller's
      // progress toast just clears.
      return { success: false, cancelled: true }
    }
  }
}
