import { CLIENT_JS } from "@/lib/comments-client-src";

// Serves the highlight-to-comment client script to the Files viewer (behind the normal login).

export const dynamic = "force-dynamic";

export async function GET() {
  return new Response(CLIENT_JS, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "private, max-age=300",
    },
  });
}
