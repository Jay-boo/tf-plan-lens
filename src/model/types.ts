// Shared model types. Pure: nothing here may import 'vscode'.

export type Action = 'create' | 'update' | 'replace' | 'destroy' | 'forget' | 'read' | 'noop';

/** Most severe first. */
export const SEVERITY: Action[] = ['destroy', 'forget', 'replace', 'update', 'create', 'read', 'noop'];

export function worst(actions: Action[]): Action {
  let best = SEVERITY.length - 1;
  for (const a of actions) best = Math.min(best, SEVERITY.indexOf(a));
  return SEVERITY[best];
}

export interface AttrChange {
  path: string;
  /** Rendered short JSON (≤ 80 chars + …); '' when absent, sensitive or unknown. */
  before: string;
  after: string;
  sensitive: boolean;
  unknown: boolean;
  forcesReplace: boolean;
}

export interface Change {
  address: string;
  moduleAddress: string;
  /** Module call names from the root, instance keys stripped. */
  modulePath: string[];
  mode: 'managed' | 'data';
  type: string;
  name: string;
  index?: string | number;
  action: Action;
  attrs: AttrChange[];
  replaceBy: string[];
  reason?: string;
  /** Set when a moved block moved it here: its address in the state. */
  previousAddress?: string;
  /** Set when an import block brings it under Terraform: the import id. */
  importing?: string;
  /**
   * Destroys: the `before` leaves; creates: the known `after` leaves (path → JSON), without sensitive, unknown or empty
   * ones. Only what tells objects apart, to pair a destroy with the create it really is (see refactor.ts).
   * Stays in the extension host: never posted to the webview.
   */
  values?: Record<string, string>;
}

export interface Plan {
  env: string;
  source: string;
  loadedAt: number;
  terraformVersion: string;
  changes: Change[];
  /** Module path joined with '.' → folder relative to the root (posix). Local sources only. */
  moduleDirs: Record<string, string>;
  /** The -target addresses the plan was run with; absent for a full plan. */
  targets?: string[];
  /** Objects changed outside Terraform since the last apply (resource_drift): update = edited, destroy = deleted. */
  drift: Change[];
  /** Outputs the plan changes. */
  outputs: OutputChange[];
}

export interface OutputChange {
  name: string;
  action: 'create' | 'update' | 'destroy';
  /** Rendered short JSON; '' when absent, sensitive or unknown. */
  before: string;
  after: string;
  sensitive: boolean;
  unknown: boolean;
}
