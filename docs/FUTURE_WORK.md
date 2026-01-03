# Future Work & Roadmap

This document outlines planned improvements and potential future directions for the OpenCode Cursor Auth project.

## Status Legend
- **Planned** - Documented and prioritized
- **In Progress** - Actively being worked on
- **Blocked** - Waiting on external dependency or more research
- **Completed** - Done and merged

---

## High Priority

### 1. Error Handling & Resilience
**Status**: Partially Completed  
**Priority**: High

- [x] Implement retry logic with exponential backoff for transient failures (implemented in `login.ts` with 1.2x multiplier, max 10s delay)
- [ ] Better error messages for common auth issues (basic messages exist, needs user-friendly improvements)
- [ ] Graceful degradation when Cursor API is unavailable
- [ ] Connection pooling for better performance

### 2. Streaming Reliability
**Status**: Partially Completed  
**Priority**: High

- [x] Implement heartbeat monitoring to detect stale streams (implemented in `agent-service.ts` with idle detection)
- [x] Add timeout handling for long-running requests (120s timeout implemented)
- [ ] Detect and recover from dropped SSE connections (timeout exists but no automatic recovery)
- [ ] Better handling of network interruptions (basic error handling exists, needs improvement)

### 3. Token Management
**Status**: Partially Completed  
**Priority**: High

- [x] Proactive token refresh before expiration (implemented via `isTokenExpiringSoon()` check in `helpers.ts`, refreshes when <5min remaining)
- [x] Automatic re-authentication when tokens become invalid (`getValidAccessToken()` handles refresh automatically)
- [ ] Better handling of concurrent requests during token refresh (not explicitly synchronized)
- [ ] Support for token rotation

---

## Medium Priority

### 4. Session Reuse
**Status**: ❌ Not Feasible (Architectural Limitation)  
**Priority**: Deprioritized

**Conclusion**: True session reuse across OpenAI API requests is **not possible** due to a fundamental architectural mismatch between OpenAI's request/response model and Cursor's bidirectional streaming.

**The Problem**:
- OpenAI API must close HTTP response to return `tool_calls` to client
- Client sends new HTTP request with tool results
- This breaks the continuous streaming context that Cursor's `bidiAppend` relies on
- BidiAppend sends tool results successfully, server acknowledges, but doesn't continue generating

**Current Workaround** (implemented and working):
- When tool results arrive, close old session and start fresh request
- `messagesToPrompt()` formats full conversation history (including tool calls/results)
- Server processes as new conversation with complete context
- Works reliably but incurs ~3-6s bootstrap per continuation

**What Was Tried**:
- [x] BidiAppend with tool results → Server only sends heartbeats
- [x] ResumeAction after tool results → No effect
- [x] Various header combinations → No change
- [x] KV blob extraction → Works for response extraction, not continuation

**Why We Stopped Investigating**:
- Fundamental API model mismatch cannot be bridged without protocol changes
- Fresh-request-with-history approach works reliably
- Time better spent on other improvements

**Future Possibility**: Could become feasible if Cursor adds stateless tool result injection API or if we discover undocumented protocol elements.

**Reference**: See `docs/SESSION_REUSE_IMPLEMENTATION.md` and `src/lib/session-reuse.ts` for full analysis.

### 5. MCP (Model Context Protocol) Support
**Status**: Planned  
**Priority**: Medium

- [ ] Full MCP tool passthrough
- [ ] MCP tool result formatting
- [ ] Custom MCP server integration
- [ ] MCP tool discovery

### 6. Multi-Model Support
**Status**: Planned  
**Priority**: Medium

- [ ] Model capability detection (streaming, tools, vision)
- [ ] Model-specific parameter normalization
- [ ] Better model alias resolution
- [ ] Model availability monitoring

---

## Low Priority

### 7. Performance Optimization
**Status**: In Progress  
**Priority**: Low

- [x] Timing instrumentation for request phases (message build, SSE connection, BidiAppend, first chunk/text/tool, turn ended)
- [x] Performance logging via `CURSOR_TIMING=1` environment variable
- [ ] Request batching for multiple concurrent calls
- [ ] Response caching for identical requests
- [ ] Connection keep-alive optimization
- [ ] Memory usage profiling and optimization

