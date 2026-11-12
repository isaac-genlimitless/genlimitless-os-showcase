import { NextResponse } from "next/server";
import { notionStatus } from "@/lib/notion";

// Connection status for the Analytics page: is NOTION_TOKEN set, and how much is shared with it.
export async function GET() {
  return NextResponse.json(await notionStatus());
}
