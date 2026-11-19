# Orgmail

Email for a small organisation on its own domain, running entirely on your own Cloudflare account.

- **Org panel**: the owner adds and removes people, makes shared mailboxes (like `support@`) and aliases.
- **Webmail**: each person signs in and reads and sends only their own mail, plus any shared mailbox they are a member of.
  Folders, stars, conversations, search, drafts, attachments, reply, reply all and forward.

It is one Cloudflare Worker with a D1 database and an R2 bucket. No servers, no third parties: mail comes in through
Cloudflare Email Routing and goes out through Cloudflare Email Service.

The name lives in one place, [`product.json`](product.json); change it there to rename the app.

## Install

You need a domain whose DNS is on Cloudflare (it shows as **Active** there). All of the domain's mail will come to this
app. Sending to any address needs the **Workers Paid** plan; on the free plan you can send only to your own verified
addresses.

### Door A: one command

```sh
npm install
npm run setup
```

Then open the one link it prints and make your owner account. Running it again is safe: it skips what exists.
`npm run setup -- --check` only reports where things stand.

### Door B: the Deploy to Cloudflare button

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)][deploy]

Click it, sign in to Cloudflare, and press Deploy. Open the address it gives you, and the first-run screen asks for a
Cloudflare API token and your domain, then finishes the mail setup and makes your owner account.

<!-- The repository the button deploys. Change this one line to your copy; it must be a PUBLIC GitHub or GitLab repo. -->
[deploy]: https://deploy.workers.cloudflare.com/?url=https://github.com/rdvo/orgmail

The button works only once that repository is public. A fork or copy of your own works the same way.

### What it will ask you

- **A Cloudflare API token.** Both doors print or show a link that opens Cloudflare's token form with the permissions
  picked. Check the form lists all of these, and add any that are missing (two of them may not be picked for you):
  - Account: Workers Scripts Edit, D1 Edit, Workers R2 Storage Edit, Account Settings Read, Email Sending Edit
  - Zone: Zone Read, DNS Edit, Zone Settings Edit, Workers Routes Edit, Email Routing Rules Edit

  The token is used while setup runs and is never saved or logged. You can delete it afterwards and make another when
  you want to run a check.
- **Your domain**, picked from a numbered list of the domains the token can see.
- **The web address** for the app, `mail.<your domain>` unless you change it.
- **Only if the domain already gets mail somewhere** (Google Workspace, Microsoft 365, forwarding rules): setup stops,
  lists where the mail goes today, and goes on only if you type the domain. After that, all of its mail comes here.
- On the first-run screen: your name, your mailbox name and a password. Then you set up two-step sign-in with an
  authenticator app.

### What it does

Makes the D1 database `orgmail-db`, the R2 bucket `orgmail-files` and the tables; deploys the Worker; turns on Email
Routing for the domain (Cloudflare adds and locks its MX and SPF records); points the catch-all rule at the Worker;
onboards the domain for sending and adds the records that needs (bounce MX, SPF, DKIM, and DMARC only if the domain has
none); and puts the app on its web address. Address rules you already had in Email Routing keep working and win over the
catch-all; setup lists them before it starts.

### When something goes wrong

Every stop prints the problem and one line starting **To fix:**. Fix that one thing and run `npm run setup` again.

| Setup says | Do this |
|---|---|
| The project’s packages are not installed. | Run `npm install`, then `npm run setup`. |
| Cloudflare did not accept that token. | Copy the whole token again (it is shown once), or make a new one with the link. |
| The token cannot see any active domain. | Give the token Zone Read on "All zones", and check the domain shows as Active in Cloudflare. |
| *domain* is not an active domain on the token’s account. | Wait until the domain is Active (its nameservers must point to Cloudflare), or use a token for the account it is on. |
| Stopped before changing anything. | Nothing changed. Run setup again and type the domain when you are happy for its mail to move here. |
| This Cloudflare account has never opened Workers, so it has no workers.dev address yet. | Open the link it prints once and pick a name. |
| R2 is not turned on for this Cloudflare account. | Open the link it prints and turn on R2. |
| The Cloudflare token is not allowed to … | Add the permission it names to the token, or make a new one with the link. |
| The Cloudflare token is not allowed to do this (…) | Add the permission it names, or do the step by hand: the line after **To fix** is the exact dashboard path. Email Sending is the likeliest, because Cloudflare's docs don't say which permission it needs. |
| The tables were not made. / The deploy did not finish. | Read the lines Wrangler printed under it, then run setup again; it carries on from there. |
| The app did not build. | Run `npm install` again, then `npm run setup`. |
| https://*address* already opens another Worker | Choose another web address, or remove it from that Worker first. |
| An error about an existing DNS record for the web address | Delete that record in DNS > Records, or choose another web address. |
| Could not reach the Cloudflare API. | Check the internet connection and run setup again. |

The first-run screen and the **Setup health** panel (on the People page, owner only) show the same messages and fixes.
Setup health re-checks everything with a token and can fix what is red.

### Updating

Pull the new code, then `npm install` and `npm run setup` again, or `npm run deploy` with `CLOUDFLARE_API_TOKEN` set (and `CLOUDFLARE_ACCOUNT_ID` if the
token reaches more than one account).
New tables are made by the app itself on its next request.

## Using it

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

It asks for a Cloudflare API token for the account the app runs on (the setup token works) and asks you to type the
owner's address. Then it gives the owner a one-time password, removes their two-step sign-in and signs them out
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
- **Who can claim a fresh install.** Until the owner account exists, anyone who finds the address sees the first-run
  screen, so it accepts only proof that the visitor controls the Cloudflare account the app runs in:
  - a **setup code**: a random secret (`SETUP_TOKEN`) that `npm run setup` stores on the Worker and puts in the link it
    prints. You can also add one by hand (Worker > Settings > Variables and Secrets) and choose "I have a setup code".
  - or a **Cloudflare API token**, checked against Cloudflare itself in two parts. First, the token must see the chosen
    domain as an *active* zone: anyone can add any domain to their own account, but it stays pending unless the domain's
    nameservers really point there. Second, in that same account, the Worker serving the address you opened must have
    deployed the exact version answering the request. That version id is a random id Cloudflare gives each upload; it
    is never sent to the browser and can't be given to an upload in another account. A stranger's token only reaches
    the stranger's own account, where no Worker runs this version, so it fails whatever domain they name.

  The token is used for that one request and is never stored or logged. Attempts are rate-limited (10 per visitor per
  15 minutes, 60 in all per hour), and once the owner exists the first-run endpoints answer "not found" for good. The
  reasoning is also in `worker/setup.ts`.
- No secrets live in this repository. `setup.json` keeps only your domain and web address, and is ignored by git.

## Layout

```
worker/         the Worker: API, sign-in, first run and setup health, org panel, mail, email handler
src/            the web app (React, built by Vite into dist/ and served as Worker static assets)
shared/         the Cloudflare API calls setup and the Worker both make
migrations/     the D1 schema; the Worker also applies it on its first request
scripts/        setup and owner recovery
wrangler.json   the Worker's configuration (no account ids: the database and bucket are found or made by name)
product.json    the app's name
```

## Licence

MIT. See [LICENSE](LICENSE).
