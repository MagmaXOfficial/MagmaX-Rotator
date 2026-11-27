export interface LiveEvent {
  id: number;
  ts: number;
  type: string;
  data: Record<string, unknown>;
}

type Listener = (event: LiveEvent) => void;

const listeners = new Set<Listener>();
const history: LiveEvent[] = [];
let seq = 0;

export function publish(type: string, data: Record<string, unknown> = {}): LiveEvent {
  const event: LiveEvent = { id: ++seq, ts: Date.now(), type, data };
  history.push(event);
  if (history.length > 400) history.shift();
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      /* a broken subscriber must not break routing */
    }
  }
  return event;
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function recentEvents(limit = 100): LiveEvent[] {
  return history.slice(-limit);
}

export function subscriberCount(): number {
  return listeners.size;
}
