// The settings the sidebar's settings page shows and changes. One list: the page is drawn from it, the extension only
// accepts changes that fit it, and a test checks it against package.json. Pure: no vscode.

export type Visibility = 'shown' | 'discreet' | 'hidden';
export const VISIBILITY: Visibility[] = ['shown', 'discreet', 'hidden'];

export interface SettingDef {
  key: string;
  group: 'Sidebar' | 'Editor' | 'Plans and apply';
  label: string;
  help: string;
  type: 'visibility' | 'boolean' | 'string';
  default: Visibility | boolean | string;
  /** Saved for this workspace (folders, apply) rather than for the user. */
  workspace?: boolean;
  placeholder?: string;
}

export const SETTINGS: SettingDef[] = [
  { key: 'sidebar.drift', group: 'Sidebar', label: 'Changed outside Terraform', help: 'Drift since the last apply. Discreet: one faint line you can open.', type: 'visibility', default: 'discreet' },
  { key: 'sidebar.imports', group: 'Sidebar', label: 'Imports', help: 'Objects import blocks bring under Terraform.', type: 'visibility', default: 'shown' },
  { key: 'sidebar.moved', group: 'Sidebar', label: 'Moved', help: 'Objects moved blocks move to a new address.', type: 'visibility', default: 'shown' },
  { key: 'sidebar.reads', group: 'Sidebar', label: 'Reads', help: 'Data sources read during the plan.', type: 'visibility', default: 'discreet' },
  { key: 'sidebar.outputs', group: 'Sidebar', label: 'Outputs', help: 'Outputs the plan changes (sensitive values never shown).', type: 'visibility', default: 'shown' },
  { key: 'refactor', group: 'Sidebar', label: 'Refactor autopilot', help: 'Spot destroys that are moves, offer moved blocks (sidebar card, editor hints, quick fix).', type: 'boolean', default: true },
  { key: 'editorMarkers', group: 'Editor', label: 'Plan on the code', help: 'Gutter icon, coloured band and end-of-line hint on changed blocks.', type: 'boolean', default: true },
  { key: 'showUnchanged', group: 'Editor', label: '"No changes" hints', help: 'A faint hint on blocks the plan leaves alone.', type: 'boolean', default: true },
  { key: 'preview', group: 'Editor', label: 'Preview edits on save', help: 'After a plan, saving a block plans just that block (no refresh, no lock) and says on the edited lines what it would do: update, replace…', type: 'boolean', default: true },
  { key: 'completions', group: 'Editor', label: 'Completions from your data', help: 'Complete map keys and object fields from the evaluated values: local.x["…"], each.value.…, var.x.…', type: 'boolean', default: true },
  { key: 'inlineValues', group: 'Editor', label: 'Values as you write', help: 'What locals, variables, for_each and outputs evaluate to, for the environment (terraform console on a copy, never the real state).', type: 'boolean', default: true },
  { key: 'allowApply', group: 'Plans and apply', label: 'Apply from Plan Lens', help: 'Apply the exact plan shown, after a confirmation. For this workspace only.', type: 'boolean', default: false, workspace: true },
  { key: 'terraformPath', group: 'Plans and apply', label: 'Terraform binary', help: 'Empty: terraform, or tofu when only OpenTofu is installed.', type: 'string', default: '', placeholder: 'terraform' },
];

/** A change the settings page asked for, checked against the list; undefined when it does not fit. */
export function validSetting(key: unknown, value: unknown): { def: SettingDef; value: Visibility | boolean | string } | undefined {
  const def = SETTINGS.find((s) => s.key === key);
  if (!def) return undefined;
  if (def.type === 'visibility') return VISIBILITY.includes(value as Visibility) ? { def, value: value as Visibility } : undefined;
  if (def.type === 'boolean') return typeof value === 'boolean' ? { def, value } : undefined;
  return typeof value === 'string' && value.length < 1024 && !/[\r\n\0]/.test(value) ? { def, value: value.trim() } : undefined;
}
