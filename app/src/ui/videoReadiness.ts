import { useRef, useState } from 'react';
import type { NativeSyntheticEvent } from 'react-native';

let nextSurface = 0;
interface FrameState {
  surfaceId: string;
  generation: number;
  ready: boolean;
}

/** Local renderer observation, never a signaling or camera-permission fact.
 * Each surface lifetime gets a token so queued Fabric events cannot cross a
 * swap, reconnect, camera toggle, or recycled native view. Native generations
 * order track replacements within the same surface. */
export function useVideoReadiness(cid: string, track: string, expected: boolean) {
  const current = useRef<{
    cid: string; track: string; expected: boolean; surfaceId: string; generation: number;
  } | null>(null);
  if (!current.current || current.current.cid !== cid ||
      current.current.track !== track || current.current.expected !== expected) {
    current.current = { cid, track, expected, surfaceId: `video-${++nextSurface}`, generation: -1 };
  }
  const surfaceId = current.current.surfaceId;
  const [frame, setFrame] = useState<FrameState | null>(null);
  return {
    surfaceId,
    ready: expected && frame?.surfaceId === surfaceId && frame.ready,
    onFrameReady: (event: NativeSyntheticEvent<FrameState>) => {
      const next = event.nativeEvent;
      const active = current.current;
      if (
        !active || !expected || next.surfaceId !== active.surfaceId ||
        !Number.isSafeInteger(next.generation) || next.generation < 0 ||
        next.generation < active.generation || typeof next.ready !== 'boolean'
      ) return;
      active.generation = next.generation;
      setFrame(next);
    },
  };
}
