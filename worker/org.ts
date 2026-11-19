import { passwordHash, tempPassword, type Account } from './auth';
import { purgeMailbox } from './mail';
import { cleanName, domainOf, json, localPart, readJson, type Env } from './util';

/* The org panel: people, mailboxes and aliases. The owner changes things; an admin may look. Nothing here reads mail.
 * A personal mailbox belongs to one account and only that account is its member. A mailbox nobody signs in to (shared,
 * or a removed person's) has members the owner picks. */

type Row = Record<string, string | number | null>;

async function snapshot(env: Env) {
  const [people, boxes, members, aliases] = await env.DB.batch<Row>([
    env.DB.prepare('SELECT a.id,a.name,a.role,m.address,a.mailbox_id AS mailboxId,a.must_change AS waiting,(a.totp IS NOT NULL) AS twoStep,a.created_at AS createdAt FROM account a JOIN mailbox m ON m.id=a.mailbox_id ORDER BY a.created_at'),
    env.DB.prepare('SELECT m.id,m.address,m.name,m.kind,(SELECT a.id FROM account a WHERE a.mailbox_id=m.id) AS accountId FROM mailbox m ORDER BY m.kind DESC,m.address'),
    env.DB.prepare('SELECT mailbox_id AS mailboxId,account_id AS accountId FROM mailbox_member'),
    env.DB.prepare('SELECT address,mailbox_id AS mailboxId FROM alias ORDER BY address'),
  ]);
  return {
    domain: domainOf(env),
    people: people.results.map(row => ({ ...row, waiting: Boolean(row.waiting), twoStep: Boolean(row.twoStep) })),
    mailboxes: boxes.results.map(box => ({ ...box, members: members.results.filter(row => row.mailboxId === box.id).map(row => row.accountId),
      aliases: aliases.results.filter(row => row.mailboxId === box.id).map(row => row.address) })),
  };
}

/** Whether an address already receives mail here, as a mailbox or an alias. */
const taken = async (env: Env, address: string) =>
  Boolean(await env.DB.prepare('SELECT 1 FROM mailbox WHERE address=?1 UNION ALL SELECT 1 FROM alias WHERE address=?1 LIMIT 1').bind(address).first());
const badLocal = () => json({ error: 'Use letters, numbers, dots, dashes or underscores before the @.' }, 400);

async function addPerson(request: Request, env: Env) {
  const input = await readJson<{ address: string; name: string; role: string }>(request), local = localPart(input.address);
  if (!local) return badLocal();
  const address = `${local}@${domainOf(env)}`, name = cleanName(input.name) || local, role = input.role === 'admin' ? 'admin' : 'member';
  const existing = await env.DB.prepare('SELECT m.id,m.kind,EXISTS (SELECT 1 FROM account a WHERE a.mailbox_id=m.id) AS owned FROM mailbox m WHERE m.address=?1').bind(address).first<{ id: string; kind: string; owned: number }>();
  if (existing?.owned) return json({ error: 'That address already belongs to someone.' }, 409);
  if (existing && existing.kind !== 'personal') return json({ error: 'That address is a shared mailbox.' }, 409);
  if (!existing && await taken(env, address)) return json({ error: 'That address is an alias. Remove the alias first.' }, 409);
  // A removed person's mailbox is given back with its mail, and only the new account can open it.
  const password = tempPassword(), accountId = crypto.randomUUID(), mailboxId = existing?.id ?? crypto.randomUUID(), now = Date.now();
  await env.DB.batch([
    existing ? env.DB.prepare('UPDATE mailbox SET name=?2 WHERE id=?1').bind(mailboxId, name)
      : env.DB.prepare("INSERT INTO mailbox(id,address,name,kind,created_at) VALUES(?1,?2,?3,'personal',?4)").bind(mailboxId, address, name, now),
    env.DB.prepare('DELETE FROM mailbox_member WHERE mailbox_id=?1').bind(mailboxId),
    env.DB.prepare('INSERT INTO account(id,mailbox_id,name,role,password,must_change,created_at) VALUES(?1,?2,?3,?4,?5,1,?6)').bind(accountId, mailboxId, name, role, await passwordHash(password), now),
    env.DB.prepare('INSERT INTO mailbox_member(mailbox_id,account_id) VALUES(?1,?2)').bind(mailboxId, accountId),
  ]);
  return json({ ...await snapshot(env), issued: { address, password, role } });
}

