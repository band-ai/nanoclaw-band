# Fork conventions (band-ai/nanoclaw-band)

This fork merges `nanocoai/nanoclaw` `main` regularly. Every line changed inside an upstream-owned file (any path that exists in `upstream/main`) can cause a merge conflict. Keep that diff minimal:

- **Fork logic goes in fork-owned files.** Host code goes in `src/fork/<topic>.ts`, agent-runner code in `container/agent-runner/src/fork/<topic>.ts`. Existing fork files (`src/db/fork-*.ts`, `src/db/migrations/fork.ts`, `src/channels/channel-container-registry.ts`, `container/agent-runner/src/{mcp-servers,lifecycle}.ts`) stay where they are.
- **Upstream files keep only thin hooks:** one `// Fork:` import block at the end of the import section, plus one-line calls. Add new lines; don't rewrite, reflow, or re-comment upstream lines.
- **Extend upstream types without editing their files.** Use `declare module '<path>'` interface augmentation (see `src/fork/session-contribution.ts`, `src/fork/channel-adapter.ts`, `container/agent-runner/src/fork/claude-env.ts`).
- **Put fork tests in fork-owned files** (`<name>.fork.test.ts` or `src/fork/*.test.ts`), not appended to upstream test files.
- **No cosmetic edits to upstream files.** Don't reformat them, fix comment typos, or restyle types. Upstream's `container/` and `setup/` files are not all Prettier-clean; leave them as upstream has them. CI's `format:check` covers `src/` only.
- **Generic fixes go upstream as PRs** so the fork can drop them. Current candidates are the `user_visible_tool` provider event, `CLAUDE_CODE_EXECUTABLE`, per-query MCP env, `InboundRouteResult`, and the CodeQL/workflow hardening.

To check the current surface:

```bash
git diff --numstat --diff-filter=M upstream/main HEAD | sort -k1 -nr
```
