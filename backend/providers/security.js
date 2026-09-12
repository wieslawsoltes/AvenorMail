import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export const fail = (message, status = 400, code = 'provider_error') => {
  throw Object.assign(new Error(message), { status, code });
};
export const hash = value => createHash('sha256').update(value).digest('hex');
export const randomToken = () => randomBytes(32).toString('base64url');
export const json = (data, status = 200) => Response.json(data, { status, headers: {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
} });

export function dataKey(env) {
  const text = env.DATA_KEY;
  if (typeof text !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(text)) {
    fail('External mail is unavailable: configure DATA_KEY as a 32-byte base64 key.', 503, 'provider_not_configured');
  }
  const key = Buffer.from(text, 'base64');
  if (key.length !== 32) fail('External mail encryption key is invalid.', 503, 'provider_not_configured');
  return key;
}

export function seal(value, env, context) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', dataKey(env), iv);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function unseal(value, env, context) {
  const key = dataKey(env);
  try {
    const [version, iv, tag, ciphertext, extra] = String(value).split('.');
    if (version !== 'v1' || extra !== undefined) throw new Error('Bad format');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString());
  } catch {
    fail('Connected mail credentials could not be decrypted. Restore the correct DATA_KEY or reconnect this account.', 503, 'credential_unavailable');
  }
}

export function publicOrigin(env) {
  let url;
  try { url = new URL(env.PUBLIC_URL); } catch { fail('Configure PUBLIC_URL before connecting external mail.', 503, 'provider_not_configured'); }
  if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    fail('PUBLIC_URL must use HTTPS (HTTP is allowed only on localhost).', 503, 'provider_not_configured');
  }
  return url.origin;
}

export async function readJSON(request, limit = 65536) {
  if (!request.body) fail('A JSON body is required.');
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) { await reader.cancel(); fail('Account settings are too large.', 413); }
    chunks.push(value);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch { fail('Invalid JSON account settings.'); }
}

export function requireUser(user) {
  if (!user?.userId) fail('Sign in before connecting external mail.', 401, 'authentication_required');
  return String(user.userId);
}
