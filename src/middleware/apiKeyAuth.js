function apiKeyAuth(req, res, next) {
  const key = req.header('x-api-key');
  if (!key || key !== process.env.API_KEY) {
    return res.status(401).json({ error: 'API key tidak valid atau tidak disertakan' });
  }
  next();
}

module.exports = apiKeyAuth;
