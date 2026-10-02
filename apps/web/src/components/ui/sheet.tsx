// Adapted from T3 Code's shadcn/Base UI components (MIT); see apps/web/public/THIRD_PARTY_NOTICES.txt.
import { Dialog as SheetPrimitive } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";
import { Button } from "./button";

const Sheet = SheetPrimitive.Root;
const SheetPortal = SheetPrimitive.Portal;
const SheetClose = SheetPrimitive.Close;

function SheetPopup({
  className,
  children,
  showCloseButton = true,
  ...props
}: SheetPrimitive.Popup.Props & { showCloseButton?: boolean }) {
  return (
    <SheetPortal>
      <SheetPrimitive.Backdrop
        className="fixed inset-0 z-50 bg-background/60 transition-opacity duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-none"
        data-slot="sheet-backdrop"
      />
      <SheetPrimitive.Viewport
        className="pointer-events-none fixed inset-0 z-50 flex justify-end"
        data-slot="sheet-viewport"
      >
        <SheetPrimitive.Popup
          className={cn(
            "pointer-events-auto relative flex h-full w-full max-w-md min-h-0 flex-col border-l border-border bg-popover text-popover-foreground shadow-lg transition-[opacity,translate] duration-200 data-ending-style:translate-x-8 data-starting-style:translate-x-8 data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-none",
            className,
          )}
          data-slot="sheet-popup"
          {...props}
        >
          {children}
          {showCloseButton && (
            <SheetClose
              aria-label="Close dialog"
              className="absolute right-3 top-3"
              render={<Button variant="ghost" size="icon" />}
            >
              <X aria-hidden className="size-4" />
            </SheetClose>
          )}
        </SheetPrimitive.Popup>
      </SheetPrimitive.Viewport>
    </SheetPortal>
  );
}

function SheetHeader({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("flex shrink-0 flex-col gap-2 p-6 pr-14", className)}
      data-slot="sheet-header"
      {...props}
    />
  );
}

function SheetTitle({ className, ...props }: SheetPrimitive.Title.Props) {
  return (
    <SheetPrimitive.Title
      className={cn("text-base font-semibold", className)}
      data-slot="sheet-title"
      {...props}
    />
  );
}

function SheetDescription({ className, ...props }: SheetPrimitive.Description.Props) {
  return (
    <SheetPrimitive.Description
      className={cn("text-sm text-muted-foreground", className)}
      data-slot="sheet-description"
      {...props}
    />
  );
}

export {
  Sheet,
  SheetPortal,
  SheetClose,
  SheetPopup,
  SheetPopup as SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
};
