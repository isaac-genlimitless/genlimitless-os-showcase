import { ensureCreationsSchema, getArtifactByRef } from "@/lib/creations/store";
import { buildSite3dHtml } from "@/lib/creations/site3d-html";
import type { SitePlan } from "@/lib/creations/models/site-plan";

export const dynamic = "force-dynamic";

// 3D view of a site plan from a sandbox ("s<id>") or a canon version ("v<id>"). Read-only.
export async function GET(_req: Request, ctx: { params: Promise<{ ref: string; key: string }> }) {
  const { ref, key } = await ctx.params;
  await ensureCreationsSchema();
  let html: string;
  try {
    const { creationTitle, artifact } = getArtifactByRef(ref, key);
    if (artifact.kind !== "plan") throw new Error("artifact not found");
    html = buildSite3dHtml(`${creationTitle}: ${artifact.title}`, artifact.data as SitePlan);
  } catch {
    return new Response("Not found", { status: 404 });
  }
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      // Runs scripts (3D engine from the CDN) but isolated from the OS origin, also when opened in its own tab.
      "Content-Security-Policy": "sandbox allow-scripts",
    },
  });
}
