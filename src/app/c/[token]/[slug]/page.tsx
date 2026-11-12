"use client";
import { Suspense, use } from "react";
import CreationWorkspace from "@/components/creation/CreationWorkspace";

export default function CollabCreation({ params }: { params: Promise<{ token: string; slug: string }> }) {
  const { token, slug } = use(params);
  return (
    <Suspense fallback={<div className="p-8 text-sm text-muted">Loading…</div>}>
      <CreationWorkspace slug={slug} apiBase={`/c/${token}/api/creations`} linkBase={`/c/${token}`} />
    </Suspense>
  );
}
