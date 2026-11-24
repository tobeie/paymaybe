import { shortKey } from "../lib/constants";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

interface Props {
  seed: string;
  caption?: string;
  href?: string;
}

export function ReceiptBarcode({ seed, caption, href }: Props) {
  let x = 0;
  const rects: { x: number; w: number }[] = [];
  for (let i = 0; i < seed.length && x < 196; i++) {
    const raw = B58.indexOf(seed[i]);
    const v = raw >= 0 ? raw : i * 7;
    const w = 1 + (v % 3);
    const gap = 1 + ((v >> 2) % 3);
    rects.push({ x, w });
    x += w + gap;
  }
  const viewWidth = Math.max(x, 60);
  const label = caption ?? shortKey(seed);

  const svg = (
    <svg
      className="barcode"
      viewBox={`0 0 ${viewWidth} 40`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {rects.map((r, i) => (
        <rect key={i} x={r.x} y={0} width={r.w} height={40} />
      ))}
    </svg>
  );

  return (
    <div className="printing">
      {href ? (
        <a href={href} target="_blank" rel="noopener noreferrer" aria-label={`Inspect transaction ${label} on Solana Explorer`}>
          {svg}
          <div className="r-center r-muted r-link">{label} ↗</div>
        </a>
      ) : (
        <>
          {svg}
          <div className="r-center r-muted">{label}</div>
        </>
      )}
    </div>
  );
}
