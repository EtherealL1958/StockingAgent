# AGENTS.md

## Project

This repository implements a TypeScript-based personal A-share research and analysis agent.

The system may support:

- market and financial data retrieval
- technical and fundamental analysis
- stock screening
- forecasting
- backtesting
- portfolio analysis
- risk evaluation

It is an investment research tool, not an autonomous real-money trading system.

The target user has limited capital and prioritizes risk control over speculative returns.

---

## Development Rules

- Keep implementations simple and explicit.
- Prefer readable code over clever abstractions.
- Implement the smallest correct change.
- Do not add unrelated refactors or features.
- Read relevant files in full before broad changes.
- Inspect existing abstractions before adding new ones.
- Inspect library types instead of guessing external APIs.
- Do not remove intentional functionality without asking first.
- Do not add backward-compatibility layers unless required by persisted data, public APIs, or explicit user instruction.
- When the user asks a question, answer it before making implementation changes.

---

## Architecture

Maintain these boundaries:

```text
Agent
  -> decides what information is needed

Tools
  -> expose narrow capabilities

Data Providers
  -> retrieve and normalize external data

Domain / Analysis
  -> calculate deterministic financial results

Risk
  -> enforce hard constraints

LLM
  -> interpret evidence and explain conclusions
```

Do not collapse these responsibilities into prompts.

Prefer one orchestrator with tools over unnecessary multi-agent complexity.

Tools should have narrow, structured inputs and outputs.

Prefer:

```text
get_quote
get_daily_bars
get_financials
calculate_indicators
screen_stocks
run_backtest
evaluate_portfolio
```

Avoid broad tools such as:

```text
analyze_everything_about_stock
```

---

## TypeScript

Use strict TypeScript.

Keep `strict: true`.

Avoid `any`. Use `unknown` for untrusted values and validate before use.

Prefer explicit domain types over generic objects.

Use runtime validation for:

- external API responses
- LLM structured output
- environment variables
- persisted JSON
- tool arguments

Prefer Zod unless the repository already uses another validation library.

Do not use unsafe type assertions to hide invalid external data.

Prefer functions and plain data structures unless classes provide clear value.

---

## Financial Data

Never fabricate:

- prices
- volume
- valuation metrics
- financial statements
- technical indicators
- news
- portfolio values
- target prices

Financial facts must originate from:

1. validated external data
2. persisted user data
3. deterministic calculations

Preserve data source and observation date where practical.

Never treat missing data as zero.

Keep these states distinct:

```text
zero
missing
not applicable
provider error
```

If required data is unavailable, return an incomplete analysis instead of inventing a value.

---

## Data Providers

External financial APIs must be isolated behind provider interfaces.

Agent and domain code must not depend directly on provider SDK response types.

Normalize provider responses at the boundary.

Possible implementations may include:

```text
TushareProvider
EastmoneyProvider
MockMarketDataProvider
```

Do not add silent fallback providers.

Fallback behavior must be explicit and observable.

---

## Deterministic Calculations

Do not use the LLM for calculations that belong in code.

TypeScript must calculate:

- returns
- portfolio weights
- position sizing
- transaction costs
- technical indicators
- volatility
- drawdown
- affordability
- risk limits
- backtest results
- trading calendar behavior

The LLM may interpret these results but must not replace them.

---

## A-Share Rules

Do not assume US-market trading behavior.

Model A-share rules explicitly, including where relevant:

- trading calendars
- minimum order quantities
- exchange and board differences
- price limits
- ST rules
- suspensions
- transaction fees
- settlement constraints

Keep market rules in domain modules, not prompts, UI code, or provider adapters.

Rules that depend on exchange, board, security type, or effective date must be configurable or modeled explicitly.

---

## Small-Capital Constraints

Affordability is a hard constraint.

Before recommending a purchase, calculate:

- available cash
- security price
- minimum executable quantity
- estimated fees
- resulting portfolio weight
- remaining cash

Do not recommend percentage allocations that cannot actually be executed.

A stock may be attractive but unsuitable for the user's capital size.

`NO_TRADE` is a valid result.

---

## Risk

Hard risk rules must be deterministic.

Examples:

```text
max single-stock weight
max industry exposure
minimum cash reserve
maximum acceptable drawdown
```

The LLM may explain risk rules but may not bypass them.

If a proposed action violates a hard constraint, application code must reject or downgrade it.

Do not force the system to produce a buy or sell recommendation.

