export const API: string;
export const TOKEN_NEEDS: string[];
export function tokenLink(name: string): string;

export class CloudflareError extends Error {
  constructor(status: number, errors: { code?: number; message?: string }[]);
  status: number;
  denied: boolean;
}

export type DnsRecord = { id?: string; type: string; name: string; content: string; priority?: number };
export type Cf = {
  (method: string, path: string, body?: unknown): Promise<any>;
  page(path: string, limit?: number): Promise<any[]>;
  lookup?: (zone: Zone, name: string, type: string) => Promise<DnsRecord[]>;
};
export function client(token: string | (() => Promise<string> | string)): Cf;

export type Zone = { id: string; name: string; accountId: string; accountName: string };
export function listZones(cf: Cf): Promise<Zone[]>;
export function findZone(cf: Cf, domain: string): Promise<Zone | null>;
export function domainService(cf: Cf, accountId: string, host: string): Promise<{ hostname: string; service: string; zone_id: string } | null>;
export function runsVersion(cf: Cf, accountId: string, script: string, versionId: string): Promise<boolean>;

export type Context = { product: string; domain: string; host: string; script: string; accountId: string; zone: Zone };
export type StepKey = 'site' | 'routing' | 'catchAll' | 'sending';
export const STEPS: Record<StepKey, { doing(c: Context): string; needs: string; dashboard(c: Context): string }>;
export type Failure = { key: StepKey; problem: string; fix: string; records?: string[] };
export function explain(key: StepKey, error: unknown, c: Context): Omit<Failure, 'key'>;

export type DnsEdit = { op: 'delete' | 'set' | 'add'; type: string; name: string; content: string; to?: string; priority?: number };
export function records(cf: Cf, zone: Zone, name: string, type: string): Promise<DnsRecord[]>;
export function describeEdit(edit: DnsEdit): string;
export class DnsNeeded extends Error { constructor(edits: DnsEdit[]); edits: DnsEdit[] }
export function applyEdits(cf: Cf, zone: Zone, edits: DnsEdit[]): Promise<boolean>;
export function mailState(cf: Cf, zone: Zone, script: string): Promise<{ routingOn: boolean; routingStatus: string; catchAllOurs: boolean; away: number; elsewhere: string[]; outside: DnsRecord[] }>;
export function changes(cf: Cf, c: Context): Promise<{ confirm: string[]; mailEdits: DnsEdit[]; hostEdits: DnsEdit[] }>;
export function sendingState(cf: Cf, zone: Zone): Promise<{ onboarded: boolean; enabled: boolean; tag: string; missing: DnsEdit[] }>;

export type HealthItem = { key: StepKey; ok: boolean; label: string; detail?: string; fix?: string };
export function inspect(cf: Cf, c: Context): Promise<HealthItem[]>;
export function repair(cf: Cf, c: Context, options?: { confirmed?: string; say?: (line: string) => void; dns?: Cf }): Promise<{ done: StepKey[]; failed?: Failure; confirm?: string[] }>;
