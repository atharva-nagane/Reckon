import { useState } from 'react';
import { api } from '../lib/api.js';
import { Card, CardHeader, CardBody, StatTile, Tag, EmptyState, ErrorState, btnPrimary, btnSecondary } from '../lib/ui.jsx';

const SCENARIOS = [
  { kind: 'drop', label: 'Drop webhooks', blurb: 'settlement webhooks vanish → missing' },
  { kind: 'drop_resolution', label: 'Drop hold resolution', blurb: 'hold opens, resolution lost → unresolved_hold' },
  { kind: 'duplicate_delivery', label: 'Duplicate delivery', blurb: 'same event id twice → idempotency holds, no break' },
  { kind: 'double_count', label: 'Double-count bug', blurb: 'idempotency bypassed → duplicate' },
  { kind: 'reorder', label: 'Reorder events', blurb: 'succeeded before processing → unresolved_hold' },
  { kind: 'mutate_amount', label: 'Corrupt amount', blurb: 'local write-path bug → amount_mismatch, flags' },
  { kind: 'delay', label: 'Delay past window', blurb: 'event held past reconciliation → stuck_pending' },
];

function ResultCell({ pass }) {
  return (
    <span className="label-row" style={{ fontWeight: 600, color: pass ? 'var(--emerald)' : 'var(--red)' }}>
      <span className="dot" style={{ background: pass ? 'var(--emerald)' : 'var(--red)' }} />
      {pass ? 'PASS' : 'FAIL'}
    </span>
  );
}

function ResolutionCell({ row }) {
  if (!row.detectedStatus) return <span className="text-disabled">—</span>;
  if (row.detectedStatus === 'open') {
    return <span style={{ fontSize: '12px', fontWeight: 500, color: '#fcd34d' }}>open — flagged for review</span>;
  }
  return (
    <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
      <span style={{ color: 'var(--emerald)' }}>{row.detectedStatus.replace('_', ' ')}</span>
      {row.resolutionAction && <span className="mono" style={{ color: 'var(--text-muted)' }}> · {row.resolutionAction}</span>}
    </span>
  );
}

export default function ChaosPage() {
  const [rows, setRows] = useState([]);
  const [score, setScore] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [arrivals, setArrivals] = useState(0);

  async function run(name, fn, apply) {
    setBusy(name);
    setError(null);
    try {
      apply(await fn());
      setArrivals((n) => n + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  const fire = (kind) => run(kind, () => api.chaosScenario(kind), (row) => setRows((prev) => [row, ...prev]));

  const fullMatrix = () =>
    run('matrix', api.chaosMatrix, (r) => {
      setRows(r.rows);
      setScore(null);
    });

  const scoring = () =>
    run('scoring', () => api.chaosScoring(2), (r) => {
      setRows(r.rows);
      setScore(r.score);
    });

  const passed = rows.filter((r) => r.pass).length;

  return (
    <div className="stack">
      <Card>
        <CardHeader
          title="Fault injection"
          subtitle="Each fault corrupts a fresh payment's webhook delivery, runs reconciliation, and scores detection against known ground truth. Mock provider only — never real money."
          right={
            <>
              <button onClick={scoring} disabled={busy !== null} className={btnSecondary}>
                {busy === 'scoring' ? 'Running…' : 'Precision / recall run'}
              </button>
              <button onClick={fullMatrix} disabled={busy !== null} className={btnPrimary}>
                {busy === 'matrix' ? 'Running…' : 'Run full matrix'}
              </button>
            </>
          }
        />
        <CardBody>
          <div className="scenario-grid">
            {SCENARIOS.map((s) => {
              const running = busy === s.kind;
              return (
                <button
                  key={s.kind}
                  onClick={() => fire(s.kind)}
                  disabled={busy !== null}
                  className={`scenario-btn${running ? ' running' : ''}`}
                >
                  <div className="scenario-title">{running ? 'Injecting…' : s.label}</div>
                  <div className="scenario-blurb">{s.blurb}</div>
                </button>
              );
            })}
          </div>
          {error && (
            <div style={{ marginTop: '0.75rem' }}>
              <ErrorState message={error} />
            </div>
          )}
        </CardBody>
      </Card>

      {score && (
        <div className="stat-grid">
          <StatTile
            label="Precision"
            value={`${(score.precision * 100).toFixed(1)}%`}
            caption={`${score.falsePositives} false positive${score.falsePositives === 1 ? '' : 's'}`}
          />
          <StatTile
            label="Recall"
            value={`${(score.recall * 100).toFixed(1)}%`}
            caption={`${score.falseNegatives} false negative${score.falseNegatives === 1 ? '' : 's'}`}
          />
          <StatTile
            label="Auto-resolution"
            value={`${(score.autoResolutionRate * 100).toFixed(1)}%`}
            caption="amount mismatches always flag for review"
          />
          <StatTile label="Payments scored" value={String(score.payments)} caption="against injected ground truth" />
        </div>
      )}

      <Card>
        <CardHeader
          title="Verification matrix"
          subtitle="fault → expected break → detected → resolution"
          right={
            rows.length > 0 ? (
              <span className="tabular" style={{ fontSize: '0.875rem', fontWeight: 600, color: passed === rows.length ? 'var(--emerald)' : 'var(--red)' }}>
                {passed}/{rows.length} PASS
              </span>
            ) : undefined
          }
        />
        <CardBody>
          {rows.length === 0 ? (
            <EmptyState>No results yet — fire a fault above, or run the full matrix.</EmptyState>
          ) : (
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Fault</th>
                    <th>Expected break</th>
                    <th>Detected</th>
                    <th>Resolution</th>
                    <th>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={`${arrivals}-${r.paymentRef}-${i}`} className="row-arrive">
                      <td className="mono" style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                        {r.scenario}
                      </td>
                      <td>{r.expectedBreak ? <Tag>{r.expectedBreak}</Tag> : <span style={{ fontSize: '12px', color: 'var(--text-faint)' }}>none expected</span>}</td>
                      <td>{r.detectedBreak ? <Tag>{r.detectedBreak}</Tag> : <span style={{ fontSize: '12px', color: 'var(--text-faint)' }}>none detected</span>}</td>
                      <td>
                        <ResolutionCell row={r} />
                      </td>
                      <td>
                        <ResultCell pass={r.pass} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
