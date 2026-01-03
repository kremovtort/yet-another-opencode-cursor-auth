# Architecture and Session Model Comparison

This document explains the architectural differences between standard stateless AI APIs (like OpenAI) and the stateful session model observed in the Cursor Agent API, and how these differences are bridged.

## Stateless Model (Standard API)

The standard AI API model is typically stateless and client-driven.

**Characteristics:**
- **Independence**: Each request is a standalone transaction.
- **Client-Side State**: The client is responsible for maintaining and providing the full conversation history in each request.
- **Synchronous Interaction**: The server responds to a request, and the turn is complete.

## Stateful Model (Agent API)

The Agent API follows a stateful, server-driven session model.

**Characteristics:**
- **Persistent Sessions**: A single connection can span multiple turns of a conversation.
- **Server-Side Context**: The server maintains state information for the duration of the session.
- **Bidirectional Streaming**: Both client and server can exchange messages within the same open stream.
- **Server-Driven Execution**: The server can request actions (such as tool execution) from the client while keeping the session active.

## Architectural Comparison

| Aspect | Standard Stateless | Observed Stateful |
|--------|--------------------|-------------------|
| **Session Model** | Stateless (per-request) | Stateful (persistent) |
| **State Location** | Client holds full history | Server maintains session state |
| **Tool Trigger** | Client receives final response | Server sends intermediate request |
| **Result Delivery** | New request with history | Append to existing session |
| **Turn Boundary** | Explicit (response ends) | Implicit (turn-end signal) |

## Bridging the Mismatch

Interfacing a stateless client with a stateful backend presents several challenges, particularly regarding how tool results are handled.

### Observed Interaction Patterns

When attempting to reuse sessions for tool execution, it has been observed that the backend may transition to an internal state where responses are stored server-side rather than streamed immediately to the client. This behavior is typically optimized for the backend's native clients.

### The Interoperability Solution: Unified Sessions

To ensure reliable communication across all client types, the compatibility layer adopts a **Unified Session** approach:

1.  **Context Injection**: For each new request, the full conversation history is provided to the backend as part of a fresh session.
2.  **Reliable Streaming**: By treating each turn as a new session, the compatibility layer ensures that the backend consistently streams responses, avoiding the complexities of long-lived session state management.
3.  **State Synchronization**: The client continues to own the conversation history, which is the most reliable way to maintain consistency across different tools and environments.

### Trade-offs

| Aspect | Unified Sessions | Persistent Session Reuse |
|--------|------------------|--------------------------|
| **Reliability** | High (Stateless) | Variable (Stateful complexity) |
| **Consistency** | Client-driven | Server-driven |
| **Implementation** | Robust and scalable | Highly protocol-dependent |

**Recommendation**: The Unified Session approach is used by default as it provides the best balance of reliability and compatibility for standard AI clients.
