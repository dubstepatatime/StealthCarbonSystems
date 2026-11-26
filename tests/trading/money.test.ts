import { describe, expect, it } from 'vitest'
import { ceilTo, dec, decimalsOf, floorTo, formatTo, toDecimalString, tryDec, usd } from '@/lib/trading/money'

describe('money', () => {
  it('parses plain decimals and rejects everything else', () => {
    expect(dec('60748.80').toFixed()).toBe('60748.8')
    expect(dec(0.1).plus(dec(0.2)).toFixed()).toBe('0.3')
    for (const bad of ['', 'abc', '1e5', '1,000', ' ', '0x10', 'NaN', 'Infinity', '1.2.3']) expect(() => dec(bad), bad).toThrow()
    expect(() => dec(Number.NaN)).toThrow()
    expect(() => dec(Number.POSITIVE_INFINITY)).toThrow()
    expect(tryDec('12.5')!.toFixed()).toBe('12.5')
    expect(tryDec({})).toBeNull()
    expect(tryDec('1e5')).toBeNull()
  })

  it('rounds sizes down and never up', () => {
    expect(floorTo(dec('0.123456789'), '0.00000001').toFixed()).toBe('0.12345678')
    expect(floorTo(dec('99.999'), '0.01').toFixed()).toBe('99.99')
    expect(ceilTo(dec('99.991'), '0.01').toFixed()).toBe('100')
    expect(floorTo(dec('7'), '0.5').toFixed()).toBe('7')
    expect(() => floorTo(dec(1), 0)).toThrow()
  })

  it('formats to exchange increments', () => {
    expect(decimalsOf('0.00000001')).toBe(8)
    expect(decimalsOf('1')).toBe(0)
    expect(formatTo(dec('0.5'), '0.00000001')).toBe('0.50000000')
    expect(formatTo(dec('60250.049'), '0.01')).toBe('60250.04')
  })

  it('never prints exponents', () => {
    expect(toDecimalString(dec('0.00000001'))).toBe('0.00000001')
    expect(toDecimalString(dec('123456789012345678'))).toBe('123456789012345678')
    expect(usd(dec('1234.565'))).toBe('1234.57')
  })
})
