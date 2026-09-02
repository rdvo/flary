import { ContainerProxy, Sandbox } from "@cloudflare/sandbox";

// Untrusted workloads cannot reach the public internet. Add narrow outbound
// handlers for package registries or source providers when a product needs
// them. Secret values stay in the Worker.
export class FlarySandbox extends Sandbox {
  enableInternet = false;
}

export { ContainerProxy };
