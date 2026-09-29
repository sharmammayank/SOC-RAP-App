/* Small design-system kit (shadcn-style: Tailwind + Radix primitives). */
import * as RDialog from "@radix-ui/react-dialog";
import * as RTooltip from "@radix-ui/react-tooltip";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { Loader2, X, Download } from "lucide-react";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode, type HTMLAttributes, type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { toCsv } from "@/engine/xlsx/writer";
import { downloadBlob } from "@/lib/download";

/** Class names with Tailwind conflict resolution: later utilities win (e.g. a caller's text colour over a variant's). */
export const cx = (...c: ClassValue[]) => twMerge(clsx(c));

type BtnVariant = "primary" | "secondary" | "ghost" | "danger" | "subtle";
export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: "sm" | "md"; loading?: boolean; icon?: ReactNode }>(
  function Button({ variant = "secondary", size = "md", loading, icon, className, children, disabled, ...p }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        disabled={disabled || loading}
        className={cx(
          "inline-flex items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition select-none disabled:opacity-55",
          size === "sm" ? "h-8 px-2.5 text-[12.5px]" : "h-9 px-3.5 text-[13.5px]",
          variant === "primary" && "bg-accent text-accent-ink hover:brightness-110",
          variant === "secondary" && "border border-line-strong bg-surface text-ink hover:bg-surface-2",
          variant === "ghost" && "text-ink-2 hover:bg-surface-2",
          variant === "subtle" && "bg-accent-soft text-accent hover:brightness-95",
          variant === "danger" && "border border-bad/50 bg-surface text-bad hover:bg-bad-bg",
          className,
        )}
        {...p}
      >
        {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : icon}
        {children}
      </button>
    );
  },
);

export function Panel({ title, sub, actions, children, className, pad = true, ...p }: { title?: ReactNode; sub?: ReactNode; actions?: ReactNode; children?: ReactNode; className?: string; pad?: boolean } & Omit<HTMLAttributes<HTMLElement>, "title">) {
  return (
    <section className={cx("rounded-lg border border-line bg-surface shadow-card", className)} {...p}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
          <div className="min-w-0">
            {title && <h3 className="text-[15px]">{title}</h3>}
            {sub && <p className="text-[12.5px] text-muted">{sub}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={pad ? "p-4" : ""}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, sub, actions, eyebrow }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        {eyebrow && <div className="eyebrow mb-1">{eyebrow}</div>}
        <h1 className="text-[22px] leading-tight">{title}</h1>
        {sub && <p className="mt-1 max-w-3xl text-[13px] text-ink-2">{sub}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export type Tone = "good" | "bad" | "warn" | "neutral" | "info";
export function Chip({ tone = "neutral", children, className, title }: { tone?: Tone; children: ReactNode; className?: string; title?: string }) {
  return (
    <span
      title={title}
      className={cx(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] font-medium whitespace-nowrap",
        tone === "good" && "bg-good-bg text-good",
        tone === "bad" && "bg-bad-bg text-bad",
        tone === "warn" && "bg-warn-bg text-warn",
        tone === "info" && "bg-accent-soft text-accent",
        tone === "neutral" && "bg-surface-2 text-ink-2 ring-1 ring-line",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Callout({ tone = "info", title, children, action }: { tone?: Tone; title?: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div
      role={tone === "bad" ? "alert" : "status"}
      className={cx(
        "flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-4 py-3 text-[13px]",
        tone === "bad" && "border-bad/30 bg-bad-bg",
        tone === "good" && "border-good/30 bg-good-bg",
        tone === "warn" && "border-warn/30 bg-warn-bg",
        (tone === "info" || tone === "neutral") && "border-accent/25 bg-accent-soft",
      )}
    >
      {title && <b className={cx(tone === "bad" && "text-bad", tone === "good" && "text-good", tone === "warn" && "text-warn")}>{title}</b>}
      <div className="min-w-0 flex-1 text-ink-2">{children}</div>
      {action}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-[13px] text-muted" role="status">
      <Loader2 className="size-4 animate-spin" aria-hidden />
      {label ?? "Loading…"}
    </div>
  );
}

export function Empty({ title, children, action, icon }: { title: string; children?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-line-strong bg-surface px-6 py-12 text-center">
      {icon && <div className="text-muted">{icon}</div>}
      <h3 className="text-[16px]">{title}</h3>
      {children && <p className="max-w-md text-[13px] text-ink-2">{children}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <Callout tone="bad" title="Something went wrong." action={onRetry && <Button size="sm" onClick={onRetry}>Try again</Button>}>
      {msg}
    </Callout>
  );
}

export function Stat({ label, value, delta, note, tone }: { label: string; value: ReactNode; delta?: ReactNode; note?: ReactNode; tone?: Tone }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-lg border border-line bg-surface px-4 py-3 shadow-card">
      <span className="eyebrow">{label}</span>
      <span className={cx("num text-[24px] font-semibold leading-tight", tone === "bad" && "text-bad", tone === "good" && "text-good", tone === "warn" && "text-warn")}>{value}</span>
      {delta}
      {note && <span className="text-[12px] text-muted">{note}</span>}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...p }, ref) {
  return <input ref={ref} className={cx("field", className)} {...p} />;
});
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, ...p }, ref) {
  return <select ref={ref} className={cx("field pr-7", className)} {...p} />;
});
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...p }, ref) {
  return <textarea ref={ref} className={cx("field h-auto py-2", className)} {...p} />;
});
export function Label({ children, htmlFor, hint }: { children: ReactNode; htmlFor?: string; hint?: ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="flex flex-col gap-0.5 text-[12.5px] font-medium text-ink-2">
      {children}
      {hint && <span className="font-normal text-muted">{hint}</span>}
    </label>
  );
}

