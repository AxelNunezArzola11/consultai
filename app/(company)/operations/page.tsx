/**
 * Enterprise Operations Page — Server Component (route: /operations)
 *
 * Hosts the 7 AG Grid Operational Management Interfaces:
 * Consultants, Projects, Tasks, Companies, Contracts, Payments, Agent Executions.
 */

import EnterpriseOperationsGrids, {
  type OperationsGridTab,
} from "@/components/operations/EnterpriseOperationsGrids";
import { isDemoMode } from "@/lib/demo/config";
import { requirePageRole } from "@/lib/auth/guards";

export const dynamic = "force-dynamic";

const VALID_TABS: OperationsGridTab[] = [
  "consultants",
  "projects",
  "tasks",
  "companies",
  "contracts",
  "payments",
  "executions",
];

export default async function OperationsPage({
  searchParams,
}: {
  searchParams?: Promise<{ tab?: string }>;
}) {
  const params = searchParams ? await searchParams : {};
  // Authenticate + authorize BEFORE rendering (grid data comes from the hardened API).
  await requirePageRole(["company", "admin"]);
  const rawTab = (params.tab ?? "tasks").toLowerCase() as OperationsGridTab;
  const initialTab = VALID_TABS.includes(rawTab) ? rawTab : "tasks";

  return <EnterpriseOperationsGrids initialTab={initialTab} demoMode={isDemoMode()} />;
}
