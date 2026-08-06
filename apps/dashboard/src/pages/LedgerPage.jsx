import { api, formatMoney } from '../lib/api.js';
import { useAsync } from '../lib/useAsync.js';
import { Card, CardHeader, CardBody, Tag, EmptyState, ErrorState, LoadingState } from '../lib/ui.jsx';

function BalancedBadge({ balanced }) {
  return (
    <span className={`badge ${balanced ? 'balanced' : 'unbalanced'}`}>
      <span className="dot" style={{ background: balanced ? 'var(--emerald)' : 'var(--red)' }} />
      {balanced ? 'BALANCED' : 'OUT OF BALANCE'}
    </span>
  );
}

const RECENT_LIMIT = 20;

export default function LedgerPage() {
  const trialBalance = useAsync(api.trialBalance);
  const transactions = useAsync(api.transactions);
  const overview = useAsync(api.overview);

  const accountName = new Map((trialBalance.data ?? []).map((r) => [r.accountId, r.accountName]));
  const books = overview.data?.booksBalance;

  // engine convention: balance = credits − debits. Present as classic trial-balance
  // Debit / Credit columns — net-debit balances left, net-credit right.
  const tbRows = (trialBalance.data ?? []).map((row) => {
    const bal = BigInt(row.balance);
    return { ...row, debit: bal < 0n ? -bal : null, credit: bal > 0n ? bal : null };
  });
  const totalDebit = tbRows.reduce((a, r) => a + (r.debit ?? 0n), 0n);
  const totalCredit = tbRows.reduce((a, r) => a + (r.credit ?? 0n), 0n);
  const recent = (transactions.data ?? []).slice(0, RECENT_LIMIT);

  return (
    <div className="stack">
      <Card>
        <CardHeader
          title="Trial balance"
          subtitle="Every balance is derived from postings, never stored — the books must sum to zero by construction."
          right={
            <>
              {books && <BalancedBadge balanced={books.balanced} />}
              <a href={api.exportUrl('ledger')} className="link">
                Export CSV
              </a>
            </>
          }
        />
        <CardBody>
          {trialBalance.loading && <LoadingState />}
          {trialBalance.error && <ErrorState message={trialBalance.error} />}
          {trialBalance.data && (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Type</th>
                  <th className="right">Debit</th>
                  <th className="right pl-6">Credit</th>
                </tr>
              </thead>
              <tbody>
                {tbRows.map((row) => (
                  <tr key={row.accountId}>
                    <td style={{ color: 'var(--text-secondary)' }}>{row.accountName}</td>
                    <td>
                      <Tag>{row.accountType}</Tag>
                    </td>
                    <td className="right mono tabular" style={{ color: 'var(--text-primary)' }}>
                      {row.debit !== null ? formatMoney(row.debit.toString()) : <span className="text-disabled">—</span>}
                    </td>
                    <td className="right pl-6 mono tabular" style={{ color: 'var(--text-primary)' }}>
                      {row.credit !== null ? formatMoney(row.credit.toString()) : <span className="text-disabled">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td
                    colSpan={2}
                    style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)' }}
                  >
                    Total
                  </td>
                  <td className="right mono tabular" style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                    {formatMoney(totalDebit.toString())}
                  </td>
                  <td className="right pl-6 mono tabular" style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                    {formatMoney(totalCredit.toString())}
                  </td>
                </tr>
              </tfoot>
            </table>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Recent ledger transactions"
          subtitle="Append-only — corrections are reversing transactions, never edits."
          right={
            transactions.data && transactions.data.length > RECENT_LIMIT ? (
              <span className="tabular text-muted" style={{ fontSize: '12px' }}>
                showing {RECENT_LIMIT} of {transactions.data.length}
              </span>
            ) : undefined
          }
        />
        <CardBody>
          {transactions.loading && <LoadingState />}
          {transactions.error && <ErrorState message={transactions.error} />}
          {transactions.data?.length === 0 && <EmptyState>No transactions yet — seed the database or drive a payment.</EmptyState>}
          <div>
            {recent.map((txn) => (
              <div key={txn.id} className="txn-card">
                <div className="flex-row" style={{ flexWrap: 'wrap', gap: '0.5rem 0.75rem' }}>
                  <Tag>{txn.kind}</Tag>
                  <span className="mono" style={{ fontSize: '11px', color: 'var(--text-faint)' }}>
                    {txn.id.slice(0, 8)}
                  </span>
                  {txn.description && (
                    <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{txn.description}</span>
                  )}
                  <span className="ml-auto tabular" style={{ fontSize: '11px', color: 'var(--text-faint)' }}>
                    {new Date(txn.createdAt).toLocaleString()}
                  </span>
                </div>
                <table className="mini-table">
                  <tbody>
                    {txn.postings.map((p) => (
                      <tr key={p.id}>
                        <td className="w-14 mono" style={{ fontSize: '11px', textTransform: 'uppercase', color: 'var(--text-faint)' }}>
                          {p.direction}
                        </td>
                        <td style={{ color: 'var(--text-tertiary)' }}>{accountName.get(p.accountId) ?? p.accountId.slice(0, 8)}</td>
                        <td className="right mono tabular" style={{ color: 'var(--text-secondary)' }}>
                          {formatMoney(p.amount)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
