/**
 * Phase 11 - the page that drives the real-OPFS certification worker.
 *
 * It does nothing itself. Sync access handles are worker-only, so every claim
 * being certified has to be made from inside the worker; this side exists to
 * start it, render what comes back, and park the whole result on
 * `window.__phase11` where an automated driver can read it without scraping
 * the table.
 */

import type { CertifyRow } from './opfs-certify.worker';

declare global {
  interface Window {
    __phase11: {
      status: 'running' | 'done' | 'unsupported';
      rows: CertifyRow[];
      passed: number;
      failed: number;
      userAgent: string;
    };
  }
}

const statusElement = document.getElementById('status') as HTMLDivElement;
const rowsElement = document.getElementById('rows') as HTMLTableSectionElement;

window.__phase11 = {
  status: 'running',
  rows: [],
  passed: 0,
  failed: 0,
  userAgent: navigator.userAgent,
};

function renderRow(row: CertifyRow): void {
  const tr = document.createElement('tr');

  const verdict = document.createElement('td');
  verdict.className = `verdict ${row.ok ? 'pass' : 'fail'}`;
  verdict.textContent = row.ok ? 'PASS' : 'FAIL';

  const name = document.createElement('td');
  name.textContent = row.name;

  const detail = document.createElement('td');
  detail.className = 'detail';
  detail.textContent = Object.entries(row.detail)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join('  ');

  tr.append(verdict, name, detail);
  rowsElement.append(tr);
}

// `location.protocol` rather than `isSecureContext` alone, so the message can
// say what to do about it. OPFS needs a secure context, and http://localhost is
// one - a LAN address over plain http is not.
if (!window.isSecureContext) {
  window.__phase11.status = 'unsupported';
  statusElement.textContent = `Not a secure context (${location.origin}). OPFS is unavailable here.`;
} else {
  const sizes = (new URLSearchParams(location.search).get('sizes') ?? '1,16,64')
    .split(',')
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0);

  statusElement.textContent = `Running: sizes ${sizes.join(', ')} MiB…`;

  const worker = new Worker(new URL('./opfs-certify.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (event: MessageEvent<{ kind: 'row'; row: CertifyRow } | { kind: 'done' }>) => {
    if (event.data.kind === 'row') {
      window.__phase11.rows.push(event.data.row);
      if (event.data.row.ok) window.__phase11.passed += 1;
      else window.__phase11.failed += 1;
      renderRow(event.data.row);
      statusElement.textContent = `Running: ${window.__phase11.rows.length} checks, ${window.__phase11.failed} failed…`;
      return;
    }
    window.__phase11.status = 'done';
    statusElement.textContent = `Done: ${window.__phase11.passed} passed, ${window.__phase11.failed} failed.`;
  };
  worker.onerror = (event) => {
    window.__phase11.status = 'done';
    window.__phase11.failed += 1;
    window.__phase11.rows.push({ name: 'worker', ok: false, detail: { error: event.message } });
    statusElement.textContent = `Worker error: ${event.message}`;
  };
  worker.postMessage({ sizes });
}
