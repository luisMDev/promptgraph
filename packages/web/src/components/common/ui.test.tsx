// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Button, Checkbox, Modal } from "./ui";

afterEach(cleanup);

function ModalHarness({ onClose }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      {open && (
        <Modal
          title="Harness"
          onClose={() => {
            onClose?.();
            setOpen(false);
          }}
        >
          <button type="button">Inside</button>
        </Modal>
      )}
    </>
  );
}

describe("Modal (Radix Dialog)", () => {
  it("is exposed as a dialog named by its title", () => {
    render(
      <Modal title="Settings" onClose={() => {}}>
        body
      </Modal>,
    );
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
  });

  it("moves focus into the dialog on open, to an autoFocus input when there is one", async () => {
    const { unmount } = render(
      <Modal title="Plain" onClose={() => {}}>
        <button type="button">A</button>
      </Modal>,
    );
    const dialog = screen.getByRole("dialog", { name: "Plain" });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    unmount();

    render(
      <Modal title="With input" onClose={() => {}}>
        {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
        <input aria-label="Name" autoFocus />
      </Modal>,
    );
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Name" })));
  });

  it("traps Tab and Shift+Tab inside the dialog", async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button">Outside</button>
        <Modal title="Trap" onClose={() => {}} footer={<button type="button">Last</button>}>
          <button type="button">Middle</button>
        </Modal>
      </>,
    );
    const close = screen.getByRole("button", { name: "Close" });
    const middle = screen.getByRole("button", { name: "Middle" });
    const last = screen.getByRole("button", { name: "Last" });
    await waitFor(() => expect(document.activeElement).toBe(close));

    await user.tab();
    expect(document.activeElement).toBe(middle);
    await user.tab();
    expect(document.activeElement).toBe(last);
    await user.tab();
    expect(document.activeElement).toBe(close);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(last);
  });

  it("calls onClose exactly once on Escape", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Modal title="Esc" onClose={onClose}>
        <button type="button">A</button>
      </Modal>,
    );
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes only the topmost of two stacked dialogs on Escape", async () => {
    const user = userEvent.setup();
    const outerClose = vi.fn();
    const innerClose = vi.fn();
    render(
      <Modal title="Outer" onClose={outerClose}>
        <Modal title="Inner" onClose={innerClose}>
          <button type="button">Inner button</button>
        </Modal>
      </Modal>,
    );
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Inner" }).contains(document.activeElement)).toBe(true));
    await user.keyboard("{Escape}");
    expect(innerClose).toHaveBeenCalledTimes(1);
    expect(outerClose).not.toHaveBeenCalled();
  });

  it("returns focus to the opener after closing", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ModalHarness onClose={onClose} />);
    const opener = screen.getByRole("button", { name: "Open" });
    await user.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Harness" });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("returns focus to the menu trigger when it was opened from a dropdown menu item", async () => {
    // The item that had focus when the Modal mounted unmounts with the menu; focus must not fall to <body>.
    function MenuOpened() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button>Actions</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onSelect={() => setOpen(true)}>Edit…</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {open && (
            <Modal title="Edit" onClose={() => setOpen(false)}>
              <button type="button">Inside</button>
            </Modal>
          )}
        </>
      );
    }
    const user = userEvent.setup();
    render(<MenuOpened />);
    const trigger = screen.getByRole("button", { name: "Actions" });
    trigger.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(document.activeElement?.getAttribute("role")).toBe("menuitem"));
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", { name: "Edit" });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("calls onClose from the Close button", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Modal title="X" onClose={onClose}>
        body
      </Modal>,
    );
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose on a pointer down outside the dialog (the overlay)", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Modal title="Outside" onClose={onClose}>
        body
      </Modal>,
    );
    const overlay = document.querySelector<HTMLElement>("[data-slot=dialog-overlay]");
    expect(overlay).not.toBeNull();
    // Radix gives the overlay pointer-events: auto while the body is pointer-events: none, so this targets it like a real click.
    await user.pointer({ keys: "[MouseLeft]", target: overlay! });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("Button wrapper", () => {
  it("defaults to type=button and maps variant/size to the shadcn button", () => {
    render(
      <Button variant="danger" size="sm">
        Delete
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Delete" });
    expect(button.getAttribute("type")).toBe("button");
    expect(button.dataset.variant).toBe("destructive");
    expect(button.dataset.size).toBe("sm");
  });

  it("uses secondary/md by default and honours an explicit submit type", () => {
    render(<Button type="submit">Save</Button>);
    const button = screen.getByRole("button", { name: "Save" });
    expect(button.getAttribute("type")).toBe("submit");
    expect(button.dataset.variant).toBe("outline");
    expect(button.dataset.size).toBe("default");
  });

  it("does not fire onClick when disabled", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Run
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Run" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("Checkbox wrapper", () => {
  it("toggles through its label and reports the new value", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Checkbox checked={false} onChange={onChange} label="Auto-advance" />);
    const box = screen.getByRole("checkbox", { name: "Auto-advance" });
    expect(box.getAttribute("aria-checked")).toBe("false");
    await user.click(screen.getByText("Auto-advance"));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("reports false when unchecking and ignores clicks when disabled", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(<Checkbox checked onChange={onChange} label="Flag" />);
    await user.click(screen.getByRole("checkbox", { name: "Flag" }));
    expect(onChange).toHaveBeenLastCalledWith(false);

    onChange.mockClear();
    rerender(<Checkbox checked onChange={onChange} label="Flag" disabled />);
    await user.click(screen.getByRole("checkbox", { name: "Flag" }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
