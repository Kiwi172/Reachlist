export function errorHandler(err, req, res, _next) {
  console.error(err);
  const status = err.status || 500;
  // Internal errors return a fixed string — stack traces and driver
  // messages leak schema details to anyone who can trigger a 500.
  const message = status >= 500 ? 'Internal server error' : err.message;
  res.status(status).json({ error: message });
}

export function notFound(req, res) {
  res.status(404).json({ error: 'Not found' });
}
