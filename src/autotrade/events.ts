/**
 * Event-window layer.
 *
 * Suppresses trading before/after macro events (FOMC, CPI, NFP, PPI, Jobless
 * Claims, retail sales, GDP, Powell speeches, major earnings) and provides
 * event-state flags for the signal log.
 *
 * Events are loaded from `config/events.json`. Each entry is a UTC ISO
 * timestamp plus a type tag. Windows (pre/post) are configurable.
 *
 * This is intentionally static in this task. A live calendar feed can replace
 * the JSON source later without changing the consumer API.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

export interface MacroEvent {
  /** UTC ISO timestamp of the event release. */
  iso_utc: string;
  /** Short tag: "FOMC", "CPI", "NFP", "PPI", "EARNINGS:NVDA", etc. */
  type: string;
  /** Optional description. */
  note?: string;
}

export interface EventConfig {
  pre_window_minutes: number;
  post_window_minutes: number;
  events: MacroEvent[];
}

export interface EventState {
  is_event_window: boolean;
  event_type: string | null;
  minutes_to_next_event: number | null;
  minutes_since_last_event: number | null;
  no_trade_due_to_event: boolean;
  /** Structured reason, empty if no suppression. */
  suppression_reason: string;
}

const DEFAULT_CONFIG: EventConfig = {
  pre_window_minutes: 15,
  post_window_minutes: 10,
  events: [],
};

export class EventCalendar {
  private readonly config: EventConfig;
  private readonly upcoming: MacroEvent[];

  constructor(config: EventConfig) {
    this.config = {
      pre_window_minutes: Math.max(0, config.pre_window_minutes),
      post_window_minutes: Math.max(0, config.post_window_minutes),
      events: [...config.events],
    };
    // Sort events ascending by time for binary-scan-like access
    this.upcoming = [...this.config.events].sort(
      (a, b) => Date.parse(a.iso_utc) - Date.parse(b.iso_utc),
    );
  }

  static load(configDir: string = './config'): EventCalendar {
    const path = join(configDir, 'events.json');
    if (!existsSync(path)) {
      return new EventCalendar(DEFAULT_CONFIG);
    }
    try {
      const raw = readFileSync(path, 'utf8');
      const parsed = JSON.parse(raw) as Partial<EventConfig>;
      return new EventCalendar({
        pre_window_minutes: parsed.pre_window_minutes ?? DEFAULT_CONFIG.pre_window_minutes,
        post_window_minutes: parsed.post_window_minutes ?? DEFAULT_CONFIG.post_window_minutes,
        events: Array.isArray(parsed.events) ? parsed.events : [],
      });
    } catch (err) {
      console.warn('[EVENTS] Failed to load events.json, using empty calendar:', err);
      return new EventCalendar(DEFAULT_CONFIG);
    }
  }

  /**
   * Evaluate the event state at `now`. Returns the next/previous event and
   * whether a pre- or post-event no-trade window is active.
   */
  evaluate(now: Date = new Date()): EventState {
    const nowMs = now.getTime();
    let prev: MacroEvent | null = null;
    let next: MacroEvent | null = null;

    for (const e of this.upcoming) {
      const t = Date.parse(e.iso_utc);
      if (isNaN(t)) continue;
      if (t <= nowMs) prev = e;
      else { next = e; break; }
    }

    const minsToNext = next ? (Date.parse(next.iso_utc) - nowMs) / 60_000 : null;
    const minsSincePrev = prev ? (nowMs - Date.parse(prev.iso_utc)) / 60_000 : null;

    const inPre = minsToNext !== null && minsToNext <= this.config.pre_window_minutes && minsToNext >= 0;
    const inPost = minsSincePrev !== null && minsSincePrev <= this.config.post_window_minutes && minsSincePrev >= 0;

    const eventType = inPre ? (next?.type ?? null)
      : inPost ? (prev?.type ?? null)
      : null;
    const isWindow = inPre || inPost;

    let reason = '';
    if (inPre) {
      reason = `pre_event_window:${next?.type}:${Math.round(minsToNext!)}min_to_event`;
    } else if (inPost) {
      reason = `post_event_window:${prev?.type}:${Math.round(minsSincePrev!)}min_since_event`;
    }

    return {
      is_event_window: isWindow,
      event_type: eventType,
      minutes_to_next_event: minsToNext !== null ? Math.round(minsToNext) : null,
      minutes_since_last_event: minsSincePrev !== null ? Math.round(minsSincePrev) : null,
      no_trade_due_to_event: isWindow,
      suppression_reason: reason,
    };
  }

  size(): number {
    return this.upcoming.length;
  }
}
