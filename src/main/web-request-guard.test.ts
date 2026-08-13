import { describe, it, expect, vi } from 'vitest'
import { guardFailureLine, guardedVerdict } from './web-request-guard'

describe('guardedVerdict', () => {
  it('returns the listener verdict when nothing throws', () => {
    const log = vi.fn()
    const verdict = guardedVerdict<{ cancel?: boolean }>(
      'onBeforeRequest',
      'https://x.test/a',
      {},
      () => ({ cancel: true }),
      log
    )
    expect(verdict).toEqual({ cancel: true })
    expect(log).not.toHaveBeenCalled()
  })

  it('answers neutral instead of hanging the request when the listener throws', () => {
    const log = vi.fn()
    const verdict = guardedVerdict(
      'onBeforeRequest',
      'https://js.stripe.com/v3/elements-inner-address.html',
      {},
      () => {
        throw new Error('DNR match blew up')
      },
      log
    )
    // Neutral = the same answer as having no listener at all: the request goes on.
    expect(verdict).toEqual({})
  })

  it('logs the failing event and URL so the throw is not silent', () => {
    const log = vi.fn()
    const boom = new Error('bridge emit blew up')
    guardedVerdict(
      'onHeadersReceived',
      'https://js.stripe.com/v3/x.js',
      {},
      () => {
        throw boom
      },
      log
    )
    expect(log).toHaveBeenCalledTimes(1)
    const [message, error] = log.mock.calls[0]
    expect(message).toContain('onHeadersReceived')
    expect(message).toContain('https://js.stripe.com/v3/x.js')
    expect(error).toBe(boom)
  })

  it('keeps the original headers as the neutral answer of a header event', () => {
    const requestHeaders = { Accept: '*/*' }
    const verdict = guardedVerdict(
      'onBeforeSendHeaders',
      'https://x.test/a',
      { requestHeaders },
      () => {
        throw new Error('nope')
      },
      vi.fn()
    )
    expect(verdict).toEqual({ requestHeaders })
  })

  it('survives a request with no URL', () => {
    expect(guardFailureLine('onBeforeRequest', undefined)).toContain('<no url>')
  })
})
