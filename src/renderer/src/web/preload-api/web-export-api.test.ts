// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWebExportApi } from './web-export-api'

const HTML = '<!DOCTYPE html><html><body><h1>Doc</h1></body></html>'

// happy-dom never loads srcdoc, so drive the frame's load event by hand.
function autoLoadFrames(view: { print: () => void }): void {
  const append = HTMLElement.prototype.append
  vi.spyOn(HTMLElement.prototype, 'append').mockImplementation(function (
    this: HTMLElement,
    ...nodes: (Node | string)[]
  ) {
    append.apply(this, nodes)
    for (const node of nodes) {
      if (node instanceof HTMLIFrameElement) {
        Object.defineProperty(node, 'contentWindow', { value: view, configurable: true })
        node.dispatchEvent(new Event('load'))
      }
    }
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

describe('web export API', () => {
  it('prints the export document from a hidden frame and leaves the save to the browser', async () => {
    const print = vi.fn()
    const addEventListener = vi.fn()
    autoLoadFrames({ print, focus: vi.fn(), addEventListener } as never)

    const result = await createWebExportApi().htmlToPdf({ html: HTML, title: 'Doc' })

    expect(print).toHaveBeenCalledTimes(1)
    // Neither success nor error: the browser's print dialog never reports its outcome.
    expect(result).toEqual({ success: false, cancelled: true })
    const frame = document.querySelector('iframe')
    expect(frame?.getAttribute('srcdoc')).toBe(HTML)
    expect(addEventListener).toHaveBeenCalledWith('afterprint', expect.any(Function), {
      once: true
    })
  })

  it('reports empty and unpreparable documents instead of throwing', async () => {
    await expect(createWebExportApi().htmlToPdf({ html: '  ', title: 'Doc' })).resolves.toEqual({
      success: false,
      error: 'No content to export'
    })

    autoLoadFrames(null as never)
    await expect(createWebExportApi().htmlToPdf({ html: HTML, title: 'Doc' })).resolves.toEqual({
      success: false,
      error: 'Could not prepare the export document'
    })
    expect(document.querySelector('iframe')).toBeNull()
  })
})
