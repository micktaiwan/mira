import { describe, it, expect } from 'vitest'
import { extraBinDirs, augmentedPath, ytdlpArgs, parseProgress, pickFilepath } from './ytdlp'

describe('extraBinDirs', () => {
  it('lists Homebrew/system bins, and adds HOME-relative pyenv/local/cargo bins', () => {
    const dirs = extraBinDirs('/Users/me')
    expect(dirs).toContain('/opt/homebrew/bin')
    expect(dirs).toContain('/Users/me/.pyenv/shims')
    expect(dirs).toContain('/Users/me/.local/bin')
  })

  it('omits the HOME-relative dirs when HOME is undefined', () => {
    const dirs = extraBinDirs(undefined)
    expect(dirs.every((d) => !d.includes('.pyenv'))).toBe(true)
  })
})

describe('augmentedPath', () => {
  it('prepends the extra bins before the inherited PATH', () => {
    const p = augmentedPath('/usr/bin:/bin', '/Users/me')
    const parts = p.split(':')
    expect(parts[0]).toBe('/opt/homebrew/bin')
    expect(parts.indexOf('/Users/me/.pyenv/shims')).toBeLessThan(parts.indexOf('/usr/bin'))
  })

  it('drops empties and duplicates', () => {
    const p = augmentedPath('/opt/homebrew/bin::/usr/bin', '/Users/me')
    const parts = p.split(':')
    expect(parts.filter((x) => x === '/opt/homebrew/bin')).toHaveLength(1)
    expect(parts).not.toContain('')
  })
})

describe('ytdlpArgs', () => {
  it('builds the download args with a title template and the url last', () => {
    const args = ytdlpArgs('https://x.com/a/status/1/video/1', '/tmp/dl')
    expect(args).toContain('--no-playlist')
    expect(args).toContain('--restrict-filenames')
    expect(args[args.length - 1]).toBe('https://x.com/a/status/1/video/1')
    const oi = args.indexOf('-o')
    expect(args[oi + 1]).toBe('/tmp/dl/%(title).100s.%(ext)s')
  })
})

describe('parseProgress', () => {
  it('reads a percentage from a download line', () => {
    expect(parseProgress('[download]  42.3% of 6.00MiB')).toBe(42.3)
    expect(parseProgress('[download] 100% of 6.00MiB')).toBe(100)
  })
  it('caps at 100 and returns null for non-progress lines', () => {
    expect(parseProgress('[download] 120%')).toBe(100)
    expect(parseProgress('[info] Writing video')).toBeNull()
    expect(parseProgress('random')).toBeNull()
  })
})

describe('pickFilepath', () => {
  it('returns the last bare (non-bracketed) stdout line', () => {
    const out = ['[download] 100%', '/Users/me/Downloads/clip.mp4', ''].join('\n')
    expect(pickFilepath(out)).toBe('/Users/me/Downloads/clip.mp4')
  })
  it('returns empty when only status lines are present', () => {
    expect(pickFilepath('[download] 50%\n[download] 100%')).toBe('')
  })
})
