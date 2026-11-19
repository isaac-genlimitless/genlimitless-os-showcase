# Security Policy

## Overview

GenLimitless OS Showcase is a **sanitized public sample** of a personal AI operating system. It demonstrates multi-agent architecture, approval flows, tool permissions, and self-build pipelines. It is **not** a production system and does not connect to real email, calendars, or personal data.

## Supported Versions

| Version | Supported |
| ------- | --------- |
| main    | Yes       |

Only the latest commit on `main` is considered supported for security reports.

## Reporting a Vulnerability

If you discover a security issue in this repository (for example, a flaw in the agent permission model, an approval bypass pattern, or a potential data-exposure risk in the tool design), please report it privately.

**Preferred method:** Open a private security advisory on this GitHub repository  
(Security → Advisories → Report a vulnerability).

Alternatively, you may contact the maintainer directly. Please include:

- A clear description of the issue
- Steps to reproduce (if applicable)
- Any relevant code paths or files
- Your assessment of impact and severity

**Do not** open a public GitHub issue for security vulnerabilities.

## What to Expect

- Acknowledgment of your report within a reasonable timeframe
- A discussion of whether the issue applies to the showcase code as written
- Credit in the advisory (if you wish) once resolved

Because this is a demonstration repository rather than a live service, most reports will result in documentation or code updates rather than emergency patches.

## Scope

In scope:
- Agent runtime and tool permission enforcement (`src/lib/agents/runtime.ts` and related)
- Approval flows for irreversible actions
- Guardrails and outcome methods in agent charters
- Any hardcoded credentials or secrets that may have been missed during sanitization

Out of scope:
- The original private GenLimitless OS repository (this is a separate, sanitized copy)
- Infrastructure, deployment scripts, or personal integrations that were intentionally removed
- Issues that require the full original feature set or live credentials to reproduce
- General best-practice suggestions that do not represent a concrete vulnerability

## Secrets

This repository should contain **no real secrets**. Environment examples use only placeholders. If you find an actual credential, token, or production hostname, please report it immediately so it can be removed.

## Thank You

Responsible disclosure helps keep both this sample and the patterns it demonstrates safer for anyone learning from or building on the code.
