import { useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

export class HiddenDiscoveryTracker {
  taps: number[] = [];
  requiredTaps: number;
  windowMs: number;

  constructor(requiredTaps: number, windowMs: number) {
    this.requiredTaps = requiredTaps;
    this.windowMs = windowMs;
  }

  registerTap(now: number): boolean {
    this.taps.push(now);
    this.taps = this.taps.filter(time => now - time <= this.windowMs);
    if (this.taps.length >= this.requiredTaps) {
      this.taps = [];
      return true;
    }
    return false;
  }
}

export const useHiddenDiscovery = (targetPath: string = '/internal/qa', requiredTaps: number = 5, windowMs: number = 3000) => {
  const navigate = useNavigate();
  const tracker = useRef(new HiddenDiscoveryTracker(requiredTaps, windowMs));

  const handleTap = useCallback((_e?: React.MouseEvent | React.TouchEvent) => {
    if (tracker.current.registerTap(Date.now())) {
      navigate(targetPath);
    }
  }, [navigate, targetPath]);

  return { handleTap };
};
