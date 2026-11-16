// The vendored shared/verify-mark files (VerifyMark.jsx, VerifyMark.css) match their pin files byte for byte, and the pins are the canonical hashes.
// They come from curtismu7/AI-DEMO-Standalone shared/verify-mark: change them there, re-pin, re-vendor; never edit them here.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const CANONICAL = { "VerifyMark.jsx": "81c2532041c5a65aaf762e55c56e889df09dfde5811fc5cc788897ca8712c130", "VerifyMark.css": "4774585cd47c3affc739d3d99fa6843d62f607d8d3e69b4438de756ac3d49dc5" };

describe("vendored verify-mark", () => {
  it("matches VerifyMark.sha256 and VerifyMark.css.sha256, and those are the canonical hashes", () => {
    const dir = path.join(process.cwd(), "src", "components");
    for (const [file, pinFile] of [["VerifyMark.jsx", "VerifyMark.sha256"], ["VerifyMark.css", "VerifyMark.css.sha256"]]) {
      const [hash, name] = fs.readFileSync(path.join(dir, pinFile), "utf8").trim().split(/\s+/);
      expect(name, pinFile).toBe(file);
      expect(hash, `${pinFile} is the canonical hash`).toBe(CANONICAL[file]);
      expect(createHash("sha256").update(fs.readFileSync(path.join(dir, file))).digest("hex"), file).toBe(hash);
    }
  });
});
