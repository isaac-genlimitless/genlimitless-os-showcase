import { createCreation, listCreations } from "@/lib/creations/store";
import { guarded, readJson } from "@/lib/creations/http";

export const dynamic = "force-dynamic";

export async function GET() {
  return guarded(() => ({ creations: listCreations() }));
}

export async function POST(req: Request) {
  const body = await readJson(req);
  return guarded(() => ({ creation: createCreation(body) }), 201);
}
