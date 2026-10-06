import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

const buttonVariants = cva(
  "relative inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-[var(--control-radius)] border font-medium outline-none transition-[background-color,box-shadow] cursor-pointer focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-60 aria-disabled:cursor-not-allowed aria-disabled:opacity-60 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    defaultVariants: { size: "default", variant: "default" },
    variants: {
      size: {
        default: "h-8 px-3 text-sm",
        sm: "h-7 gap-1.5 px-2.5 text-xs",
        compact: "h-7 gap-1 px-2 text-xs",
        icon: "size-8 p-0",
      },
      variant: {
        default: "border-primary bg-primary text-primary-foreground shadow-xs hover:bg-primary/90",
        outline:
          "border-input bg-popover text-foreground shadow-xs/5 hover:bg-accent/50 dark:bg-input/32",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/90",
        ghost: "border-transparent text-foreground hover:bg-accent",
        destructive: "border-destructive bg-destructive text-white hover:bg-destructive/90",
      },
    },
  },
);

type ButtonVariant = NonNullable<VariantProps<typeof buttonVariants>["variant"]>;
type ButtonSize = NonNullable<VariantProps<typeof buttonVariants>["size"]>;
interface ButtonProps extends useRender.ComponentProps<"button"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

function Button({ className, variant, size, render, ...props }: ButtonProps) {
  const defaultProps = {
    className: cn(buttonVariants({ className, variant, size })),
    "data-slot": "button",
    "data-size": size ?? "default",
    type: render ? undefined : ("button" as const),
  };
  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(defaultProps, props),
    render,
  });
}

export { Button, type ButtonProps, type ButtonVariant, type ButtonSize };
