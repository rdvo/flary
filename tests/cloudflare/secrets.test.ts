import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { CloudflareEncryptedSecretStore } from "../../src/harness/cloudflare/secrets.js";
import { encodeBase64Url } from "../../src/harness/vault/crypto.js";

function d1() {
  const database = new DatabaseSync(":memory:");
  return {
    database,
    adapter: {
      prepare(query: string) {
        let bindings: unknown[] = [];
        return {
          bind(...values: unknown[]) {
            bindings = values;
            return this;
          },
          async run() {
            const result = database.prepare(query).run(...bindings);
            return { success: true, meta: { changes: Number(result.changes) } };
          },
          async first<T>() {
            return (database.prepare(query).get(...bindings) as T) ?? null;
          },
        };
      },
    },
  };
}

test("the Cloudflare secret store encrypts values and returns only metadata", async () => {
  const { database, adapter } = d1();
  const store = new CloudflareEncryptedSecretStore({
    database: adapter,
    encryptionKey: encodeBase64Url(new Uint8Array(32).fill(7)),
    now: () => new Date("2026-08-26T12:00:00.000Z"),
  });
  const scope = {
    authorization: {
      organizationId: "tenant_1",
      actor: { id: "user_1", kind: "user" as const, version: "1" },
    },
    appId: "app_1",
    threadId: "thread_1",
  };
  const metadata = await store.put(scope, "github", {
    name: "api-token",
    value: "plaintext-must-not-be-stored",
    scope: "organization",
  });

  assert.equal(metadata.version, 1);
  assert.equal("value" in metadata, false);
  const row = database.prepare("SELECT ciphertext, iv FROM flary_connection_secret").get() as {
    ciphertext: string;
    iv: string;
  };
  assert.equal(JSON.stringify(row).includes("plaintext-must-not-be-stored"), false);
  assert.equal(
    await store.resolve(scope, "github", "api-token", "organization"),
    "plaintext-must-not-be-stored",
  );

  const rotated = await store.put(scope, "github", {
    name: "api-token",
    value: "rotated-value",
    scope: "organization",
  });
  assert.equal(rotated.version, 2);
  assert.equal(await store.resolve(scope, "github", "api-token", "organization"), "rotated-value");
});
