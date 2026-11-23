// OAuth 2.1 sign-in for connectors, as the MCP authorization spec describes:
// discover the authorization server from the connector (RFC 9728 / 8414),
// register this app with it on the fly (RFC 7591), then sign in with PKCE.
// Tokens are kept in the OS keychain and refreshed when they expire.
import { onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { invoke, isTauri, platform } from "../platform";
import { openExternal } from "../platform/files";
import { httpFetch, readError } from "../platform/http";
import { deleteSecret, getSecret, setSecret } from "../platform/secrets";
import { bytesToBase64 } from "../util/bytes";

export interface OAuthTokens {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  token_type?: string;
  scope?: string;
  client_id: string;
  client_secret?: string;
  token_endpoint: string;
  resource?: string;
  /** OpenID Connect ID token (only used to show who is signed in) */
  id_token?: string;
}

export const tokenSecret = (id: string) => `oauth.${id}`;

export async function loadTokens(id: string): Promise<OAuthTokens | null> {
  const raw = await getSecret(tokenSecret(id));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as OAuthTokens;
  } catch {
    return null;
  }
}

export const saveTokens = (id: string, t: OAuthTokens) => setSecret(tokenSecret(id), JSON.stringify(t));
export const forgetTokens = (id: string) => deleteSecret(tokenSecret(id));

function b64url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  const verifier = b64url(raw);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return { verifier, challenge: b64url(digest) };
}

export interface AuthServer {
  issuer?: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
}

