/**
 * Fork-owned additions to the channel adapter contract (src/channels/adapter.ts).
 *
 * - `InboundRouteResult`: what routeInbound reports back to the adapter, so
 *   ACK-aware adapters (Band) can confirm durable persistence before emitting
 *   platform-level processed markers. Re-exported from adapter.ts.
 * - `InboundRouteReturn`: return type of ChannelSetup.onInbound/onInboundEvent.
 * - Optional ChannelAdapter capability flags, added via module augmentation so
 *   the upstream interface body stays untouched.
 */
export type InboundRouteResult =
  | {
      status: 'persisted';
      platformMessageId: string;
      sessionIds: string[];
      sessionMessageIds: string[];
    }
  | {
      status: 'dropped';
      platformMessageId: string;
      reason: string;
      audited: boolean;
      retryable: boolean;
      intentional: boolean;
    }
  | {
      status: 'failed';
      platformMessageId: string;
      reason: string;
      retryable: boolean;
    };

export type InboundRouteReturn = void | InboundRouteResult | Promise<void | InboundRouteResult>;

declare module '../channels/adapter.js' {
  interface ChannelAdapter {
    /**
     * Whether this adapter implements delivery ACK semantics.
     *
     * When true, the router writes the inbound_delivery_ledger rows
     * (beginInboundDelivery / markInboundDeliveryDropped /
     * markInboundDeliveryPersisted) so the adapter can use the ledger to
     * confirm durable persistence before emitting platform-level processed
     * markers. Adapters that don't support ACKing skip ledger writes entirely.
     * Default: false.
     */
    supportsDeliveryAck?: boolean;

    /**
     * Whether this adapter needs a graceful stop window for its container
     * teardown work (e.g. Band memory consolidation). When true, the host
     * sweep tags ceiling kills with 'graceful' so stopGraceForReason grants
     * GRACEFUL_STOP_GRACE_SEC (30 min) instead of FAST_STOP_GRACE_SEC (10 s).
     * Default: false.
     */
    needsGracefulStop?: boolean;
  }
}
