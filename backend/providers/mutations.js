import { fail } from './security.js';

export const MUTABLE_FOLDERS = new Set(['inbox', 'archive', 'deleted', 'junk', 'drafts', 'sent']);

export function validateMessagePatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length ||
      Object.keys(patch).some(key => !['read','flagged','folder'].includes(key))) {
    fail('Provider updates support only read, flagged, and standard folder changes.', 400, 'provider_mutation_unsupported');
  }
  const normalized = {};
  for (const key of ['read','flagged']) {
    if (Object.hasOwn(patch, key)) {
      if (typeof patch[key] !== 'boolean') fail(`${key} must be true or false.`, 400, 'provider_mutation_invalid');
      normalized[key] = patch[key];
    }
  }
  if (Object.hasOwn(patch, 'folder')) {
    if (!MUTABLE_FOLDERS.has(patch.folder)) fail('This folder cannot be synchronized to the provider.', 400, 'provider_mutation_unsupported');
    normalized.folder = patch.folder;
  }
  return normalized;
}

const graphFolders = { inbox: 'inbox', archive: 'archive', deleted: 'deleteditems', junk: 'junkemail', drafts: 'drafts', sent: 'sentitems' };
const jsonHeaders = { 'Content-Type': 'application/json', Prefer: 'IdType="ImmutableId"' };

export async function updateGraphMessage(api, providerId, patch) {
  const target = `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(providerId)}`;
  const fields = {};
  if (patch.read !== undefined) fields.isRead = patch.read;
  if (patch.flagged !== undefined) fields.flag = { flagStatus: patch.flagged ? 'flagged' : 'notFlagged' };
  let currentId = providerId;
  if (Object.keys(fields).length) {
    const result = await api(target, { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify(fields) });
    if (!result?.id) fail('Microsoft did not confirm the message update.', 502, 'provider_mutation_unconfirmed');
    currentId = result.id;
  }
  if (patch.folder) {
    const result = await api(`https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(currentId)}/move`, {
      method: 'POST', headers: jsonHeaders, body: JSON.stringify({ destinationId: graphFolders[patch.folder] }),
    });
    if (!result?.id) fail('Microsoft did not return the moved message identifier. Synchronize before continuing.', 502, 'provider_mutation_unconfirmed');
    currentId = result.id;
  }
  return { status: 'applied', providerId: currentId, ...patch };
}

export async function updateGmailMessage(api, providerId, patch) {
  if (['drafts','sent'].includes(patch.folder)) fail('Gmail assigns Draft and Sent automatically; messages cannot be moved into those folders.', 400, 'provider_mutation_unsupported');
  const target = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(providerId)}`;
  const current = await api(`${target}?format=minimal`);
  if (!current?.id || !Array.isArray(current.labelIds)) fail('Google did not return the message labels.', 502);
  if (current.labelIds.includes('DRAFT')) fail('Gmail draft labels cannot be edited with this message operation.', 400, 'provider_mutation_unsupported');
  if (patch.folder === 'archive' && current.labelIds.includes('SENT')) fail('Gmail retains its Sent label; this sent message cannot be represented as Archive.', 400, 'provider_mutation_unsupported');
  const add = new Set(), remove = new Set();
  if (patch.read !== undefined) (patch.read ? remove : add).add('UNREAD');
  if (patch.flagged !== undefined) (patch.flagged ? add : remove).add('STARRED');
  if (patch.folder) {
    // Gmail allows these three system labels to be manually changed. One
    // modify call applies flags plus reversible trash/folder changes together.
    for (const label of ['INBOX','SPAM','TRASH']) remove.add(label);
    const destination = { inbox: 'INBOX', junk: 'SPAM', deleted: 'TRASH' }[patch.folder];
    if (destination) { remove.delete(destination); add.add(destination); }
  }
  const result = await api(`${target}/modify`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ addLabelIds: [...add], removeLabelIds: [...remove] }) });
  if (!result?.id) fail('Google did not confirm the message update.', 502, 'provider_mutation_unconfirmed');
  return { status: 'applied', providerId: result.id, ...patch };
}
