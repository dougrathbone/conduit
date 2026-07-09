import { describe, it, expect } from 'vitest'
import { formatBytes } from './utils'

describe('formatBytes', () => {
  it('renders zero as "0 B"', () => {
    expect(formatBytes(0)).toBe('0 B')
  })

  it('renders sub-kilobyte values as whole bytes', () => {
    expect(formatBytes(1)).toBe('1 B')
    expect(formatBytes(512)).toBe('512 B')
  })

  it('drops the trailing .0 on exact units', () => {
    expect(formatBytes(1024)).toBe('1 KB')
    expect(formatBytes(1024 * 1024)).toBe('1 MB')
    expect(formatBytes(1024 ** 3)).toBe('1 GB')
    expect(formatBytes(1024 ** 4)).toBe('1 TB')
  })

  it('shows one decimal place for fractional units', () => {
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(6.4 * 1024 ** 3)).toBe('6.4 GB')
  })

  it('scales into the largest fitting unit', () => {
    expect(formatBytes(2 * 1024 ** 2)).toBe('2 MB')
    expect(formatBytes(3 * 1024 ** 4)).toBe('3 TB')
  })

  it('treats negative or non-finite input as zero', () => {
    expect(formatBytes(-1)).toBe('0 B')
    expect(formatBytes(NaN)).toBe('0 B')
    expect(formatBytes(Infinity)).toBe('0 B')
  })
})
