import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { patchExtensionFiles, patchStaleOpidIndex } from './extension-file-patches'

// The shape of the shipped collector, reduced to the branch being fixed.
const COLLECTOR = `class Collector {
  constructor() {
    this.autofillFieldElements = new Map();
    this.autofillFieldsByOpid = new Map();
  }
  cache(element, field) {
    this.autofillFieldElements.set(element, field);
    this.autofillFieldsByOpid.set(field.opid, element);
  }
  renumber(element, index) {
    element.opid = \`__\${index}\`;
    const existingAutofillField = this.autofillFieldElements.get(element);
    if (existingAutofillField) {
      existingAutofillField.opid = element.opid;
      this.autofillFieldElements.set(element, existingAutofillField);
    }
  }
  lookup(opid) {
    return this.autofillFieldsByOpid.get(opid);
  }
}
Collector;`

/** Collect three fields, then renumber them as if a field appeared above them. */
function lookupsAfterInsertAbove(source: string): (string | undefined)[] {
  const Collector = new Function(`return (function () { ${source}\nreturn Collector; })()`)()
  const collector = new Collector()
  const fields = ['number', 'expiry', 'cvc'].map((id, index) => {
    const element = { id, opid: `__${index}` }
    collector.cache(element, { opid: element.opid })
    return element
  })
  fields.forEach((element, index) => collector.renumber(element, index + 1))
  return ['__1', '__2', '__3'].map((opid) => collector.lookup(opid)?.id)
}

describe('patchStaleOpidIndex', () => {
  it('reproduces the shifted lookup on the unpatched source', () => {
    expect(lookupsAfterInsertAbove(COLLECTOR)).toEqual(['expiry', 'cvc', undefined])
  })

  it('makes each opid resolve to its own field after a renumbering', () => {
    expect(lookupsAfterInsertAbove(patchStaleOpidIndex(COLLECTOR))).toEqual([
      'number',
      'expiry',
      'cvc'
    ])
  })

  it('changes nothing on a second run', () => {
    const once = patchStaleOpidIndex(COLLECTOR)
    expect(patchStaleOpidIndex(once)).toBe(once)
  })

  it('leaves a script without the opid index alone', () => {
    const other = 'existingAutofillField.opid = element.opid;'
    expect(patchStaleOpidIndex(other)).toBe(other)
  })
})

describe('patchExtensionFiles', () => {
  const dirs: string[] = []
  const extension = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'mira-ext-patch-'))
    dirs.push(dir)
    return dir
  }
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('patches the content scripts once and reports it', () => {
    const dir = extension()
    mkdirSync(join(dir, 'content'))
    const script = join(dir, 'content', 'bootstrap-autofill.js')
    writeFileSync(script, COLLECTOR)
    expect(patchExtensionFiles(dir)).toBe(true)
    expect(readFileSync(script, 'utf8')).toBe(patchStaleOpidIndex(COLLECTOR))
    expect(patchExtensionFiles(dir)).toBe(false)
  })

  it('reports nothing for an extension with no content folder', () => {
    expect(patchExtensionFiles(extension())).toBe(false)
  })
})
