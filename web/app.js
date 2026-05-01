require('dotenv').config();

const path = require('node:path');
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);

const { pool } = require('./db');
const { bootstrap } = require('./lib/bootstrap');
const { assertEncryptionKey } = require('./lib/crypto');
const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const plaidRoutes = require('./routes/plaid');
const transactionRoutes = require('./routes/transactions');
const accountRoutes = require('./routes/accounts');
const categoryRoutes = require('./routes/categories');
const budgetRoutes = require('./routes/budgets');
const alertRoutes = require('./routes/alerts');
const subscriptionRoutes = require('./routes/subscriptions');
const netWorthRoutes = require('./routes/net-worth');
const insightsRoutes = require('./routes/insights');
const userSettingsRoutes = require('./routes/user-settings');
const findingsRoutes = require('./routes/findings');
const passwordResetRoutes = require('./routes/password-reset');
const { router: emailVerificationRoutes } = require('./routes/email-verification');
const { enforceIdleTimeout } = require('./middleware/idle-timeout');

const PORT = Number(process.env.PORT) || 3001;
const IS_PROD = process.env.NODE_ENV === 'production';
const SESSION_SECRET = process.env.SESSION_SECRET;

if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
  console.error(
    '[fatal] SESSION_SECRET is missing or too short (need ≥ 32 chars). ' +
    'Generate one with:  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64\'))"'
  );
  process.exit(1);
}

try {
  assertEncryptionKey();
} catch (err) {
  console.error('[fatal] ' + err.message);
  process.exit(1);
}

// Production-readiness gate. Empty/missing → fatal. The literal placeholder
// string is allowed for dev — sends become no-ops and the email lib logs
// a warning at module load. In production set this to the real key.
if (!process.env.RESEND_API_KEY) {
  console.error('[fatal] RESEND_API_KEY is missing. Get one at https://resend.com/api-keys');
  process.exit(1);
}

const app = express();

if (IS_PROD) {
  // Needed for secure cookies to work behind a TLS-terminating proxy.
  app.set('trust proxy', 1);
}

app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');
app.disable('x-powered-by');

app.use(express.urlencoded({ extended: false, limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: IS_PROD ? '1d' : 0 }));

// Default cookie maxAge here is the SHORTER of the two possible session
// lifetimes (12h). On a successful login, the route extends maxAge to
// 30 days when "Remember me" is checked. `rolling: true` re-stamps the
// cookie on each authenticated request so an active session never
// expires mid-use, but the absolute lifetime is bounded by absoluteTimeoutMs
// below.
app.use(
  session({
    name: 'moneymind.sid',
    store: new PgSession({ pool, tableName: 'session', createTableIfMissing: false }),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: IS_PROD,
      maxAge: 1000 * 60 * 60 * 12, // 12h default; logInAs overrides for "Remember me"
    },
  })
);

// Absolute-timeout enforcement. The cookie's maxAge handles browser-side
// expiry, but a stolen session cookie can be replayed past the original
// loginAt + lifetime. This belt-and-braces check rejects any session
// whose loginAt is older than the lifetime it was created with.
app.use(function enforceAbsoluteTimeout(req, res, next) {
  if (!req.session || !req.session.userId || !req.session.loginAt) return next();
  const lifetime = req.session.rememberMe
    ? 30 * 24 * 60 * 60 * 1000
    : 12 * 60 * 60 * 1000;
  if (Date.now() - req.session.loginAt > lifetime) {
    return req.session.destroy((err) => {
      if (err) return next(err);
      res.clearCookie('moneymind.sid', { path: '/' });
      const wantsHtml = req.accepts(['html', 'json']) === 'html';
      if (wantsHtml) return res.redirect('/login?reason=expired');
      return res.status(401).json({ error: 'session_expired' });
    });
  }
  return next();
});

app.use(enforceIdleTimeout);

app.get('/', (req, res) => {
  if (req.session && req.session.userId) return res.redirect('/dashboard');
  return res.redirect('/login');
});

app.use(authRoutes);

// Public auth-flow routes mount BEFORE any router that does
// `router.use(requireAuth)`. Otherwise requireAuth on a later router
// would intercept un-matched paths (like /forgot-password) and redirect
// them to /login before they reach their handler.
app.use(passwordResetRoutes);
app.use(emailVerificationRoutes);

app.use(dashboardRoutes);
app.use(plaidRoutes);
app.use(transactionRoutes);
app.use(accountRoutes);
app.use(categoryRoutes);
app.use(budgetRoutes);
app.use(alertRoutes);
app.use(subscriptionRoutes);
app.use(netWorthRoutes);
app.use(insightsRoutes);
app.use(userSettingsRoutes);
app.use(findingsRoutes);

app.use((req, res) => {
  res.status(404).send('Not found');
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  console.error('[error]', err.stack || err.message);
  res.status(500).send('Something went wrong.');
});

async function main() {
  await bootstrap();
  app.listen(PORT, () => {
    console.log(`MoneyMind web → http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('[fatal] startup failed:', err.message);
  process.exit(1);
});
