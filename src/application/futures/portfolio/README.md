# `application/futures/portfolio/`

Skeleton for the future **Portfolio Manager** application module.

## Responsibilities (planned)
- Implement `PortfolioManagerPort.getExposure()` and `getPnLByStrategy()`.
- Track per-strategy and per-symbol exposure derived from the paper-trading engine + (future) live order manager.
- Emit `PORTFOLIO_SNAPSHOT` events at a fixed cadence (default 1 s) to subscribed clients.

## Boundaries
- Read-only over the trading engine state. Never mutates positions.
- Aggregates across symbols, so runs on the main thread.

## Status
Not implemented. See [PortfolioManagerPort.js](../../../domain/futures/ports/inbound/PortfolioManagerPort.js).
