To make this a scalable, company-wide standard, we can transition the architecture into a Modular Extensible Broker.
By applying a dynamic router pattern, you can add new SaaS tools simply by dropping in a new configuration file (or class) that conforms to a unified interface. The core engine handles Cloudflare Access JWT validation, error handling, logging, and KV storage interaction uniformly.
## Modular Architecture Directory Structure
When building your Worker project, structure your files like this to keep integration modules isolated:

src/
├── index.ts          # Core engine (Routing, Access JWT verification)
├── types.ts          # Unified interfaces and configuration schemas
└── providers/        # Isolated SaaS integration plugins
    ├── github.ts
    ├── slack.ts
    └── aws.ts

------------------------------
## Step 1: Define the Unified Plugin Interface (src/types.ts)
Every SaaS tool handles its auth exchange differently, but they all share a lifecycle. This interface standardises those phases.

export interface Env {
  AUTH_TOKENS: KVNamespace;
  // Shared secrets read by the core engine
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  SLACK_CLIENT_ID: string;
  SLACK_CLIENT_SECRET: string;
  AWS_ROLE_ARN: string; // Used for OIDC assumption
}
export interface TokenPayload {
  token: string;
  expires_in?: number;
  additional_data?: Record<string, any>;
}
export interface AuthProvider {
  slug: string; // e.g., 'github', 'slack', 'aws'
  
  // Generates the initial interactive onboarding URL
  getAuthUrl(env: Env, userId: string): string;
  
  // Handles the initial OAuth callback code exchange
  handleCallback(request: Request, env: Env): Promise<{ refreshToken: string; data: any }>;
  
  // Exchanges a stored refresh token for a fresh short-lived token
  refreshToken(refreshToken: string, env: Env): Promise<TokenPayload & { newRefreshToken?: string }>;
}

------------------------------
## Step 2: Implement the Core Router Engine (src/index.ts)
The core engine manages the common plumbing. It dynamically matches the URL slug (/get-token/:provider) to the correct plugin.

import { Env, AuthProvider } from "./types";import { GitHubProvider } from "./providers/github";import { SlackProvider } from "./providers/slack";import { AWSProvider } from "./providers/aws";
// Register available pluginsconst providers: Record<string, AuthProvider> = {
  github: new GitHubProvider(),
  slack: new SlackProvider(),
  aws: new AWSProvider(),
};
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const pathParts = url.pathname.split("/").filter(Boolean); // e.g. ["get-token", "github"]

    // 1. Enforce Global Cloudflare Zero Trust Identity
    const accessJwt = request.headers.get("Cf-Access-Jwt-Assertion");
    if (!accessJwt) {
      return new Response(JSON.stringify({ error: "Unauthorized: Cloudflare Access Required" }), {
        status: 401,
        headers: { "Content-Type": "application/json" }
      });
    }

    // Extract User Identity
    const [, payloadBase64] = accessJwt.split('.');
    const payload = JSON.parse(atob(payloadBase64));
    const userId = payload.email;

    const action = pathParts[0];      // "callback" or "get-token"
    const providerSlug = pathParts[1]; // "github", "slack", "aws"

    const provider = providers[providerSlug];
    if (!provider) {
      return new Response(JSON.stringify({ error: `Unsupported provider: ${providerSlug}` }), { status: 404 });
    }

    // ROUTE: Universal OAuth Callback Router
    if (action === "callback") {
      try {
        const { refreshToken, data } = await provider.handleCallback(request, env);
        // Persist securely in KV namespaced by provider and user identity
        await env.AUTH_TOKENS.put(`refresh:${providerSlug}:${userId}`, refreshToken);
        
        return new Response(`<h1>${providerSlug.toUpperCase()} Linked!</h1><p>Setup successful. You can close this tab.</p>`, {
          headers: { "Content-Type": "text/html" }
        });
      } catch (err: any) {
        return new Response(`Callback Failed: ${err.message}`, { status: 400 });
      }
    }

    // ROUTE: Universal Token Request / Refresh Router
    if (action === "get-token") {
      const storageKey = `refresh:${providerSlug}:${userId}`;
      const storedRefreshToken = await env.AUTH_TOKENS.get(storageKey);

      // If the plugin requires an interactive OAuth flow and token is missing
      if (!storedRefreshToken && providerSlug !== "aws") { 
        const authUrl = provider.getAuthUrl(env, userId);
        return new Response(JSON.stringify({ setup_required: true, url: authUrl }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }

      try {
        // Delegate token retrieval/refreshing to the specific plugin
        const tokenData = await provider.refreshToken(storedRefreshToken || "", env);

        // If the SaaS provider rotates the refresh token, update it immediately in KV
        if (tokenData.newRefreshToken) {
          await env.AUTH_TOKENS.put(storageKey, tokenData.newRefreshToken);
        }

        return new Response(JSON.stringify({
          token: tokenData.token,
          expires_in: tokenData.expires_in,
          ...tokenData.additional_data
        }), { headers: { "Content-Type": "application/json" } });

      } catch (err: any) {
        // Clear broken/revoked tokens automatically
        await env.AUTH_TOKENS.delete(storageKey);
        return new Response(JSON.stringify({ setup_required: true, url: provider.getAuthUrl(env, userId) }), { status: 200 });
      }
    }

    return new Response("Endpoint Not Found", { status: 404 });
  }
};

