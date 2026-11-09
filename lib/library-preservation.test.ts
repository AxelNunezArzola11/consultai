/**
 * Enterprise library preservation — Bryntum Gantt & AG Grid.
 *
 * Guards the audit contract: neither vendor library may be replaced with
 * custom tables/timelines, and neither dependency may be removed.
 * Fast, hermetic (filesystem only — no DB, no network).
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function readSource(rel: string): string {
  return readFileSync(resolve(repoRoot, rel), "utf8");
}

describe("library preservation", () => {
  const pkg = readJson(resolve(repoRoot, "package.json"));
  const deps = pkg["dependencies"] as Record<string, string>;

  it("declares Bryntum Gantt packages", () => {
    expect(deps["@bryntum/gantt"]).toBe("npm:@bryntum/gantt-trial@7.3.7");
    expect(deps["@bryntum/gantt-react"]).toBe("7.3.7");
  });

  it("declares AG Grid packages", () => {
    expect(deps["ag-grid-community"]).toBe("32.3.9");
    expect(deps["ag-grid-react"]).toBe("32.3.9");
  });

  it("has matching installed versions", () => {
    expect(
      readJson(resolve(repoRoot, "node_modules/@bryntum/gantt/package.json"))["version"],
    ).toBe("7.3.7");
    expect(
      readJson(resolve(repoRoot, "node_modules/@bryntum/gantt-react/package.json"))["version"],
    ).toBe("7.3.7");
    expect(
      readJson(resolve(repoRoot, "node_modules/ag-grid-community/package.json"))["version"],
    ).toBe("32.3.9");
    expect(
      readJson(resolve(repoRoot, "node_modules/ag-grid-react/package.json"))["version"],
    ).toBe("32.3.9");
  });

  it("keeps Bryntum Gantt mounted from the vendor package", () => {
    const gantt = readSource("components/bryntum-gantt/BryntumGantt.tsx");
    expect(gantt).toContain("@bryntum/gantt-react");
    expect(gantt).toContain("criticalPathsFeature");
    expect(readSource("components/bryntum-gantt/PlanningLayout.tsx")).toContain("BryntumGantt");
  });

  it("keeps AG Grid mounted from the vendor package", () => {
    for (const rel of [
      "components/operations/EnterpriseOperationsGrids.tsx",
      "components/canvas/FinancialLedger.tsx",
      "components/bryntum-gantt/UnscheduledTasksGrid.tsx",
    ]) {
      expect(readSource(rel)).toContain("ag-grid-react");
    }
    expect(readSource("components/operations/EnterpriseOperationsGrids.tsx")).toContain(
      "AgGridReact",
    );
  });

  it("does not leave vendor imports pointing at missing installs", () => {
    expect(existsSync(resolve(repoRoot, "node_modules/@bryntum/gantt"))).toBe(true);
    expect(existsSync(resolve(repoRoot, "node_modules/ag-grid-react"))).toBe(true);
  });
});
