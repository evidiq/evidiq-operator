---
name: EVIDIQ Operator
version: 1.0.0
description: Computer Use Infrastructure for AI agents — drive a real browser from natural language via x402 USDT0 on X Layer.
category: Automation
provider: EVIDIQ
provider_url: https://evidiq.dev
license: MIT
---

# EVIDIQ Operator MCP

![EVIDIQ Operator — computer use infrastructure visual](https://evidiq.dev/docs/operator-hero.png)

**Reason. Execute. Return.**

[Read the full EVIDIQ Operator documentation](https://evidiq.dev/docs/operator) for quickstart, tool reference, the agent loop, and pricing.

EVIDIQ Operator lets an AI agent drive a real Chromium browser on dedicated Linux desktop infrastructure. Submit a natural-language task and GPT-5.6-Terra (via 0G Compute) plans each action from screenshots. The agent never runs browser code itself — it only describes the next action, and Operator executes it via Playwright.

## Supported Inputs

- **Natural-language tasks** ("log in and download the latest invoice")
- **Login + extraction goals** (credentials supplied by the caller)
- **Form fills** (field-label → value pairs)
- **Direct document downloads** (`https://...`)
- **Ordered multi-step workflows** (up to 10 steps)

## Paid Tools (0.02 USDT0 per call — `X402_PRICE=20000`)

| Tool | Purpose |
|------|---------|
| `browser_task` | Natural-language browser task — LLM plans + executes each step |
| `login_and_extract` | Log in to a site and extract data from the logged-in page |
| `fill_form` | Fill and (optionally) submit a form |
| `download_document` | Download a file from a URL via the browser runtime |
| `navigate` | Open a URL and return a screenshot |
| `screenshot` | Single snapshot of the current browser state |
| `multi_step_workflow` | Run an ordered chain of step descriptions |

## Free Tools

| Tool | Purpose |
|------|---------|
| `health` | Service status + browser pool telemetry + 0G/AI config |
| `capabilities` | Full tool catalog with costs and descriptions |
| `supported_targets` | Categories of sites/workflows Operator can drive, plus limits |
| `estimate_cost` | Exact atomic and human-readable price for a paid tool |

## How a task runs

1. Agent calls a paid tool with a natural-language goal.
2. Operator spawns (or reuses) a dedicated Chromium sandbox.
3. GPT-5.6-Terra (via 0G Compute) receives a screenshot + the task.
4. The LLM returns a single structured action: `click`, `type`, `scroll`, `navigate`, `extract`, or `done`.
5. Operator executes the action on the sandbox via Playwright.
6. Repeat until `done` or the step budget is reached (default 20).
7. Return: summary + step log + extracted data + optional 0G Storage anchor.

## Result contract

Every completed paid call returns structured JSON:

- `task` (the submitted goal)
- `success` (boolean)
- `steps` (number of actions taken)
- `summary` (final human-readable outcome)
- `extractedData` (optional structured result)
- `stepLog` (ordered action trace)
- `storageRoot` / `storageTx` (0G Storage best-effort anchor, when configured)
- `error` (present only on failure)

Operator produces **structured results, not guarantees**. A screenshot proves the browser reached a state — it does not vouch for the website's correctness. Failed calls (browser runtime error) are not settled.

## Limitations

- No CAPTCHA solving (returns `done` with a note).
- No 2FA SMS/OTP autofill (the caller supplies any code).
- Heavy SPAs may need extra steps (max 20 per call, 10 per workflow chain).

## Pricing

- **Per paid tool call**: `20000` atomic (`X402_PRICE=20000`) = **0.02 USDT0** on X Layer (`eip155:196`, chain `196`).
- Flat pricing: all seven paid browser tools cost `0.02` regardless of complexity.
- Token: `USDT0` (`0x779ded0c9e1022225f8e0630b35a9b54be713736`, 6 decimals).
- EIP-712 token domain: `{ name: "USD₮0", version: "1" }`.
- Free tools (`health`, `capabilities`, `supported_targets`, `estimate_cost`) are always `HTTP 200` and never gated.

## Usage Example

```bash
# Free: capabilities and pricing discovery
curl https://mcp.evidiq.dev/operator/x402 | python3 -m json.tool

# Paid: run a browser task (requires PAYMENT-SIGNATURE header with x402 v2 envelope)
curl -X POST https://mcp.evidiq.dev/operator/mcp \
  -H "content-type: application/json" \
  -H "accept: application/json" \
  -d '{"jsonrpc":"2.0","id":"1","method":"tools/call","params":{"name":"navigate","arguments":{"url":"https://example.com"}}}'

# Expected: 402 challenge with amount: "20000", x402Version: 2, scheme: "exact"
```

## Paying from your agent (x402 v2)

1. An unpaid call to a paid tool returns **HTTP 402** with `accepts[]` payment requirements.
2. Sign an EIP-3009 `transferWithAuthorization` (gasless for the payer) over the requested USDT0 amount.
3. Retry with a base64 `PAYMENT-SIGNATURE` header carrying `{ x402Version: 2, accepted, payload: { signature, authorization } }`.
4. Operator verifies + settles, then executes and returns the result with a `payment-response` header.

## Endpoints (public)

- Documentation: `https://evidiq.dev/docs/operator`
- Health: `GET https://mcp.evidiq.dev/operator/health`
- Skill (this document): `GET https://mcp.evidiq.dev/operator/skill.md`
- MCP: `POST https://mcp.evidiq.dev/operator/mcp`
- x402 discovery: `GET https://mcp.evidiq.dev/operator/x402`

## References

- EVIDIQ family repos: `github.com/evidiq/evidiq`, `github.com/evidiq/evidiq-notary-mcp`, `github.com/evidiq/evidiq-sentinel-mcp`
- Open Skill format: `SKILL.md`

## Version

`v1.0.0` — MIT © 2026 EVIDIQ — OKX.AI Agent #6504.
