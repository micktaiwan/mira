import { readFileSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

// electron-chrome-extensions 4.9.0 sends contextMenus.onClicked with a
// hard-coded `parentMenuItemId: -1`. Bitwarden switches on that field to pick
// the action of a cipher submenu item ("Copy password", "Copy username",
// "Autofill login"), so every one of them was a silent no-op in Mira.
// patches/electron-chrome-extensions+4.9.0.patch reports the real parent; this
// guards it against a lib bump that drops the patch.

const require = createRequire(import.meta.url)
// The main entry is dist/cjs/index.js; both bundles sit under dist/.
const libDir = join(require.resolve('electron-chrome-extensions'), '..', '..')

describe('electron-chrome-extensions contextMenus.onClicked patch', () => {
  for (const bundle of ['cjs/index.js', 'esm/index.mjs']) {
    it(`reports the clicked item's parent (${bundle})`, () => {
      const source = readFileSync(join(libDir, bundle), 'utf8')
      expect(source).not.toContain('parentMenuItemId: -1')
      expect(source).toContain(
        'parentMenuItemId: this.menus.get(extensionId)?.get(menuItemId)?.parentId'
      )
    })
  }
})
