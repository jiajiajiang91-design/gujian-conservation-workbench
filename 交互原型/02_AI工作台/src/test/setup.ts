import '@testing-library/jest-dom/vitest'
import { Blob as NodeBlob } from 'node:buffer'

Object.defineProperty(globalThis, 'Blob', { configurable: true, value: NodeBlob })
