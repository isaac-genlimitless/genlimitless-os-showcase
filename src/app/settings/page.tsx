import Link from "next/link";
import AnalyticsPage from "../analytics/page";
import WeeklyCleanupCard from "@/components/WeeklyCleanupCard";
import ServerHealthCard from "@/components/ServerHealthCard";
import DiskUsageCard from "@/components/DiskUsageCard";
import AgentSchedulesCard from "@/components/AgentSchedulesCard";
import UsersPanel from "@/components/UsersPanel";
import { isOwnerCell } from "@/lib/instance";

export default async function SettingsPage({ searchParams }: { searchParams?: Promise<{ tab?: string }> }) {
  const owner = isOwnerCell();
  const sp = (await searchParams) ?? {};
  const usersTab = owner && sp.tab === "users";
  const tabCls = (on: boolean) =>
    `inline-flex items-center min-h-[44px] px-4 rounded-lg text-sm font-semibold border ${on ? "bg-foreground text-background border-foreground" : "border-black/10 dark:border-white/15"}`;
  return (
    <>
      {owner && (
        <nav aria-label="Settings tabs" className="flex gap-2 px-4 md:px-8 pt-4">
          <Link href="/settings" className={tabCls(!usersTab)}>General</Link>
          <Link href="/settings?tab=users" className={tabCls(usersTab)}>Users</Link>
        </nav>
      )}
      {usersTab ? (
        <div className="px-4 md:px-8 py-6">
          <h1 className="text-2xl font-bold mb-4">Users</h1>
          <UsersPanel />
        </div>
      ) : (
        <>
          <AnalyticsPage />
          {owner && (
            <>
              <div className="px-4 md:px-8 pb-8">
                <WeeklyCleanupCard />
              </div>
              <div className="px-4 md:px-8 pb-8">
                <ServerHealthCard />
              </div>
              <div className="px-4 md:px-8 pb-8">
                <DiskUsageCard />
              </div>
            </>
          )}
          <div className="px-4 md:px-8 pb-8">
            <AgentSchedulesCard />
          </div>
        </>
      )}
    </>
  );
}
