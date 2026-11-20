# Flary

Your organisation's own email, on your own domain and your own Cloudflare account. Like a small Google Workspace for mail,
with nobody in the middle.

- **Webmail**: each person signs in and reads and sends only their own mail, plus any shared mailbox they are a member of.
  Folders, stars, conversations, search, drafts, attachments, reply, reply all and forward.
- **Org panel**: the owner adds and removes people, makes shared mailboxes (like `support@`) and aliases, and sets the
  organisation's name and logo.

It is one Cloudflare Worker with a D1 database and an R2 bucket. No servers, no third parties: mail comes in through
Cloudflare Email Routing and goes out through Cloudflare Email Service.

The name lives in one place, [`product.json`](product.json); change it there to rename the app.

## Install

You need a domain whose DNS is on Cloudflare (it shows as **Active** there). All of the domain's mail will come to this
app. Sending to any address needs the **Workers Paid** plan; on the free plan you can send only to your own verified
addresses.

### Easiest: ask your coding agent

Paste this into Claude Code, Cursor, Codex or any agent that can run commands:

```text
Install Flary for me (https://github.com/rdvo/flary): clone it into a folder named flary, run `npm install`,
then run `npm run setup` and keep it running until it ends. When it opens a Cloudflare page in my browser, tell
me to choose Allow. When it prints a setup link, give it to me and wait while I finish the wizard. If it lists
DNS records to change: if you have Cloudflare's MCP server (mcp.cloudflare.com) connected, make exactly those
changes with it; otherwise show me the list and the link, and wait. When it ends, tell me what it printed.
```

You click **Allow** on Cloudflare's page, fill in the wizard, and the agent does the rest. With Cloudflare's MCP server
connected to your agent, it can also make any DNS changes setup asks for, so you never open the DNS page.

### Or run it yourself

```sh
git clone https://github.com/rdvo/flary.git
cd flary
npm install
npm run setup
```

1. **Sign in to Cloudflare.** Setup uses wrangler, Cloudflare's own tool, which comes with the project. Your browser opens
   Cloudflare's own page; choose **Allow**. There is no token to make or paste, and the sign-in stays on your computer.
2. **It builds and deploys** the app, makes its database and file bucket, and prints one link.
3. **Open the link and follow the wizard:** your organisation's name and logo, your domain, the web address
   (`mail.<your domain>` unless you change it), and your account.
4. **Setup carries on** on your computer once the wizard is done: it turns on mail for the domain, sends all of it to the
   app, sets the domain up to send, and puts the app on its web address.
5. **Sign in,** set up two-step sign-in with an authenticator app, and invite your team (or skip that for later).

### If the domain already gets mail, or the web address is taken

If mail for the domain goes somewhere today (Google Workspace, Microsoft 365, another server, forwarding rules), the
wizard lists what would change and goes on only if you type the domain. Address rules you already had in Email Routing
keep working and win over the catch-all.

Wrangler's sign-in can't edit DNS records, so when old records are in the way (another server's MX records, an SPF record
that needs Cloudflare added, a record already on the web address), setup lists exactly what to change, with a link to the
domain's DNS page, and carries on by itself once you have made the changes. Or paste a Cloudflare API token with DNS Edit
when it asks, and it makes them for you; the token is used once and not saved.

### Or: the Deploy to Cloudflare button

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)][deploy]

Click it, sign in to Cloudflare, and press Deploy. With no installer on your computer, the wizard starts by asking for a
Cloudflare API token, made with a link that picks its permissions, and uses it once to set up your mail. It is not kept.

<!-- The repository the button deploys. Change this one line to your copy; it must be a PUBLIC GitHub or GitLab repo. -->
[deploy]: https://deploy.workers.cloudflare.com/?url=https://github.com/rdvo/flary

A token for the button, or for checking from Setup health, needs:

- Account: Workers Scripts Edit, D1 Edit, Workers R2 Storage Edit, Account Settings Read, Email Sending Edit
- Zone: Zone Read, DNS Edit, Zone Settings Edit, Workers Routes Edit, Email Routing Rules Edit

### When something goes wrong

Every stop says what went wrong and one thing to do, starting **To fix:**. Fix that one thing and run `npm run setup`
again. In the app, **Setup health** (People and mailboxes, owner only) shows what setup last did.

| It says | Do this |
|---|---|
| The project’s packages are not installed. | Run `npm install`, then `npm run setup`. |
| Cloudflare did not accept the sign-in. | Run `npx wrangler login`, choose Allow, and run setup again. |
| There is no active domain in … | Add the domain to Cloudflare and wait until it shows as Active. |
| This Cloudflare account has never opened Workers | Open the link it prints once and pick a name. |
| R2 is not turned on for this Cloudflare account. | Open the link it prints and turn on R2. |
| Cloudflare did not allow setup to … | Run `npx wrangler login`, choose Allow, and run setup again. |
| These DNS records need changing | Make the listed changes on the DNS page it links to; setup carries on by itself. |
| The deploy did not finish. | Read the lines Wrangler printed under it, then run setup again; it carries on from there. |
| The app did not build. | Run `npm install` again, then `npm run setup`. |
| https://*address* already opens another Worker | Choose another web address, or remove it from that Worker first. |
| Could not reach the Cloudflare API. | Check the internet connection and try again. |