export function Segmented<T extends string>({ value, onChange, options, label, size = "md" }: { value: T; onChange: (v: T) => void; options: { v: T; label: ReactNode; disabled?: boolean }[]; label: string; size?: "sm" | "md" }) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-md border border-line-strong bg-surface p-0.5">
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          disabled={o.disabled}
          aria-pressed={value === o.v}
          onClick={() => onChange(o.v)}
          className={cx("rounded px-2.5 font-medium transition", size === "sm" ? "h-7 text-[12px]" : "h-8 text-[13px]", value === o.v ? "bg-accent text-accent-ink" : "text-ink-2 hover:bg-surface-2")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Dialog({ open, onOpenChange, title, description, children, footer, wide }: { open: boolean; onOpenChange: (o: boolean) => void; title: ReactNode; description?: ReactNode; children?: ReactNode; footer?: ReactNode; wide?: boolean }) {
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <RDialog.Content className={cx("fixed top-1/2 left-1/2 z-50 max-h-[88vh] w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-xl border border-line bg-surface shadow-2xl", wide ? "max-w-4xl" : "max-w-lg")}>
          <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
            <div>
              <RDialog.Title className="font-head text-[17px] font-semibold">{title}</RDialog.Title>
              {description ? <RDialog.Description className="mt-0.5 text-[13px] text-ink-2">{description}</RDialog.Description> : <RDialog.Description className="sr-only">{typeof title === "string" ? title : "Dialog"}</RDialog.Description>}
            </div>
            <RDialog.Close className="rounded p-1 text-muted hover:bg-surface-2" aria-label="Close">
              <X className="size-4" />
            </RDialog.Close>
          </div>
          <div className="px-5 py-4">{children}</div>
          {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

export function Tip({ content, children }: { content: ReactNode; children: ReactNode }) {
  return (
    <RTooltip.Root delayDuration={150}>
      <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content sideOffset={6} className="z-50 max-w-sm rounded-md bg-ink px-2.5 py-1.5 text-[12px] leading-snug text-bg shadow-lg">
          {content}
          <RTooltip.Arrow className="fill-ink" />
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  );
}
export const TipProvider = RTooltip.Provider;

/** Every grid gets a CSV export (spec §7.4). */
export function CsvButton({ rows, name, label = "CSV" }: { rows: () => (string | number | boolean | null | undefined)[][]; name: string; label?: string }) {
  return (
    <Button size="sm" variant="ghost" icon={<Download className="size-3.5" />} onClick={() => downloadBlob(new Blob([toCsv(rows())], { type: "text/csv;charset=utf-8" }), name.endsWith(".csv") ? name : name + ".csv")}>
      {label}
    </Button>
  );
}

export function Progress({ value, label }: { value: number; label?: string }) {
  return (
    <div className="flex flex-col gap-1">
      {label && <span className="text-[12.5px] text-ink-2">{label}</span>}
      <div className="h-2 overflow-hidden rounded-full bg-surface-2 ring-1 ring-line" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value)}>
        <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${Math.max(2, Math.min(100, value))}%` }} />
      </div>
    </div>
  );
}

export function Delta({ cur, prev, pts, goodUp = false }: { cur: number | null | undefined; prev: number | null | undefined; pts?: boolean; goodUp?: boolean }) {
  if (cur == null || prev == null || (!pts && !prev)) return <span className="text-[12px] text-muted">no prior data</span>;
  const d = cur - prev;
  if (Math.abs(d) < 1e-9) return <span className="text-[12px] text-muted">no change</span>;
  const good = d > 0 === goodUp;
  const txt = pts ? `${d > 0 ? "▲" : "▼"} ${Math.abs(d).toFixed(2)} pts` : `${d > 0 ? "▲" : "▼"} ${Math.abs(d).toLocaleString("en-US")} (${d > 0 ? "+" : "−"}${Math.abs((d / prev) * 100).toFixed(1)}%)`;
  return <span className={cx("num text-[12px] font-medium", good ? "text-good" : "text-bad")}>{txt}</span>;
}

export function StatusChip({ s, why }: { s: string; why?: string | null }) {
  const m: Record<string, [Tone, string]> = { MET: ["good", "Met"], NOT_MET: ["bad", "Not met"], PENDING: ["warn", "Pending"], NA: ["neutral", "N/A"], ERROR: ["bad", "Error"] };
  const [tone, label] = m[s] ?? ["neutral", s];
  const chip = <Chip tone={tone}>{label}</Chip>;
  return why ? (
    <Tip content={why}>
      <span tabIndex={0}>{chip}</span>
    </Tip>
  ) : (
    chip
  );
}

export const PRIO_COLOR: Record<string, string> = { Critical: "#6B1D1A", High: "#D9472B", Medium: "#E0A100", Low: "#7A9A45", Informational: "#8C97A8" };
export function PrioDot({ p }: { p: string | null }) {
  return <span aria-hidden className="mr-1.5 inline-block size-2.5 rounded-full align-middle" style={{ background: p ? PRIO_COLOR[p] : "var(--muted)" }} />;
}
