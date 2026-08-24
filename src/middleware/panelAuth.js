function requirePanelLogin(req, res, next) {
  if (req.session && req.session.loggedIn) {
    return next();
  }
  return res.status(401).json({ error: 'Belum login' });
}

module.exports = requirePanelLogin;
