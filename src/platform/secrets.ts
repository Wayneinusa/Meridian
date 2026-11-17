// API keys and connector tokens. In the app they live in the OS credential
// store (Windows Credential Manager / iOS Keychain). They are never written
// to conversation files, sync folders or backups.
import { invoke, isTauri } from "./index";

const LS_PREFIX = "meridian.secret.";

export async function getSecret(name: string): Promise<string | null> {
  if (isTauri) return (await invoke<string | null>("secret_get", { name })) ?? null;
  return globalThis.localStorage?.getItem(LS_PREFIX + name) ?? null;
}

export async function setSecret(name: string, value: string): Promise<void> {
  if (isTauri) return invoke("secret_set", { name, value });
  globalThis.localStorage?.setItem(LS_PREFIX + name, value);
}

export async function deleteSecret(name: string): Promise<void> {
  if (isTauri) return invoke("secret_delete", { name });
  globalThis.localStorage?.removeItem(LS_PREFIX + name);
}

export const providerKeyName = (providerId: string) => `provider.${providerId}`;
export const mcpTokenName = (serverId: string) => `mcp.${serverId}`;
