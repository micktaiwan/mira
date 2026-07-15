import { type KeyboardEvent } from 'react'

// One tab folder's header row in the sidebar: a caret (collapsed/expanded), the
// name, a tab count, and a remove (×) button. Click toggles collapse; double-click
// renames inline; × dissolves the folder (its tabs fall back to loose — they are
// not closed). Pure presentation: every action is a callback the Sidebar wires to
// a registry command (toggle / rename / remove-tab-folder). Tabs are NOT rendered
// here — the Sidebar renders them below the header so they share its drag state.
//
// The rename input is CONTROLLED by the Sidebar (`editing` + onEditStart/End): the
// Sidebar opens it on double-click AND automatically for a just-created folder, so
// "New Folder" from the right-click menu lands straight in an editable, selected
// name field (a native menu can't prompt for text).

/** A tab folder as the sidebar sees it (mirrors TabFolder in the registry). */
export interface TabFolder {
  id: string
  title: string
  collapsed: boolean
  /** Accent color (a CSS color string), or absent for the default look. */
  color?: string
}

export interface FolderHeaderProps {
  folder: TabFolder
  /** How many tabs are in the folder (shown as a count badge). */
  count: number
  /** Whether the name field is open (Sidebar-owned, so a freshly created folder
   * can be put straight into edit mode). */
  editing: boolean
  onToggle: () => void
  onRename: (title: string) => void
  onRemove: () => void
  /** Open the name field (double-click). */
  onEditStart: () => void
  /** Close the name field (blur / Enter / Escape). */
  onEditEnd: () => void
  /** Right-click: ask main to pop the native folder menu (color, remove, …). */
  onContextMenu: () => void
}

function FolderHeader({
  folder,
  count,
  editing,
  onToggle,
  onRename,
  onRemove,
  onEditStart,
  onEditEnd,
  onContextMenu
}: FolderHeaderProps): React.JSX.Element {
  const submit = (title: string): void => {
    const t = title.trim()
    if (t && t !== folder.title) onRename(t)
    onEditEnd()
  }

  if (editing) {
    return (
      <div className="folder-header folder-editing">
        <span className="folder-caret" aria-hidden="true">
          {folder.collapsed ? '▶' : '▼'}
        </span>
        <input
          className="folder-input"
          defaultValue={folder.title}
          autoFocus
          spellCheck={false}
          // Select the default name so the first keystroke replaces it — the
          // create-then-name flow reads as "type the folder's name".
          onFocus={(e) => e.target.select()}
          onBlur={(e) => submit(e.target.value)}
          onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
            if (e.key === 'Enter') submit(e.currentTarget.value)
            else if (e.key === 'Escape') onEditEnd()
          }}
        />
      </div>
    )
  }

  return (
    <div
      className="folder-header"
      onClick={onToggle}
      onDoubleClick={(e) => {
        e.stopPropagation()
        onEditStart()
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        onContextMenu()
      }}
      title={folder.title || 'Untitled'}
    >
      <span className="folder-caret" aria-hidden="true">
        {folder.collapsed ? '▶' : '▼'}
      </span>
      {folder.color && (
        <span className="folder-dot" aria-hidden="true" style={{ backgroundColor: folder.color }} />
      )}
      <span className="folder-title">{folder.title || 'Untitled'}</span>
      <span className="folder-count" aria-hidden="true">
        {count}
      </span>
      <button
        type="button"
        className="folder-remove"
        aria-label="Remove folder"
        title="Remove folder (tabs kept)"
        onClick={(e) => {
          e.stopPropagation()
          onRemove()
        }}
      >
        ×
      </button>
    </div>
  )
}

export default FolderHeader
