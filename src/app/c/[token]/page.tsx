"use client";
import { useOwnerName } from "@/components/CellContext";
import { use } from "react";
import CreationsHome from "@/components/creation/CreationsHome";

// What a collaborator sees at their private link: only the creations they're on.
export default function CollabHome({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const ownerName = useOwnerName();
  return (
    <>
      <div className="px-4 md:px-12 pt-8">
        <h1 className="font-display text-3xl tracking-wide">The Creation</h1>
        <p className="text-sm text-muted mt-1">Shared with you by {ownerName}. Build anything in your own sandboxes; {ownerName} approves what becomes canon.</p>
      </div>
      <CreationsHome apiBase={`/c/${token}/api/creations`} linkBase={`/c/${token}`} canCreate={false} />
    </>
  );
}
