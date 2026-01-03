# Authentication Flow Documentation

This document outlines the authentication mechanisms and flow supported by the Cursor API, as observed during interoperability research.

## Overview

The Cursor API supports multiple authentication methods to interact with backend services (`api2.cursor.sh`, `agent.api5.cursor.sh`, etc.). Authentication is primarily token-based (JWT), managed through access and refresh tokens.

## Authentication Methods

The following primary ways to authenticate have been identified:

### 1. Interactive Login
*   **Mechanism**: Browser-based OAuth flow with PKCE.
*   **Flow**:
    1.  Generate a login URL and open the browser.
    2.  User completes authentication in the browser.
    3.  Poll for the authentication result.
    4.  Store the received access and refresh tokens.
    5.  Initialize user settings and privacy preferences.

### 2. API Key Authentication
*   **Usage**: Providing an API key directly.
*   **Mechanism**: Exchanges the API key for access/refresh tokens.
*   **Implementation logic**:
    ```typescript
    const authResult = await exchangeApiKeyForTokens(apiKey);
    await storeAuthentication(
        authResult.accessToken, 
        authResult.refreshToken, 
        apiKey
    );
    ```

### 3. Direct Auth Token
*   **Usage**: Providing a direct JWT token.
*   **Mechanism**: Bypasses the login flow; uses the provided JWT directly for requests.
*   **Use Case**: Automated environments, CI/CD pipelines, or debugging scenarios.

### 4. Development Login
*   **Mechanism**: Fetches a development session token from a specialized endpoint (e.g., `/auth/cursor_dev_session_token`).
*   **Use Case**: Internal testing and local development environments.

## Token Management

### Token Structure
*   **Access Token**: A JWT containing user identity claims and expiration timestamps.
*   **Refresh Token**: Used to obtain new access tokens when the current one expires.

### Refresh Logic
Tokens are typically validated before requests:

1.  **Expiration Check**: Decodes the JWT payload to check the `exp` claim against the current time.
2.  **Auto-Refresh**: If a token is near expiration (e.g., within 5 minutes), the refresh token is used to obtain a new access token via the `/auth/refresh` endpoint.

## Request Interceptor

Requests to the API are expected to include several specific headers:

| Header | Description |
|--------|-------------|
| `Authorization` | `Bearer <token>` |
| `x-ghost-mode` | Privacy setting (e.g., `"true"` or `"false"`) |
| `x-cursor-client-version` | Client identifier string |
| `x-cursor-client-type` | Client type identifier (typically `"cli"`) |
| `x-request-id` | A unique UUID for each request |

## Privacy and Endpoint Selection

The API routing can change based on the user's privacy settings:

*   **Default API**: `https://api2.cursor.sh`
*   **Specialized Backends**: Privacy-sensitive operations may be routed to specific endpoints like `agent.api5.cursor.sh` or `agentn.api5.cursor.sh` depending on whether data storage/training is opted into.

## Environment Variables

The following environment variables are commonly used to configure authentication:

| Variable | Description |
|----------|-------------|
| `CURSOR_API_KEY` | API key for authentication |
| `CURSOR_AUTH_TOKEN` | Direct JWT token for authentication |
| `CURSOR_API_ENDPOINT` | Override default API endpoint |
| `CURSOR_PRIVACY_CACHE_MAX_AGE_MS` | TTL for cached privacy settings |
