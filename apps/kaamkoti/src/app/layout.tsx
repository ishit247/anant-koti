import { defineRoute } from "@bodhchakra/tenancy";
import "./globals.css";

export const route = defineRoute({ scope: "none" });

export const metadata = { title: "Kaam Koti" };

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <main>{children}</main>
      </body>
    </html>
  );
}
