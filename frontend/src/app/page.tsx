"use client";
import Link from "next/link";
import { ITEMS, formatSolShort } from "../lib/constants";
import { HeroReceipt } from "../components/HeroReceipt";
import { ItemIcon } from "../components/ItemIcon";

export default function ShopPage() {
  const scrollToShelf = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    const el = document.getElementById("shelf");
    if (!el) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ behavior: reduced ? "auto" : "smooth" });
  };

  return (
    <section className="view" aria-labelledby="h-shop">
      <div className="hero wrap">
        <div className="hero-copy">
          <h1 id="h-shop">
            Buy now.
            <br />
            Pay maybe.
          </h1>
          <p className="lede">
            Every checkout comes with one spin. You might get 25% back, half back, or the whole
            thing free, and every spin earns shards you can cash in later.
          </p>
          <div className="hero-actions">
            <a className="btn btn-key" href="#shelf" onClick={scrollToShelf}>
              Pick something
            </a>
            <Link className="btn btn-line" href="/fair">
              See the odds
            </Link>
          </div>
          <dl className="hero-facts">
            <div>
              <dt>Free</dt>
              <dd>1 in 100</dd>
            </div>
            <div>
              <dt>Something back</dt>
              <dd>1 in 4</dd>
            </div>
            <div>
              <dt>Shards</dt>
              <dd>every time</dd>
            </div>
          </dl>
        </div>

        <HeroReceipt />
      </div>

      <div className="shelf wrap" id="shelf">
        <div className="section-head">
          <h2>Today&apos;s shelf</h2>
          <p>Prices are in devnet SOL. Each item includes one provably fair spin at checkout.</p>
        </div>
        <ul className="tags">
          {ITEMS.map((item) => (
            <li key={item.id}>
              <article className="tag" aria-labelledby={`tag-${item.id}`}>
                <ItemIcon icon={item.icon} />
                <h3 id={`tag-${item.id}`}>{item.name}</h3>
                <p>{item.description}</p>
                <p className="tag-price">
                  {formatSolShort(item.priceLamports)} <small>SOL</small>
                </p>
                <Link className="btn btn-key" href={`/checkout/${item.id}`}>
                  Buy and spin
                </Link>
              </article>
            </li>
          ))}
        </ul>
      </div>

      <div className="flow wrap">
        <div className="section-head">
          <h2>What happens when you pay</h2>
          <p>Four steps, each one a live transaction you can verify on Solana.</p>
        </div>
        <ol className="flow-list">
          <li>
            <h3>Your payment is held</h3>
            <p>
              The fixed catalog price goes into the store&apos;s vault on Solana. Nothing is
              refunded or kept until your spin settles.
            </p>
          </li>
          <li>
            <h3>Your spin goes private</h3>
            <p>
              Your checkout delegates into a MagicBlock Intel TDX rollup gated by the Permission
              Program. While it&apos;s there, strangers read null.
            </p>
          </li>
          <li>
            <h3>A number is drawn</h3>
            <p>
              MagicBlock VRF draws an unbiased number from 0 to 9,999. Nobody can choose it, the
              store included.
            </p>
          </li>
          <li>
            <h3>The result is settled</h3>
            <p>
              The result is committed back to Solana. Claim your cashback or sell shards back for
              instant SOL whenever you like.
            </p>
          </li>
        </ol>
      </div>
    </section>
  );
}
