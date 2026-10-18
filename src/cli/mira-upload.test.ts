import { describe, it, expect } from 'vitest'
import { buildUploadScripts, mimeFor } from './mira-core.mjs'

describe('mimeFor', () => {
  it('maps common extensions, case-insensitively', () => {
    expect(mimeFor('a.PDF')).toBe('application/pdf')
    expect(mimeFor('scan.jpg')).toBe('image/jpeg')
    expect(mimeFor('noext')).toBe('application/octet-stream')
  })
})

describe('buildUploadScripts', () => {
  it('refuses an empty file list', () => {
    expect(buildUploadScripts([])).toEqual({ error: 'no file given' })
  })

  it('splits each file into chunks between a reset and a final dispatch', () => {
    const r = buildUploadScripts(
      [
        { name: 'a.pdf', b64: 'AAAABBBBCC' },
        { name: 'b.png', b64: 'DD' }
      ],
      { chunk: 4 }
    )
    if (!('scripts' in r)) throw new Error('expected scripts')
    // reset + 3 chunks for a + 1 chunk for b + final
    expect(r.scripts).toHaveLength(6)
    expect(r.scripts[0]).toContain('[[],[]]')
    expect(r.scripts[1]).toContain('window.__miraUpload[0].push("AAAA")')
    expect(r.scripts[3]).toContain('window.__miraUpload[0].push("CC")')
    expect(r.scripts[4]).toContain('window.__miraUpload[1].push("DD")')
    const last = r.scripts[5]
    expect(last).toContain('"application/pdf"')
    expect(last).toContain('"image/png"')
    expect(last).toContain('input[type=file]')
    expect(last).toContain("dispatchEvent(new Event('change'")
  })

  it('targets the nth match of a custom selector', () => {
    const r = buildUploadScripts([{ name: 'x.pdf', b64: 'QQ==' }], { selector: '#doc', nth: 2 })
    if (!('scripts' in r)) throw new Error('expected scripts')
    const last = r.scripts[r.scripts.length - 1]
    expect(last).toContain('document.querySelectorAll("#doc")')
    expect(last).toContain('inputs[1]')
  })

  it('produces a final script that actually runs and fills the input', () => {
    const r = buildUploadScripts([{ name: 'hi.txt', b64: Buffer.from('hello').toString('base64') }], { chunk: 3 })
    if (!('scripts' in r)) throw new Error('expected scripts')
    const added: File[] = []
    const inp: any = { files: null, dispatchEvent: () => true }
    const g: any = globalThis
    const saved = { window: g.window, document: g.document, DataTransfer: g.DataTransfer }
    g.window = g
    g.document = { querySelectorAll: () => [inp] }
    g.DataTransfer = class {
      items = { add: (f: File) => added.push(f) }
      get files() {
        return added
      }
    }
    try {
      let out: any
      for (const s of r.scripts) out = (0, eval)(s)
      expect(out.files).toEqual(['hi.txt (5 B)'])
      expect(added[0].type).toBe('text/plain')
    } finally {
      Object.assign(g, saved)
    }
  })
})
