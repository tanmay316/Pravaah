/**
 * Web shim for LiveKit integration in Expo.
 * 
 * On the Web, WebRTC is natively supported, so we do not need to call
 * registerGlobals() or manage a native AudioSession.
 */

// We don't need registerGlobals on the web, but we still export startAudioSession 
// and stopAudioSession to keep the API identical to the native lib/livekit.ts.

export async function startAudioSession(): Promise<void> {
  // No-op for web
  console.log("Web: startAudioSession (no-op)");
}

export async function stopAudioSession(): Promise<void> {
  // No-op for web
  console.log("Web: stopAudioSession (no-op)");
}

/**
 * Token refresh scheduler.
 * (Identical to native implementation since it's just JS timers)
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
