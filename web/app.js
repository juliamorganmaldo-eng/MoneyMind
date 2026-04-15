require('dotenv').config();

const express = require('express');
const session = require('express-session');
const path = require('path');
const { pool } = require('./db');
const SqliteStore = require('./session-store')(session);

const authRouter = require('./routes/auth');
const accountsRouter = require('./routes/accounts');
const dashboardRouter = require('./routes/dashboard');
const findingsRouter = require('./routes/findings');
const actionsRouter = require('./routes/actions');
const budgetRouter = require('./routes/budget');
const budgetSettingsRouter = require('./routes/budget-settings');
const networthRouter = require('./routes/networth');
const subscriptionsRouter = require('./routes/subscriptions');
const spendingRouter = require('./routes/spending');
const transactionsRouter = require('./routes/transactions');
const goalsRouter = require('./routes/goals');
const notificationsRouter = require('./routes/notifications');
const { scheduleMonthlyReports } = require('./lib/monthly-report');

const app = express();
const PORT = process.env.PORT || 3001;

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Body parsing
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Session store (SQLite-backed)
app.use(
  session({
    store: new SqliteStore(),
    secret: process.env.SESSION_SECRET || 'dev-secret-change-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
    },
    name: 'moneymind.sid',
  })
);

// Flash messages middleware
app.use((req, res, next) => {
  // Expose flash from session to res.locals, then clear it
  res.locals.flash = req.session.flash || null;
  if (req.session.flash) {
    delete req.session.flash;
  }

  // Expose user to all templates
  res.locals.user = req.session.user || null;

  next();
});

// Routes
app.use('/auth', authRouter);
app.use('/accounts', accountsRouter);
app.use('/dashboard', dashboardRouter);
app.use('/findings', findingsRouter);
app.use('/actions', actionsRouter);
app.use('/budget', budgetRouter);
app.use('/budget-settings', budgetSettingsRouter);
app.use('/networth', networthRouter);
app.use('/subscriptions', subscriptionsRouter);
app.use('/spending', spendingRouter);
app.use('/transactions', transactionsRouter);
app.use('/goals', goalsRouter);
app.use('/notifications', notificationsRouter);

// Root redirect
app.get('/', (req, res) => {
  if (req.session && req.session.user) {
    return res.redirect('/dashboard');
  }
  res.redirect('/auth/login');
});

// 404 handler
app.use((req, res) => {
  res.status(404).send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>404 — MoneyMind</title>
      <style>
        body { font-family: system-ui, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #F0F7F2; color: #111827; }
        h1 { font-size: 4rem; margin: 0; color: #2D6A4F; }
        p { color: #6B7280; }
        a { color: #2D6A4F; font-weight: 600; text-decoration: none; }
        a:hover { text-decoration: underline; }
      </style>
    </head>
    <body>
      <h1>404</h1>
      <p>Page not found.</p>
      <a href="/">Go home</a>
    </body>
    </html>
  `);
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>Error — MoneyMind</title>
      <style>
        body { font-family: system-ui, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #F0F7F2; color: #111827; }
        h1 { font-size: 2rem; margin: 0; color: #EF4444; }
        p { color: #6B7280; }
        a { color: #2D6A4F; font-weight: 600; text-decoration: none; }
      </style>
    </head>
    <body>
      <h1>Something went wrong</h1>
      <p>${process.env.NODE_ENV === 'development' ? err.message : 'An unexpected error occurred.'}</p>
      <a href="/">Go home</a>
    </body>
    </html>
  `);
});

app.listen(PORT, () => {
  console.log(`MoneyMind web server running on http://localhost:${PORT}`);
  scheduleMonthlyReports();
});

module.exports = app;
