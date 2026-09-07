import { describe, it, expect } from 'vitest'
import {
  enterFullScreen,
  panelChanged,
  exitFullScreen,
  shouldLeaveWindowFullScreen
} from './html-fullscreen'

describe('html fullscreen panel bookkeeping', () => {
  it('exit restores the panels as they were on enter', () => {
    const ep = enterFullScreen('tab-1', { tabsCollapsed: false, skillPaneOpen: true })
    expect(ep.tabId).toBe('tab-1')
    expect(exitFullScreen(ep)).toEqual({ tabsCollapsed: false, skillPaneOpen: true })
  })

  it('a panel toggled during fullscreen wins over the snapshot', () => {
    let ep = enterFullScreen('tab-1', { tabsCollapsed: false, skillPaneOpen: false })
    ep = panelChanged(ep, { tabsCollapsed: true })
    expect(exitFullScreen(ep)).toEqual({ tabsCollapsed: true, skillPaneOpen: false })
  })

  it('only the changed panel is overridden, the other keeps its snapshot', () => {
    let ep = enterFullScreen('tab-1', { tabsCollapsed: true, skillPaneOpen: true })
    ep = panelChanged(ep, { skillPaneOpen: false })
    expect(exitFullScreen(ep)).toEqual({ tabsCollapsed: true, skillPaneOpen: false })
  })

  it('the LAST change wins when a panel is toggled several times', () => {
    let ep = enterFullScreen('tab-1', { tabsCollapsed: false, skillPaneOpen: false })
    ep = panelChanged(ep, { skillPaneOpen: true })
    ep = panelChanged(ep, { skillPaneOpen: false })
    ep = panelChanged(ep, { skillPaneOpen: true })
    expect(exitFullScreen(ep)).toEqual({ tabsCollapsed: false, skillPaneOpen: true })
  })
})

describe('window fullscreen ownership', () => {
  it('takes the window out of fullscreen when the PAGE is what put it there', () => {
    const episode = enterFullScreen('t1', { tabsCollapsed: false, skillPaneOpen: false }, false)
    expect(shouldLeaveWindowFullScreen(episode)).toBe(true)
  })

  it('leaves the window fullscreen when the user had already put it there', () => {
    const episode = enterFullScreen('t1', { tabsCollapsed: false, skillPaneOpen: false }, true)
    expect(shouldLeaveWindowFullScreen(episode)).toBe(false)
  })

  it('defaults to "the page did it" when the caller says nothing', () => {
    const episode = enterFullScreen('t1', { tabsCollapsed: false, skillPaneOpen: false })
    expect(episode.windowWasFullScreen).toBe(false)
  })
})
