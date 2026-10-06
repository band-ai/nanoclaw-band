import { describe, it, expect } from 'bun:test';

import { MockProvider } from './providers/mock.js';

describe('mock provider (fork)', () => {
  it('should wrap default responses for the originating destination', async () => {
    const provider = new MockProvider();
    const query = provider.query({
      prompt: '<message from="band-live-smoke" sender="User">hello</message>',
      cwd: '/tmp',
    });

    let resultText: string | undefined;
    for await (const event of query.events) {
      if (event.type !== 'result') continue;
      resultText = event.text ?? undefined;
      break;
    }

    expect(resultText).toContain('<message to="band-live-smoke">Mock response to:');
  });
});
