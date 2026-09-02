const CALL_BOOTSTRAP_PATHS = [
  { method: 'POST', pattern: /^\/api\/native-call-auth\/?$/ },
  { method: 'GET', pattern: /^\/api\/turn-credentials\/?$/ },
  { method: 'GET', pattern: /^\/calls\/pending\/[^/]+\/?$/ },
];

function isCallBootstrapRequest(req = {}) {
  const method = String(req.method || '').toUpperCase();
  const path = String(req.path || req.url || '').split('?')[0];
  return CALL_BOOTSTRAP_PATHS.some((route) => route.method === method && route.pattern.test(path));
}

module.exports = { isCallBootstrapRequest };
