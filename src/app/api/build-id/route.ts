import { buildId } from "@/lib/pwa-heal";
export const dynamic = "force-dynamic";
export function GET() {
  return new Response(buildId(), { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}
