import { Unzip, UnzipInflate } from 'fflate'
import { PackageLimits } from '../application/package-contract'
import { createSha256 } from './hash'

export interface ExtractedZipEntry {
  bytes: Uint8Array
  sha256: string
}

export type ExtractedZip = Map<string, ExtractedZipEntry>

export class PackageBoundaryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PackageBoundaryError'
  }
}

export function assertSafePackagePath(path: string): void {
  const normalized = path.normalize('NFC')
  const segments = normalized.split('/')
  if (
    normalized.length > 500 ||
    normalized.startsWith('/') ||
    normalized.includes('\\') ||
    normalized.includes('\0') ||
    /^[a-z]:/i.test(normalized) ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new PackageBoundaryError(`不安全的项目包路径：${path}`)
  }
}

function combineChunks(chunks: Uint8Array[], length: number): Uint8Array {
  const output = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.length
  }
  return output
}

export async function extractZip(blob: Blob): Promise<ExtractedZip> {
  if (blob.size > PackageLimits.compressedBytes) {
    throw new PackageBoundaryError('项目包超过压缩大小限制')
  }

  return new Promise((resolve, reject) => {
    const entries: ExtractedZip = new Map()
    const normalizedPaths = new Set<string>()
    let expandedBytes = 0
    let activeFiles = 0
    let inputFinished = false
    let settled = false

    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      reject(error instanceof Error ? error : new Error(String(error)))
    }

    const finishIfReady = () => {
      if (!settled && inputFinished && activeFiles === 0) {
        settled = true
        resolve(entries)
      }
    }

    const unzip = new Unzip((file) => {
      try {
        assertSafePackagePath(file.name)
        const normalized = file.name.normalize('NFC').toLocaleLowerCase('en-US')
        if (normalizedPaths.has(normalized)) {
          throw new PackageBoundaryError(`项目包路径重复：${file.name}`)
        }
        normalizedPaths.add(normalized)
        if (normalizedPaths.size > PackageLimits.fileCount + 1) {
          throw new PackageBoundaryError('项目包文件数量超过限制')
        }
        if (file.originalSize !== undefined && file.originalSize > PackageLimits.singleFileBytes) {
          throw new PackageBoundaryError(`文件超过大小限制：${file.name}`)
        }
        if (
          file.size !== undefined &&
          file.originalSize !== undefined &&
          file.originalSize / Math.max(file.size, 1) > PackageLimits.compressionRatio
        ) {
          throw new PackageBoundaryError(`文件压缩比超过限制：${file.name}`)
        }

        activeFiles += 1
        const chunks: Uint8Array[] = []
        const hasher = createSha256()
        let fileBytes = 0
        file.ondata = (error, chunk, final) => {
          if (error) {
            fail(error)
            return
          }
          if (settled) return
          fileBytes += chunk.length
          expandedBytes += chunk.length
          if (fileBytes > PackageLimits.singleFileBytes) {
            fail(new PackageBoundaryError(`文件实际大小超过限制：${file.name}`))
            return
          }
          if (expandedBytes > PackageLimits.expandedBytes) {
            fail(new PackageBoundaryError('项目包实际展开大小超过限制'))
            return
          }
          chunks.push(chunk)
          hasher.update(chunk)
          if (final) {
            entries.set(file.name, {
              bytes: combineChunks(chunks, fileBytes),
              sha256: hasher.digestHex(),
            })
            activeFiles -= 1
            finishIfReady()
          }
        }
        file.start()
      } catch (error) {
        fail(error)
      }
    })
    unzip.register(UnzipInflate)

    void (async () => {
      try {
        const reader = blob.stream().getReader()
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (settled) {
            await reader.cancel()
            return
          }
          unzip.push(value, false)
        }
        unzip.push(new Uint8Array(), true)
        inputFinished = true
        finishIfReady()
      } catch (error) {
        fail(error)
      }
    })()
  })
}
