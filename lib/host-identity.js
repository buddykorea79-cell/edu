'use strict';

const crypto = require('node:crypto');

// One browser profile keeps one private identity across tabs and reloads. The
// cookie is signed so clients cannot choose another room owner's identity.
function createHostIdentity() {
  const key = crypto.randomBytes(32);
  const cookieName = 'edutalk-host';
  const sign = id => crypto.createHmac('sha256', key).update(id).digest('hex');
  function verify(token) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}\.[a-f0-9]{64}$/.test(token)) return null;
    const [id, signature] = token.split('.');
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(sign(id)))) return null;
    return { userId: crypto.createHash('sha256').update(id).digest('hex'), status: 'approved', name: '방장' };
  }
  function read(req) {
    return (req.headers.cookie || '').split(';').map(s => s.trim())
      .find(s => s.startsWith(cookieName + '='))?.slice(cookieName.length + 1) || '';
  }
  function session(req, res) {
    let token = read(req);
    if (!verify(token)) {
      const id = crypto.randomBytes(32).toString('hex');
      token = id + '.' + sign(id);
      res.cookie(cookieName, token, { httpOnly: true, sameSite: 'lax',
        secure: req.secure || req.get('x-forwarded-proto') === 'https',
        maxAge: 365 * 24 * 60 * 60 * 1000, path: '/' });
    }
    return { token, account: verify(token) };
  }
  return { read, verify, session };
}

module.exports = { createHostIdentity };
