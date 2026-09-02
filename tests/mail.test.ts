import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createReplyThreadHeaders,
  mailThreadKey,
  normalizeMailAddress,
  normalizeMailSubject,
  replySubject,
} from "../src/mail/index.ts";

test("mail helpers normalize addresses and reply subjects", () => {
  assert.equal(normalizeMailAddress("Flary <Admin@Example.com>"), "admin@example.com");
  assert.equal(normalizeMailSubject("Re: Fwd:  Account   access "), "Account access");
  assert.equal(replySubject("Account access"), "Re: Account access");
  assert.equal(replySubject("RE: Account access"), "RE: Account access");
});

test("reply headers preserve a bounded RFC message chain", () => {
  const headers = createReplyThreadHeaders(
    "<child@example.com>",
    "<root@example.com> <parent@example.com>",
  );
  assert.deepEqual(headers, {
    "In-Reply-To": "<child@example.com>",
    References: "<root@example.com> <parent@example.com> <child@example.com>",
  });
});

test("thread keys prefer the root reference", async () => {
  const first = await mailThreadKey({
    messageId: "<child-a@example.com>",
    references: "<root@example.com>",
    subject: "Re: Hello",
    participants: ["a@example.com", "support@example.com"],
  });
  const second = await mailThreadKey({
    messageId: "<child-b@example.com>",
    references: "<root@example.com> <child-a@example.com>",
    subject: "Re: Hello again",
    participants: ["support@example.com", "a@example.com"],
  });
  assert.equal(first, second);
});

test("the mail template keeps Better Auth account identities issuer scoped", async () => {
  const [migration, schema, components] = await Promise.all([
    readFile(new URL("../templates/mail/migrations/0001_mail.sql", import.meta.url), "utf8"),
    readFile(new URL("../templates/mail/src/db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../templates/mail/components.json", import.meta.url), "utf8"),
  ]);
  assert.match(migration, /issuer TEXT NOT NULL/);
  assert.match(migration, /UNIQUE\(issuer, account_id\)/);
  assert.match(schema, /issuer: text\("issuer"\)\.notNull\(\)/);
  assert.equal(JSON.parse(components).tailwind.css, "src/styles.css");
});
