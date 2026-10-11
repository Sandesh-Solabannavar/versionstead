import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { cn } from "../../lib/utils";

export const Menu = MenuPrimitive.Root;
export const MenuTrigger = MenuPrimitive.Trigger;
export function MenuPopup({ children, className, ...props }: MenuPrimitive.Popup.Props) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner align="end" sideOffset={4} className="z-[130]">
        <MenuPrimitive.Popup className={cn("connection-menu dropdown-glass", className)} {...props}>
          {children}
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}
export function MenuItem({ className, ...props }: MenuPrimitive.Item.Props) {
  return <MenuPrimitive.Item className={cn("connection-menu-item", className)} {...props} />;
}
/** An anchor styled as a menu item; the menu closes when it is followed. */
export function MenuLinkItem({ className, ...props }: MenuPrimitive.LinkItem.Props) {
  return (
    <MenuPrimitive.LinkItem
      className={cn("connection-menu-item", className)}
      closeOnClick
      {...props}
    />
  );
}
