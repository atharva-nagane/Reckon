import { api, formatMoney } from '../lib/api.js';
import { useAsync } from '../lib/useAsync.js';
import {
  Card,
  CardHeader,
  CardBody,
  StatTile,
  PaymentStateLabel,
  SeverityLabel,
  ErrorState,
  LoadingState,
} from '../lib/ui.jsx';

const STATE_ORDER = ['created', 'pending', 'inflight', 'succeeded', 'failed', 'refund_pending', 'refunded'];
const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'];

export default function OverviewPage() {
  const overview = useAsync(api.overview);

  if (overview.loading) return <LoadingState />;
  if (overview.error) return <ErrorState message={overview.error} />;
  const data = overview.data;

  const states = STATE_ORDER.filter((s) => data.paymentsByState[s] !== undefined).map((s) => [s, data.paymentsByState[s]]);
  const totalPayments = states.reduce((a, [, n]) => a + n, 0);
  const maxState = Math.max(1, ...states.map(([, n]) => n));
  const openBreaks = SEVERITY_ORDER.filter((sev) => data.openBreaksBySeverity[sev]);

  return (
    <div className="stack">
      <div className="stat-grid">
        <StatTile
          label="Books balanced"
          value={data.booksBalance.balanced ? 'Yes' : 'No'}
          tone={data.booksBalance.balanced ? 'good' : 'bad'}
          caption="assets = liabilities + revenue"
        />
        {/* engine reports balances credits-minus-debits; assets are debit-normal, so present negated */}
        <StatTile label="Assets" value={formatMoney((-BigInt(data.booksBalance.assets)).toString())} />
        <StatTile label="Liabilities + revenue" value={formatMoney(data.booksBalance.liabilitiesAndRevenue)} />
        <StatTile label="Payments" value={String(totalPayments)} caption="across all lifecycle states" />
      </div>

      <div className="grid-2">
        <Card>
          <CardHeader title="Payments by state" subtitle="Lifecycle distribution across the state machine." />
          <CardBody>
            <div className="stack" style={{ gap: '0.5rem' }}>
              {states.map(([state, count]) => (
                <div key={state} className="flex-row">
                  <div className="w-32 shrink-0">
                    <PaymentStateLabel state={state} />
                  </div>
                  <div className="bar-track">
                    <div className="bar-fill" style={{ width: `${Math.max(2, (count / maxState) * 100)}%` }} />
                  </div>
                  <div className="w-10 shrink-0 mono tabular" style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
                    {count}
                  </div>
                </div>
              ))}
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Open breaks by severity" subtitle="Unresolved reconciliation discrepancies." />
          <CardBody>
            {openBreaks.length === 0 ? (
              <p className="flex-row" style={{ padding: '0.5rem 0', fontSize: '0.875rem', color: 'var(--text-tertiary)' }}>
                <span className="dot" style={{ background: 'var(--emerald)' }} />
                None — the books reconcile clean.
              </p>
            ) : (
              <div className="stack" style={{ gap: '0.5rem' }}>
                {openBreaks.map((sev) => (
                  <div key={sev} className="list-row">
                    <SeverityLabel severity={sev} />
                    <span className="mono tabular" style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
                      {data.openBreaksBySeverity[sev]}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
