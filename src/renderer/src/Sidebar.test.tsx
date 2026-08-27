import { describe, it, expect, vi } from 'vitest'
import type { ReactElement } from 'react'
import { TabRow, type TabInfo } from './Sidebar'

const tab: TabInfo = {
  id: 'tab-1',
  title: 'Example',
  url: 'https://example.com',
  favicon: null,
  loaded: true,
  loading: false,
  pinned: false,
  folderId: null,
  audible: false,
  kind: 'web'
}

// React elements are plain objects, so the row's output can be inspected without a
// DOM: what matters is that the × is the LAST child (that is what puts every row's
// button on the same vertical line) and that clicking it closes instead of selecting.
function renderRow(overrides: Partial<TabInfo>, onClose: () => void): ReactElement {
  return TabRow({
    tab: { ...tab, ...overrides },
    active: false,
    dragging: false,
    dropPos: null,
    onSelect: () => {},
    onClose,
    onContextMenu: () => {},
    onDragStart: () => {},
    onDragOver: () => {},
    onDrop: () => {},
    onDragEnd: () => {}
  })
}

function childrenOf(row: ReactElement): ReactElement[] {
  const kids = (row.props as { children: unknown }).children as unknown[]
  return kids.flat().filter((c): c is ReactElement => !!c && typeof c === 'object')
}

describe('TabRow close button', () => {
  it('is the last element of the row, so every row aligns on the same x', () => {
    const last = childrenOf(renderRow({}, () => {})).at(-1)
    expect((last?.props as { className?: string }).className).toBe('tab-close')
  })

  it('stays last even when the audio icon takes a slot before it', () => {
    const kids = childrenOf(renderRow({ audible: true }, () => {}))
    const last = kids.at(-1)
    expect((last?.props as { className?: string }).className).toBe('tab-close')
    expect(kids.length).toBe(4) // favicon, title, audio, close
  })

  it('closes the tab and does not let the click select the row', () => {
    const onClose = vi.fn()
    const stopPropagation = vi.fn()
    const button = childrenOf(renderRow({}, onClose)).at(-1) as ReactElement
    const onClick = (button.props as { onClick: (e: unknown) => void }).onClick
    onClick({ stopPropagation })
    expect(onClose).toHaveBeenCalledOnce()
    expect(stopPropagation).toHaveBeenCalledOnce()
  })
})