`npm run setup -- --check` only reports where things stand and changes nothing.

### Updating

Pull the new code, then `npm install` and `npm run setup` again (or ask your agent to). Once the wizard is done, setup
also checks the mail setup and puts right anything that is off. New tables are made by the app itself on its next request.

## Using it

- **Organisation** (owner only): the name and logo shown on the sign-in page and at the top of every page.
- **People** (owner only; admins can view): adding a person creates their mailbox and a one-time password, shown once
  with a note to copy and send them. They choose their own password (10+ characters) the first time they sign in.
  Owners and admins must set up two-step sign-in. **Reset** signs a person out and gives them a new one-time password.
  **Remove** signs them out and keeps their mailbox and mail; you can then give someone access to it or delete it.
- **Shared mailboxes**: an address several people read and answer. Mail sent from it comes from its address.
- **Aliases**: extra addresses that deliver into a mailbox, like `hello@` into `support@`.
- Mail to any other address on the domain is refused. `name+anything@` delivers to `name@`.
- Replies to your mail join the right conversation through the Message-ID Cloudflare assigns to each sent message (you
  can't set your own). A reply that names no message here joins the newest conversation you wrote to that person under
  the same subject in the last 90 days.

## Your account

- **Change password** (the key button at the top of the mail page): needs your current password and signs you out
  everywhere else.

### When the owner is locked out

If the owner loses their password or their authenticator app, run this from this folder:

```sh
npm run recover-owner
```

It signs in to Cloudflare the way setup does and asks you to type the owner's address. Then it gives the owner a one-time password, removes their two-step sign-in and signs them out
everywhere. At the next sign-in the owner chooses a new password and sets up two-step again. It changes only the owner
account. Anyone who can run it already controls the Cloudflare account.

## What it does not do

- No IMAP, POP or SMTP, so no Outlook, Apple Mail or phone mail apps. It is webmail only.
- No calendar or contacts.
- No spam filtering beyond filing mail that fails the sender's DMARC check in Spam.
- No storage quotas or per-person limits.
- No custom domains per mailbox: everything is on one domain.

## Security

- Passwords are stored as PBKDF2-SHA256 (100,000 iterations) with a per-account salt. Five wrong tries lock an account
  for 15 minutes. Sign-in does the same work whether or not the account exists.
- Two-step sign-in (TOTP, RFC 6238) is required for owner and admin accounts; each code works once.
- The session cookie is `__Host-`, HttpOnly, Secure and SameSite=Lax; only its SHA-256 is stored. Every request that
  changes something must come from the site's own origin.
- Every query on mail goes through one function that scopes it to a mailbox the signed-in person is a member of
  (`worker/mail.ts`). A person's own mailbox can only ever be opened by them; the owner cannot add themselves to it.
- Received HTML is shown in a sandboxed frame that runs no scripts and loads only pictures (https and inline), inline
  styles and fonts. Mail in Spam, or that failed the sender check, loads no outside pictures. Attachments are served with `nosniff` and a
  `sandbox` content security policy, and only plain images and PDFs open in the browser; everything else downloads.
- **No Cloudflare token is kept anywhere.** `npm run setup` signs in with wrangler, whose login stays on your computer,
  and does every Cloudflare step from there. The app itself holds no Cloudflare credentials. A token pasted in the wizard
  (Deploy button) or in Setup health is used for that one request and not stored or logged.
- **Who can claim a fresh install.** Until the owner account exists, anyone who finds the address sees the setup
  wizard, so it accepts only proof that the visitor controls the Cloudflare account the app runs in:
  - a **setup code**: a random secret (`SETUP_TOKEN`) that `npm run setup` stores on the Worker and puts in the link it
    prints.
  - or a **Cloudflare API token**, checked against Cloudflare itself in two parts. First, the token must see the chosen
    domain as an *active* zone: anyone can add any domain to their own account, but it stays pending unless the domain's
    nameservers really point there. Second, in that same account, the Worker serving the address you opened must have
    deployed the exact version answering the request. That version id is a random id Cloudflare gives each upload; it
    is never sent to the browser and can't be given to an upload in another account. A stranger's token only reaches
    the stranger's own account, where no Worker runs this version, so it fails whatever domain they name.

  Attempts are rate-limited (10 per visitor per 15 minutes, 60 in all per hour), and once the owner exists the wizard's
  endpoints answer "not found" for good. The reasoning is also in `worker/setup.ts`.
- The organisation's logo must be a PNG, JPEG or WebP under 512 KB, and is served with `nosniff` and a `sandbox` policy.
- No secrets live in this repository. `setup.json` keeps only your Cloudflare account id, and is ignored by git.

## Layout

```
worker/         the Worker: API, sign-in, setup wizard and setup health, branding, org panel, mail, email handler
src/            the web app (React, built by Vite into dist/ and served as Worker static assets)
shared/         the Cloudflare API calls setup and the Worker both make
migrations/     the D1 schema; the Worker also applies it on its first request
scripts/        setup and owner recovery
wrangler.json   the Worker's configuration (no account ids: the database and bucket are found or made by name)
product.json    the app's name
```

## Licence

MIT. See [LICENSE](LICENSE).