async function getJson(url: string): Promise<any | null> {
  try {
    const res = await httpFetch(url, { headers: { Accept: "application/json" } });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** Find the authorization server that protects `resourceUrl`. */
export async function discover(resourceUrl: string, resourceMetadataUrl?: string): Promise<{ server: AuthServer; scopes?: string[] }> {
  const u = new URL(resourceUrl);
  const candidates = [resourceMetadataUrl, `${u.origin}/.well-known/oauth-protected-resource${u.pathname.replace(/\/$/, "")}`, `${u.origin}/.well-known/oauth-protected-resource`].filter(Boolean) as string[];
  let issuer = u.origin;
  let scopes: string[] | undefined;
  for (const c of candidates) {
    const meta = await getJson(c);
    if (meta?.authorization_servers?.length) {
      issuer = meta.authorization_servers[0];
      scopes = meta.scopes_supported;
      break;
    }
  }
  const iu = new URL(issuer);
  const path = iu.pathname.replace(/\/$/, "");
  const metaUrls = [
    `${iu.origin}/.well-known/oauth-authorization-server${path}`,
    `${iu.origin}/.well-known/openid-configuration${path}`,
    `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
    `${iu.origin}/.well-known/oauth-authorization-server`,
  ];
  for (const m of metaUrls) {
    const meta = await getJson(m);
    if (meta?.authorization_endpoint && meta?.token_endpoint) return { server: meta, scopes: scopes ?? meta.scopes_supported };
  }
  // last resort: the defaults the MCP spec allows servers to rely on
  return { server: { authorization_endpoint: `${iu.origin}/authorize`, token_endpoint: `${iu.origin}/token`, registration_endpoint: `${iu.origin}/register` }, scopes };
}

export async function registerClient(server: AuthServer, redirectUri: string): Promise<{ client_id: string; client_secret?: string }> {
  if (!server.registration_endpoint) throw new Error("This service does not let apps register themselves. Add a client ID in the connector's settings.");
  const res = await httpFetch(server.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_name: "Meridian",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "native",
    }),
  });
  if (!res.ok) throw new Error(`Could not register with the sign-in service: ${await readError(res)}`);
  const j = await res.json();
  return { client_id: j.client_id, client_secret: j.client_secret };
}

/** Where the browser comes back to, and a way to wait for it. */
export async function redirectChannel(fixedPort?: number): Promise<{ uri: string; wait: () => Promise<string> }> {
  if (!isTauri) throw new Error("Signing in to connectors needs the installed app.");
  if (platform().mobile) {
    const uri = "meridian://oauth/callback";
    return {
      uri,
      wait: () =>
        new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Sign-in timed out after 10 minutes.")), 600_000);
          void onOpenUrl((urls) => {
            const hit = urls.find((x) => x.startsWith(uri));
            if (hit) {
              clearTimeout(timer);
              resolve(hit);
            }
          });
        }),
    };
  }
  const port = await invoke<number>("oauth_listen", fixedPort ? { port: fixedPort } : {});
  return { uri: `http://127.0.0.1:${port}/callback`, wait: () => invoke<string>("oauth_wait", { port }) };
}

export interface SignInOptions {
  /** the connector URL (MCP resource) */
  resource?: string;
  resourceMetadataUrl?: string;
  /** fixed endpoints and client (Google, Microsoft) instead of discovery */
  server?: AuthServer;
  clientId?: string;
  clientSecret?: string;
  scopes?: string[];
  extraAuthParams?: Record<string, string>;
  /** how to show the sign-in page */
  open?: (url: string) => Promise<void>;
  redirect?: { uri: string; wait: () => Promise<string> };
}

export async function signIn(opts: SignInOptions): Promise<OAuthTokens> {
  const found = opts.server ? { server: opts.server, scopes: opts.scopes } : await discover(opts.resource!, opts.resourceMetadataUrl);
  const redirect = opts.redirect ?? (await redirectChannel());
  const client = opts.clientId ? { client_id: opts.clientId, client_secret: opts.clientSecret } : await registerClient(found.server, redirect.uri);
  const { verifier, challenge } = await pkce();
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const auth = new URL(found.server.authorization_endpoint);
  const params: Record<string, string> = {
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: redirect.uri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    ...(opts.extraAuthParams ?? {}),
  };
  const scopes = opts.scopes ?? found.scopes;
  if (scopes?.length) params.scope = scopes.join(" ");
  if (opts.resource) params.resource = opts.resource;
  for (const [k, v] of Object.entries(params)) auth.searchParams.set(k, v);
  await (opts.open ?? openExternal)(auth.toString());
  const back = new URL(await redirect.wait());
  if (back.searchParams.get("error")) throw new Error(`Sign-in was not completed: ${back.searchParams.get("error_description") ?? back.searchParams.get("error")}`);
  if (back.searchParams.get("state") !== state) throw new Error("Sign-in failed a security check (state mismatch). Try again.");
  const code = back.searchParams.get("code");
  if (!code) throw new Error("The sign-in page returned no code.");
  return exchange(found.server.token_endpoint, client, { grant_type: "authorization_code", code, redirect_uri: redirect.uri, code_verifier: verifier, ...(opts.resource ? { resource: opts.resource } : {}) }, opts.resource);
}

async function exchange(tokenEndpoint: string, client: { client_id: string; client_secret?: string }, body: Record<string, string>, resource?: string, prev?: OAuthTokens): Promise<OAuthTokens> {
  const form = new URLSearchParams({ ...body, client_id: client.client_id });
  if (client.client_secret) form.set("client_secret", client.client_secret);
  const res = await httpFetch(tokenEndpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: form.toString() });
  if (!res.ok) throw new Error(`The sign-in service refused the token request: ${await readError(res)}`);
  const j = await res.json();
  if (!j.access_token) throw new Error("The sign-in service returned no access token.");
  return {
    access_token: j.access_token,
    refresh_token: j.refresh_token ?? prev?.refresh_token,
    expires_at: j.expires_in ? Date.now() + Number(j.expires_in) * 1000 : undefined,
    token_type: j.token_type,
    scope: j.scope ?? prev?.scope,
    client_id: client.client_id,
    client_secret: client.client_secret,
    token_endpoint: tokenEndpoint,
    resource,
    id_token: j.id_token ?? prev?.id_token,
  };
}

/** A valid access token for connector `id`, refreshing it when needed; null when signed out. */
export async function accessToken(id: string, force = false): Promise<string | null> {
  const t = await loadTokens(id);
  if (!t) return null;
  const fresh = !t.expires_at || t.expires_at - Date.now() > 60_000;
  if (fresh && !force) return t.access_token;
  if (!t.refresh_token) return force ? null : t.access_token;
  try {
    const next = await exchange(t.token_endpoint, { client_id: t.client_id, client_secret: t.client_secret }, { grant_type: "refresh_token", refresh_token: t.refresh_token, ...(t.resource ? { resource: t.resource } : {}) }, t.resource, t);
    await saveTokens(id, next);
    return next.access_token;
  } catch {
    return null;
  }
}

/** Parse WWW-Authenticate: Bearer resource_metadata="..." */
export function resourceMetadataFrom(header: string | null): string | undefined {
  return header ? /resource_metadata="([^"]+)"/.exec(header)?.[1] : undefined;
}

