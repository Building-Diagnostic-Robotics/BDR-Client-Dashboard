# AGENTS.md

These rules apply to all agents working in this repository.

## Development Rules

- **Understand before changing.** Inspect the relevant code, types, tests, and surrounding architecture before modifying anything. Do not guess how a system works from filenames or partial context.

- **Follow existing patterns.** Prefer the repository's established structure, conventions, libraries, abstractions, and naming. Do not introduce a new pattern or dependency unless it provides a clear benefit.

- **Keep changes scoped.** Solve the requested task without unrelated refactors, cleanup, dependency upgrades, or architecture changes.

- **Do not weaken security for convenience.** Preserve authentication, authorization, organization isolation, secure session handling, private S3 access, environment separation, and least-privilege IAM.

- **Treat client input as untrusted.** Never trust IDs, roles, organization information, filenames, paths, headers, or other values supplied by the browser as authorization evidence.

- **Preserve publication invariants.** Draft data must not become client-visible accidentally. Published report versions are immutable; replacements create new versions rather than overwriting existing files.

- **Fail closed.** If identity, authorization, ownership, publication state, or required security data cannot be verified, deny the operation rather than falling back to permissive behavior.

- **Handle failure states deliberately.** Consider retries, partial failures, concurrency, and idempotency when implementing mutations or workflows involving DynamoDB, S3, uploads, or publication.

- **Keep types and contracts aligned.** When changing an API or domain model, update shared types, validation, callers, and tests together. Avoid `any` or duplicated interfaces where shared contracts exist.

- **Validate your work.** Run the relevant typecheck, lint, tests, and build for the affected area. Add or update tests for important behavior, especially authorization and state transitions.

- **Do not hide problems.** Do not suppress errors, weaken validation, skip failing tests, or add workarounds merely to make checks pass. Fix the underlying issue or clearly report it.

- **Ask before major deviations.** If the task appears to require a significant architectural change, new infrastructure/service, destructive migration, or weakening of an existing invariant, explain the tradeoff before implementing it.

## Working Style

Prefer simple, readable, production-quality code over clever abstractions. Make the smallest complete change that solves the problem, and leave the codebase in a state another engineer can understand and continue from.