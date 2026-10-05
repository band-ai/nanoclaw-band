import { describe, expect, it } from 'vitest';

import { FAST_STOP_GRACE_SEC, GRACEFUL_STOP_GRACE_SEC, stopGraceForReason } from './stop-grace.js';

describe('stopGraceForReason', () => {
  it('grants the long graceful window when the reason contains "graceful"', () => {
    expect(stopGraceForReason('absolute-ceiling graceful')).toBe(GRACEFUL_STOP_GRACE_SEC);
  });

  it('keeps recovery/stuck kills on the fast window', () => {
    expect(stopGraceForReason('absolute-ceiling')).toBe(FAST_STOP_GRACE_SEC);
    expect(stopGraceForReason('claim-stuck')).toBe(FAST_STOP_GRACE_SEC);
    expect(stopGraceForReason('rebuild applied')).toBe(FAST_STOP_GRACE_SEC);
  });
});
