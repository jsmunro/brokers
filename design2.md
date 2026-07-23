Here is the complete production-ready setup for your Modular Extensible Broker, including the wrangler.toml infrastructure definition and a automated Background Refresh routine.
------------------------------
## Step 1: The Infrastructure Definition (wrangler.toml)
This configuration registers your domain routes, binds your encrypted production secrets, sets up your Cloudflare KV namespace, and activates a Cron Trigger that wakes up the worker every 30 minutes to proactively refresh tokens.

#:schema node_modules/wrangler/config-schema.json
name = "central-auth-broker"
main = "src/index.ts"
compatibility_date = "2026-07-23"
# Define the domains where this broker lives
routes = [
  { pattern = "://yourdomain.com*", zone_name = "yourdomain.com" },
  { pattern = "://yourdomain.com*", zone_name = "yourdomain.com" }
]
# Production Key-Value Storage for user states and refresh tokens
kv_namespaces = [
  { binding = "AUTH_TOKENS", id = "da39a3ee5e6b4b0d3255bfef95601890" } 
]
# Automated Background Refresh Engine Engine (Runs every 30 minutes)
[triggers]
crons = ["*/30 * * * *"]
# Non-sensitive configuration variables
[vars]
ENVIRONMENT = "production"
# Note: Sensitive production tokens do not go in this file. # Upload them via CLI using: wrangler secret put <SECRET_NAME># - GITHUB_CLIENT_ID# - GITHUB_CLIENT_SECRET# - SLACK_CLIENT_ID# - SLACK_CLIENT_SECRET# - AWS_ROLE_ARN

------------------------------
## Step 2: The Core Router Engine with Background Refresh Support (src/index.ts)
We now upgrade the core execution handler to intercept Cron Triggers. When Cloudflare wakes the Worker up via the cron schedule, it scans the KV store for any aging user refresh tokens and rotates them directly on the SaaS APIs before they can expire.

import { Env, AuthProvider } from "./types";import { GitHubProvider } from "./providers/github";import { SlackProvider } from "./providers/slack";import { AWSProvider } from "./providers/aws";
const providers: Record<string, AuthProvider> = {
  github: new GitHubProvider(),
  slack: new SlackProvider(),
  aws: new AWSProvider(),
};
export default {
  // ROUTINE A: Intercept and process developer HTTP requests
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const pathParts = url.pathname.split("/").filter(Boolean);

    // Endpoint validations
    const action = pathParts[0];      // "callback" or "get-token"
    const providerSlug = pathParts[1]; // "github", "slack", "aws"

    const provider = providers[providerSlug];
    if (!provider) {
      return new Response(JSON.stringify({ error: `Unsupported provider: ${providerSlug}` }), { status: 404 });
    }

    // 1. Enforce Cloudflare Zero Trust Identification
    const accessJwt = request.headers.get("Cf-Access-Jwt-Assertion");
    if (!accessJwt) {
      return new Response(JSON.stringify({ error: "Unauthorized: Cloudflare Access Required" }), {
        status: 401,
        headers: { "Content-Type": "application/json" }
      });
    }

    const [, payloadBase64] = accessJwt.split('.');
    const payload = JSON.parse(atob(payloadBase64));
    const userId = payload.email;

    // Route: OAuth App Code Handler
    if (action === "callback") {
      try {
        const { refreshToken, data } = await provider.handleCallback(request, env);
        await env.AUTH_TOKENS.put(`refresh:${providerSlug}:${userId}`, refreshToken);
        
        return new Response(`<h1>${providerSlug.toUpperCase()} Successfully Linked!</h1>`, {
          headers: { "Content-Type": "text/html" }
        });
      } catch (err: any) {
        return new Response(`Callback Verification Failed: ${err.message}`, { status: 400 });
      }
    }

    // Route: Retrieve / Refresh User Token 
    if (action === "get-token") {
      const storageKey = `refresh:${providerSlug}:${userId}`;
      const storedRefreshToken = await env.AUTH_TOKENS.get(storageKey);

      if (!storedRefreshToken && providerSlug !== "aws") { 
        return new Response(JSON.stringify({ setup_required: true, url: provider.getAuthUrl(env, userId) }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }

      try {
        // Retrieve or perform OIDC step
        const tokenData = await provider.refreshToken(storedRefreshToken || "", env, accessJwt);

        if (tokenData.newRefreshToken) {
          await env.AUTH_TOKENS.put(storageKey, tokenData.newRefreshToken);
        }

        return new Response(JSON.stringify({
          token: tokenData.token,
          expires_in: tokenData.expires_in,
          ...tokenData.additional_data
        }), { headers: { "Content-Type": "application/json" } });

      } catch (err: any) {
        await env.AUTH_TOKENS.delete(storageKey);
        return new Response(JSON.stringify({ setup_required: true, url: provider.getAuthUrl(env, userId) }), { status: 200 });
      }
    }

    return new Response("Endpoint Not Found", { status: 404 });
  },

  // ROUTINE B: Automated Background Token Maintenance (No user input required)
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        console.log(`Starting automated refresh cron job executed at: ${event.scheduledTime}`);
        
        // 1. Fetch a complete index of all active user sessions currently tracked in KV
        const listResult = await env.AUTH_TOKENS.list({ prefix: "refresh:" });
        
        for (const key of listResult.keys) {
          // Parse out the format structure e.g., ["refresh", "github", "user@company.com"]
          const [, providerSlug, userId] = key.name.split(":");
          const provider = providers[providerSlug];
          
          if (!provider) continue;

          try {
            const currentRefreshToken = await env.AUTH_TOKENS.get(key.name);
            if (!currentRefreshToken) continue;

            console.log(`Refreshing active session for user: ${userId} on ${providerSlug}`);
            
            // Execute the refresh call directly against the downstream target API
            const tokenData = await provider.refreshToken(currentRefreshToken, env);
            
            if (tokenData.newRefreshToken) {
              // Commit the brand-new rotated refresh token safely back to KV storage
              await env.AUTH_TOKENS.put(key.name, tokenData.newRefreshToken);
            }
          } catch (error) {
            console.error(`Background refresh failure for identifier ${key.name}:`, error);
            // Notice: We don't drop tokens instantly here to allow for temporary network down-times
          }
        }
      })()
    );
  }
};

------------------------------
## Step 3: Production Deployment Guide
Execute these steps inside your terminal to bring your secure corporate broker online:
## 1. Formally Deploy the Script Configuration

wrangler deploy

## 2. Provision Isolated Downstream Secrets Securely
Run these individual commands to hand off encryption responsibilities to Cloudflare's secure secrets container:

wrangler secret put GITHUB_CLIENT_ID
wrangler secret put GITHUB_CLIENT_SECRET
wrangler secret put SLACK_CLIENT_ID
wrangler secret put SLACK_CLIENT_SECRET
wrangler secret put AWS_ROLE_ARN


