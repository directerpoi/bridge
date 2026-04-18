// ─── Request Timeline / Metrics ────────────────────────────────────────────────

/**
 * Timing information for a single HTTP request.
 * All values are in milliseconds.
 */
export interface RequestTimeline {
  /** Timestamp when the request started */
  startTime: number;
  /** Time spent on DNS resolution (ms) */
  dnsLookup: number;
  /** Time to establish TCP connection (ms) */
  tcpConnect: number;
  /** Time for TLS handshake (ms, 0 for HTTP) */
  tlsHandshake: number;
  /** Time to first byte of response (ms) */
  firstByte: number;
  /** Time to download entire response body (ms) */
  contentDownload: number;
  /** Total request duration (ms) */
  total: number;
}

/**
 * Creates an empty timeline object to be populated during the request.
 */
export function createTimeline(): RequestTimeline {
  return {
    startTime: Date.now(),
    dnsLookup: 0,
    tcpConnect: 0,
    tlsHandshake: 0,
    firstByte: 0,
    contentDownload: 0,
    total: 0,
  };
}

/**
 * Finalizes the timeline by computing the total duration.
 */
export function finalizeTimeline(timeline: RequestTimeline): RequestTimeline {
  timeline.total = Date.now() - timeline.startTime;
  return timeline;
}
