import type { ReactNode } from "react";
import { Icon } from "./icons.tsx";

// The app bar every customer page opens with (ui-guidelines.md): back arrow, avatar, business and place,
// so the customer knows whose page this is before reading what it asks. On the business's own page the
// name is the h1; elsewhere the back arrow leads home and the page's own title (passed as children,
// shown below the bar) is the h1.
export function BusinessHeader({
  business,
  home,
  children,
}: {
  business: { name: string; city: string; serviceArea: string };
  home: { href: string } | "here";
  children?: ReactNode;
}) {
  const initial = business.name.trim().charAt(0).toUpperCase();
  return (
    <>
      <header className="appbar">
        {home === "here" ? null : (
          <a className="back" href={home.href} aria-label={`Back to ${business.name}`}>
            <Icon name="back" size={22} />
          </a>
        )}
        <span className="avatar" aria-hidden="true">
          {initial}
        </span>
        <div className="title">
          {home === "here" ? (
            <h1 className="name">{business.name}</h1>
          ) : (
            <span className="name">{business.name}</span>
          )}
          <p className="where muted">
            <Icon name="pin" size={14} />
            {business.city}
            {business.serviceArea ? ` · ${business.serviceArea}` : ""}
          </p>
        </div>
      </header>
      {children ? <div className="hero">{children}</div> : null}
    </>
  );
}
