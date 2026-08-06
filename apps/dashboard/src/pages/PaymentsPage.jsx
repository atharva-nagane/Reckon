import { useState } from 'react';
import { api, formatMoney } from '../lib/api.js';
import { useAsync } from '../lib/useAsync.js';
import { Card, CardHeader, CardBody, PaymentStateLabel, EmptyState, ErrorState, LoadingState } from '../lib/ui.jsx';

const LIST_LIMIT = 30;

export default function PaymentsPage() {
  const payments = useAsync(api.payments);
  const [selectedId, setSelectedId] = useState(null);
  const detail = useAsync(() => (selectedId ? api.payment(selectedId) : Promise.resolve(null)), [selectedId]);
  const listed = (payments.data ?? []).slice(0, LIST_LIMIT);

  return (
    <div className="grid-2">
      <Card>
        <CardHeader
          title="Payments"
          subtitle="Click a payment to inspect its state-machine history."
          right={
            <>
              {payments.data && payments.data.length > LIST_LIMIT && (
                <span className="tabular text-muted" style={{ fontSize: '12px' }}>
                  showing {LIST_LIMIT} of {payments.data.length}
                </span>
              )}
              <a href={api.exportUrl('payments')} className="link">
                Export CSV
              </a>
            </>
          }
        />
        <CardBody>
          {payments.loading && <LoadingState />}
          {payments.error && <ErrorState message={payments.error} />}
          {payments.data && (
            <table className="data-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th className="right">Amount</th>
                  <th className="pl-4">State</th>
                </tr>
              </thead>
              <tbody>
                {listed.map((p) => (
                  <tr
                    key={p.id}
                    onClick={() => setSelectedId(p.id)}
                    className={`row-clickable${selectedId === p.id ? ' row-selected' : ''}`}
                  >
                    <td className="mono" style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                      {p.id.slice(0, 8)}
                    </td>
                    <td className="right mono tabular" style={{ color: 'var(--text-primary)' }}>
                      {formatMoney(p.amount, p.currency)}
                    </td>
                    <td className="pl-4">
                      <PaymentStateLabel state={p.state} />
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
          title="State-machine history"
          subtitle="Append-only event log — the state column is only a cache of this."
        />
        <CardBody>
          {!selectedId && <EmptyState>Select a payment to see its event log.</EmptyState>}
          {detail.loading && selectedId && <LoadingState />}
          {detail.data && (
            <ul className="event-list">
              {detail.data.events.map((e, i) => (
                <li key={i} className="list-row">
                  <span className="flex-row" style={{ gap: '0.5rem' }}>
                    <span className="mono" style={{ fontSize: '12px', color: 'var(--text-faint)' }}>
                      {e.fromState ?? '∅'}
                    </span>
                    <span style={{ color: 'var(--text-disabled)' }}>→</span>
                    <PaymentStateLabel state={e.toState} />
                  </span>
                  {e.applied ? (
                    <span className="tabular" style={{ fontSize: '11px', color: 'var(--text-faint)' }}>
                      {new Date(e.occurredAt).toLocaleTimeString()}
                    </span>
                  ) : (
                    <span style={{ fontSize: '11px', fontWeight: 500, color: '#fcd34d' }}>not applied — {e.reason}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
