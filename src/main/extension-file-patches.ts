// Source fixes applied to an extension's files on disk, before it is loaded.
//
// Bitwarden's page collector keeps two indexes: element -> field, and opid ->
// element. When a field appears ABOVE fields it has already collected, the next
// collection renumbers them, but its "already known element" branch only updates
// the first index. The opid index still maps each opid to the element that held
// it before, so every value lands one field too low.
//
// Measured with Bitwarden 2026.10.2's own collector on number / expiry / CVC with
// a hidden input inserted first: the number resolved to the expiry field and the
// expiry to the CVC field. A payment form that adds such an input right after its
// fields therefore ends up with the expiry in the CVC and nothing else.
//
// The patch moves the element's opid entry along with the renumbering. It only
// applies to the exact source it was written for: when a Bitwarden update changes
// these lines, it stops matching and the file is left as shipped.

import { readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

const STALE_OPID_SOURCE = 'existingAutofillField.opid = element.opid;'
const FRESH_OPID_SOURCE =
  'if (this.autofillFieldsByOpid.get(existingAutofillField.opid) === element) ' +
  'this.autofillFieldsByOpid.delete(existingAutofillField.opid); ' +
  'existingAutofillField.opid = element.opid; ' +
  'this.autofillFieldsByOpid.set(element.opid, element);'

/** The fixed source, or the input unchanged when it is not the code this patch
 * targets. Already-patched source no longer contains the bare statement alone,
 * so it is recognized first and a second run changes nothing. Pure. */
export function patchStaleOpidIndex(source: string): string {
  if (source.includes(FRESH_OPID_SOURCE)) return source
  if (!source.includes('this.autofillFieldsByOpid')) return source
  return source.split(STALE_OPID_SOURCE).join(FRESH_OPID_SOURCE)
}

/** Patch every script of an extension's `content/` folder. Returns whether a file
 * changed, so the caller can reload an extension that is already running. A folder
 * that does not exist is the normal case for most extensions. */
export function patchExtensionFiles(extPath: string): boolean {
  const dir = join(extPath, 'content')
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return false
  }
  let changed = false
  for (const name of names) {
    if (!name.endsWith('.js')) continue
    const path = join(dir, name)
    const source = readFileSync(path, 'utf8')
    const patched = patchStaleOpidIndex(source)
    if (patched === source) continue
    writeFileSync(path, patched, 'utf8')
    changed = true
  }
  return changed
}
