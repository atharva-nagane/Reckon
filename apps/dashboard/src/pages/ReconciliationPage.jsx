import { useState } from 'react';
import { api } from '../lib/api.js';
import { useAsync } from '../lib/useAsync.js';
import {
  Card,
  CardHeader,
  CardBody,
  Tag,
  SeverityLabel,
  StatusLabel,
  EmptyState,
  ErrorState,
  LoadingState,
  btnPrimary,
  btnSmall,
  selectStyle,
} from '../lib/ui.jsx';

const DRIFT_CLASSES = ['missing', 'duplicate', 'amount_mismatch', 'stuck_pending', 'unresolved_hold', 'status_mismatch'];
const STATUSES = ['open', 'auto_resolved', 'resolved', 'ignored'];
const LIST_LIMIT = 30;

function Snapshot({ label, data }) {
  return (
    <div>
      <div className="snapshot-label">{label}</div>
      <pre className="snapshot-pre">{JSON.stringify(data, null, 2)}</pre>
    </div>
  );
}

export default function ReconciliationPage() {
  const [status, setStatus] = useState('');
  const [driftClass, setDriftClass] = useState('');
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(false);
  const [runResult, setRunResult] = useState(null);

  const breaks = useAsync(
    () => api.breaks({ ...(status ? { status } : {}), ...(driftClass ? { driftClass } : {}) }),
    [status, driftClass],
  );

  async function runNow() {
    setBusy(true);
    setRunResult(null);
    try {
      const r = await api.runReconciliation(60);
      setRunResult(`Run complete — ${r.breaksCreated} break(s) created, ${r.autoResolved} auto-resolved.`);
      breaks.reload();
    } catch (err) {
      setRunResult(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function act(kind, brk) {
    setBusy(true);
    try {
      if (kind === 'resolve') await api.resolveBreak(brk.id, 'operator', 'manually reviewed from dashboard');
      else await api.ignoreBreak(brk.id, 'operator');
      setSelected(null);
      breaks.reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <div className="filters-row">
        <select value={status} onChange={(e) => setStatus(e.target.value)} className={selectStyle}>
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s.replace('_', ' ')}
            </option>
          ))}
        </select>
        <select value={driftClass} onChange={(e) => setDriftClass(e.target.value)} className={selectStyle}>
          <option value="">All drift classes</option>
          {DRIFT_CLASSES.map((d) => (
            <option key={d} value={d}>
              {d.replace('_', ' ')}
            </option>
          ))}
        </select>
        <button onClick={runNow} disabled={busy} className={btnPrimary}>
          {busy ? 'Running…' : 'Run reconciliation now'}
        </button>
        <a href={api.exportUrl('breaks')} className="link">
          Export CSV
        </a>
        {runResult && <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{runResult}</span>}
      </div>

      <div className="grid-2">
        <Card>
          <CardHeader
            title="Breaks"
            subtitle="Every discrepancy between the provider's record and Reckon's ledger."
            right={
              breaks.data && breaks.data.length > LIST_LIMIT ? (
                <span className="tabular text-muted" style={{ fontSize: '12px' }}>
                  showing {LIST_LIMIT} of {breaks.data.length} — narrow with the filters
                </span>
              ) : undefined
            }
          />
          <CardBody>
            {breaks.loading && <LoadingState />}
            {breaks.error && <ErrorState message={breaks.error} />}
            {breaks.data?.length === 0 && <EmptyState>No breaks match this filter.</EmptyState>}
            {breaks.data && breaks.data.length > 0 && (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Payment</th>
                    <th>Drift class</th>
                    <th>Severity</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {breaks.data.slice(0, LIST_LIMIT).map((b) => (
                    <tr
                      key={b.id}
                      onClick={() => setSelected(b)}
                      className={`row-clickable${selected?.id === b.id ? ' row-selected' : ''}`}
                    >
                      <td className="mono" style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                        {b.paymentRef.slice(0, 8)}
                      </td>
                      <td>
                        <Tag>{b.driftClass}</Tag>
                      </td>
                      <td>
                        <SeverityLabel severity={b.severity} />
                      </td>
                      <td>
                        <StatusLabel status={b.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Provider vs Reckon"
            subtitle="Both snapshots stored on every break — the full audit trail."
            right={
              selected?.status === 'open' ? (
                <>
                  <button onClick={() => act('resolve', selected)} disabled={busy} className={btnSmall}>
                    Resolve
                  </button>
                  <button onClick={() => act('ignore', selected)} disabled={busy} className={btnSmall}>
                    Ignore
                  </button>
                </>
              ) : undefined
            }
          />
          <CardBody>
            {!selected && <EmptyState>Select a break to drill into its snapshots.</EmptyState>}
            {selected && (
              <div className="stack" style={{ gap: '0.75rem' }}>
                <div className="flex-row" style={{ flexWrap: 'wrap' }}>
                  <Tag>{selected.driftClass}</Tag>
                  <SeverityLabel severity={selected.severity} />
                  <StatusLabel status={selected.status} />
                  <span className="ml-auto mono" style={{ fontSize: '11px', color: 'var(--text-faint)' }}>
                    {selected.paymentRef.slice(0, 8)}
                  </span>
                </div>
                <Snapshot label="Provider snapshot" data={selected.providerSnapshot} />
                <Snapshot label="Reckon snapshot" data={selected.reckonSnapshot} />
                {selected.resolutionAction && (
                  <p style={{ borderTop: '1px solid var(--border)', paddingTop: '0.5rem', fontSize: '12px', color: 'var(--text-muted)' }}>
                    Resolution: <span className="mono" style={{ color: 'var(--text-tertiary)' }}>{selected.resolutionAction}</span>
                    {selected.resolutionTransactionId && (
                      <span className="mono"> · txn {selected.resolutionTransactionId.slice(0, 8)}</span>
                    )}
                    {selected.resolvedBy && <span> · by {selected.resolvedBy}</span>}
                  </p>
                )}
              </div>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
