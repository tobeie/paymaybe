"use client";
import { useEffect, useRef, useState } from "react";

interface Props {
  /** Fixed-width 4-decimal SOL string, e.g. "0.0200" or "0.0000" */
  value: string;
  /** While true, digit columns continuously blur-spin waiting for VRF */
  spinning: boolean;
}

const STRIP_DIGITS = Array.from({ length: 20 }, (_, i) => i % 10);

export function OdometerReel({ value, spinning }: Props) {
  const chars = [...value];
  const digitIndices = chars
    .map((c, idx) => (/\d/.test(c) ? idx : -1))
    .filter((idx) => idx >= 0);

  // Track which digit positions have landed after a spin (staggered 130ms left-to-right)
  const [landedCount, setLandedCount] = useState<number>(digitIndices.length);
  const [isLandingPhase, setIsLandingPhase] = useState(false);
  const wasSpinningRef = useRef(false);

  useEffect(() => {
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (spinning) {
      wasSpinningRef.current = true;
      setLandedCount(0);
      setIsLandingPhase(false);
      return;
    }

    if (wasSpinningRef.current && !spinning) {
      wasSpinningRef.current = false;
      if (reduced) {
        setLandedCount(digitIndices.length);
        setIsLandingPhase(false);
        return;
      }

      setIsLandingPhase(true);
      const timers: ReturnType<typeof setTimeout>[] = [];
      for (let i = 0; i < digitIndices.length; i++) {
        timers.push(
          setTimeout(() => {
            setLandedCount(i + 1);
          }, i * 130)
        );
      }
      timers.push(
        setTimeout(() => {
          setIsLandingPhase(false);
        }, digitIndices.length * 130 + 780)
      );
      return () => {
        timers.forEach(clearTimeout);
      };
    }

    setLandedCount(digitIndices.length);
  }, [spinning, value, digitIndices.length]);

  let digitRank = 0;

  return (
    <span className="reel" role="img" aria-label={`${value} SOL`}>
      {chars.map((c, idx) => {
        if (!/\d/.test(c)) {
          return (
            <span key={`sep-${idx}`} className="ch">
              {c}
            </span>
          );
        }
        const rank = digitRank++;
        const digitNum = Number(c);
        const digitIsSpinning = spinning || (isLandingPhase && rank >= landedCount);
        const digitIsLanding = !spinning && isLandingPhase && rank < landedCount;
        const offsetRow = digitIsLanding ? 10 + digitNum : digitNum;

        return (
          <span
            key={`dig-${idx}`}
            className={`ch dig${digitIsSpinning ? " spin" : ""}${digitIsLanding ? " land" : ""}`}
          >
            <span
              className="strip"
              style={
                digitIsSpinning
                  ? undefined
                  : { transform: `translateY(calc(var(--h) * -${offsetRow}))` }
              }
            >
              {STRIP_DIGITS.map((d, j) => (
                <span key={j}>{d}</span>
              ))}
            </span>
          </span>
        );
      })}
    </span>
  );
}
