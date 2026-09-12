import { createHash } from 'node:crypto';
import { fail, publicOrigin, randomToken } from './security.js';

const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send';
const MICROSOFT_SCOPE = 'offline_access https://graph.microsoft.com/User.Read https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send';

export function oauthConfig(provider, env) {
  const redirectUri = `${publicOrigin(env)}/api/oauth/${provider}/callback`;
  if (provider === 'google') {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) fail('Google mail is not configured. Ask the administrator to set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.', 503, 'provider_not_configured');
    return { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, redirectUri,
      authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: 'https://oauth2.googleapis.com/token', scope: GOOGLE_SCOPE };
  }
  if (provider === 'microsoft') {
    if (!env.MICROSOFT_CLIENT_ID || !env.MICROSOFT_CLIENT_SECRET) fail('Microsoft mail is not configured. Ask the administrator to set MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET.', 503, 'provider_not_configured');
    const tenant = env.MICROSOFT_TENANT || 'common';
    if (!/^[a-zA-Z0-9.-]+$/.test(tenant)) fail('MICROSOFT_TENANT is invalid.', 503, 'provider_not_configured');
    const base = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0`;
    return { clientId: env.MICROSOFT_CLIENT_ID, clientSecret: env.MICROSOFT_CLIENT_SECRET, redirectUri,
      authorizationUrl: `${base}/authorize`, tokenUrl: `${base}/token`, scope: MICROSOFT_SCOPE };
  }
  fail('Unknown mail provider.', 404);
}

export function authorizationRequest(provider, env) {
  const config = oauthConfig(provider, env);
  const state = randomToken();
  const verifier = randomToken();
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const url = new URL(config.authorizationUrl);
  const values = { client_id: config.clientId, response_type: 'code', redirect_uri: config.redirectUri,
    scope: config.scope, state, code_challenge: challenge, code_challenge_method: 'S256' };
  if (provider === 'google') Object.assign(values, { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' });
  else Object.assign(values, { response_mode: 'query', prompt: 'select_account' });
  url.search = new URLSearchParams(values).toString();
  return { url: url.toString(), state, verifier, redirectUri: config.redirectUri };
}

export async function boundedResponse(response, max = 40 * 1024 * 1024) {
  if (!response.body) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) { await reader.cancel(); fail('The provider returned an item that exceeds the mail size limit.', 413, 'provider_response_too_large'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export async function fetchJSON(fetchImpl, url, init = {}) {
  let response;
  try { response = await fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(30000) }); }
  catch { fail('The mail provider did not confirm the request. Check the connection before retrying.', 502, 'provider_connection_error'); }
  const bytes = await boundedResponse(response);
  let body = null;
  try { body = bytes.length ? JSON.parse(bytes.toString()) : null; } catch { /* Never expose remote content or secrets. */ }
  if (!response.ok) {
    const error = Object.assign(new Error(response.status === 401 ? 'Mail authorization expired. Reconnect this account.' : response.status === 429 ? 'The mail provider is limiting requests. Try again later.' : 'The mail provider rejected the request.'),
      { status: response.status === 401 ? 409 : response.status === 429 ? 429 : 502,
        providerStatus: response.status, code: response.status === 401 ? 'provider_reconnect_required' : 'provider_request_failed' });
    throw error;
  }
  if (bytes.length && body === null) fail('The mail provider returned an invalid response.', 502);
  return body;
}

export async function tokenRequest(provider, env, fetchImpl, values) {
  const config = oauthConfig(provider, env);
  const body = new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, ...values });
  const result = await fetchJSON(fetchImpl, config.tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  if (!result?.access_token || typeof result.access_token !== 'string') fail('The mail provider did not issue an access token.', 502);
  return { accessToken: result.access_token, refreshToken: result.refresh_token || null,
    expiresAt: Date.now() + Math.max(1, Number(result.expires_in) || 3600) * 1000, scope: result.scope || config.scope };
}

export async function providerIdentity(provider, token, fetchImpl) {
  const url = provider === 'microsoft' ? 'https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName,displayName' : 'https://gmail.googleapis.com/gmail/v1/users/me/profile';
  const profile = await fetchJSON(fetchImpl, url, { headers: { Authorization: `Bearer ${token}` } });
  const email = provider === 'microsoft' ? profile?.mail || profile?.userPrincipalName : profile?.emailAddress;
  if (typeof email !== 'string' || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(email)) fail('The provider did not return a usable mailbox address.', 502);
  return { email: email.toLowerCase(), displayName: profile.displayName || email, providerUserId: String(profile.id || email) };
}
