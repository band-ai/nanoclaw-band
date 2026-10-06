import { describe, expect, it } from 'vitest';

import { FAST_STOP_GRACE_SEC, GRACEFUL_STOP_GRACE_SEC, stopGraceForReason } from './stop-grace.js';

describe('stopGraceForReason', () => {
  it('grants the long graceful window when the reason contains "graceful"', () => {
    expect(stopGraceForReason('absolute-ceiling graceful')).toBe(GRACEFUL_STOP_GRACE_SEC);
  });

  it('keeps recovery/stuck kills on the base window', () => {
    expect(stopGraceForReason('absolute-ceiling')).toBe(FAST_STOP_GRACE_SEC);
    expect(stopGraceForReason('claim-stuck', 1)).toBe(1);
    expect(stopGraceForReason('rebuild applied', 5)).toBe(5);
  });

  it('never shortens a base grace that already exceeds the graceful window', () => {
    expect(stopGraceForReason('absolute-ceiling graceful', GRACEFUL_STOP_GRACE_SEC + 60)).toBe(
      GRACEFUL_STOP_GRACE_SEC + 60,
    );
  });
});
