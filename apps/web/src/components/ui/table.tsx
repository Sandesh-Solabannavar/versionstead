import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

function Table({ className, ...props }: ComponentProps<"table">) {
  return (
    <table
      className={cn("w-full caption-bottom text-xs", className)}
      data-slot="table"
      {...props}
    />
  );
}

function TableHeader({ className, ...props }: ComponentProps<"thead">) {
  return <thead className={cn("[&_tr]:border-b", className)} data-slot="table-header" {...props} />;
}

function TableBody({ className, ...props }: ComponentProps<"tbody">) {
  return (
    <tbody
      className={cn("[&_tr:last-child]:border-0", className)}
      data-slot="table-body"
      {...props}
    />
  );
}

function TableRow({ className, ...props }: ComponentProps<"tr">) {
  return (
    <tr
      className={cn(
        "border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted",
        className,
      )}
      data-slot="table-row"
      {...props}
    />
  );
}

function TableHead({ className, ...props }: ComponentProps<"th">) {
  return (
    <th
      className={cn(
        "h-9 px-2 text-left align-middle font-medium whitespace-nowrap text-muted-foreground",
        className,
      )}
      data-slot="table-head"
      {...props}
    />
  );
}

function TableCell({ className, ...props }: ComponentProps<"td">) {
  return (
    <td
      className={cn("p-2 align-middle whitespace-nowrap", className)}
      data-slot="table-cell"
      {...props}
    />
  );
}

export { Table, TableHeader, TableBody, TableRow, TableHead, TableCell };
