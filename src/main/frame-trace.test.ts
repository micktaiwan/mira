import { describe, it, expect } from 'vitest'
import { isAbortedLoad, isExpectedExit, processGoneLine, subframeFailureLine } from './frame-trace'

describe('aborted loads', () => {
  it('treats ERR_ABORTED as a non-failure', () => {
    expect(isAbortedLoad(-3)).toBe(true)
  })

  it('keeps real net errors', () => {
    expect(isAbortedLoad(-105)).toBe(false)
    expect(isAbortedLoad(0)).toBe(false)
  })
})

describe('subframe failure line', () => {
  it('names the error and the frame URL', () => {
    const line = subframeFailureLine({
      url: 'https://js.stripe.com/v3/elements-inner-address.html',
      errorCode: -105,
      errorDescription: 'ERR_NAME_NOT_RESOLVED'
    })
    expect(line).toContain('ERR_NAME_NOT_RESOLVED')
    expect(line).toContain('-105')
    expect(line).toContain('https://js.stripe.com/v3/elements-inner-address.html')
  })
})

describe('process death', () => {
  it('stays quiet on a clean exit', () => {
    expect(isExpectedExit('clean-exit')).toBe(true)
  })

  it('reports crashes, kills and OOMs', () => {
    expect(isExpectedExit('crashed')).toBe(false)
    expect(isExpectedExit('killed')).toBe(false)
    expect(isExpectedExit('oom')).toBe(false)
    expect(isExpectedExit(undefined)).toBe(false)
  })

  it('formats a tab renderer death with its reason and exit code', () => {
    const line = processGoneLine('tab abc', { reason: 'crashed', exitCode: 133 })
    expect(line).toContain('tab abc')
    expect(line).toContain('reason=crashed')
    expect(line).toContain('exitCode=133')
  })

  it('names the process type and service of a child process', () => {
    const line = processGoneLine('child process', {
      type: 'Utility',
      serviceName: 'network.mojom.NetworkService',
      reason: 'crashed',
      exitCode: 5
    })
    expect(line).toContain('Utility/network.mojom.NetworkService')
    expect(line).toContain('reason=crashed')
  })

  it('degrades gracefully when Electron reports almost nothing', () => {
    expect(processGoneLine('child process', {})).toContain('reason=unknown')
  })
})
