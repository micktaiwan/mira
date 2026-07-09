// The bookmarks (favorites) data model, kept pure and Electron-free so it is
// fully unit-tested — the same split as profile-store.ts / tab-store.ts. This
// file owns the tree algebra (insert / remove / rename / move / find / flatten /
// import); the native side (src/main/profiles.ts) owns id generation and
// persistence (userData/bookmarks.json), and menu.ts renders the tree.
//
// Favorites are a FOLDER TREE (Atlas-style), rendered in the native "Bookmarks"
// menu. A node is either a url or a folder (which holds children). The tree is
// GLOBAL — one list for the whole app, not per profile (minimalist choice; see
// track.md). Ids are stable strings.

/** A bookmarked page. */
export interface BookmarkUrl {
  id: string
  kind: 'url'
  title: string
  url: string
}

/** A folder holding an ordered list of child nodes (urls and/or sub-folders). */
export interface BookmarkFolder {
  id: string
  kind: 'folder'
  title: string
  children: BookmarkNode[]
}

export type BookmarkNode = BookmarkUrl | BookmarkFolder

/** The whole tree: the ordered top-level nodes (the implicit root / bookmark bar).
 * `parentId: null` in the ops below means this top level. */
export type BookmarkTree = BookmarkNode[]

export function emptyTree(): BookmarkTree {
  return []
}

/** Depth-first search for a node by id, anywhere in the tree. */
export function findNode(tree: BookmarkTree, id: string): BookmarkNode | undefined {
  for (const node of tree) {
    if (node.id === id) return node
    if (node.kind === 'folder') {
      const found = findNode(node.children, id)
      if (found) return found
    }
  }
  return undefined
}

/** The first url node matching `url`, anywhere in the tree. Used to keep the tree
 * de-duplicated by url and to drive the address-bar star. */
export function findUrl(tree: BookmarkTree, url: string): BookmarkUrl | undefined {
  for (const node of tree) {
    if (node.kind === 'url') {
      if (node.url === url) return node
    } else {
      const found = findUrl(node.children, url)
      if (found) return found
    }
  }
  return undefined
}

/** Every url node in the tree, depth-first (folders flattened away). For the
 * star's "is this page bookmarked" check and counts. */
export function flatten(tree: BookmarkTree): BookmarkUrl[] {
  const out: BookmarkUrl[] = []
  for (const node of tree) {
    if (node.kind === 'url') out.push(node)
    else out.push(...flatten(node.children))
  }
  return out
}

/** True if `folderId` is `id` itself or a folder nested anywhere inside it —
 * used to forbid moving a folder into its own subtree (which would detach it). */
function isSelfOrDescendant(tree: BookmarkTree, id: string, folderId: string): boolean {
  if (id === folderId) return true
  const node = findNode(tree, id)
  if (!node || node.kind !== 'folder') return false
  return findNode(node.children, folderId) !== undefined
}

/** Insert `node` under `parentId` (a folder id, or null for the top level) at
 * `index` (clamped; appended when omitted). Throws if the parent is unknown or is
 * not a folder. Pure: returns a new tree, input untouched. */
export function insertNode(
  tree: BookmarkTree,
  parentId: string | null,
  node: BookmarkNode,
  index?: number
): BookmarkTree {
  if (parentId === null) {
    return spliceInto(tree, node, index)
  }
  const parent = findNode(tree, parentId)
  if (!parent) throw new Error(`unknown folder: ${parentId}`)
  if (parent.kind !== 'folder') throw new Error(`not a folder: ${parentId}`)
  return tree.map((n) => mapInsert(n, parentId, node, index))
}

function mapInsert(
  n: BookmarkNode,
  parentId: string,
  node: BookmarkNode,
  index?: number
): BookmarkNode {
  if (n.kind !== 'folder') return n
  if (n.id === parentId) return { ...n, children: spliceInto(n.children, node, index) }
  return { ...n, children: n.children.map((c) => mapInsert(c, parentId, node, index)) }
}

function spliceInto(list: BookmarkNode[], node: BookmarkNode, index?: number): BookmarkNode[] {
  const at = index === undefined ? list.length : Math.min(Math.max(index, 0), list.length)
  const out = [...list]
  out.splice(at, 0, node)
  return out
}

/** Remove the node with `id` (and, if it is a folder, its whole subtree). No-op
 * (same contents) on an unknown id. */
export function removeNode(tree: BookmarkTree, id: string): BookmarkTree {
  return tree
    .filter((n) => n.id !== id)
    .map((n) => (n.kind === 'folder' ? { ...n, children: removeNode(n.children, id) } : n))
}

/** Relabel a node (url or folder). Throws on an unknown id. */
export function renameNode(tree: BookmarkTree, id: string, title: string): BookmarkTree {
  if (!findNode(tree, id)) throw new Error(`unknown bookmark: ${id}`)
  const rename = (n: BookmarkNode): BookmarkNode => {
    if (n.id === id) return { ...n, title }
    if (n.kind === 'folder') return { ...n, children: n.children.map(rename) }
    return n
  }
  return tree.map(rename)
}

