import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import App from "./App";

// The header shows this lab's own Verified / In progress mark, read from the same /api/shelf call the lab-proxy sends to the shelf (the shelf lists every
// demo with its mark). The lab's own /api/shelf has only { shelfUrl }, so there is no mark when it is opened on its own port. The lab has no Shelf link,
// so the badge sits in TopMenu's children slot.
const mark = (status, label, extra = {}) => ({ status, label, note: "", updatedAt: "2026-11-15", source: "shipped", ...extra });
function withShelf(payload) {
  const res = (body, status = 200) => ({ ok: status < 400, status, headers: { get: () => "application/json" }, json: async () => body, text: async () => JSON.stringify(body) });
  globalThis.fetch = vi.fn(async (url) => (url === "/api/shelf" ? res(payload) : res({}, 404)));
}
afterEach(() => { vi.restoreAllMocks(); window.location.hash = ""; });

describe("verification mark in the header", () => {
  it("shows this lab's own mark in the top menu, and no other lab's, with the note as the tooltip", async () => {
    withShelf({ shelfUrl: "http://shelf.example", demos: [{ id: "other-lab", verification: mark("in-progress", "In progress") }, { id: "pingone-events-lab", verification: mark("verified", "Verified", { note: "Webhook receiver run on the mock" }) }] });
    render(<App />);
    const bar = within(await screen.findByTestId("top-menu"));
    expect(await bar.findByText("Verified")).toBeInTheDocument();
    expect(bar.queryByText("In progress")).toBeNull();
    expect(document.querySelectorAll(".verify")).toHaveLength(1);
    expect(bar.getByText("Verified").closest(".verify")).toHaveAttribute("title", expect.stringContaining("Webhook receiver run on the mock"));
  });

  it("shows nothing when the lab is opened on its own port (its /api/shelf has no demos) or the shelf has no mark for it", async () => {
    for (const payload of [{ shelfUrl: "http://shelf.example" }, { shelfUrl: "http://shelf.example", demos: [{ id: "pingone-events-lab", verification: null }, { id: "other-lab", verification: mark("verified", "Verified") }] }]) {
      withShelf(payload);
      const { unmount } = render(<App />);
      await screen.findByTestId("top-menu");
      await vi.waitFor(() => expect(globalThis.fetch.mock.calls.some(([u]) => u === "/api/shelf")).toBe(true));
      await new Promise((r) => setTimeout(r, 50)); // let the shelf answer settle
      expect(document.querySelector(".verify")).toBeNull();
      unmount();
    }
  });
});
