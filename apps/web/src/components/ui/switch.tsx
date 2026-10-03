// Adapted from T3 Code's shadcn/Base UI components (MIT); see THIRD_PARTY_NOTICES.txt.
import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { cn } from "../../lib/utils";
export function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root className={cn("settings-switch", className)} {...props}>
      <SwitchPrimitive.Thumb className="settings-switch-thumb" />
    </SwitchPrimitive.Root>
  );
}
