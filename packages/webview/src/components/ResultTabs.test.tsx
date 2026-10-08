import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { CodeBlock, CopyButton, Empty, Spinner } from "./ResultTabs";

describe("CodeBlock", () => {
  it("renders pretty JSON with syntax colors", () => {
    const { container } = render(<CodeBlock text='{"name": "Alice", "active": true}' />);
    const codeEl = container.querySelector(".code");
    expect(codeEl).not.toBeNull();
    expect(codeEl!.textContent).toContain("Alice");
    // JSON keys and strings get class spans
    const spans = codeEl!.querySelectorAll("span");
    const classes = Array.from(spans).map((s) => s.className);
    expect(classes.some((c) => c.includes("j-key"))).toBe(true);
    expect(classes.some((c) => c.includes("j-str"))).toBe(true);
    expect(classes.some((c) => c.includes("j-bool"))).toBe(true);
  });

  it("renders plain text for non-JSON", () => {
    const { container } = render(<CodeBlock text="Not JSON at all" />);
    const codeEl = container.querySelector(".code");
    expect(codeEl!.textContent).toBe("Not JSON at all");
    expect(codeEl!.querySelectorAll("span").length).toBe(0);
  });

  it("renders plain text for JSON over 300k chars", () => {
    const text = JSON.stringify(Array(40000).fill({ x: 1 }));
    const { container } = render(<CodeBlock text={text} />);
    const codeEl = container.querySelector(".code");
    expect(codeEl!.querySelectorAll("span").length).toBe(0);
    expect(codeEl!.textContent).toContain("x");
  });

  it("applies custom className", () => {
    const { container } = render(<CodeBlock text="hi" className="body" />);
    expect(container.querySelector(".code.body")).not.toBeNull();
  });
});

describe("CopyButton", () => {
  it("renders a Copy icon initially", () => {
    const { container } = render(<CopyButton text="hello" />);
    expect(container.querySelector("svg")).not.toBeNull();
    expect(screen.getByRole("button")).toHaveAttribute("aria-label", "Copy");
  });

  it("copies to clipboard on click and shows Copied", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<CopyButton text="secret-token" />);
    const btn = screen.getByRole("button");
    await act(async () => {
      fireEvent.click(btn);
      // allow the promise to resolve
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(writeText).toHaveBeenCalledWith("secret-token");
    expect(btn).toHaveAttribute("title", "Copied");
  });

  it("uses custom label", () => {
    render(<CopyButton text="data" label="Copy body" />);
    expect(screen.getByRole("button")).toHaveAttribute("aria-label", "Copy body");
  });
});

describe("Empty", () => {
  it("renders children with empty class", () => {
    render(<Empty>No data here</Empty>);
    const el = screen.getByText("No data here");
    expect(el.closest(".empty")).not.toBeNull();
  });
});

describe("Spinner", () => {
  it("renders a spinner with default label", () => {
    const { container } = render(<Spinner />);
    expect(container.querySelector(".spinner")).not.toBeNull();
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("renders custom label", () => {
    render(<Spinner label="Comparing…" />);
    expect(screen.getByText("Comparing…")).toBeInTheDocument();
  });
});
