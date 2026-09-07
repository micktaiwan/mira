// Tab tidying: reorder the strip so twins and neighbours sit together.
//
// Pure and Electron-free (the testable half, like tab-store.ts): it takes the
// tab list and returns a new one. The command (commands/tab-tidy.ts) and the
// ProfileManager own the wiring.
//
// What "tidy" means here, in the order the rules apply:
//   1. Tabs are grouped by REGISTRABLE DOMAIN (github.com), in the order each
//      domain first appears — so a domain never jumps ahead of one that was
//      already above it.
//   2. Inside a domain, tabs are grouped by HOST (docs.github.com before
//      gist.github.com), again by first appearance: subdomains cluster, and
//      they stay under their domain.
//   3. Inside a host, exact twins (same normalized url) are collected under the
//      first of them.
// Everything else keeps its relative order, so a tidy is stable: running it
// twice changes nothing.
//
// Out of scope, deliberately: pinned tabs and tabs inside a tab folder never
// move and are never used as an anchor. They keep their exact index in the
// list; only the loose tabs are permuted, among the slots they already occupy.

import { registrableDomain } from './domain'
import type { TabMeta } from './tab-store'

/** A tab's identity for "these two are the same page": the normalized url, with
 * the same tolerance as `sameUrl` in url.ts (the trailing slash Chromium adds on
 * a bare origin is cosmetic; query and hash stay significant — a different
 * anchor IS a different destination). An unparseable url is its own key. */
export function tabUrlKey(url: string): string {
  try {
    const u = new URL(url)
    // Only a web url has a meaningful origin to normalize; about:, file: and the
    // like have an opaque one ("null"), so they stay their raw selves.
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return url
    return u.origin.toLowerCase() + u.pathname.replace(/\/$/, '') + u.search + u.hash
  } catch {
    return url
  }
}

/** The two grouping levels of a url: its registrable domain and its host, both
 * lower-cased. A url with no host (about:blank, file://…, an unparseable one)
 * has neither, and falls back to the url key itself so such tabs group only
 * with their exact twins instead of piling into one bogus bucket. */
export function tabDomainKeys(url: string): { domain: string; host: string } {
  let host = ''
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    host = ''
  }
  if (host === '') {
    const key = tabUrlKey(url)
    return { domain: key, host: key }
  }
  return { domain: registrableDomain(host), host }
}

/** Whether a tab takes part in a tidy: unpinned and in no folder. */
function isLoose(tab: TabMeta): boolean {
  return tab.pinned !== true && tab.folderId === undefined
}

/**
 * The loose tabs, reordered domain → host → exact url, each bucket ordered by
 * where its first member already was. Pinned and foldered tabs are not here.
 */
export function tidyLooseTabs(loose: readonly TabMeta[]): TabMeta[] {
  // Two levels of insertion-ordered maps: domain → host → url key → tabs.
  const byDomain = new Map<string, Map<string, Map<string, TabMeta[]>>>()
  for (const tab of loose) {
    const { domain, host } = tabDomainKeys(tab.url)
    let hosts = byDomain.get(domain)
    if (!hosts) {
      hosts = new Map()
      byDomain.set(domain, hosts)
    }
    let urls = hosts.get(host)
    if (!urls) {
      urls = new Map()
      hosts.set(host, urls)
    }
    const key = tabUrlKey(tab.url)
    const twins = urls.get(key)
    if (twins) twins.push(tab)
    else urls.set(key, [tab])
  }
  const out: TabMeta[] = []
  for (const hosts of byDomain.values()) {
    for (const urls of hosts.values()) {
      for (const twins of urls.values()) out.push(...twins)
    }
  }
  return out
}

/**
 * Tidy a whole strip: the loose tabs are permuted among the slots they already
 * occupy, every pinned or foldered tab keeps its exact index, and the active tab
 * is untouched (a tidy reorders, it never changes what you are looking at, and
 * it never opens or closes a tab).
 *
 * Returns the new list plus how many loose tabs actually changed index, so the
 * caller can say "nothing to tidy" instead of claiming work it did not do.
 */
export function tidyTabOrder(tabs: readonly TabMeta[]): { tabs: TabMeta[]; moved: number } {
  const slots: number[] = []
  const loose: TabMeta[] = []
  tabs.forEach((tab, index) => {
    if (!isLoose(tab)) return
    slots.push(index)
    loose.push(tab)
  })
  const tidied = tidyLooseTabs(loose)
  const next = [...tabs]
  let moved = 0
  slots.forEach((slot, i) => {
    if (next[slot].id !== tidied[i].id) moved++
    next[slot] = tidied[i]
  })
  return { tabs: next, moved }
}
