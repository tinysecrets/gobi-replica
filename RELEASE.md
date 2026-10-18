# Release Checklist

## Validation

Install the locked dependencies and run the repository's available automated checks:

```bash
npm ci
npm test
node --check src/index.js
```

The package currently defines a Node test script but no lint or build script. Record that accurately; add explicit CI gates before treating a package build or lint result as complete. Keep test output showing passed, failed, skipped, and total counts.

## Runtime and data safety

Gobi exposes an autonomous agent with shell/file/web/API tools, scheduled tasks, communications integrations, persistent SQLite memory, and optional cloud LLM providers. Before release, review tool permissions and prompt-to-tool boundaries, restrict the service to loopback/private networks unless authentication and access controls have been independently verified, and disable real email/SMS/outbound integrations in tests. Use a temporary data directory/database and synthetic credentials for integration tests.

Never commit `.env`, provider/API keys, SQLite state, chat history, or logs containing user prompts. Inspect `git diff --check`, the staged diff, dependency changes, and the exact commit before deploying. Preserve a backup of required state and a known-good revision for rollback.