---

## Forecasting

Do not present forecasts as certain outcomes.

Prefer forecasting:

- trend regime
- volatility regime
- relative strength
- scenario ranges

over exact future prices.

If numerical forecasting is implemented, preserve:

- forecast horizon
- model version
- feature window
- training period
- evaluation period
- evaluation metrics

Do not describe model confidence as the probability of a price increase unless that probability is explicitly modeled and validated.

---

## Technical and Fundamental Analysis

Technical indicators must be calculated in code.

Do not ask the LLM to calculate:

```text
MA
EMA
MACD
RSI
ATR
volatility
drawdown
```

Indicators are evidence, not automatic trading rules.

Fundamental analysis must use retrieved data.

Clearly distinguish:

```text
raw fact
derived metric
model interpretation
```

Prefer industry-relative comparisons where appropriate.

Do not judge a company from one metric alone.

---

## Screening

Natural-language screening must be converted into structured criteria before execution.

Flow:

```text
user request
-> structured criteria
-> schema validation
-> deterministic screener
-> candidate securities
-> optional LLM explanation
```

The LLM must not invent matching securities without executing the screener.

---

## Portfolio

Conversation history is not portfolio state.

Persist portfolio data separately.

Portfolio calculations must be deterministic.

Include where relevant:

- market value
- cost basis
- unrealized P&L
- cash weight
- position weights
- concentration
- industry exposure
- drawdown

---

## Backtesting

Prevent look-ahead bias.

Data used at simulated time `T` must have been available at or before `T`.

Financial statements must respect publication dates.

Model relevant execution constraints where applicable:

- minimum lot size
- transaction fees
- slippage
- suspensions
- price limits

Every backtest should expose its assumptions.

At minimum report:

- total return
- maximum drawdown
- trade count
- benchmark return
- equity curve

Do not evaluate a strategy using return alone.

Prefer comparison against a simple baseline such as buy-and-hold or a relevant broad-market index.

If optimization is introduced, separate training, validation, and test periods.

---

## LLM Output

Prefer structured output for machine-consumed model responses.

Always validate LLM structured output before use.

Flow:

```text
LLM
-> schema validation
-> domain validation
-> application logic
```

Malformed output must fail explicitly or be retried.

Never silently continue with partially parsed output.

---

## Error Handling

External APIs can fail.

Handle:

- timeouts
- rate limits
- invalid symbols
- empty datasets
- provider outages
- schema changes
- missing trading days
- partial responses

Provider failure must never become a financial conclusion.

Example:

```text
PE unavailable
```

must produce:

```text
valuation analysis incomplete
```

not:

```text
stock is cheap
```

---

## Testing

Financial calculations require deterministic tests.

Test at minimum:

- returns
- drawdown
- indicators
- position sizing
- fees
- minimum order constraints
- portfolio weights
- risk rules
- backtest execution

Use fixed fixtures.

Do not call real paid APIs in unit tests.

Mock:

- market data providers
- LLM providers
- news providers

When fixing a financial calculation bug, add a regression test.

Backtest regression tests should cover:

- future-data leakage
- trade timestamps
- insufficient cash
- minimum lot handling
- transaction costs
- suspensions
- empty signals

---

## Dependencies

Before adding a dependency:

- check whether existing code can solve the problem
- inspect package types
- inspect maintenance status
- prefer lightweight packages
- prefer first-class TypeScript support

Do not add a large agent framework only to avoid writing a small orchestration layer.

Treat lockfile changes as code changes.

---

## Security

Never commit:

- API keys
- Tushare tokens
- LLM credentials
- database credentials
- email credentials

Use environment variables or another secret-management mechanism.

Maintain `.env.example` with safe placeholders only.

Never log secrets.

---

## Commands

Use the package manager already selected by the repository.

Do not switch package managers without explicit instruction.

After TypeScript code changes, run the relevant repository scripts, typically:

```bash
npm run typecheck
npm run lint
```

If tests were changed, run the affected tests.

Do not run expensive full test suites or production builds unless needed.

Fix errors introduced by the current change before finishing.

---

## Final Principle

When deciding where logic belongs:

```text
Retrieve facts
-> provider / tool

Calculate financial results
-> domain / analysis

Enforce hard constraints
-> risk / domain

Decide what information is needed
-> agent

Explain evidence
-> LLM
```

Financial correctness and reproducibility take priority over agent complexity.