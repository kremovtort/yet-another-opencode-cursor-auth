# Authentication Flow Documentation

This document outlines the authentication mechanisms and flow within the restored Cursor CLI codebase.

## Overview

The Cursor CLI supports multiple authentication methods to interact with the Cursor backend services (`api2.cursor.sh`, `repo42.cursor.sh`, etc.). Authentication is primarily token-based (JWT), managed via a `CredentialManager` and enforced through request interceptors.

## Authentication Methods

The CLI supports three primary ways to authenticate:

1.  **Interactive Login**
    *   **Command**: `cursor login`
    *   **Mechanism**: Initiates an interactive login flow (likely browser-based).
    *   **Result**: Retrieves an Access Token and a Refresh Token, which are stored securely by the `CredentialManager`.
    *   **Code Reference**: `src/index.tsx` (Login subcommand).

2.  **API Key**
    *   **Usage**:
        *   CLI Option: `--api-key <key>`
        *   Environment Variable: `CURSOR_API_KEY`
    *   **Mechanism**: The API key is used to obtain or refresh access tokens.
    *   **Code Reference**: `src/auth-refresh.ts` (`refreshTokenWithApiKey`).

3.  **Direct Token**
    *   **Usage**:
        *   CLI Option: `--auth-token <token>`
        *   Environment Variable: `CURSOR_AUTH_TOKEN`
    *   **Mechanism**: Bypasses the login flow and uses the provided JWT directly for requests. useful for CI/CD or debugging.

4.  **Development Login** (Internal/Dev only)
    *   **Command**: `cursor dev-login`
    *   **Options**: `-t, --trial` (Login with free trial account)
    *   **Code Reference**: `src/index.tsx` (Dev Login subcommand).

## Token Management

Token lifecycle is handled primarily in `src/auth-refresh.ts`.

### Token Structure
*   **Access Token**: A JWT containing user identity claims (e.g., `sub` for Auth ID).
*   **Refresh Token**: Used to obtain new access tokens when the current one expires.

### Refresh Logic
The system automatically checks token validity before requests:

1.  **Expiration Check**:
    *   The `isTokenExpiringSoon(token)` function decodes the JWT header (without verifying signature) to check the `exp` claim.
    *   Threshold: Tokens are considered "expiring soon" if they have less than **5 minutes** (300 seconds) remaining.

2.  **Auto-Refresh**:
    *   If a token is expired or expiring soon, `getValidAccessToken` attempts to refresh it.
    *   If an API Key is present, it calls `refreshTokenWithApiKey`, using the `LoginManager` to exchange the key for a new Access/Refresh token pair.
    *   The new tokens are updated in the `CredentialManager`.

## Key Components

### `CredentialManager`
*   **Location**: `../cli-credentials/dist/index.js` (External dependency)
*   **Role**: Abstract storage for sensitive data.
*   **Methods**:
    *   `getAccessToken()`
    *   `getApiKey()`
    *   `setAuthentication(accessToken, refreshToken, apiKey)`

### `UuidRepositoryIdentityProvider`
*   **Location**: `src/index.tsx`
*   **Role**: Determines the identity of the repository owner based on the current authentication.
*   **Logic**:
    *   Retrieves the Access Token.
    *   Extracts the `sub` claim (Auth ID) using `extractAuthId`.
    *   This ID is used to scope repository operations.

### Request Interceptor
*   **Location**: `src/client.ts` / `src/privacy.ts`
*   **Role**: Middleware that attaches the authentication header to outgoing requests.
*   **Format**: `Authorization: Bearer <token>`
*   **Implementation**: 
    *   Calls `getValidAccessToken` ensures a valid token is available before modifying the request headers.
    *   Triggers a background refresh of the privacy cache via `maybeRefreshPrivacyCacheInBackground`.
    *   Sets `x-ghost-mode` header based on the privacy configuration.
    *   Sets `x-cursor-client-version` and `x-cursor-client-type`.
    *   Generates and sets `x-request-id` if not present.

## Usage in Code

To make an authenticated request, the codebase typically constructs a client with an interceptor:

```typescript
// Example from src/client.ts
const authInterceptor = createAuthInterceptor(credentialManager, middleware, {
    baseUrl: endpoint,
    configProvider: configProvider
});

const transport = createConnectTransport({
    baseUrl: endpoint,
    interceptors: [authInterceptor],
    // ...
});
```

This ensures that all RPC calls via `connect-rpc` (or similar transport) automatically carry the user's credentials and adhere to privacy settings.
