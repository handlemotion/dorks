import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "#/lib/utils";

const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center rounded-full border border-transparent text-sm font-normal leading-[1.3] whitespace-nowrap transition-colors duration-250 ease-out outline-none select-none focus-visible:ring-2 focus-visible:ring-white/75 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        solid: "bg-white text-black hover:bg-white/90 active:bg-white/80",
        solidDark: "bg-neutral-950 text-white hover:bg-neutral-800 active:bg-neutral-700",
        glass: "bg-[#c5b6b7]/85 text-white backdrop-blur-md hover:bg-[#c5b6b7] active:bg-[#b8a7a8]",
        nav: "bg-transparent text-white hover:bg-black/15 active:bg-black/20",
        navLight: "bg-transparent text-neutral-800 hover:bg-black/8 hover:text-black active:bg-black/14",
        splitPrimary: "rounded-none rounded-l-full border-0 bg-white text-black hover:bg-[#f4f4f5] active:bg-[#e9e9ec] focus-visible:ring-inset focus-visible:ring-black/25",
        splitTrigger:
          "rounded-none rounded-r-full border-0 border-l border-l-[#f0f0f0] bg-white text-black hover:bg-[#f4f4f5] active:bg-[#e9e9ec] data-[popup-open]:bg-[#f0f0f2] focus-visible:ring-inset focus-visible:ring-black/25",
        ghost: "bg-transparent text-neutral-900 hover:bg-neutral-100 active:bg-neutral-200/70",
      },
      size: {
        default: "h-9 gap-2.5 px-3.5",
        sm: "h-8 gap-2 px-3.5",
        splitMain: "h-9 gap-2.5 pl-3.5 pr-3",
        splitEnd: "h-9 w-9 pr-[3px]",
        icon: "size-9",
        "icon-sm": "size-8",
      },
    },
    defaultVariants: {
      variant: "solid",
      size: "default",
    },
  },
);

type ButtonProps = ButtonPrimitive.Props & VariantProps<typeof buttonVariants>;

function Button({ className, variant, size, ...props }: ButtonProps) {
  return <ButtonPrimitive data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

export { Button, buttonVariants, type ButtonProps };
