/**
 * LiveKit integration for the Expo app.
 *
 * Handles:
 * - registerGlobals() (required before any LiveKit code)
 * - AudioSession management
 * - Token refresh monitoring
 */

import { registerGlobals, AudioSession } from "@livekit/react-native";

// Must be called once before any LiveKit usage
registerGlobals();

/**
 * Start the audio session. Call when entering the speaking screen.
 */
export async function startAudioSession(): Promise<void> {
  await AudioSession.startAudioSession();
}

/**
 * Stop the audio session. Call when leaving the speaking screen.
 */
export async function stopAudioSession(): Promise<void> {
  await AudioSession.stopAudioSession();
}

/**
 * Token refresh scheduler.
 *
 * Calls the refreshFn at a configurable interval before the token expires.
 * Returns a cleanup function to cancel the timer.
 *
 * @param tokenTtlSeconds - Token time-to-live in seconds (default 15 min)
 * @param refreshBeforeSeconds - Refresh this many seconds before expiry (default 2 min)
 * @param refreshFn - Async function that returns the new token string
 * @param onToken - Callback with the new token
 * @param onError - Callback for refresh errors
 */
export function scheduleTokenRefresh(
  tokenTtlSeconds: number = 900,
  refreshBeforeSeconds: number = 120,
  refreshFn: () => Promise<string>,
  onToken: (token: string) => void,
  onError: (error: Error) => void
): () => void {
  const intervalMs = (tokenTtlSeconds - refreshBeforeSeconds) * 1000;

  const timer = setInterval(async () => {
    try {
      const newToken = await refreshFn();
      onToken(newToken);
    } catch (err) {
      onError(err instanceof Error ? err : new Error(String(err)));
    }
  }, intervalMs);

  return () => clearInterval(timer);
}
