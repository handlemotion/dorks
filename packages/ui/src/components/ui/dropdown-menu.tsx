"use client";

// The app's menu: a fluid hover fill that springs between rows,
// a hairline and the one soft drop shadow the app allows. 32px rows at the app's 14px.

import * as React from "react";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";

import { cn } from "cn";
import { FluidHoverHighlight } from "#ui/fluid-hover-highlight";
import { useFluidHoverList } from "#hooks/use-fluid-hover-list";
import {
  MENU_HELD_SELECTOR,
  MENU_HIGHLIGHTED_SELECTOR,
  MENU_ITEM_SELECTOR,
  menuHighlightClassName,
} from "#lib/menu-fluid-hover";
import { ChevronRightIcon, CheckIcon } from "lucide-react";

/** The menu popup: a hairline and the app's one soft shadow. Shared with the context menu so there is still only one. */
export const MENU_POPUP_CLASS =
  "relative z-50 flex max-h-(--available-height) min-w-40 flex-col gap-0.5 overflow-x-hidden overflow-y-auto rounded-[10px] border border-border bg-popover p-1 text-popover-foreground shadow-[0_1px_2px_-1px_rgb(0_0_0/0.04),0_6px_10px_-6px_rgb(0_0_0/0.07)] outline-none";

function DropdownMenu({ ...props }: MenuPrimitive.Root.Props) {
  return <MenuPrimitive.Root data-slot="dropdown-menu" {...props} />;
}

function DropdownMenuPortal({ ...props }: MenuPrimitive.Portal.Props) {
  return <MenuPrimitive.Portal data-slot="dropdown-menu-portal" {...props} />;
}

function DropdownMenuTrigger({ ...props }: MenuPrimitive.Trigger.Props) {
  return <MenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />;
}

