import { Input as InputPrimitive } from "@base-ui/react/input";
import { cn } from "../../lib/utils";

type InputProps = Omit<InputPrimitive.Props, "size"> & {
  size?: "default" | "sm" | "compact";
};

function Input({ className, size = "default", ...props }: InputProps) {
  return (
    <InputPrimitive
      className={cn(
        "w-full min-w-0 rounded-[var(--control-radius)] border border-input bg-background px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 dark:bg-input/32",
        size === "default" ? "h-8" : "h-7 px-2.5 text-xs",
        props.type === "search" && "[&::-webkit-search-cancel-button]:appearance-none",
        className,
      )}
      data-slot="input"
      {...props}
    />
  );
}

export { Input, type InputProps };