**Timing metrics available** (enable with `CURSOR_TIMING=1`):
```
[TIMING] ═══════════════════════════════════════════════════════
[TIMING] Request Performance Summary
[TIMING] ───────────────────────────────────────────────────────
[TIMING]   Message build:     Xms
[TIMING]   SSE connection:    Xms  
[TIMING]   First BidiAppend:  Xms
[TIMING]   First chunk:       Xms
[TIMING]   First text:        Xms
[TIMING]   First tool call:   Xms
[TIMING]   Turn ended:        Xms
[TIMING]   Total:             Xms
[TIMING] ═══════════════════════════════════════════════════════
```

### 8. Observability
**Status**: Planned  
**Priority**: Low

- [ ] Structured logging with configurable levels
- [ ] Request/response metrics (latency, error rates)
- [ ] OpenTelemetry integration for tracing
- [ ] Dashboard for monitoring proxy health

### 9. Configuration Management
**Status**: Planned  
**Priority**: Low

- [ ] Configuration file support (opencode.json / .cursorrc)
- [ ] Environment-specific configurations
- [ ] Runtime configuration reload
- [ ] Configuration validation

### 10. Additional API Endpoints
**Status**: Planned  
**Priority**: Low

- [ ] `/v1/embeddings` - Text embeddings (if supported by Cursor)
- [ ] `/v1/audio/transcriptions` - Speech-to-text (if available)
- [ ] `/v1/images/generations` - Image generation (if available)
- [ ] Custom endpoints for Cursor-specific features

---

## Research & Exploration

### Understanding Cursor's Architecture
**Status**: Largely Complete

Key findings documented in `docs/SESSION_REUSE_IMPLEMENTATION.md`:
- [x] Why BidiAppend doesn't trigger continuation (API model mismatch)
- [x] How Cursor CLI maintains continuous streams (not replicable with OpenAI compat)
- [x] Role of KV blobs in response storage
- [ ] Checkpoint role in conversation state (low priority)

### Native Cursor Provider for OpenCode
**Status**: Exploratory  
**Priority**: Long-term

A native Cursor provider in OpenCode would provide the fastest possible integration by eliminating the OpenAI compatibility layer.

**Benefits**:
- Direct streaming without format translation
- Native tool calling with Cursor's exec/MCP system
- Zero protocol overhead
- Full access to Cursor-specific features (thinking mode, checkpoints, etc.)

**Challenges**:
- Requires changes to OpenCode core
- Would need to maintain provider alongside OpenAI-compat layer
- Cursor's protocol may change frequently

**Prerequisites**:
- [ ] Document full Cursor Agent API protocol (largely done in `CURSOR_API.md`)
- [ ] Understand remaining protobuf message types
- [ ] Implement provider interface for OpenCode
- [ ] Add Cursor-specific tool definitions

### Alternative Approaches
**Status**: Exploratory

- [ ] Direct WebSocket connection to Cursor (bypass gRPC-Web)
- [ ] Custom Cursor CLI wrapper instead of API reverse-engineering
- [ ] Integration with Cursor's VS Code extension protocol
- [ ] Browser-based proxy using Cursor web interface

---

## Technical Debt

### Code Quality
- [ ] Remove unused variables (linting warnings)
- [ ] Fix test mock types (session-reuse.test.ts)
- [ ] Document all public APIs
- [ ] Add JSDoc comments to core functions

### Testing
- [ ] Increase test coverage for edge cases
- [ ] Add integration tests with mock Cursor API
- [ ] End-to-end tests with real Cursor API (CI/CD)
- [ ] Performance benchmarks

### Documentation
- [x] Comprehensive README
- [x] Architecture documentation
- [x] API reference
- [ ] Contribution guidelines
- [ ] Deployment guides

---

## Breaking Changes Consideration

Future versions may include breaking changes. Potential areas:

1. **API Surface**: Tool call ID format may change
2. **Configuration**: Environment variable names may be standardized
3. **Authentication**: May move to a more secure credential storage
4. **Protocol**: May adopt different protobuf versions

---

## How to Contribute

Interested in helping? Here's how:

1. **Pick an issue**: Check the GitHub issues for `good first issue` or `help wanted` labels
2. **Research**: For blocked items, research and document findings
3. **Test**: Help improve test coverage
4. **Document**: Improve documentation and examples

---

## Version History

### v0.1.0 (Current)
- Initial release
- OpenAI-compatible proxy server
- Full tool calling support
- Model listing and resolution
- Basic authentication

### v0.2.0 (Planned)
- Improved error handling
- Better token management
- Performance optimizations

### v1.0.0 (Future)
- Stable API
- Production-ready reliability
- Comprehensive documentation
