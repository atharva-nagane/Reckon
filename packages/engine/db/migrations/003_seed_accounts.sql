-- Chart of accounts (docs/chart_of_accounts.md is the canonical description).
-- provider_holds (§6.5) is distinct from provider_clearing so the trial
-- balance always shows reserved-but-unsettled money separately.
INSERT INTO accounts (name, type, currency) VALUES
  ('provider_clearing', 'asset', 'INR'),
  ('provider_holds', 'asset', 'INR'),
  ('customer_liability', 'liability', 'INR'),
  ('revenue', 'revenue', 'INR'),
  ('fees', 'fee', 'INR')
ON CONFLICT (name) DO NOTHING;
