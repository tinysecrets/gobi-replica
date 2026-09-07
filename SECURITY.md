# Security Policy

## Scope

Gobi Replica is an autonomous agent runtime capable of executing tools, accessing data, and integrating with external services. Treat tool access and credentials as production-sensitive configuration.

## Reporting a vulnerability

Please do not publish credentials, API keys, tokens, private data, or an exploitable proof-of-concept in a public issue.

Report security concerns privately to the repository maintainer through the GitHub account associated with this project.

## Deployment guidance

- Keep secrets in environment variables; never commit `.env` files.
- Run the agent with the minimum host permissions required.
- Review enabled tools before exposing the HTTP API outside the local machine.
- Keep persistent application data outside the source tree's tracked files.
- Validate and constrain autonomous actions before granting access to sensitive systems.
