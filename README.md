# GenLimitless OS (showcase)

A personal AI operating system: one Next.js app where a team of AI agents runs email, calendar,
texts, files, meetings and research for individuals and SMBs. A Chief of Staff agent takes every request,
delegates to specialist agents, checks their work and reports back. **Every significant send, delete or code
change waits for the owner's approval.**

> This is a sanitized showcase copy. Personal data, private integrations, deployment scripts and
> several personal features were removed, names were replaced with placeholders (Owner, Chief,
> Partner), and the git history starts fresh. It shows the architecture and code, not a
> ready-to-deploy product.

<!-- Screenshots: add images to docs/screenshots/ and link them here. -->

## What's interesting in here

| Area | Where | What it does |
| --- | --- | --- |
| Agent runtime | `src/lib/agents/runtime.ts` | Runs agents on the Claude Agent SDK: chat turns, delegated hand-offs, scheduled loops (morning briefing, evening shutdown, weekly review) |
| Agent team | `src/lib/agents/charters.ts`, `registry.ts` | Core agents (Chief of Staff, Full Stack Engineer) plus custom agents the Chief can create, rewrite and retire |
| Tools | `src/lib/agents/tools.ts` | ~90 MCP tools grouped by role, with per-agent permissions and owner-only groups |
| Approval flow | `src/lib/agents/approvals.ts`, `src/app/decisions/` | One queue of everything waiting on the owner; nothing irreversible happens without a click |
| Self-build pipeline | `src/lib/agents/fixes.ts`, `src/lib/pr-*.ts`, `src/lib/auto-merge-policy.ts` | The engineer agent proposes code fixes; the Chief reviews; major changes go to the owner; approved fixes become PRs |
| Undo | `src/lib/undo*.ts` | Agent actions are logged with before/after state so a chat turn can be undone |
| Files ("second brain") | `src/app/files/`, `src/lib/pages.ts` | Notion-style pages with comments, versions, sharing and mentions |
| Creations studio | `src/lib/creations/` | Multi-agent missions with budgets, sandboxes and proposals promoted to canon |
| Mail, calendar, texts | `src/lib/mail*.ts`, `gcal*.ts`, `imessage.ts` | IMAP/SMTP, CalDAV/Google Calendar and an iMessage bridge |
| Multi-user cells | `src/lib/instance.ts`, `src/lib/accounts/` | Owner cell plus member cells with a reduced tool set |

## Guardrails

- Agents draft; the owner sends. Outbound messages go through approval or a per-recipient Autopilot the owner turns on.
- Deletions are soft (archive/trash) and go through `request_owner_approval`.
- The engineer agent can't edit code directly: proposal → Chief of Staff review → owner approval for anything major → type-check and tests.
- Web reading is GET-only and blocks private addresses (see `src/lib/web-page.ts` and its tests).

## Stack

Next.js (App Router) · TypeScript · SQLite (`better-sqlite3`) · Claude Agent SDK · BlockNote editor ·
Playwright (about 190 e2e specs in `e2e/`; a few were written against features removed from this showcase and may fail).

## Running it locally

Requires Node 20.9+ (a Next.js 16 requirement).

```bash
npm install
cp .env.example .env.local   # everything in it is optional
npm run dev -- -p 3100
```

Configuration is read from environment variables (see `.env.example`; for example `SESSION_SECRET`, `GMAIL_USER`,
`GMAIL_APP_PASSWORD`, `GOOGLE_CLIENT_ID`, `NOTION_TOKEN`, `GITHUB_REPO`). Integrations without
credentials stay off. Data lives in `GENLIMITLESS_DATA_DIR` (default `./data`, git-ignored).
