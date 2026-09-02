import assert from "node:assert/strict";
import test from "node:test";
import { Aes256GcmEnvelopeEncryptor, randomAes256Key } from "../../src/harness/vault/crypto.js";
import { createSecretsContext, MissingSecretError } from "../../src/harness/vault/secrets.js";

test("encrypts an envelope and does not expose a missing secret", async () => {
  const rootKey = randomAes256Key();
  const encryptor = new Aes256GcmEnvelopeEncryptor({
    async getKey() {
      return rootKey;
    },
  });
  const plaintext = new TextEncoder().encode("private-value");
  const envelope = await encryptor.encrypt(plaintext, { keyId: "tenant-key" });
  const decrypted = await encryptor.decrypt(envelope);
  assert.equal(new TextDecoder().decode(decrypted), "private-value");

  const secrets = createSecretsContext({
    provider: {
      async get() {
        return undefined;
      },
    },
  });
  await assert.rejects(
    secrets.with("OPENAI_API_KEY", async () => "not-called"),
    MissingSecretError,
  );
});
