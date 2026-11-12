import { NextRequest, NextResponse } from "next/server";
import { deleteDoc, getDoc, updateDoc } from "@/lib/docs";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const doc = getDoc(Number(id));
  if (!doc) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ doc });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const doc = getDoc(Number(id));
  if (!doc) return NextResponse.json({ error: "not found" }, { status: 404 });
  const input = await req.json();
  const updated = await updateDoc(Number(id), input);
  return NextResponse.json({ doc: updated });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const doc = getDoc(Number(id));
  if (!doc) return NextResponse.json({ error: "not found" }, { status: 404 });
  const result = deleteDoc(Number(id));
  return NextResponse.json(result);
}
