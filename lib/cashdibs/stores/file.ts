import fs from 'node:fs';
import path from 'node:path';
import { FundingAttempt, ReimbursementIntent } from '../types';
import { MemoryFundingStore, MemoryReimbursementStore } from './memory';

function save(file: string, rows: Map<string, unknown>) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  // 0600: rows contain the signed envelope
  fs.writeFileSync(tmp, JSON.stringify([...rows.values()], null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** JSON-file store so the demo script survives a crash between "persist" and "submit". Single-process only. */
export class FileFundingStore extends MemoryFundingStore {
  constructor(private file: string) {
    super();
    if (fs.existsSync(file)) for (const r of JSON.parse(fs.readFileSync(file, 'utf8')) as FundingAttempt[]) this.rows.set(r.payoutId, r);
  }
  protected persist() { save(this.file, this.rows); }
}
export class FileReimbursementStore extends MemoryReimbursementStore {
  constructor(private file: string) {
    super();
    if (fs.existsSync(file)) for (const r of JSON.parse(fs.readFileSync(file, 'utf8')) as ReimbursementIntent[]) this.rows.set(r.pickupRef, r);
  }
  protected persist() { save(this.file, this.rows); }
}
