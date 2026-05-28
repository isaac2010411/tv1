# `application/futures/orders/`

Skeleton for the future **Order Manager** application module.

## Responsibilities (planned)
- Implement `OrderManagerPort.submit / cancel / getOpen`.
- Mediate between strategy signals and the exchange (or paper engine) order placement.
- Emit `ORDER_LIFECYCLE` events for every state transition (NEW → PARTIAL → FILLED → CANCELED → REJECTED).
- Cooperate with the Risk Manager: every `submit()` first calls `RiskGuardPort.evaluate()`.

## Boundaries
- Owns the live order book *of our orders* (not the market order book).
- Persists order lifecycle through an outbound `OrderRepositoryPort` (to be defined).

## Status
Not implemented. See [OrderManagerPort.js](../../../domain/futures/ports/inbound/OrderManagerPort.js).
