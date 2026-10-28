import * as path from 'node:path';
import * as vscode from 'vscode';
import { Block, scanBlocks } from './model/hclScanner';
import { BlockMark, matchPlan } from './model/matcher';
import { Env } from './model/envs';
import { Change, Plan } from './model/types';

/** What the editor side needs from the plan store. */
export interface PlanState {
  readonly plan?: Plan;
  /** Absolute fs path of the Terraform root the plan belongs to. */
  readonly root?: string;
  marksFor(relPath: string, text: string): BlockMark[];
  readonly onDidChange: vscode.Event<void>;
}

/** The one in-memory state: current plan, where it applies, and whether a run is going. */
export class PlanStore implements PlanState, vscode.Disposable {
  plan?: Plan;
  root?: string;
  env?: Env;
  running = false;
  error?: string;
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly scanCache = new Map<string, { text: string; blocks: Block[] }>();
  /** address → location, from every .tf file under the root; built once per plan. */
  private locations?: Map<string, { file: string; line: number }>;
  private orphanList: Change[] = [];

  async setPlan(plan: Plan, root: string): Promise<void> {
    this.plan = plan;
    this.root = root;
    this.error = undefined;
    this.scanCache.clear();
    await this.index();
    this.emitter.fire();
  }

  clear(): void {
    this.plan = undefined;
    this.locations = undefined;
    this.orphanList = [];
    this.scanCache.clear();
    this.emitter.fire();
  }

  setRunning(running: boolean, error?: string): void {
    this.running = running;
    this.error = error;
    this.emitter.fire();
  }

  /** Something changed that the view should re-render (env picked, a minute passed). */
  touch(): void {
    this.emitter.fire();
  }

  marksFor(relPath: string, text: string): BlockMark[] {
    if (!this.plan) return [];
    let hit = this.scanCache.get(relPath);
    if (!hit || hit.text !== text) {
      hit = { text, blocks: scanBlocks(text) };
      this.scanCache.set(relPath, hit);
    }
    return matchPlan(this.plan, [{ path: relPath, blocks: hit.blocks }]).byFile.get(relPath) ?? [];
  }

  orphans(): Change[] {
    return this.orphanList;
  }

  locate(address: string): { file: string; line: number } | undefined {
    return this.locations?.get(address);
  }

  private async index(): Promise<void> {
    const plan = this.plan!;
    const root = this.root!;
    const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(vscode.Uri.file(root), '**/*.tf'), '**/{.terraform,node_modules}/**');
    const files = await Promise.all(
      uris.map(async (u) => {
        const text = Buffer.from(await vscode.workspace.fs.readFile(u)).toString('utf8');
        return { path: path.relative(root, u.fsPath).split(path.sep).join('/'), blocks: scanBlocks(text) };
      }),
    );
    const { byFile, orphans } = matchPlan(plan, files);
    const locations = new Map<string, { file: string; line: number }>();
    for (const [file, marks] of byFile) {
      for (const m of marks) {
        if (m.block.kind === 'module') continue;
        for (const c of m.changes) locations.set(c.address, { file, line: m.block.startLine });
      }
    }
    this.locations = locations;
    this.orphanList = orphans;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
