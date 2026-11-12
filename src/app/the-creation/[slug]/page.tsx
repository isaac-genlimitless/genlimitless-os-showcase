"use client";
import { Suspense, use } from "react";
import CreationWorkspace from "@/components/creation/CreationWorkspace";

export default function CreationPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  return (
    <Suspense fallback={<div className="p-8 text-sm text-muted">Loading…</div>}>
      <CreationWorkspace slug={slug} />
    </Suspense>
  );
}
