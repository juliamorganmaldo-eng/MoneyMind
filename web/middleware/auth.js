function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  return res.redirect('/login');
}

function redirectIfAuthed(req, res, next) {
  if (req.session && req.session.userId) return res.redirect('/dashboard');
  return next();
}

module.exports = { requireAuth, redirectIfAuthed };
