/**
 * Diagnostics mode — opt-in, clearly labeled, zero protocol impact.
 *
 * - Offline: no network calls, checked via localStorage / URL param only.
 * - Removable/disabled: when not enabled, collectors are no-ops and reports not generated.
 * - Labeled: report.app.diagnosticsLabel is "DIAGNOSTICS — ..." when enabled.
 * - Exportable: exportDiagnosticsReport(report) triggers a local download.
 * - Redacted: filenames/file contents never shipped into logs by default.
 */

export const DIAGNOSTICS_STORAGE_KEY = 'deqr:diagnostics';
export const DIAGNOSTICS_URL_PARAM = 'diag';

export function isDiagnosticsEnabled(): boolean {
  try {
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      if (url.searchParams.get(DIAGNOSTICS_URL_PARAM) === '1') return true;
      if (window.localStorage.getItem(DIAGNOSTICS_STORAGE_KEY) === '1') return true;
    }
  } catch {
    // ignore — storage may be blocked (private browsing)
  }
  // Allow forcing via environment in tests / bench harness
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (typeof process !== 'undefined' && (process as any).env?.DEQR_DIAGNOSTICS === '1') return true;
  } catch {}
  return false;
}

export function setDiagnosticsEnabled(enabled: boolean): void {
  try {
    if (typeof window !== 'undefined') {
      if (enabled) window.localStorage.setItem(DIAGNOSTICS_STORAGE_KEY, '1');
      else window.localStorage.removeItem(DIAGNOSTICS_STORAGE_KEY);
    }
  } catch {}
}

export function diagnosticsLabel(enabled: boolean): string {
  return enabled ? 'DIAGNOSTICS — detailed run report will be captured' : 'PRODUCTION';
}

/**
 * Export a report as a local JSON file download. No network.
 * Filename is sanitized, content is the serialized report.
 */
export function exportDiagnosticsReport(json: string, filename = `deqr-diagnostics-${new Date().toISOString().slice(0, 10)}.json`): void {
  if (typeof document === 'undefined') return;
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = safeName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