async function person(request: Request, env: Env, id: string, action: string) {
  const found = await env.DB.prepare('SELECT a.id,a.role,a.mailbox_id AS mailboxId,m.address FROM account a JOIN mailbox m ON m.id=a.mailbox_id WHERE a.id=?1').bind(id)
    .first<{ id: string; role: string; mailboxId: string; address: string }>();
  if (!found) return json({ error: 'That person is gone.' }, 404);
  if (request.method === 'PATCH' && !action) {
    const input = await readJson<{ name: string; role: string }>(request), name = input.name === undefined ? '' : cleanName(input.name);
    const role = input.role === 'admin' || input.role === 'member' ? input.role : null;
    if (input.name !== undefined && !name) return json({ error: 'Add a name.' }, 400);
    if (role && found.role === 'owner') return json({ error: 'The owner stays the owner.' }, 400);
    await env.DB.batch([
      ...(name ? [env.DB.prepare('UPDATE account SET name=?2 WHERE id=?1').bind(id, name), env.DB.prepare('UPDATE mailbox SET name=?2 WHERE id=?1').bind(found.mailboxId, name)] : []),
      // A new role takes effect at the next sign-in, which for a new admin means setting up two-step first.
      ...(role && role !== found.role ? [env.DB.prepare('UPDATE account SET role=?2 WHERE id=?1').bind(id, role), env.DB.prepare('DELETE FROM session WHERE account_id=?1').bind(id)] : []),
    ]);
    return json(await snapshot(env));
  }
  if (found.role === 'owner') return json({ error: 'The owner account can’t be reset or removed here.' }, 400);
  if (request.method === 'POST' && action === 'reset') {
    const password = tempPassword();
    await env.DB.batch([
      env.DB.prepare('UPDATE account SET password=?2,must_change=1,totp=NULL,totp_pending=NULL,totp_step=0,failed=0,locked_until=0 WHERE id=?1').bind(id, await passwordHash(password)),
      env.DB.prepare('DELETE FROM session WHERE account_id=?1').bind(id),
    ]);
    return json({ ...await snapshot(env), issued: { address: found.address, password, role: found.role } });
  }
  if (request.method === 'DELETE' && !action) {
    // The mailbox and its mail stay; the owner can give someone access to it, or delete it, later.
    await env.DB.batch([
      env.DB.prepare('DELETE FROM session WHERE account_id=?1').bind(id),
      env.DB.prepare('DELETE FROM mailbox_member WHERE account_id=?1').bind(id),
      env.DB.prepare("DELETE FROM account WHERE id=?1 AND role!='owner'").bind(id),
    ]);
    return json(await snapshot(env));
  }
  return json({ error: 'Method not allowed.' }, 405);
}

async function addMailbox(request: Request, env: Env, owner: Account) {
  const input = await readJson<{ address: string; name: string }>(request), local = localPart(input.address);
  if (!local) return badLocal();
  const address = `${local}@${domainOf(env)}`, name = cleanName(input.name) || local, id = crypto.randomUUID();
  if (await taken(env, address)) return json({ error: 'That address is already in use.' }, 409);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO mailbox(id,address,name,kind,created_at) VALUES(?1,?2,?3,'shared',?4)").bind(id, address, name, Date.now()),
    env.DB.prepare('INSERT INTO mailbox_member(mailbox_id,account_id) VALUES(?1,?2)').bind(id, owner.id),
  ]);
  return json(await snapshot(env));
}

