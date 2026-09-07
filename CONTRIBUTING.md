# Contributing to Gobi Replica

Thanks for helping improve Gobi Replica.

## Development principles

- Keep changes focused and reviewable.
- Prefer small, composable services over tightly coupled features.
- Preserve local-first operation wherever practical.
- Never commit secrets, credentials, local databases, or generated runtime state.
- Test agent behavior against real tool results; do not rely on mocked success for critical workflows.
- Document new environment variables and operational requirements.

## Development

```bash
npm install
npm run dev
```

The default HTTP service listens on port `8080`.

## Pull requests

A good pull request should explain:

1. What changed.
2. Why it changed.
3. How it was tested.
4. Any configuration or deployment implications.

For autonomous-agent changes, include the relevant tool-execution and failure-path behavior.
