# Flary Mail

Open-source business email on Cloudflare. This project receives mail with Email Workers, sends mail
with the Email Service binding, stores mailbox state in D1 and R2, runs background work through
Queues, and publishes live changes through a Durable Object per mailbox.

```bash
npx flary deploy
```

The installer enables Email Routing and Email Sending for the configured domain. Email Routing
replaces the domain's inbound MX records. Do not enable it on a domain that must keep an external
inbound provider.

After deployment, open `/setup` and use `FLARY_SETUP_TOKEN` from `.dev.vars` to create the first
owner. The owner can add members and grant mailbox access.

The web app supports inbox, sent, outbox, drafts, archive, spam, trash, compose, reply, attachments,
team access, and real-time updates.

The responsive UI uses Tailwind CSS 4, shadcn-compatible design tokens, and Lucide icons.
`components.json` is included, so you can add more shadcn/ui components with its CLI without
changing the project aliases.

## SMTP and mail clients

Cloudflare provides outbound SMTP submission:

- Host: `smtp.mx.cloudflare.net`
- Port: `465`
- Security: implicit TLS
- Username: `api_token`
- Password: a Cloudflare API token with **Email Sending: Edit**

The sender domain must be enabled in Cloudflare Email Sending. Treat the API token as a password
because it can send from every enabled domain in its Cloudflare account.

Cloudflare does not provide IMAP or POP. SMTP can send from Outlook and other mail clients, but it
cannot synchronize this Flary inbox. Full Outlook sync needs a separate IMAP/JMAP gateway or a
Microsoft Graph bridge. Email Routing can forward inbound messages to an existing Outlook address,
but forwarded mail and SMTP submissions do not create a complete two-way mailbox mirror.
