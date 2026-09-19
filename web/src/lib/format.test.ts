import { describe, expect, it } from 'vitest';
import { fmtMoney, fmtParams, fmtIST } from './format';

describe('format utils', () => {
  it('fmtMoney INR grouping with sign', () => {
    expect(fmtMoney(37862)).toBe('₹37,862');
    expect(fmtMoney(-152430)).toBe('-₹1,52,430');
  });
  it('fmtParams joins key=value', () => {
    expect(fmtParams({ period: 9 })).toBe('period=9');
    expect(fmtParams({})).toBe('—');
  });
  it('fmtIST prints IST wall time, not UTC', () => {
    expect(fmtIST(Date.parse('2023-01-02T09:24:00+05:30'))).toBe('2023-01-02T09:24:00+05:30');
  });
});
