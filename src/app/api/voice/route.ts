import { NextRequest, NextResponse } from "next/server";
import { getVoiceProfile, regenerateVoiceProfile, addVoiceSource } from "@/lib/voice";

export async function GET() {
  const profile = getVoiceProfile();
  return NextResponse.json({ profile });
}

export async function POST(req: NextRequest) {
  try {
    const contentType = req.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const body = await req.json().catch(() => null);
      if (body?.extraText) {
        addVoiceSource(body.label || "provided thread", body.extraText);
      }
    }

    const profile = await regenerateVoiceProfile();
    return NextResponse.json({ profile });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
