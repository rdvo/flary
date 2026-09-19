import type { CloudflareExtension } from "@flue/runtime/cloudflare";
import type {
  CreateCloudflareWorkerConfigOptions,
  CreateFlueAgentClassOptions,
} from "@flue/runtime/cloudflare/internal";

type CloudflareInternal = typeof import("@flue/runtime/cloudflare/internal");
type WorkerConfig = ReturnType<CloudflareInternal["createCloudflareWorkerConfig"]>;
type AgentClass = ReturnType<CloudflareInternal["createFlueAgentClass"]>;

// The Cloudflare entry imports the virtual `cloudflare:workers` module, so this
// proof is intentionally compile-time only. The remaining spike artifacts run
// under Node; deployed DO construction is called out as an unverified edge.
const extension = {
  base(Base) {
    return Base;
  },
  wrap(Final) {
    return Final;
  },
} as CloudflareExtension;

const classOptions: CreateFlueAgentClassOptions = {
  AgentBase: class FakeAgent {},
  runtime: null as unknown as CreateFlueAgentClassOptions["runtime"],
  className: "FlueFlaryThreadAgent",
  agentName: "flary-thread",
  extension,
};

const workerOptions: CreateCloudflareWorkerConfigOptions = {
  env: { FLUE_FLARY_THREAD_AGENT: { binding: "thread-agent" } },
  agentIdentities: {
    "flary-thread": {
      bindingName: "FLUE_FLARY_THREAD_AGENT",
      className: "FlueFlaryThreadAgent",
    },
  },
  fetchAgent: async (_binding, _id, _request) => Response.json({ ok: true }),
};

const expectedClassName: CreateFlueAgentClassOptions["className"] = "FlueFlaryThreadAgent";
const expectedAgentName: CreateFlueAgentClassOptions["agentName"] = "flary-thread";
const expectedWorkerKeys: Array<keyof WorkerConfig> = [
  "dispatchQueue",
  "routeAgentRequest",
  "instanceInfo",
];
const expectedAgentClass: AgentClass | undefined = undefined;

void classOptions;
void workerOptions;
void expectedClassName;
void expectedAgentName;
void expectedWorkerKeys;
void expectedAgentClass;

console.log(
  JSON.stringify({
    typecheck: {
      internalBuilder: "createFlueAgentClass(CreateFlueAgentClassOptions)",
      extension: "extend({ base, wrap })",
      workerConfig: "createCloudflareWorkerConfig(CreateCloudflareWorkerConfigOptions)",
    },
    className: "FlueFlaryThreadAgent",
    agentName: "flary-thread",
    dispatchPath: "/__flue/internal/dispatch",
    migration: {
      tag: "flary-v1",
      className: "FlueFlaryThreadAgent",
      newMigrationRequired: false,
    },
    runtimeExecution: "not-run: cloudflare:workers virtual module",
  }),
);
