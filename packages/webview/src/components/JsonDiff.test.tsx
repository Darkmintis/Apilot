import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { JsonDiff } from "./JsonDiff";

describe("JsonDiff", () => {
  it("shows 'Bodies are identical' when there are no changes", () => {
    const body = JSON.stringify({ name: "Alice", id: 1 });
    render(<JsonDiff left={body} right={body} leftTitle="Before" rightTitle="After" />);
    expect(screen.getByText(/Bodies are identical/)).toBeInTheDocument();
  });

  it("renders left and right titles", () => {
    render(<JsonDiff left="hello" right="world" leftTitle="Before" rightTitle="After" />);
    expect(screen.getByText("Before")).toBeInTheDocument();
    expect(screen.getByText("After")).toBeInTheDocument();
  });

  it("shows removed/added lines for changed bodies", () => {
    render(
      <JsonDiff
        left='{\n  "name": "Alice"\n}'
        right='{\n  "name": "Bob"\n}'
        leftTitle="Before"
        rightTitle="After"
      />
    );
    // Should show the changed line on both sides
    const codeCells = document.querySelectorAll(".code");
    expect(codeCells.length).toBeGreaterThanOrEqual(1);
  });

  it("renders a fold button when there are more than 4 unchanged lines", () => {
    const left = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
    const right = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n") + "\nextra";
    render(<JsonDiff left={left} right={right} leftTitle="Before" rightTitle="After" />);
    const foldButton = screen.queryByText(/Show \d+ unchanged line/);
    // With 10 unchanged lines + 1 added, there should be a fold button
    expect(foldButton).not.toBeNull();
  });

  it("expands folded lines when the fold button is clicked", () => {
    const left = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
    const right = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n") + "\nextra";
    render(<JsonDiff left={left} right={right} leftTitle="Before" rightTitle="After" />);
    const foldButton = screen.queryByText(/Show \d+ unchanged line/);
    expect(foldButton).not.toBeNull();
    fireEvent.click(foldButton!);
    // After clicking, the fold button should no longer be visible (lines expanded)
    expect(screen.queryByText(/Show \d+ unchanged line/)).toBeNull();
  });
});
