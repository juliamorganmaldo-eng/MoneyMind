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
      maxAge: 1000 * 60 * 60 * 24 * 14, // 14 days
    },
  })
);

app.get('/', (req, res) => {
  if (req.session && req.session.userId) return res.redirect('/dashboard');
  return res.redirect('/login');
});

app.use(authRoutes);
app.use(dashboardRoutes);
app.use(plaidRoutes);

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