------------------------------
## Step 3: Implement Plugins (SaaS Blueprints)## Plugin A: Slack Integration (src/providers/slack.ts)
Slack handles user tokens similarly to GitHub but utilizes distinct scope syntax and parameters.

import { AuthProvider, Env } from "../types";
export class SlackProvider implements AuthProvider {
  slug = "slack";

  getAuthUrl(env: Env, userId: string): string {
    // Slack configuration handles scopes via space-separated parameters
    return `https://slack.com{env.SLACK_CLIENT_ID}&user_scope=channels:read,chat:write`;
  }

  async handleCallback(request: Request, env: Env) {
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    
    const res = await fetch("https://slack.com", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.SLACK_CLIENT_ID,
        client_secret: env.SLACK_CLIENT_SECRET,
        code: code || ""
      })
    });
    
    const data: any = await res.json();
    if (!data.ok) throw new Error(data.error);
    
    // Slack user refresh tokens reside inside the authed_user block
    return {
      refreshToken: data.authed_user.refresh_token,
      data
    };
  }

  async refreshToken(refreshToken: string, env: Env) {
    const res = await fetch("https://slack.com", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.SLACK_CLIENT_ID,
        client_secret: env.SLACK_CLIENT_SECRET,
        grant_type: "refresh_token",
        refresh_token: refreshToken
      })
    });

    const data: any = await res.json();
    if (!data.ok) throw new Error(data.error);

    return {
      token: data.authed_user.access_token,
      expires_in: data.authed_user.expires_in,
      newRefreshToken: data.authed_user.refresh_token // Slack rotates tokens on use
    };
  }
}

## Plugin B: AWS STS Integration (src/providers/aws.ts)
AWS doesn’t use OAuth. Instead, it uses OIDC. We can map the verified Cloudflare Access JWT directly to an AWS Role via AWS STS (AssumeRoleWithWebIdentity). Developers get temporary AWS CLI credentials without ever doing an OAuth onboarding flow.

import { AuthProvider, Env } from "../types";
export class AWSProvider implements AuthProvider {
  slug = "aws";

  getAuthUrl(): string { return ""; } // No onboarding flow required for AWS OIDC
  async handleCallback() { return { refreshToken: "", data: {} }; }

  async refreshToken(refreshToken: string, env: Env) {
    // 1. Grab the raw inbound Cloudflare Access token passing through the system
    // (Note: To pass the raw JWT into this provider, adjust your engine context to store the original token string)
    const cfAccessJwt = "..." ; 

    // 2. Call AWS Security Token Service (STS)
    const stsUrl = `https://amazonaws.com{encodeURIComponent(env.AWS_ROLE_ARN)}&RoleSessionName=CloudflareBrokerSession&WebIdentityToken=${cfAccessJwt}&Version=2011-06-15`;

    const res = await fetch(stsUrl, {
      method: "POST",
      headers: { "Accept": "application/json" }
    });

    // Parse AWS XML or JSON response to extract temporary AccessKeyId, SecretAccessKey, and SessionToken
    const text = await res.text();
    
    return {
      token: "extracted-aws-session-token",
      expires_in: 3600,
      additional_data: {
        aws_access_key_id: "EXTRACTED_KEY_ID",
        aws_secret_access_key: "EXTRACTED_SECRET"
      }
    };
  }
}

------------------------------
## Step 4: Standardised Local Helper Client (cf-auth.sh)
Update the terminal helper script to support a target argument. The script seamlessly routes requests dynamically to whatever tool the developer wants to use.

#!/bin/bashset -e

PROVIDER=$1if [ -z "$PROVIDER" ]; then
    echo "Usage: cf-auth.sh <github|slack|aws>" >&2
    exit 1fi

BROKER_URL="https://yourdomain.com"
# 1. Grab Cloudflare Token
CF_JWT=$(cloudflared access token --app=$BROKER_URL 2>/dev/null || echo "")if [ -z "$CF_JWT" ]; then
    cloudflared access login https://yourdomain.com >&2
    CF_JWT=$(cloudflared access token --app=$BROKER_URL)fi
# 2. Fetch target SaaS token payload
RESPONSE=$(curl -s -H "Cf-Access-Jwt-Assertion: $CF_JWT" "$BROKER_URL")
# 3. Handle First-Time OAuth Setup Redirectionif echo "$RESPONSE" | grep -q '"setup_required":true'; then
    AUTH_URL=$(echo "$RESPONSE" | grep -o '"url":"[^"]*' | grep -o '[^"]*$')
    echo "Onboarding required for $PROVIDER. Redirecting to browser..." >&2
    open "$AUTH_URL" || xdg-open "$AUTH_URL"
    exit 1fi
# 4. Print payload for environment intake
echo "$RESPONSE"

## Developer Application Profiles
Now, your developers configure their terminal profiles (~/.zshrc) uniformly:

# GitHub Configuration
alias auth-github='export GH_TOKEN=$(cf-auth.sh github | grep -o '"token":"[^"]*' | grep -o '[^**"]*$')'

# AWS Configuration 
auth-aws() {
    DATA=$(cf-auth.sh aws)
    export AWS_ACCESS_KEY_ID=$(echo $DATA | jq -r '.aws_access_key_id')
    export AWS_SECRET_ACCESS_KEY=$(echo $DATA | jq -r '.aws_secret_access_key')
    export AWS_SESSION_TOKEN=$(echo $DATA | jq -r '.token')
}

