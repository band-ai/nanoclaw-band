/**
 * Fork-owned inbound route results + delivery-ACK ledger for routeInbound
 * (src/router.ts) and the host's ChannelSetup handlers (src/index.ts).
 *
 * routeInbound opens an InboundRoute before the pre-route interceptors run.
 * That applies the receiving adapter's thread policy up front (interceptors
 * see the thread-collapsed event) and, for adapters with
 * `supportsDeliveryAck === true`, records the platform message in
 * inbound_delivery_ledger — returning the settled result immediately when the
 * ledger already holds a persisted/processed/intentionally-dropped row. Every
 * routeInbound exit then settles the route as dropped (with a reason) or
 * persisted (with the session ids it landed in). Non-ACK adapters get the same
 * results without ledger writes (`audited: false`).
 */
import type { InboundEvent } from '../channels/adapter.js';
import { getChannelAdapter } from '../channels/channel-registry.js';
import {
  beginInboundDelivery,
  markInboundDeliveryDropped,
  markInboundDeliveryPersisted,
  type InboundDeliveryKey,
} from '../db/inbound-delivery-ledger.js';
import type { InboundRouteResult } from './channel-adapter.js';

export type { InboundRouteResult };

/** One session message deliverToAgent wrote for an inbound event. */
export interface InboundDelivery {
  sessionId: string;
  sessionMessageId: string;
}

export interface InboundRoute {
  /** The event after the receiving adapter's thread policy is applied. */
  readonly event: InboundEvent;
  readonly ackMode: boolean;
  readonly key: InboundDeliveryKey;
  readonly sessionIds: string[];
  readonly sessionMessageIds: string[];
  /** Already settled by the ledger — routeInbound returns this without routing. */
  readonly settled?: InboundRouteResult;
}

export async function beginInboundRoute(event: InboundEvent): Promise<InboundRoute> {
  const adapter = getChannelAdapter(event.instance ?? event.channelType);
  const ackMode = adapter?.supportsDeliveryAck === true;
  if (adapter && !adapter.supportsThreads) {
    event = { ...event, threadId: null };
  }
  const key: InboundDeliveryKey = {
    channelType: event.channelType,
    platformId: event.platformId,
    platformMessageId: event.message.id,
  };
  const route: InboundRoute = { event, ackMode, key, sessionIds: [], sessionMessageIds: [] };
  if (!ackMode) return route;

  const existingDelivery = await beginInboundDelivery(key, event.threadId);
  if (existingDelivery.status === 'persisted' || existingDelivery.status === 'processed') {
    return {
      ...route,
      settled: {
        status: 'persisted',
        platformMessageId: event.message.id,
        sessionIds: existingDelivery.session_ids_json
          ? (JSON.parse(existingDelivery.session_ids_json) as string[])
          : [],
        sessionMessageIds: existingDelivery.session_message_ids_json
          ? (JSON.parse(existingDelivery.session_message_ids_json) as string[])
          : [],
      },
    };
  }
  if (existingDelivery.status === 'intentionally_dropped') {
    return {
      ...route,
      settled: {
        status: 'dropped',
        platformMessageId: event.message.id,
        reason: existingDelivery.reason ?? 'intentionally_dropped',
        audited: true,
        retryable: false,
        intentional: true,
      },
    };
  }
  return route;
}

/** Collect a deliverToAgent result; true when a session message was written. */
export function addInboundDelivery(route: InboundRoute, delivery: InboundDelivery | null): boolean {
  if (!delivery) return false;
  route.sessionIds.push(delivery.sessionId);
  route.sessionMessageIds.push(delivery.sessionMessageId);
  return true;
}

export async function dropInboundRoute(
  route: InboundRoute,
  reason: string,
  opts: { intentional?: boolean; retryable?: boolean } = {},
): Promise<InboundRouteResult> {
  if (route.ackMode) {
    await markInboundDeliveryDropped(route.key, {
      reason,
      intentional: opts.intentional ?? false,
      retryable: opts.retryable ?? false,
    });
  }
  return {
    status: 'dropped',
    platformMessageId: route.event.message.id,
    reason,
    audited: route.ackMode,
    retryable: opts.retryable ?? false,
    intentional: opts.intentional ?? false,
  };
}

export async function persistInboundRoute(route: InboundRoute): Promise<InboundRouteResult> {
  const { sessionIds, sessionMessageIds } = route;
  if (route.ackMode) await markInboundDeliveryPersisted(route.key, { sessionIds, sessionMessageIds });
  return {
    status: 'persisted',
    platformMessageId: route.event.message.id,
    sessionIds,
    sessionMessageIds,
  };
}

/** Result handed back to the adapter when routeInbound throws. */
export function failedInboundRoute(platformMessageId: string, err: unknown): InboundRouteResult {
  return {
    status: 'failed',
    platformMessageId,
    reason: err instanceof Error ? err.message : 'route_failed',
    retryable: true,
  };
}
