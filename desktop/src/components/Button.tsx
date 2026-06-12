import React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue-500 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        primary: "btn-primary",
        secondary: "btn-secondary",
        destructive: "btn-reset bg-red-600/90 text-white shadow-sm hover:bg-red-500",
        outline: "btn-reset border border-slate-200 dark:border-white/20 bg-transparent shadow-sm hover:bg-slate-50 dark:hover:bg-zinc-800 hover:text-slate-900 dark:hover:text-white text-slate-700 dark:text-zinc-300",
        ghost: "btn-reset hover:bg-slate-100 dark:hover:bg-zinc-800/50 text-slate-600 dark:text-zinc-300 hover:text-slate-900 dark:hover:text-white",
      },
      size: {
        default: "",
        sm: "h-10 rounded-lg px-5 text-sm",
        lg: "h-12 rounded-xl px-10 text-base",
        icon: "h-10 w-10",
      },
      fullWidth: {
        true: "w-full",
      }
    },
    defaultVariants: {
      variant: "primary",
      size: "default",
      fullWidth: false,
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, fullWidth, ...props }, ref) => {
    return (
      <button
        className={buttonVariants({ variant, size, fullWidth, className })}
        ref={ref}
        {...props}
      />
    )
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
