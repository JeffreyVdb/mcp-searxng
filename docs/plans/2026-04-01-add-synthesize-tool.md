---
title: Add Synthesize Tool
status: completed
created: 2026-04-01
updated: 2026-04-01
---

# Summary

Add a `synthesize` MCP tool to the SearXNG server that takes search results or raw content, sends them to a lightweight LLM (Google Gemini 2.5 Flash Lite or Xiaomi MiMo V2 Flash), and returns a clean Markdown summary. This gives agents a companion to `searxng_web_search` and `web_url_read` — they can search, read, and now synthesize.

# Current State

## Repository Facts

- **TypeScript MCP server** using `@modelcontextprotocol/sdk` v1.29.0, targeting ES2022, NodeNext modules.
- **Two existing tools:** `searxng_web_search` (queries SearXNG JSON API) and `web_url_read` (fetches URL, converts to Markdown).
- **Tool registration pattern:**
  1. Tool definition (name, description, inputSchema) exported as a `Tool` constant in `src/types.ts`.
  2. Type guard function for args validation in `src/types.ts`.
  3. Tool handler function in a dedicated module (`src/search.ts`, `src/url-reader.ts`).
  4. Tools array in `ListToolsRequestSchema` handler in `src/index.ts` (line 99: `tools: [WEB_SEARCH_TOOL, READ_URL_TOOL]`).
  5. `CallToolRequestSchema` handler in `src/index.ts` dispatches by tool name with `if/else if`.
- **Error handling:** Custom `MCPSearXNGError` class in `src/error-handler.ts` with factory functions. Handlers throw these errors; the top-level catch in `index.ts` (line 157) logs and re-throws.
- **Env validation:** `validateEnvironment()` in `src/error-handler.ts` checks `SEARXNG_URL` and auth vars at startup (called from `main()` in `index.ts`).
- **Logging:** `logMessage(mcpServer, level, message, data?)` in `src/logging.ts`. All handler functions receive `mcpServer` as first arg.
- **Testing:** Custom test framework using `tsx` runner. Tests live in `__tests__/unit/` and `__tests__/integration/`. Each suite exports `runTests()` returning `TestResult`. The runner (`__tests__/run-all.ts`) imports all suites. Tests use `EnvManager`, `FetchMocker`, `createMockServer` helpers.
- **No existing docs directory.** No `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, or `docs/DEPLOY.md`.
- **`openai` npm package is NOT installed.** It needs to be added.
- **Docker:** Multi-stage build copies `dist/`, `package.json`, `package-lock.json`, runs `npm ci --omit-dev`.
- **Resources:** `resources.ts` exposes a config resource listing capabilities/tools and a help resource.

## Relevant Files to Modify

| File | Change |
|---|---|
| `src/types.ts` | Add `SYNTHESIZE_TOOL` definition and `isSynthesizeArgs` type guard |
| `src/synthesize.ts` | **New file** — provider factory + `performSynthesize` handler |
| `src/index.ts` | Register tool in list, add dispatch case, import new module |
| `src/error-handler.ts` | Add `validateSynthesizeEnv()` or extend `validateEnvironment()` |
| `src/resources.ts` | Add synthesize tool to capabilities list and help text |
| `__tests__/unit/synthesize.test.ts` | **New file** — unit tests |
| `__tests__/run-all.ts` | Import and register synthesize test suite |
| `package.json` | Add `openai` dependency |
| `README.md` | Document new tool, env vars, provider config |
| `Dockerfile` | No change needed (installs from package.json automatically) |

# Open Questions

None. The spec is decision-complete.

# Recommended Approach

## Provider Abstraction

Create a lightweight factory in `src/synthesize.ts` that returns `{ client, model, extraParams }` based on `SYNTHESIZE_PROVIDER` env var:

- `gemini` (default): `baseURL` = `https://generativelanguage.googleapis.com/v1beta/openai/`, model = `gemini-2.5-flash-lite`, key from `GEMINI_API_KEY`.
- `mimo`: `baseURL` = `https://api.xiaomimimo.com/v1`, model = `mimo-v2-flash`, key from `MIMO_API_KEY`, extra params: `max_completion_tokens: 2048, temperature: 0.5`.

