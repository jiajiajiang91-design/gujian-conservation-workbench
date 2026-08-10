import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'

export function sha256Hex(input: Uint8Array | string): string {
  const bytes = typeof input === 'string' ? utf8ToBytes(input) : input
  return bytesToHex(sha256(bytes))
}

export function createSha256() {
  const hasher = sha256.create()
  return {
    update(chunk: Uint8Array) {
      hasher.update(chunk)
    },
    digestHex() {
      return bytesToHex(hasher.digest())
    },
  }
}
