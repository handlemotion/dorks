"use client";

// The right-click menu: the dropdown menu's popup (its hairline, its one soft shadow, the springing hover fill), opened at the pointer.
// Its rows are the dropdown menu's own items (`DropdownMenuItem` and friends), which work inside it unchanged.

import * as React from "react";
import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";

import { cn } from "cn";
import { MENU_POPUP_CLASS } from "#ui/dropdown-menu";
import { FluidHoverHighlight } from "#ui/fluid-hover-highlight";
import { useFluidHoverList } from "#hooks/use-fluid-hover-list";
import {
  MENU_HELD_SELECTOR,
  MENU_HIGHLIGHTED_SELECTOR,
  MENU_ITEM_SELECTOR,
  menuHighlightClassName,
} from "#lib/menu-fluid-hover";

function ContextMenu({ ...props }: ContextMenuPrimitive.Root.Props) {
  return <ContextMenuPrimitive.Root data-slot="context-menu" {...props} />;
}

function ContextMenuTrigger({ ...props }: ContextMenuPrimitive.Trigger.Props) {
  return <ContextMenuPrimitive.Trigger data-slot="context-menu-trigger" {...props} />;
}

function ContextMenuContent({ className, children, ...props }: ContextMenuPrimitive.Popup.Props) {
  const hover = useFluidHoverList({
    itemSelector: MENU_ITEM_SELECTOR,
    highlightedSelector: MENU_HIGHLIGHTED_SELECTOR,
    heldSelector: MENU_HELD_SELECTOR,
  });
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Positioner className="isolate z-50 outline-none">
        <ContextMenuPrimitive.Popup
          data-slot="context-menu-content"
          {...hover.containerProps}
          className={cn(MENU_POPUP_CLASS, className)}
          {...props}
        >
          <FluidHoverHighlight {...hover.highlightProps} className={menuHighlightClassName(hover.activeElement)} />
          {children}
        </ContextMenuPrimitive.Popup>
      </ContextMenuPrimitive.Positioner>
    </ContextMenuPrimitive.Portal>
  );
}

export { ContextMenu, ContextMenuContent, ContextMenuTrigger };
