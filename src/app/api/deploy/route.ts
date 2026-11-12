import { ownerOnly } from "@/lib/instance";
import { NextRequest, NextResponse } from "next/server";
import { diskInfo, gb, neededBytes, deployEnabled, latestMainSha, liveRelease, readDeployStatus, startDeploy } from "@/lib/deploy";

// GET → is this the server, which commit is live, is GitHub main ahead, and the last deploy's status.
async function glosGET() {
  if (!deployEnabled()) return NextResponse.json({ enabled: false });
  const [latest] = await Promise.all([latestMainSha()]);
  const live = liveRelease();
  return NextResponse.json({
    enabled: true,
    live,
    latest,
    behind: !!latest && live !== latest,
    status: readDeployStatus(),
    disk: diskInfo(),
  });
}

// POST { action: "deploy" | "rollback" }: only starts the deploy script; progress comes from GET.
async function glosPOST(req: NextRequest) {
  if (!deployEnabled()) return NextResponse.json({ error: "Deploys only run on the server" }, { status: 400 });
  const { action } = await req.json();
  if (action !== "deploy" && action !== "rollback") return NextResponse.json({ error: "unknown action" }, { status: 400 });
  if (readDeployStatus()?.state === "running") return NextResponse.json({ error: "A deploy is already running" }, { status: 409 });
  if (action === "deploy") {
    const disk = diskInfo();
    const need = neededBytes();
    if (disk && disk.freeBytes < need) {
      return NextResponse.json(
        {
          error: `Not enough free disk to back up the database before deploying: ${gb(disk.freeBytes)} GB free, need about ${gb(need)} GB. Free space on the server first; deleting old backups/releases needs Owner's OK.`,
        },
        { status: 507 }
      );
    }
  }
  try {
    await startDeploy(action);
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// Owner-only: 404 in a member cell (docs/multi-user.md "Member mode").
export const GET = ownerOnly(glosGET);
export const POST = ownerOnly(glosPOST);
