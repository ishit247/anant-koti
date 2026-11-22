import { Icon } from "./icons.tsx";

// The customer's tab bar, at the bottom of every page in one business's space (D15). Plain links: no client
// JavaScript. Work list and Profile need the customer session; signed out, they lead to sign-in and back.
const TABS = [
  { path: "", key: "home", label: "Home", icon: "home" },
  { path: "/requests", key: "requests", label: "Work list", icon: "list" },
  { path: "/profile", key: "profile", label: "Profile", icon: "user" },
] as const;

export type CustomerTab = (typeof TABS)[number]["key"];

/** `current` is the tab this page belongs to; a page inside none (the request form) passes nothing. */
export function CustomerNav({ space, current }: { space: string; current?: CustomerTab }) {
  return (
    <nav className="tabs" aria-label="Main">
      {TABS.map((tab) => (
        <a
          key={tab.key}
          href={`${space}${tab.path}`}
          aria-current={tab.key === current ? "page" : undefined}
        >
          <Icon name={tab.icon} size={22} />
          {tab.label}
        </a>
      ))}
    </nav>
  );
}