async function mailbox(request: Request, env: Env, context: ExecutionContext, id: string, rest: string[]) {
  const box = await env.DB.prepare('SELECT m.id,EXISTS (SELECT 1 FROM account a WHERE a.mailbox_id=m.id) AS owned FROM mailbox m WHERE m.id=?1').bind(id).first<{ id: string; owned: number }>();
  if (!box) return json({ error: 'That mailbox is gone.' }, 404);
  if (box.owned) return json({ error: 'A person’s own mailbox is theirs alone. Change the person instead.' }, 400);
  if (request.method === 'PATCH' && !rest.length) {
    const name = cleanName((await readJson<{ name: string }>(request)).name);
    if (!name) return json({ error: 'Add a name.' }, 400);
    await env.DB.prepare('UPDATE mailbox SET name=?2 WHERE id=?1').bind(id, name).run();
    return json(await snapshot(env));
  }
  if (request.method === 'DELETE' && !rest.length) {
    if (!await purgeMailbox(env, context, id)) return json({ error: 'That mailbox can’t be deleted.' }, 409);
    return json(await snapshot(env));
  }
  if (rest[0] === 'members' && rest[1] && rest.length === 2) {
    if (request.method === 'PUT') {
      if (!await env.DB.prepare('SELECT 1 FROM account WHERE id=?1').bind(rest[1]).first()) return json({ error: 'That person is gone.' }, 404);
      await env.DB.prepare('INSERT OR IGNORE INTO mailbox_member(mailbox_id,account_id) VALUES(?1,?2)').bind(id, rest[1]).run();
      return json(await snapshot(env));
    }
    if (request.method === 'DELETE') {
      await env.DB.prepare('DELETE FROM mailbox_member WHERE mailbox_id=?1 AND account_id=?2').bind(id, rest[1]).run();
      return json(await snapshot(env));
    }
  }
  return json({ error: 'Method not allowed.' }, 405);
}

async function aliases(request: Request, env: Env, address: string) {
  if (request.method === 'POST' && !address) {
    const input = await readJson<{ address: string; mailboxId: string }>(request), local = localPart(input.address);
    if (!local) return badLocal();
    const full = `${local}@${domainOf(env)}`;
    if (!await env.DB.prepare('SELECT 1 FROM mailbox WHERE id=?1').bind(String(input.mailboxId || '')).first()) return json({ error: 'That mailbox is gone.' }, 404);
    if (await taken(env, full)) return json({ error: 'That address is already in use.' }, 409);
    await env.DB.prepare('INSERT INTO alias(address,mailbox_id,created_at) VALUES(?1,?2,?3)').bind(full, String(input.mailboxId), Date.now()).run();
    return json(await snapshot(env));
  }
  if (request.method === 'DELETE' && address) {
    await env.DB.prepare('DELETE FROM alias WHERE address=?1').bind(address.toLowerCase()).run();
    return json(await snapshot(env));
  }
  return json({ error: 'Method not allowed.' }, 405);
}

/** /api/org/…: GET for the owner and admins; every change is the owner's alone. */
export async function orgRoute(request: Request, env: Env, context: ExecutionContext, account: Account, path: string) {
  if (account.role === 'member') return json({ error: 'Not found.' }, 404);
  if (request.method === 'GET' && !path) return json(await snapshot(env));
  if (account.role !== 'owner') return json({ error: 'Only the owner can change this.' }, 403);
  let parts: string[];
  try { parts = path.split('/').map(part => decodeURIComponent(part)); } catch { return json({ error: 'Not found.' }, 404); }
  if (parts[0] === 'people' && parts.length === 1 && request.method === 'POST') return addPerson(request, env);
  if (parts[0] === 'people' && parts[1] && parts.length <= 3) return person(request, env, parts[1], parts[2] || '');
  if (parts[0] === 'mailboxes' && parts.length === 1 && request.method === 'POST') return addMailbox(request, env, account);
  if (parts[0] === 'mailboxes' && parts[1]) return mailbox(request, env, context, parts[1], parts.slice(2));
  if (parts[0] === 'aliases' && parts.length <= 2) return aliases(request, env, parts[1] || '');
  return json({ error: 'Not found.' }, 404);
}
