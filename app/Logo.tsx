// The Flipwright mark: a price tag with its corner turned.
//
// The tag is the listing; the turn is the flip. The gold corner is the same
// gold the app uses everywhere for the numbers you're meant to look at.
//
// Two details that matter more than they look:
//
//  • The hole is a MASK, not a filled circle. Punching it properly means the
//    ground shows through, so one mark sits on the cream masthead, on a dark
//    tab strip, and on the teal login tile without a recoloured copy for each.
//  • Two flat colours and no gradient, which is why it still reads at the
//    16px a browser tab gives it.
//
// The ids are suffixed per instance. Two of these on one page — a masthead and
// a footer — would otherwise both point at the first one's mask, and SVG has no
// scoping to save you from that.

let seq = 0;

export function Logo({
  size = 40,
  className,
  title = "Flipwright",
}: {
  size?: number;
  className?: string;
  /** Empty string marks it decorative, for when adjacent text already names it. */
  title?: string;
}) {
  const uid = `fw${seq++}`;
  const TAG =
    "M24 8 H56 A6 6 0 0 1 62 14 V50 A6 6 0 0 1 56 56 H24 L5.4 37.4 A7.6 7.6 0 0 1 5.4 26.6 Z";

  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role={title ? "img" : undefined}
      aria-label={title || undefined}
      aria-hidden={title ? undefined : true}
    >
      <defs>
        <mask id={`${uid}-hole`}>
          <rect width="64" height="64" fill="#fff" />
          <circle cx="20" cy="32" r="4.4" fill="#000" />
        </mask>
        <clipPath id={`${uid}-clip`}>
          <path d={TAG} />
        </clipPath>
      </defs>
      <g mask={`url(#${uid}-hole)`}>
        <path d={TAG} fill="#0A6154" />
        <g clipPath={`url(#${uid}-clip)`}>
          <path d="M62 14 L62 56 L20 56 Z" fill="#DAA23F" />
        </g>
      </g>
    </svg>
  );
}
