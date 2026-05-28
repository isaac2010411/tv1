# `application/futures/risk/`

Skeleton for the future **Risk Manager** application module.

## Responsibilities (planned)
- Implement `RiskGuardPort.evaluate(order, portfolio)` to gate orders before they reach the order manager.
- Aggregate risk policies (per-symbol notional caps, per-strategy DD limits, global exposure ceiling, kill-switch).
- Emit `RISK_DECISION` events through the realtime layer when a candidate order is blocked or reduced.

## Boundaries
- Pure application logic. No direct Binance / Mongoose access; consume them via outbound ports.
- Runs on the **main thread** (synchronous with order submission), never on worker threads.
- Stateless from the caller's perspective; persistence (if any) lives behind a `RiskPolicyRepositoryPort`.

## Status
Not implemented. This directory exists only to anchor the contract — see [RiskGuardPort.js](../../../domain/futures/ports/inbound/RiskGuardPort.js).
