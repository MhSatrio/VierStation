// First-run setup and installation choices: lab name, data folder and acceptance of the terms of use.
// They live in vierstation.config.json next to the application (not in the database), so the data folder can be chosen before the database exists.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { config, ROOT, setupFile } from './config.ts';
import { bad } from './util.ts';
import { APP_VERSION } from '../shared/app.ts';

/** Bump when TERMS.md changes materially: everyone then sees and accepts the new text once. */
export const TERMS_VERSION = 1;
interface Cfg { labName?: string; dataDir?: string; termsAcceptedVersion?: number }

export function readCfg(): Cfg { try { return JSON.parse(readFileSync(setupFile, 'utf8')) as Cfg; } catch { return {}; } }

export function setupState() {
  const c = readCfg();
  return { labName: c.labName ?? null, dataDir: config.dataDir, dataDirConfigured: c.dataDir ?? null, termsAccepted: c.termsAcceptedVersion === TERMS_VERSION, termsVersion: TERMS_VERSION, version: APP_VERSION };
}

export function termsText(): string {
  return readFileSync(join(ROOT, 'TERMS.md'), 'utf8').replaceAll('{{VERSION}}', APP_VERSION);
}

/** Saves choices. A new data folder takes effect after the application restarts (the database is opened at start-up). */
export function saveSetup(b: { labName?: unknown; dataDir?: unknown; acceptTerms?: unknown }): { restartRequired: boolean } {
  const c = readCfg(); let restartRequired = false;
  if (b.labName !== undefined) {
    const n = String(b.labName ?? '').trim().slice(0, 80);
    if (!n) throw bad('Enter a lab name (for example “Smith Lab”).');
    c.labName = n;
  }
  if (b.dataDir !== undefined) {
    const d = String(b.dataDir ?? '').trim();
    if (!d || !isAbsolute(d)) throw bad('Give a full folder path, for example C:\\Users\\you\\VierStation-data');
    const target = resolve(d);
    try {
      mkdirSync(target, { recursive: true });
      const probe = join(target, '.vierstation-write-test'); writeFileSync(probe, 'ok'); rmSync(probe, { force: true });
    } catch { throw bad('That folder cannot be written to. Choose another folder.'); }
    if (target !== config.dataDir) restartRequired = true;
    c.dataDir = target;
  }
  if (b.acceptTerms === true) c.termsAcceptedVersion = TERMS_VERSION;
  writeFileSync(setupFile, JSON.stringify(c, null, 2));
  return { restartRequired };
}