/** Move node `id` under `newParentId` (folder id, or null for top level) at
 * `index`. Throws on unknown id, unknown/non-folder parent, or moving a folder
 * into its own subtree. */
export function moveNode(
  tree: BookmarkTree,
  id: string,
  newParentId: string | null,
  index?: number
): BookmarkTree {
  const node = findNode(tree, id)
  if (!node) throw new Error(`unknown bookmark: ${id}`)
  if (newParentId !== null && isSelfOrDescendant(tree, id, newParentId)) {
    throw new Error('cannot move a folder into itself')
  }
  const detached = removeNode(tree, id)
  return insertNode(detached, newParentId, node, index)
}

/** Coerce whatever was parsed from bookmarks.json into a valid tree: keep only
 * well-formed nodes (url needs a non-empty url; folder recurses), drop entries
 * with an empty id and duplicate ids. Never throws — bad input degrades to an
 * empty tree. */
export function normalizeBookmarks(raw: unknown): BookmarkTree {
  return normalizeList(raw, new Set<string>())
}

function normalizeList(raw: unknown, seen: Set<string>): BookmarkTree {
  if (!Array.isArray(raw)) return []
  const out: BookmarkTree = []
  for (const item of raw) {
    const node = normalizeNode(item, seen)
    if (node) out.push(node)
  }
  return out
}

function normalizeNode(raw: unknown, seen: Set<string>): BookmarkNode | null {
  if (!raw || typeof raw !== 'object') return null
  const v = raw as Record<string, unknown>
  if (typeof v.id !== 'string' || v.id.trim() === '') return null
  if (seen.has(v.id)) return null
  const title = typeof v.title === 'string' ? v.title : ''
  // A node is a folder if it says so or simply carries children; else a url.
  if (v.kind === 'folder' || Array.isArray(v.children)) {
    seen.add(v.id)
    return { id: v.id, kind: 'folder', title, children: normalizeList(v.children, seen) }
  }
  if (typeof v.url !== 'string' || v.url.trim() === '') return null
  seen.add(v.id)
  return { id: v.id, kind: 'url', title, url: v.url }
}

// ---- Atlas import --------------------------------------------------------
//
// Map a parsed Atlas `bookmarks/BookmarkBar` JSON tree into our model. Verified
// Atlas shape (see track.md): each node has `uuid`, `title`, `type` (a one-key
// object: {bookmarkBar:{}} | {folder:{}} | {url:{}}), `children[]`, and `url`
// for url nodes. We reuse the Atlas uuid as our stable id (deterministic import).
// The root (bookmarkBar) itself is dropped — its children become our top level.

interface AtlasNode {
  uuid?: unknown
  title?: unknown
  url?: unknown
  type?: unknown
  children?: unknown
}

function atlasKind(type: unknown): 'folder' | 'url' | 'bookmarkBar' | null {
  if (!type || typeof type !== 'object') return null
  const keys = Object.keys(type as object)
  const k = keys[0]
  return k === 'folder' || k === 'url' || k === 'bookmarkBar' ? k : null
}

function importAtlasNode(raw: AtlasNode, seen: Set<string>): BookmarkNode | null {
  const kind = atlasKind(raw.type)
  const id = typeof raw.uuid === 'string' && raw.uuid.trim() !== '' ? raw.uuid : null
  if (!id || seen.has(id)) return null
  const title = typeof raw.title === 'string' ? raw.title : ''
  if (kind === 'url') {
    if (typeof raw.url !== 'string' || raw.url.trim() === '') return null
    seen.add(id)
    return { id, kind: 'url', title, url: raw.url }
  }
  if (kind === 'folder') {
    seen.add(id)
    return { id, kind: 'folder', title, children: importAtlasChildren(raw.children, seen) }
  }
  return null
}

function importAtlasChildren(raw: unknown, seen: Set<string>): BookmarkTree {
  if (!Array.isArray(raw)) return []
  const out: BookmarkTree = []
  for (const child of raw) {
    const node = importAtlasNode(child as AtlasNode, seen)
    if (node) out.push(node)
  }
  return out
}

/** Convert a parsed Atlas BookmarkBar JSON object into our tree. The root's own
 * node is unwrapped: its children become our top-level list. Accepts either the
 * root object or a bare children array. Pure and deterministic (ids = Atlas
 * uuids), so it is unit-tested without touching the disk. */
export function importAtlasTree(atlas: unknown): BookmarkTree {
  const seen = new Set<string>()
  if (Array.isArray(atlas)) return importAtlasChildren(atlas, seen)
  if (atlas && typeof atlas === 'object') {
    return importAtlasChildren((atlas as AtlasNode).children, seen)
  }
  return []
}
