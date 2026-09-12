import { randomUUID } from 'node:crypto';
import { fail, seal, unseal } from './security.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const context = row => `account:${row.owner}:${row.id}:${row.provider}`;
const folders = ['inbox','sentitems','drafts','deleteditems','junkemail','archive'];
export const grantedScopes = (row, env) => new Set(String(unseal(row.encrypted_secret, env, context(row)).scope || '').toLowerCase().split(/\s+/).map(scope => scope.replace(/^https:\/\/graph.microsoft.com\//,'')));

function baseAccount(service, user, id) {
  const account = service.account(user, id);
  if (account.provider !== 'microsoft' || account.parent_account_id) fail('Use a primary Microsoft account to discover or attach a delegated mailbox.', 400, 'shared_mailbox_primary_required');
  const scopes = grantedScopes(account, service.env);
  if (!scopes.has('mail.read.shared') && !scopes.has('mail.readwrite.shared')) fail('Reconnect Microsoft and grant shared-mailbox access.', 409, 'provider_reconnect_required');
  return { account, scopes };
}

function mailboxTarget(value) {
  if (typeof value !== 'string') fail('Enter the mailbox email address or directory identifier.');
  const target = value.trim();
  if (target.length > 320 || !(/^[A-Fa-f0-9]{8}-[A-Fa-f0-9-]{27}$/.test(target) || /^[^\s<>@,;/\\?#]+@[^\s<>@,;/\\?#]+\.[^\s<>@,;/\\?#]+$/.test(target))) fail('Enter a valid mailbox email address or directory identifier.');
  return target;
}

async function probe(service, account, target, all = false) {
  const accessible = [];
  for (const name of all ? folders : ['inbox']) {
    try {
      const result = await service.api(account, `${GRAPH}/users/${encodeURIComponent(target)}/mailFolders/${name}?$select=id,displayName`);
      if (typeof result?.id === 'string') accessible.push({ key: name, id: result.id, name: result.displayName || name });
      else fail('Microsoft returned an invalid mailbox folder.', 502);
    } catch (error) {
      if (![403,404].includes(error.providerStatus)) throw error;
    }
  }
  return accessible;
}

/** Directory search is optional and is never presented as permission enumeration. */
export async function discoverSharedMailboxes(service, user, id, query) {
  const { account, scopes } = baseAccount(service, user, id);
  const attached = service.listAccounts(user).filter(item => item.parentAccountId === id);
  if (!scopes.has('user.readbasic.all') && !scopes.has('user.read.all') && !scopes.has('directory.read.all')) {
    return { mailboxes: [], attached, directorySearchAvailable: false, complete: false,
      reason: 'Directory search permission is not granted. Attach a known mailbox address directly.' };
  }
  const search = String(query || '').trim();
  if (search.length < 2 || search.length > 80 || [...search].some(c=>c.charCodeAt(0)<32 || c.charCodeAt(0)===127)) fail('Enter 2–80 characters to search the directory.');
  const escaped = search.replace(/'/g,"''");
  const params = new URLSearchParams({ '$select':'id,displayName,mail,userPrincipalName', '$top':'10',
    '$filter':`startswith(displayName,'${escaped}') or startswith(mail,'${escaped}') or startswith(userPrincipalName,'${escaped}')` });
  const page = await service.api(account, `${GRAPH}/users?${params}`);
  if (!Array.isArray(page?.value)) fail('Microsoft returned an invalid directory page.',502);
  const mailboxes = [];
  for (const candidate of page.value.slice(0,10)) {
    const email = candidate.mail || candidate.userPrincipalName;
    if (!candidate.id || !email || String(email).toLowerCase() === account.email.toLowerCase()) continue;
    const accessible = await probe(service, account, candidate.id);
    if (accessible.length) mailboxes.push({ mailboxId: candidate.id, email, displayName: candidate.displayName || email,
      accessVerified: true, verifiedFolders: accessible, sendPermission: 'checked-at-submission' });
  }
  return { mailboxes, attached, directorySearchAvailable:true, complete:!page['@odata.nextLink'],
    ...(page['@odata.nextLink'] ? { reason:'More directory matches exist. Narrow the search to locate another mailbox.' } : {}) };
}

export async function attachSharedMailbox(service, user, id, input) {
  const { account, scopes } = baseAccount(service, user, id);
  const target = mailboxTarget(input.mailboxId || input.email);
  let identity;
  if (scopes.has('user.readbasic.all') || scopes.has('user.read.all') || scopes.has('directory.read.all')) {
    identity = await service.api(account, `${GRAPH}/users/${encodeURIComponent(target)}?$select=id,mail,displayName,userPrincipalName`);
  } else if (!target.includes('@')) fail('Use an email address when directory search permission is unavailable.',400);
  const email = String(identity?.mail || identity?.userPrincipalName || target).toLowerCase();
  mailboxTarget(email);
  if (email === account.email.toLowerCase() || identity?.id === account.provider_user_id) fail('This is already your primary connected mailbox.',409);
  const canonicalTarget = identity?.id || target;
  const accessible = await probe(service, account, canonicalTarget, true);
  if (!accessible.length) fail('Microsoft has not granted this account access to the requested mailbox folders.',403,'shared_mailbox_access_denied');
  const existing = service.db.prepare('SELECT * FROM provider_accounts WHERE owner=? AND provider=? AND email=?').get(account.owner,'microsoft',email);
  if (existing && existing.parent_account_id !== account.id) fail('That mailbox is already connected through a different account. Remove its connection before attaching it here.',409);
  const row = { id:existing?.id || randomUUID(),owner:account.owner,provider:'microsoft' }, now=Date.now();
  service.db.prepare(`INSERT INTO provider_accounts(id,owner,provider,email,display_name,provider_user_id,encrypted_secret,parent_account_id,mailbox_target,shared_folders_json,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner,provider,email) DO UPDATE SET
    display_name=excluded.display_name,mailbox_target=excluded.mailbox_target,shared_folders_json=excluded.shared_folders_json,status='connected',last_error=NULL,updated_at=excluded.updated_at`).run(
    row.id,row.owner,row.provider,email,String(identity?.displayName || input.displayName || email).slice(0,200),identity?.id || null,
    seal({parentAccountId:account.id},service.env,context(row)),account.id,canonicalTarget,JSON.stringify(accessible),now,now);
  service.notify(account.owner,{type:'accounts-changed'});
  return service.listAccounts(user).find(item=>item.id===row.id);
}
