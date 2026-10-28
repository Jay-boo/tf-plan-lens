import * as vscode from 'vscode';
import { BlockMark } from './model/matcher';
import { Plan } from './model/types';

/** What the editor side needs from the plan store. */
export interface PlanState {
  readonly plan?: Plan;
  /** Absolute fs path of the Terraform root the plan belongs to. */
  readonly root?: string;
  marksFor(relPath: string, text: string): BlockMark[];
  readonly onDidChange: vscode.Event<void>;
}