function DropdownMenuContent({
  align = "start",
  alignOffset = 0,
  collisionAvoidance,
  side = "bottom",
  sideOffset = 4,
  className,
  children,
  ...props
}: MenuPrimitive.Popup.Props &
  Pick<
    MenuPrimitive.Positioner.Props,
    "align" | "alignOffset" | "collisionAvoidance" | "side" | "sideOffset"
  >) {
  const hover = useFluidHoverList({
    itemSelector: MENU_ITEM_SELECTOR,
    highlightedSelector: MENU_HIGHLIGHTED_SELECTOR,
    heldSelector: MENU_HELD_SELECTOR,
  });
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        className="isolate z-50 outline-none"
        align={align}
        alignOffset={alignOffset}
        collisionAvoidance={collisionAvoidance}
        side={side}
        sideOffset={sideOffset}
      >
        <MenuPrimitive.Popup
          data-slot="dropdown-menu-content"
          {...hover.containerProps}
          onClick={(event) => {
            hover.containerProps.onClick(event);
            event.stopPropagation();
          }}
          className={cn(
            MENU_POPUP_CLASS, "w-(--anchor-width)",
            className,
          )}
          {...props}
        >
          <FluidHoverHighlight
            {...hover.highlightProps}
            className={menuHighlightClassName(hover.activeElement)}
          />
          {children}
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

function DropdownMenuGroup({ className, ...props }: MenuPrimitive.Group.Props) {
  return (
    <MenuPrimitive.Group
      data-slot="dropdown-menu-group"
      className={cn("flex flex-col gap-0.5", className)}
      {...props}
    />
  );
}

function DropdownMenuLabel({
  className,
  inset,
  ...props
}: MenuPrimitive.GroupLabel.Props & {
  inset?: boolean;
}) {
  return (
    <MenuPrimitive.GroupLabel
      data-slot="dropdown-menu-label"
      data-inset={inset}
      className={cn(
        "flex min-h-[28px] items-center px-2 py-0 text-xs leading-none font-normal text-muted-foreground data-inset:pl-8",
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuItem({
  className,
  inset,
  variant = "default",
  ...props
}: MenuPrimitive.Item.Props & {
  inset?: boolean;
  variant?: "default" | "destructive";
}) {
  return (
    <MenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(
        "group/dropdown-menu-item relative flex h-8 cursor-default items-center gap-2 rounded-[6px] px-2 text-sm leading-5 outline-hidden transition-[background-color] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] select-none data-[variant=destructive]:text-destructive data-[variant=destructive]:data-highlighted:text-destructive data-[variant=destructive]:*:[svg]:text-destructive data-highlighted:text-foreground data-disabled:opacity-50 data-inset:pl-8 motion-reduce:transition-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:size-3.5 [&_svg]:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuLinkItem({
  className,
  inset,
  ...props
}: MenuPrimitive.LinkItem.Props & {
  inset?: boolean;
}) {
  return (
    <MenuPrimitive.LinkItem
      data-slot="dropdown-menu-link-item"
      data-inset={inset}
      className={cn(
        "relative flex h-8 cursor-default items-center gap-2 rounded-[6px] px-2 text-sm leading-5 outline-hidden transition-[background-color] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] select-none data-highlighted:text-foreground data-disabled:opacity-50 data-inset:pl-8 motion-reduce:transition-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:size-3.5 [&_svg]:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuSub({ ...props }: MenuPrimitive.SubmenuRoot.Props) {
  return <MenuPrimitive.SubmenuRoot data-slot="dropdown-menu-sub" {...props} />;
}

function DropdownMenuSubTrigger({
  className,
  closeDelay = 150,
  inset,
  children,
  openOnHover = true,
  ...props
}: MenuPrimitive.SubmenuTrigger.Props & {
  inset?: boolean;
}) {
  return (
    <MenuPrimitive.SubmenuTrigger
      closeDelay={closeDelay}
      data-slot="dropdown-menu-sub-trigger"
      data-inset={inset}
      openOnHover={openOnHover}
      className={cn(
        "relative flex h-8 cursor-default items-center gap-2 rounded-[6px] px-2 text-sm leading-5 outline-hidden select-none data-highlighted:text-foreground data-open:text-foreground data-popup-open:text-foreground data-inset:pl-8 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:size-3.5 [&_svg]:text-foreground",
        className,
      )}
      {...props}
    >
      {children}
      <ChevronRightIcon className="ml-auto size-4 text-muted-foreground" strokeWidth={1.5} />
    </MenuPrimitive.SubmenuTrigger>
  );
}

function DropdownMenuSubContent({
  align = "start",
  alignOffset = -5,
  side = "right",
  sideOffset = 3,
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuContent>) {
  return (
    <DropdownMenuContent
      data-slot="dropdown-menu-sub-content"
      className={cn("w-auto min-w-[96px]", className)}
      align={align}
      alignOffset={alignOffset}
      side={side}
      sideOffset={sideOffset}
      {...props}
    />
  );
}

function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  inset,
  ...props
}: MenuPrimitive.CheckboxItem.Props & {
  inset?: boolean;
}) {
  return (
    <MenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      data-inset={inset}
      className={cn(
        "relative flex h-8 cursor-default items-center gap-2 rounded-[6px] py-0 pr-8 pl-2 text-sm leading-5 outline-hidden transition-[background-color] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] select-none data-checked:bg-foreground/[0.05] data-highlighted:text-foreground data-disabled:opacity-50 data-inset:pl-8 motion-reduce:transition-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:size-3.5 [&_svg]:text-foreground",
        className,
      )}
      checked={checked}
      {...props}
    >
      <span
        className="pointer-events-none absolute right-2 flex size-3.5 items-center justify-center"
        data-slot="dropdown-menu-checkbox-item-indicator"
      >
        <MenuPrimitive.CheckboxItemIndicator>
          <CheckIcon className="size-3.5" />
        </MenuPrimitive.CheckboxItemIndicator>
      </span>
      {children}
    </MenuPrimitive.CheckboxItem>
  );
}

function DropdownMenuRadioGroup({ className, ...props }: MenuPrimitive.RadioGroup.Props) {
  return (
    <MenuPrimitive.RadioGroup
      data-slot="dropdown-menu-radio-group"
      className={cn("flex flex-col gap-0.5", className)}
      {...props}
    />
  );
}

function DropdownMenuRadioItem({
  className,
  children,
  inset,
  ...props
}: MenuPrimitive.RadioItem.Props & {
  inset?: boolean;
}) {
  return (
    <MenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      data-inset={inset}
      className={cn(
        "relative flex h-8 cursor-default items-center gap-2 rounded-[6px] px-2 py-0 pr-7 text-sm leading-5 outline-hidden transition-[background-color] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] select-none data-checked:bg-foreground/[0.05] data-highlighted:text-foreground data-disabled:opacity-50 data-inset:pl-8 motion-reduce:transition-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:size-3.5 [&_svg]:text-foreground",
        className,
      )}
      {...props}
    >
      <span
        className="pointer-events-none absolute right-2 flex size-3.5 items-center justify-center"
        data-slot="dropdown-menu-radio-item-indicator"
      >
        <MenuPrimitive.RadioItemIndicator>
          <CheckIcon className="size-3.5" />
        </MenuPrimitive.RadioItemIndicator>
      </span>
      {children}
    </MenuPrimitive.RadioItem>
  );
}

function DropdownMenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
  return (
    <MenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn("-mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  );
}

function DropdownMenuShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      className={cn(
        "ml-auto text-xs tracking-widest text-muted-foreground group-focus/dropdown-menu-item:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

export {
  DropdownMenu,
  DropdownMenuPortal,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuLinkItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
};
