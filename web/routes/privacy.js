// Public privacy-policy page. Mounted before any router that does
// `router.use(requireAuth)` so an unauthenticated visitor reaches it
// without being redirected to /login.
//
// The route is intentionally trivial: it just renders the EJS with an
// `authed` flag so the shared header partial can show full nav for
// logged-in visitors and a brand-only header for everyone else.

const express = require('express');

const router = express.Router();

router.get('/privacy', (req, res) => {
  const authed = !!(req.session && req.session.userId);
  res.render('privacy', { authed });
});

module.exports = router;