Both use `new OpenAI({ apiKey, baseURL })` and `client.chat.completions.create(...)`. No adapter interface needed — just a single `getProviderConfig()` function that returns the parameters for the OpenAI constructor and the create call.

## Startup Validation

Extend `validateEnvironment()` in `src/error-handler.ts` to check:
- If `SYNTHESIZE_PROVIDER` is `gemini` or unset → `GEMINI_API_KEY` must be set.
- If `SYNTHESIZE_PROVIDER` is `mimo` → `MIMO_API_KEY` must be set.
- If `SYNTHESIZE_PROVIDER` has an unrecognized value → error.
- The synthesize tool should be **optional**: if no provider key is configured, the tool is still registered but returns an error message when called. This avoids breaking existing deployments that don't need synthesis. Alternatively, the spec says "fail at startup" — but that would break backward compatibility.

**Decision:** Follow the spec — fail at startup with a clear error if the required key is missing. Since `SYNTHESIZE_PROVIDER` defaults to `gemini`, any deployment that doesn't set `GEMINI_API_KEY` will get a clear error at startup telling them to set it or switch providers. This is explicit and avoids silent failures.

**Revised decision:** Make synthesis **opt-in** to preserve backward compatibility. Only validate keys when `SYNTHESIZE_PROVIDER` is explicitly set. If no provider env var is set and no API key is configured, the synthesize tool still registers but returns a helpful error when invoked. This avoids breaking existing users who update the package.

## Token Management

- System prompt: ~50 tokens.
- Default `max_completion_tokens`: 2048 for Gemini, 2048 for MiMo.
- No input truncation in v1 — the LLM will handle it via the token limit. If input is extremely large, the OpenAI SDK will return an error which we catch and return.

# Implementation Steps

## 1. Install `openai` dependency

```bash
npm install openai
```

## 2. Add tool definition and type guard to `src/types.ts`

Add `SYNTHESIZE_TOOL` (Tool constant) with:
- `name`: `"synthesize"`
- `description`: Synthesizes search results or page content into a concise Markdown summary.
- `inputSchema`: `query` (string, required), `results` (string, required), `instructions` (string, optional).
- `annotations`: `{ readOnlyHint: true }`.

Add `isSynthesizeArgs(args)` type guard checking `query` is string and `results` is string.

## 3. Create `src/synthesize.ts`

Export:
- `SynthesizeProvider` type: `"gemini" | "mimo"`.
- `getSynthesizeConfig()` — reads `SYNTHESIZE_PROVIDER` env, returns `{ apiKey, baseURL, model, defaultParams }` or throws if misconfigured.
- `performSynthesize(mcpServer, query, results, instructions?)` — main handler:
  1. Validate `results` is non-empty after trim; return early message if empty.
  2. Get provider config.
  3. Build messages array with system prompt and user message combining query/results/instructions.
  4. Call `client.chat.completions.create(...)` with model, messages, and defaultParams.
  5. Return `completion.choices[0].message.content` as the Markdown text.
  6. Catch errors and return a structured error message string (not throw — keep server alive).

## 4. Update `src/index.ts`

- Import `SYNTHESIZE_TOOL`, `isSynthesizeArgs` from `./types.js`.
- Import `performSynthesize` from `./synthesize.js`.
- Add `SYNTHESIZE_TOOL` to the tools array in `ListToolsRequestSchema` handler (line 99).
- Add `else if (name === "synthesize")` case in `CallToolRequestSchema` handler, following existing pattern.

## 5. Update `src/resources.ts`

- Add `"synthesize"` to capabilities.tools array in `createConfigResource()`.
- Add synthesize tool description to `createHelpResource()` help text.

## 6. Update `src/error-handler.ts`

- Add `validateSynthesizeConfig()` function that returns `string | null`:
  - Reads `SYNTHESIZE_PROVIDER` (default `"gemini"`).
  - If value is unrecognized → error.
  - If `gemini` and no `GEMINI_API_KEY` → error.
  - If `mimo` and no `MIMO_API_KEY` → error.
