import type { MediaItem } from './media-capture'

export interface AudioAnalysis {
  media: MediaItem[]
  unavailable: number
}

// Invoked only by explicit commands. No hooks, recording, playback or background polling.
// Blob reads are bounded; MediaSource URLs reject fetch and remain unavailable.
export function audioAnalysisSource(downloadUrl?: string): string {
  return `(${async function (downloadUrl?: string) {
    const limit = 32 * 1024 * 1024
    const elements = Array.from(document.querySelectorAll('audio'))
    const urls = [...new Set(elements.map((el) => el.currentSrc || el.src).filter(Boolean))].slice(
      0,
      20
    )
    if (downloadUrl && !urls.includes(downloadUrl))
      throw new Error('Audio source changed; analyze the page again')
    let totalBytes = 0
    const readBlob = async (url: string): Promise<Blob> => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 3000)
      try {
        const response = await fetch(url, { signal: controller.signal })
        if (!response.ok) throw new Error('Audio is unavailable')
        const reader = response.body?.getReader()
        if (!reader) throw new Error('Audio is unavailable')
        const chunks: Uint8Array[] = []
        let size = 0
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.byteLength
          totalBytes += value.byteLength
          if (totalBytes > limit) {
            await reader.cancel()
            throw new Error('Audio exceeds the 32 MB limit')
          }
          chunks.push(value)
        }
        if (!size) throw new Error('Audio is empty')
        return new Blob(chunks as BlobPart[], {
          type: response.headers.get('content-type') || 'audio/mpeg'
        })
      } finally {
        clearTimeout(timer)
      }
    }
    if (downloadUrl) {
      if (!downloadUrl.startsWith('blob:')) throw new Error('Expected a blob audio URL')
      const blob = await readBlob(downloadUrl)
      return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(new Error('Cannot read audio'))
        reader.readAsDataURL(blob)
      })
    }
    // Discover file sources exposed outside <audio>, without fetching them.
    const candidates = [
      ...Array.from(document.querySelectorAll('a[href]')).map(
        (el) => el.getAttribute('href') || ''
      ),
      ...Array.from(
        document.querySelectorAll(
          'meta[property="og:audio"], meta[property="og:audio:url"], meta[property="og:audio:secure_url"]'
        )
      ).map((el) => el.getAttribute('content') || ''),
      ...performance.getEntriesByType('resource').map((entry) => entry.name)
    ]
    const discovered: string[] = []
    for (const candidate of candidates.slice(0, 6000)) {
      try {
        const url = new URL(candidate, document.baseURI)
        if (
          /^https?:$/.test(url.protocol) &&
          /\.(mp3|m4a|aac|wav|ogg|opus|flac)$/i.test(url.pathname) &&
          !urls.includes(url.href) &&
          !discovered.includes(url.href)
        )
          discovered.push(url.href)
      } catch {
        /* Ignore malformed resource URLs. */
      }
      if (discovered.length >= 100) break
    }
    let unavailable = 0
    const media = await Promise.all(
      urls.map(async (url) => {
        const el = elements.find((el) => (el.currentSrc || el.src) === url)
        const item = {
          url,
          kind: 'audio',
          sources: ['dom'],
          alt: el?.title || document.title,
          audioDownloadable: false,
          bytes: 0
        }
        if (url.startsWith('blob:')) {
          try {
            const blob = await readBlob(url)
            item.audioDownloadable = true
            item.bytes = blob.size
          } catch {
            unavailable++
          }
        }
        return item
      })
    )
    for (const url of discovered)
      media.push({
        url,
        kind: 'audio',
        sources: ['dom'],
        alt: document.title,
        audioDownloadable: false,
        bytes: 0
      })
    return { media, unavailable }
  }.toString()})(${JSON.stringify(downloadUrl)})`
}
