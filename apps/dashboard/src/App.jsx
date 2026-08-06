import { NavLink, Route, Routes } from 'react-router-dom';
import OverviewPage from './pages/OverviewPage.jsx';
import LedgerPage from './pages/LedgerPage.jsx';
import PaymentsPage from './pages/PaymentsPage.jsx';
import ReconciliationPage from './pages/ReconciliationPage.jsx';
import ChaosPage from './pages/ChaosPage.jsx';

const TABS = [
  { to: '/', label: 'Overview', end: true },
  { to: '/ledger', label: 'Ledger' },
  { to: '/payments', label: 'Payments' },
  { to: '/reconciliation', label: 'Reconciliation' },
  { to: '/chaos', label: 'Chaos' },
];

export default function App() {
  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header-inner">
          <div className="app-title-group">
            <h1 className="app-title">Reckon</h1>
            <p className="app-subtitle">reconciliation &amp; ledger integrity</p>
          </div>
          <span className="app-badge">mock provider · test mode</span>
        </div>
      </header>
      <nav className="app-nav">
        <div className="app-nav-inner">
          {TABS.map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              end={tab.end}
              className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
            >
              {tab.label}
            </NavLink>
          ))}
        </div>
      </nav>
      <main className="app-main">
        <Routes>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/ledger" element={<LedgerPage />} />
          <Route path="/payments" element={<PaymentsPage />} />
          <Route path="/reconciliation" element={<ReconciliationPage />} />
          <Route path="/chaos" element={<ChaosPage />} />
        </Routes>
      </main>
    </div>
  );
}
