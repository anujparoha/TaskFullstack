/**
 * Middleware to validate that an idempotency key is present.
 * Clients MUST provide this key for all write operations.
 * The key should be a UUID or any unique string that identifies the request.
 */
const validateIdempotencyKey = (req, res, next) => {
  const key =
    req.headers['idempotency-key'] ||
    req.body?.idempotencyKey;

  if (!key) {
    return res.status(400).json({
      success: false,
      error:
        'Missing idempotency key. Provide it as the "idempotency-key" header or "idempotencyKey" in the request body.',
    });
  }

  if (typeof key !== 'string' || key.trim().length < 8) {
    return res.status(400).json({
      success: false,
      error: 'Idempotency key must be a string of at least 8 characters.',
    });
  }

  // Normalize: always use the key from the body or header
  req.body.idempotencyKey = key.trim();
  next();
};

module.exports = { validateIdempotencyKey };