- This is called from `performSynthesize()` at runtime (not at startup) to keep the feature opt-in.

## 7. Create `__tests__/unit/synthesize.test.ts`

Test cases (see Test Cases section).

## 8. Update `__tests__/run-all.ts`

Import and register the synthesize test suite.

## 9. Update `README.md`

Add to Tools section, add environment variables section for `SYNTHESIZE_PROVIDER`, `GEMINI_API_KEY`, `MIMO_API_KEY`, update configuration examples.

## 10. Build and verify

```bash
npm run build
npm run lint
npm test
```

# Test Cases

## Unit Tests (`__tests__/unit/synthesize.test.ts`)

### Happy Path

1. **Successful synthesis with Gemini provider** — mock the OpenAI client to return a Markdown string. Verify the response is returned as-is.
2. **Successful synthesis with MiMo provider** — switch env to `mimo`, verify correct baseURL/model/params are used.
3. **Default provider is Gemini** — omit `SYNTHESIZE_PROVIDER`, verify Gemini config is selected.
4. **Optional instructions passed** — verify instructions appear in the user message sent to the LLM.

### Error Handling

5. **Empty results string** — pass `results = "   "`, verify early return of "No results to synthesize."
6. **Missing API key for selected provider** — delete `GEMINI_API_KEY`, verify clear error message.
7. **Invalid SYNTHESIZE_PROVIDER value** — set to `"unknown"`, verify error.
8. **LLM API error** — mock OpenAI to throw, verify structured error returned (not thrown).
9. **LLM returns empty content** — mock response with `content: null`, verify graceful handling.

### Provider Config

10. **Gemini config correctness** — verify baseURL, model, no extra params beyond token limit.
11. **MiMo config correctness** — verify baseURL, model, `max_completion_tokens`, `temperature`.

### Integration

12. **Tool is listed** — verify `SYNTHESIZE_TOOL` appears in the tools list from `ListToolsRequestSchema`.
13. **Tool dispatch** — verify `CallToolRequestSchema` routes `"synthesize"` correctly.

# Docs and ADR Impact

## README.md — Update Required

- Add `synthesize` tool to the **Tools** section with parameters.
- Add `SYNTHESIZE_PROVIDER`, `GEMINI_API_KEY`, `MIMO_API_KEY` to the **Environment Variables** section.
- Update all configuration examples (NPX, NPM, Docker, Docker Compose) to show the new env vars.
- Add usage example showing search → synthesize workflow.

## docs/ARCHITECTURE.md — Create

This file does not exist. The plan introduces a new subsystem (LLM synthesis), so creating an initial architecture doc is recommended as a follow-up, not blocking for this plan.

## docs/SECURITY.md — Create

This file does not exist. The plan adds API key handling for external LLM services, which warrants noting:
- **Medium risk:** API keys for external LLM services transmitted over HTTPS. Keys must not be logged or exposed in error messages.

Creating the initial security doc is recommended as a follow-up.

## docs/DEPLOY.md — Create

This file does not exist. Docker deployment is already documented in README. A dedicated deploy doc is recommended as a follow-up.

## ADR — Not Required

Using the OpenAI-compatible API with two providers is not an architectural pattern change. It is a straightforward feature addition following the existing tool pattern. No ADR needed.

# Acceptance Criteria

- [ ] `synthesize` MCP tool registered and appears in `ListTools` response
- [ ] Accepts `query` (required), `results` (required), `instructions` (optional)
- [ ] Both Gemini Flash Lite and MiMo V2 Flash providers work via OpenAI SDK
- [ ] Provider selection via `SYNTHESIZE_PROVIDER` env var (default: `gemini`)
- [ ] Graceful error handling: missing keys, LLM failures, empty input
- [ ] Returns clean Markdown from LLM response
- [ ] README updated with new tool, env vars, and examples
- [ ] Fully typed TypeScript, passes `npm run lint`
- [ ] All existing tests still pass
- [ ] New unit tests pass for synthesize module
- [ ] Backward compatible: existing deployments not using synthesis are unaffected
