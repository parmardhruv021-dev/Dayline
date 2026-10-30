# Environment and REA skill audit

**Audit date:** 2026-10-27  
**Workspace:** empty local project directory (no Git metadata at inspection time).

## Environment inspected

- OS/kernel: macOS Darwin 25.6.0, x86_64.
- Shell: Bash (`/bin/bash`).
- Available: Git, Node.js v24.22.0, npm 11.19.1, Python 3.9.6, SQLite CLI 3.51.0, Xcode command line tools (`xcodebuild`), Swift, and Cargo.
- Not found on PATH: pnpm, Yarn, Bun, Deno, Go, Docker, PostgreSQL client/server (`psql`), browser executables, and standalone Playwright command. This PATH check does not prove software is absent from all system locations.
- Workspace inspection found only an empty root directory. No existing source, package manifest, lockfile, tests, README, migrations, or uncommitted Git changes were present.

## Skill inspected

Read the complete supplied `reverse-engineer-anything/SKILL.md` and its relevant `references/runtime-observation.md` and `references/connection-and-recovery.md` documents from the supplied account-skill path.

The skill describes REA routes for native and managed artifacts, JavaScript/Electron packages, browsers, archives, databases, and other explicit targets. For browser research it documents passive observation of an already-open browser, scenario capture where connected, screenshots, accessibility/DOM detail, and focused runtime follow-ups. It explicitly requires following advertised tool schemas and not claiming that passive observation performed interactions.

## Actual capabilities available in this session

- The supplied skill documentation and instructions are available.
- General web research returned public Jibble pages and official Help Center evidence, with exact URLs recorded in `product-research.md` and `evidence-register.md`.
- A Freebuff browser preview interface is available for an owned local preview if the project later runs a server.
- **REA MCP tools were not present in the active session.** `rea` was not found in the shell PATH. No user-owned Jibble browser target or authenticated account session was supplied or inspected.
- Consequently there is no REA Evidence ID, target artifact, authenticated UI observation, screenshot, live DOM capture, or application runtime trace to report. REA capabilities described by the skill must not be mistaken for capabilities exercised in this investigation.

## Limitations and research impact

1. Public pages and documentation support documentation-level claims only; they do not establish actual runtime behavior, plan availability, or configuration in a particular Jibble tenant.
2. No sign-in, invitation, permissions, validation, refresh persistence, or device interaction was performed. These are marked unknown or partially verified in the research deliverables.
3. The app starts from an empty workspace. No project stack can be reused. PostgreSQL and Docker were not found, so the initial architecture proposes a self-hostable Node service with SQLite for the first coherent local milestone, and explicitly documents SQLite's single-host/write-contention boundary. A production deployment decision and fresh-environment test remain future work.
4. No global system configuration was changed, software installed, or unrelated path inspected.

## Research approach

Use official public Jibble product pages and Help Center documentation. Record each source and the specific claim it supports. Distinguish a vendor's documented capability from independent verification, marketing assertion, design choice, inference, and unknown. Do not probe private endpoints or bypass access controls.

## First actionable milestone

Complete the evidence ledger, screen/workflow inventories, feature matrix, and an independent architecture/security/data/API plan before beginning application implementation. Implement in later milestones only against those documented decisions; verify all implemented claims with tests rather than UI appearance alone.
