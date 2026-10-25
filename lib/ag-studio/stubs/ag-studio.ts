/**
 * Runtime stub for `ag-studio`.
 *
 * AG Studio is a licensed package. This stub is used during development and
 * CI so that imports compile and the build succeeds without the real package.
 *
 * When the real `ag-studio` npm package is installed:
 *   1. Remove the `paths` overrides for "ag-studio" and "ag-studio-react"
 *      from tsconfig.json.
 *   2. Delete this file and the sibling `ag-studio-react.ts` stub.
 *   3. Remove the webpack aliases from next.config.ts.
 *   4. The real package will be resolved automatically.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type FieldFormat =
  | "textFormat"
  | "numberFormat"
  | "currencyFormat"
  | "dateFormat"
  | "percentFormat";

export interface AgFieldDefinition {
  fieldId: string;
  label?: string;
  format?: FieldFormat;
  hide?: boolean;
  isMeasure?: boolean;
  aggregation?: "sum" | "avg" | "count" | "min" | "max";
}

export interface AgExpressionDefinition extends AgFieldDefinition {
  operator: "add" | "subtract" | "multiply" | "divide";
  operands: Array<{ tableId: string; fieldId: string } | { value: number }>;
}

export interface AgSourceDefinition {
  tableId: string;
  label: string;
  fields: AgFieldDefinition[];
  expressions?: AgExpressionDefinition[];
  /** Runtime-only: inline row data passed directly to the studio. */
  data?: Record<string, unknown>[];
}

export interface AgRelationship {
  type: "many-to-one" | "one-to-many";
  source: { tableId: string; fieldId: string };
  target: { tableId: string; fieldId: string };
}

export interface AgCalendarDefinition {
  calendarId: string;
  label: string;
  tableId: string;
  fieldId: string;
  fragments: Array<"year" | "quarter" | "month" | "week" | "day">;
}

export interface AgDataSourcesDefinition {
  sources: AgSourceDefinition[];
  relationships?: AgRelationship[];
  calendars?: AgCalendarDefinition[];
}

/** Opaque serialisable snapshot of the AG Studio workspace state. */
export type AgStudioState = Record<string, unknown>;

// ── Theme builder ─────────────────────────────────────────────────────────────

export interface AgStudioThemeParams {
  fontFamily?: string;
  textColor?: string;
  backgroundColor?: string;
  gridHeaderTextColor?: string;
  chartPaletteFills1Color?: string;
  [key: string]: string | undefined;
}

export interface AgStudioTheme {
  withParams(params: AgStudioThemeParams): AgStudioTheme;
}

export const studioTheme: AgStudioTheme = {
  withParams(_params: AgStudioThemeParams): AgStudioTheme {
    return studioTheme;
  },
};
