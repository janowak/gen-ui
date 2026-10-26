import { describe, expect, it } from "vitest";
import { refreshUrlError } from "./url.js";

describe("refresh URLs", () => {
  it("allows public https only", () => {
    expect(refreshUrlError("https://acme.com/genui/refresh")).toBeUndefined();
    expect(refreshUrlError("http://acme.com/genui/refresh")).toMatch(/https/);
    for (const url of ["https://localhost/x", "https://127.0.0.1/x", "https://10.0.0.5/x", "https://169.254.169.254/latest", "https://192.168.1.1/x", "https://[::1]/x", "https://[::ffff:127.0.0.1]/x"]) {
      expect(refreshUrlError(url), url).toMatch(/public/);
    }
  });

  it("allows http and private addresses when the registry permits them", () => {
    expect(refreshUrlError("http://127.0.0.1:9000/x", true)).toBeUndefined();
    expect(refreshUrlError("ftp://127.0.0.1/x", true)).toMatch(/http/);
  });
});
