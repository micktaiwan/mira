import { describe, it, expect } from 'vitest'
import {
  bwBinaryCandidates,
  parseCardItems,
  bwEnv,
  cardItem,
  classifyFailure,
  encodeItem,
  originHost,
  parseCreatedId,
  parseStatus
} from './bitwarden'
import type { ValidatedCard } from './card'

const card: ValidatedCard = {
  number: '4242424242424242',
  expMonth: '12',
  expYear: '2028',
  holder: 'Mickael F',
  brand: 'visa',
  origin: 'https://shop.example.com/checkout'
}
const now = new Date('2026-08-13T12:00:00Z')

describe('cardItem', () => {
  it('builds the type-3 item bw expects', () => {
    const item = cardItem(card, now)
    expect(item.type).toBe(3)
    expect(item.card.number).toBe('4242424242424242')
    expect(item.card.brand).toBe('Visa')
    expect(item.card.expMonth).toBe('12')
    expect(item.card.expYear).toBe('2028')
    expect(item.card.cardholderName).toBe('Mickael F')
  })

  it('names the item without the full number', () => {
    expect(cardItem(card, now).name).toBe('Visa 4242')
  })

  it('never writes a CVC (Mira does not capture one)', () => {
    expect(cardItem(card, now).card.code).toBe('')
  })

  it('records where and when it was saved', () => {
    expect(cardItem(card, now).notes).toBe('Saved by Mira on shop.example.com, 2026-08-13.')
  })

  it('degrades the note when the origin is not a url', () => {
    expect(cardItem({ ...card, origin: 'about:blank' }, now).notes).toBe(
      'Saved by Mira on 2026-08-13.'
    )
  })
})

describe('originHost', () => {
  it('extracts the host', () => {
    expect(originHost('https://shop.example.com/checkout')).toBe('shop.example.com')
  })

  it('returns empty for junk', () => {
    expect(originHost('not a url')).toBe('')
  })
})

describe('encodeItem', () => {
  it('round-trips through base64', () => {
    const item = cardItem(card, now)
    expect(JSON.parse(Buffer.from(encodeItem(item), 'base64').toString('utf8'))).toEqual(item)
  })
})

describe('bwEnv', () => {
  it('pins the appdata dir and keeps the inherited env', () => {
    const env = bwEnv({ PATH: '/usr/bin' }, { appDataDir: '/tmp/bw-perso' }, 'sess')
    expect(env.PATH).toBe('/usr/bin')
    expect(env.BITWARDENCLI_APPDATA_DIR).toBe('/tmp/bw-perso')
    expect(env.BW_SESSION).toBe('sess')
  })

  it('drops an inherited BW_SESSION when we have none (never use another account key)', () => {
    const env = bwEnv({ BW_SESSION: 'pro-key' }, { appDataDir: '/tmp/bw-perso' }, null)
    expect(env.BW_SESSION).toBeUndefined()
  })
})

describe('parseStatus', () => {
  it('reads a real bw status line', () => {
    const out =
      '{"serverUrl":null,"lastSync":"2026-07-13T14:19:00.274Z","userEmail":"faivrem@gmail.com","userId":"aa7","status":"locked"}'
    expect(parseStatus(out)).toEqual({ state: 'locked', email: 'faivrem@gmail.com' })
  })

  it('tolerates a banner before the json', () => {
    expect(parseStatus('some noise\n{"status":"unlocked"}').state).toBe('unlocked')
  })

  it('returns unknown rather than throwing on garbage', () => {
    expect(parseStatus('Master password:').state).toBe('unknown')
    expect(parseStatus('{oops').state).toBe('unknown')
  })
})

describe('classifyFailure', () => {
  it('spots a locked vault', () => {
    expect(classifyFailure('Vault is locked.')).toBe('locked')
    expect(classifyFailure('Invalid master password.')).toBe('locked')
  })

  it('reads a rejected refresh token as logged out, not as locked', () => {
    expect(classifyFailure("Unable to fetch ServerConfig: { error: 'invalid_grant' }")).toBe(
      'unauthenticated'
    )
  })

  it('spots a missing login and a missing binary', () => {
    expect(classifyFailure('You are not logged in.')).toBe('unauthenticated')
    expect(classifyFailure('spawn bw ENOENT')).toBe('not-installed')
  })

  it('falls back to failed', () => {
    expect(classifyFailure('some other error')).toBe('failed')
  })
})

describe('parseCreatedId', () => {
  it('reads the created item id', () => {
    expect(parseCreatedId('{"object":"item","id":"abc-123","type":3}')).toBe('abc-123')
  })

  it('returns null when bw printed nothing usable', () => {
    expect(parseCreatedId('')).toBeNull()
  })
})

describe('bwBinaryCandidates', () => {
  it('tries the Homebrew path before a bare PATH lookup', () => {
    const candidates = bwBinaryCandidates({})
    expect(candidates[0]).toBe('/opt/homebrew/bin/bw')
    expect(candidates[candidates.length - 1]).toBe('bw')
  })

  it('lets MIRA_BW_BIN win', () => {
    expect(bwBinaryCandidates({ MIRA_BW_BIN: '/opt/custom/bw' })[0]).toBe('/opt/custom/bw')
  })
})

describe('parseCardItems', () => {
  const vault = JSON.stringify([
    { id: '1', name: 'GitHub', type: 1, login: { username: 'a' } },
    {
      id: '2',
      name: 'Visa 4242',
      type: 3,
      card: {
        cardholderName: 'Mickael F',
        brand: 'Visa',
        number: '4242424242424242',
        expMonth: '12',
        expYear: '2028',
        code: '123'
      }
    },
    { id: '3', name: 'A note', type: 2 }
  ])

  it('keeps the cards and drops logins and notes', () => {
    const cards = parseCardItems(vault)
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ id: '2', name: 'Visa 4242', brand: 'Visa', expYear: '2028' })
  })

  it('returns the last four digits and NEVER the full number or the code', () => {
    const cards = parseCardItems(vault)
    expect(cards[0].last4).toBe('4242')
    expect(JSON.stringify(cards)).not.toContain('4242424242424242')
    expect(JSON.stringify(cards)).not.toContain('123')
  })

  it('survives junk and an empty vault', () => {
    expect(parseCardItems('')).toEqual([])
    expect(parseCardItems('not json')).toEqual([])
    expect(parseCardItems('[]')).toEqual([])
    expect(parseCardItems('[{"type":3}]')).toEqual([])
  })
})
