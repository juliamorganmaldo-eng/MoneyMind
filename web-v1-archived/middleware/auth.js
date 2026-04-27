function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    req.session.flash = { error: 'Please sign in to continue.' };
    return res.redirect('/auth/login');
  }
  next();
}

module.exports = { requireAuth };
