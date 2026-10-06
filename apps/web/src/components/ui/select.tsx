import { Select as SelectPrimitive } from "@base-ui/react/select";
import { Check, ChevronDown } from "lucide-react";
import { useContext } from "react";
import { DialogPortalContainer } from "./dialog-portal";
import { cn } from "../../lib/utils";

const Select = SelectPrimitive.Root;

function SelectTrigger({
  className,
  size = "default",
  children,
  ...props
}: SelectPrimitive.Trigger.Props & { size?: "default" | "sm" | "compact" }) {
  return (
    <SelectPrimitive.Trigger
      className={cn(
        "inline-flex min-w-0 cursor-pointer items-center justify-between gap-2 rounded-[var(--control-radius)] border border-input bg-popover px-2.5 text-left text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring data-disabled:pointer-events-none data-disabled:opacity-60",
        size === "default" ? "h-8 text-sm" : "h-7 text-xs",
        className,
      )}
      data-slot="select-trigger"
      {...props}
    >
      {children}
      <SelectPrimitive.Icon>
        <ChevronDown aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

function SelectValue({ className, ...props }: SelectPrimitive.Value.Props) {
  return (
    <SelectPrimitive.Value
      className={cn("min-w-0 flex-1 truncate", className)}
      data-slot="select-value"
      {...props}
    />
  );
}

function SelectPopup({
  className,
  children,
  alignItemWithTrigger = false,
  ...props
}: SelectPrimitive.Popup.Props & { alignItemWithTrigger?: boolean }) {
  const container = useContext(DialogPortalContainer);
  return (
    <SelectPrimitive.Portal container={container}>
      <SelectPrimitive.Positioner
        positionMethod="fixed"
        sideOffset={4}
        align="start"
        alignItemWithTrigger={alignItemWithTrigger}
        className="z-[70]"
        data-slot="select-positioner"
      >
        <SelectPrimitive.Popup
          className={cn(
            "min-w-(--anchor-width) max-w-(--available-width) rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg outline-none",
            className,
          )}
          data-slot="select-popup"
          {...props}
        >
          <SelectPrimitive.List
            className="max-h-(--available-height) overflow-y-auto"
            data-slot="select-list"
          >
            {children}
          </SelectPrimitive.List>
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  );
}

function SelectItem({ className, children, ...props }: SelectPrimitive.Item.Props) {
  return (
    <SelectPrimitive.Item
      className={cn(
        "flex min-h-7 cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-xs outline-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-60",
        className,
      )}
      data-slot="select-item"
      {...props}
    >
      <SelectPrimitive.ItemText className="min-w-0 flex-1">{children}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator>
        <Check aria-hidden className="size-3" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}

function SelectGroup(props: SelectPrimitive.Group.Props) {
  return <SelectPrimitive.Group data-slot="select-group" {...props} />;
}

function SelectGroupLabel({ className, ...props }: SelectPrimitive.GroupLabel.Props) {
  return (
    <SelectPrimitive.GroupLabel
      className={cn("px-2 py-1.5 text-xs text-muted-foreground", className)}
      data-slot="select-group-label"
      {...props}
    />
  );
}

export {
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectPopup as SelectContent,
  SelectItem,
  SelectGroup,
  SelectGroupLabel,
};