export interface DeviceCode {
  user_code: string;
  verification_url: string;
  /** a link that already contains the code, when the service offers one */
  verification_url_complete?: string;
  expires_in: number;
}

/**
 * Sign in with a code shown on screen (OAuth device flow, RFC 8628). Works the
 * same on every platform: no redirect address to register, nothing to catch.
 * Google and Microsoft both support it for apps people register themselves.
 */
export async function deviceSignIn(opts: {
  deviceEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  scopes: string[];
  onCode: (code: DeviceCode) => void;
  signal?: AbortSignal;
  /** extra fields for the first request (e.g. xAI's referrer) */
  extra?: Record<string, string>;
}): Promise<OAuthTokens> {
  const form = new URLSearchParams({ client_id: opts.clientId, scope: opts.scopes.join(" "), ...(opts.extra ?? {}) });
  const res = await httpFetch(opts.deviceEndpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: form.toString(), signal: opts.signal });
  if (!res.ok) throw new Error(`The sign-in service refused: ${await readError(res)}`);
  const d = await res.json();
  const code: DeviceCode = {
    user_code: d.user_code,
    verification_url: d.verification_uri ?? d.verification_url,
    verification_url_complete: d.verification_uri_complete,
    expires_in: Number(d.expires_in) || 900,
  };
  opts.onCode(code);
  let interval = (Number(d.interval) || 5) * 1000;
  const deadline = Date.now() + code.expires_in * 1000;
  const client = { client_id: opts.clientId, client_secret: opts.clientSecret };
  for (;;) {
    if (Date.now() > deadline) throw new Error("The code expired before sign-in finished. Try again.");
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, interval);
      opts.signal?.addEventListener("abort", () => (clearTimeout(t), reject(new DOMException("Aborted", "AbortError"))));
    });
    const body = new URLSearchParams({ client_id: opts.clientId, device_code: d.device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" });
    if (opts.clientSecret) body.set("client_secret", opts.clientSecret);
    const tr = await httpFetch(opts.tokenEndpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: body.toString(), signal: opts.signal });
    const j = await tr.json().catch(() => ({}));
    if (tr.ok && j.access_token) {
      return {
        access_token: j.access_token,
        refresh_token: j.refresh_token,
        expires_at: j.expires_in ? Date.now() + Number(j.expires_in) * 1000 : undefined,
        token_type: j.token_type,
        scope: j.scope,
        client_id: client.client_id,
        client_secret: client.client_secret,
        token_endpoint: opts.tokenEndpoint,
        id_token: j.id_token,
      };
    }
    if (j.error === "authorization_pending") continue;
    if (j.error === "slow_down") {
      interval += 5000;
      continue;
    }
    if (j.error === "access_denied") throw new Error("Sign-in was declined.");
    if (j.error === "expired_token") throw new Error("The code expired before sign-in finished. Try again.");
    throw new Error(`Sign-in failed: ${j.error_description ?? j.error ?? tr.status}`);
  }
}
