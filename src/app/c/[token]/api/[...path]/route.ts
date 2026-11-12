// The Creation for collaborators: everything under /c/<token>/api/creations/... mirrors /api/creations/...
// but runs as the person the token belongs to. The store enforces what they may do (members only; their own
// sandboxes; no canon or phase changes). There is no route here that decides a promotion.
import { NextResponse } from "next/server";
import {
  addComment, archiveSandbox, createSandbox, ensureCreationsSchema, getArtifactByRef, getCreation, getSandbox, getVersion,
  listCreations, proposePromotion, rebaseSandbox, resolveComment, saveArtifact,
} from "@/lib/creations/store";
import { resolveCollabToken } from "@/lib/creations/people";
import { editStep, listSteps, proposeStep } from "@/lib/creations/execution";
import { buildSite3dHtml } from "@/lib/creations/site3d-html";
import type { SitePlan } from "@/lib/creations/models/site-plan";
import { badTokenLimit } from "@/lib/page-edit-access";
import { clientIp, originOk } from "@/lib/file-comments";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ token: string; path: string[] }> };
const SEC = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };
const json = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: SEC });
const err = (e: unknown) => {
  const msg = e instanceof Error ? e.message : "Unexpected error";
  const status = /not found/i.test(msg) ? 404 : /only the|viewers can't/i.test(msg) ? 403 : 400;
  return json({ error: msg }, status);
};
const id = (raw: string | undefined) => {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error("not found");
  return n;
};

async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    const b = await req.json();
    return b && typeof b === "object" && !Array.isArray(b) ? b : {};
  } catch {
    return {};
  }
}

/** Single gate: a bad token always gets the same 404 and is rate limited per IP. */
async function who(req: Request, ctx: Ctx): Promise<{ person: string; path: string[] } | { res: Response }> {
  const { token, path } = await ctx.params;
  await ensureCreationsSchema();
  const person = resolveCollabToken(token);
  if (!person) {
    const wait = badTokenLimit(clientIp(req));
    return { res: wait ? json({ error: "too many requests" }, 429) : json({ error: "not found" }, 404) };
  }
  if (path[0] !== "creations") return { res: json({ error: "not found" }, 404) };
  return { person, path: path.slice(1) };
}

export async function GET(req: Request, ctx: Ctx) {
  const g = await who(req, ctx);
  if ("res" in g) return g.res;
  const [a, b, c, d] = g.path;
  try {
    if (a === undefined) return json({ creations: listCreations(g.person), viewer: g.person });
    if (a === "sandboxes" && c === undefined) return json(getSandbox(id(b), g.person));
    if (a === "versions" && c === undefined) return json(getVersion(id(b), g.person));
    if (a === "site3d" && b && c && d === undefined) {
      const { creationTitle, artifact } = getArtifactByRef(b, c, g.person);
      if (artifact.kind !== "plan") throw new Error("not found");
      return new Response(buildSite3dHtml(`${creationTitle}: ${artifact.title}`, artifact.data as SitePlan), {
        headers: { ...SEC, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "sandbox allow-scripts" },
      });
    }
    if (b === "steps" && c === undefined) return json({ steps: listSteps(a, g.person) });
    if (b === undefined) return json(getCreation(a, g.person));
    return json({ error: "not found" }, 404);
  } catch (e) {
    return err(e);
  }
}

export async function POST(req: Request, ctx: Ctx) {
  if (!originOk(req)) return json({ error: "cross_site_request" }, 403);
  const g = await who(req, ctx);
  if ("res" in g) return g.res;
  const [a, b, c, d] = g.path;
  const data = await body(req);
  try {
    if (a === "sandboxes" && c === "artifacts" && d === undefined) return json({ artifact: saveArtifact(id(b), data, g.person) });
    if (a === "sandboxes" && c === "promote" && d === undefined) return json({ promotion: proposePromotion(id(b), data, g.person) }, 201);
    if (a === "feed" && c === undefined) {
      if (data.action !== "resolve") throw new Error("action must be resolve");
      resolveComment(id(b), g.person);
      return json({ ok: true });
    }
    if (a && b === "sandboxes" && c === undefined) return json({ sandbox: createSandbox(a, data, g.person) }, 201);
    if (a && b === "comments" && c === undefined) return json({ comment: addComment(a, data, g.person) }, 201);
    // Collaborators can propose and edit their own proposed steps; only Owner's session can approve them.
    if (a && b === "steps" && c === undefined) return json({ step: proposeStep(a, data, g.person) }, 201);
    if (a === "steps" && c === undefined) {
      if (data.action !== "edit") throw new Error("only the owner can approve steps");
      return json({ step: editStep(id(b), { title: data.title, details: data.details, payload: data.payload }, g.person) });
    }
    return json({ error: "not found" }, 404);
  } catch (e) {
    return err(e);
  }
}

export async function PATCH(req: Request, ctx: Ctx) {
  if (!originOk(req)) return json({ error: "cross_site_request" }, 403);
  const g = await who(req, ctx);
  if ("res" in g) return g.res;
  const [a, b, c] = g.path;
  const data = await body(req);
  try {
    if (a === "sandboxes" && c === undefined) {
      if (data.action === "archive") return json({ sandbox: archiveSandbox(id(b), g.person) });
      if (data.action === "rebase") return json(rebaseSandbox(id(b), g.person));
      throw new Error("action must be archive or rebase");
    }
    return json({ error: "not found" }, 404);
  } catch (e) {
    return err(e);
  }
}
