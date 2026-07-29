type GeneratedBindings = Omit<
  CloudflareEnv,
  | "APP_URL"
  | "APP_ENV"
  | "EMAIL_DELIVERY_ENABLED"
  | "EMAIL_FROM"
  | "SANDBOX_TRANSPORT"
  | "CODE_MODE_ENABLED"
  | "ARTIFACTS"
>;

export type CloudflareArtifactsBinding = import("./artifacts-history").ArtifactsBinding;

export interface Env extends GeneratedBindings {
  /** Closed-beta binding. R2 remains the required fallback. */
  ARTIFACTS?: CloudflareArtifactsBinding;
  FLARY_DEFAULT_MODEL?: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  MOONSHOT_API_KEY?: string;
  GOOGLE_API_KEY?: string;
  CODE_MODE_ENABLED?: string;
  TURBOPUFFER_API_KEY?: string;
  TURBOPUFFER_BASE_URL?: string;
  TURBOPUFFER_NAMESPACE?: string;
  APP_URL: string;
  APP_ENV: "development" | "staging" | "production";
  EMAIL_DELIVERY_ENABLED: string;
  EMAIL_FROM: string;
  BETTER_AUTH_SECRET: string;
  CLOUDFLARE_OAUTH_CLIENT_ID?: string;
  CLOUDFLARE_OAUTH_CLIENT_SECRET?: string;
  CLOUDFLARE_OAUTH_SCOPES?: string;
  FLARY_TOKEN_ENCRYPTION_KEY_B64?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  EMAIL?: {
    send(message: unknown): Promise<void>;
  };
}
