import { budgetStatus } from "@/lib/creations/missions";
import { guarded } from "@/lib/creations/http";

export const dynamic = "force-dynamic";

export async function GET() {
  return guarded(() => ({ budget: budgetStatus() }));
}
