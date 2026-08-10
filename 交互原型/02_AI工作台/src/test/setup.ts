import '@testing-library/jest-dom/vitest'
import 'fake-indexeddb/auto'
import { Blob as NodeBlob } from 'node:buffer'

Object.defineProperty(globalThis, 'Blob', { configurable: true, value: NodeBlob })
