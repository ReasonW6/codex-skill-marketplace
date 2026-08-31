# Upstream snapshot

- Project: `mattpocock/skills`
- Upstream: https://github.com/mattpocock/skills
- Commit: `6654f6b60cd9d5be8b54c6fafe44346dabeb3b76`
- Commit date: 2026-08-24T15:19:57+01:00
- License: MIT

This plugin contains every skill under the upstream `skills/engineering/`
directory and the shared `skills/productivity/grilling/` dependency.
Experimental, deprecated, miscellaneous, and unrelated productivity skills are
not included.

Skill bodies and supporting files are unmodified. For Codex compatibility, the
frontmatter-only `disable-model-invocation: true` field is removed from the nine
upstream user-invoked skills because Codex's Skill and plugin validators do not
accept that value consistently. This means Codex may also select those skills
from their descriptions instead of requiring an explicit slash invocation.

The extra `grilling` skill is required by `grill-with-docs`, `triage`,
`wayfinder`, and `improve-codebase-architecture`.
