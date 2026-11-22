// The owner's tab bar, shown at the bottom of every owner page. Plain links: no client JavaScript.
const TABS = [
  { href: "/", label: "Home", icon: "⌂" },
  { href: "/jobs", label: "Requests", icon: "✉" },
  { href: "/catalogue", label: "Prices", icon: "₹" },
] as const;

export function OwnerNav({ current }: { current: (typeof TABS)[number]["href"] }) {
  return (
    <nav className="tabs" aria-label="Main">
      {TABS.map((tab) => (
        <a key={tab.href} href={tab.href} aria-current={tab.href === current ? "page" : undefined}>
          <span className="icon" aria-hidden="true">
            {tab.icon}
          </span>
          {tab.label}
        </a>
      ))}
    </nav>
  );
}
