import { describe, expect, it } from "vitest";
import { proxyGuard } from "./vite-proxy-guard";

const opts = { allowedHosts: ["127.0.0.1", "localhost"], port: 5173 };

describe("vite proxy guard", () => {
  it("passes requests from the dev server's own origin, and requests without Origin", () => {
    expect(proxyGuard({ host: "127.0.0.1:5173", origin: "http://127.0.0.1:5173" }, opts)).toBeNull();
    expect(proxyGuard({ host: "localhost:5173", origin: "http://localhost:5173" }, opts)).toBeNull();
    expect(proxyGuard({ host: "127.0.0.1:5173", origin: undefined }, opts)).toBeNull();
  });

  it("refuses a foreign Origin (another local port or site, or null)", () => {
    for (const origin of ["http://127.0.0.1:3000", "http://localhost:5173", "https://evil.example", "null"]) {
      expect(proxyGuard({ host: "127.0.0.1:5173", origin }, opts), origin).toMatch(/Origin/);
    }
  });

  it("refuses a Host that is not this dev server (DNS rebinding, another port, none)", () => {
    expect(proxyGuard({ host: "evil.example:5173", origin: undefined }, opts)).toMatch(/Host/);
    expect(proxyGuard({ host: "127.0.0.1:4777", origin: undefined }, opts)).toMatch(/Host/);
    expect(proxyGuard({ host: "127.0.0.1", origin: undefined }, opts)).toMatch(/Host/);
    expect(proxyGuard({ host: undefined, origin: undefined }, opts)).toMatch(/Host/);
  });
});
