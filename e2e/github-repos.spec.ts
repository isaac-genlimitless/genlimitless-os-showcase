import { test, expect } from "@playwright/test";
import { resolveRepo, allowedRepos } from "../src/lib/github-repos";
const env = { GITHUB_REPO: "your-github-user/Genlimitless-OS", GITHUB_EXTRA_REPOS: " your-github-user/partner-os , " } as any;
test("default repo when none given", () => { expect(resolveRepo(undefined, env)).toBe("your-github-user/Genlimitless-OS"); });
test("allow-listed extra repo accepted", () => { expect(resolveRepo("your-github-user/partner-os", env)).toBe("your-github-user/partner-os"); });
test("unlisted repo rejected", () => { expect(() => resolveRepo("someone/else", env)).toThrow(/isn't allowed/); });
test("no GITHUB_REPO and no repo -> clear error", () => { expect(() => resolveRepo(undefined, {} as any)).toThrow(/GITHUB_REPO/); });
test("allowlist dedupes and trims", () => { expect(allowedRepos(env)).toEqual(["your-github-user/Genlimitless-OS", "your-github-user/partner-os"]); });
